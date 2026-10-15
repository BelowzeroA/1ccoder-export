// The BSL module of a managed form, which lives nowhere a container reader can
// reach it.
//
// A processing's *object* module is its own nested container -- `{info, text}`
// -- and container.ts lifts it out. A *form* module is not: the form is stored
// as one entry holding 1C's own serialized form description, a brace-and-comma
// text format, and the module is one quoted string inside it. For a processing
// whose work is done on the form -- which is most of them -- that string is the
// entire program, and until now it was locked inside an opaque blob.
//
// Reading it back out is a heuristic, but writing it is not: we replace exactly
// the span the module occupied and leave every other byte alone. Nothing about
// the form description has to be understood, so nothing about it can be broken.
// The reference Python implementation (v8pack.py, _extract_form_module) went
// half this distance -- it extracted the text for display and never wrote it
// back, so an edit there silently did nothing.

import { KNOWN_EVENTS, parseModuleProcedures } from "../infobase/form-bindings"

const BOM = "﻿"

/** Where a module sits inside an entry's decoded text. */
export interface FormModuleSpan {
  /** Index of the opening quote. */
  readonly start: number
  /** Index just past the closing quote. */
  readonly end: number
  /** The unescaped module text. */
  readonly text: string
}

/**
 * Every quoted string in the serialized form, left to right.
 *
 * Written as one pass that consumes each string whole, so a quote *inside* a
 * string can never be mistaken for the start of another one. 1C escapes a quote
 * by doubling it, which is the only escape this format has.
 */
function* quotedStrings(text: string): Generator<FormModuleSpan> {
  let index = 0
  while (index < text.length) {
    if (text[index] !== '"') {
      index++
      continue
    }
    const start = index
    let value = ""
    let cursor = index + 1
    for (;;) {
      const quote = text.indexOf('"', cursor)
      // Unterminated: the entry is not what we think it is, so stop rather than
      // guess. Callers treat "no module found" as "leave this entry alone".
      if (quote === -1) return
      value += text.slice(cursor, quote)
      if (text[quote + 1] === '"') {
        value += '"'
        cursor = quote + 2
        continue
      }
      cursor = quote + 1
      break
    }
    yield { start, end: cursor, text: value }
    index = cursor
  }
}

/** Openers a 1C module can legitimately begin with. */
const OPENER = /^\s*(?:&[А-Яа-яA-Za-z]+|Перем\s|Процедура\s|Функция\s|\/\/|#Если|#Область)/u
/** Something every module of consequence contains. */
const BODY = /(?:^|\n)\s*(?:Процедура\s|Функция\s|&[А-Яа-яA-Za-z]+)/u

/**
 * The shortest thing we are willing to call a module.
 *
 * Form descriptions are full of short string literals, and a caption reading
 * "Процедура" would otherwise qualify. Anything genuinely worth editing is far
 * longer than this.
 */
const MIN_LENGTH = 40

function looksLikeModule(text: string): boolean {
  return text.length >= MIN_LENGTH && OPENER.test(text) && BODY.test(text)
}

/**
 * The form module inside an entry, or null when there is none.
 *
 * The longest qualifying string wins rather than the first. A module often
 * quotes BSL in a comment or builds a query from fragments, and the reference
 * implementation's "first string starting with a directive" picked those up --
 * and missed real modules that open with `Перем`, which is exactly how the one
 * module the user cared about stayed invisible.
 */
export function findFormModule(content: Buffer): FormModuleSpan | null {
  let text: string
  try {
    text = content.toString("utf8")
  } catch {
    return null
  }
  // Binary entries decode into replacement characters rather than throwing, and
  // splicing one would corrupt the entry. Only text that survives the round
  // trip byte for byte is safe to rewrite.
  if (!Buffer.from(text, "utf8").equals(content)) return null

  let best: FormModuleSpan | null = null
  for (const span of quotedStrings(text)) {
    if (!looksLikeModule(span.text)) continue
    if (!best || span.text.length > best.text.length) best = span
  }
  return best
}

/**
 * Puts an edited module back, changing nothing else.
 *
 * Returns null when the entry no longer holds a module where one was found --
 * which means the substrate was edited into a different shape, and silently
 * writing the module somewhere else would be worse than refusing.
 */
export function replaceFormModule(content: Buffer, bsl: Buffer): Buffer | null {
  const span = findFormModule(content)
  if (!span) return null

  const text = content.toString("utf8")
  // The module is a value inside the description; a BOM belongs to the entry,
  // not to the string, and carrying one in would put it mid-file.
  const next = bsl.toString("utf8").replace(BOM, "")
  const escaped = next.replace(/"/g, '""')
  return Buffer.from(`${text.slice(0, span.start)}"${escaped}"${text.slice(span.end)}`, "utf8")
}

// 2026-09-26, debrief13.md §13.12. A handler added to a form module this way
// is text only: the platform calls it when the form description lists it in
// its event table, `{N,<event uuid>,"<procedure>",…}` -- verified on the
// toolkit's own forms. A check processing got `ПриСозданииНаСервере` like
// this, never ran it, and three launches each waited out the timeout.
const EVENT_ENTRY = (name: string) =>
  new RegExp(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12},"${name}"`, "i")

/**
 * Procedures of a form module named after a form event that the form
 * description does not bind. Module text alone never matches: in the
 * description a handler is a quoted name right after the event's UUID.
 */
export function unboundEventHandlers(description: Buffer, bsl: Buffer): string[] {
  const text = description.toString("utf8")
  return parseModuleProcedures(bsl.toString("utf8"))
    .filter((procedure) => procedure.isProcedure && Object.hasOwn(KNOWN_EVENTS, procedure.name))
    .map((procedure) => procedure.name)
    .filter((name) => !EVENT_ENTRY(name).test(text))
}
