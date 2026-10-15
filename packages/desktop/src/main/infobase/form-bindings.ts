// A form event handler that nothing calls.
//
// 2026-09-25, observed live. The agent built `НастройкаШаблоновСчета.epf` with a
// correct `ПриСозданииНаСервере(Отказ, СтандартнаяОбработка)` in
// `Forms/Форма/Ext/Form/Module.bsl` -- and `Form.xml` had no `<Events>` block at
// all, so the procedure was dead code. The form opened, the handler never ran,
// and nothing said so.
//
// Why nothing said so, and why `1c_check_epf` cannot help: a compiler check
// compiles the procedure (it is valid BSL) and creating the form succeeds
// (nothing is wired, so nothing fails). Dead code passes every check that exists.
// The only place the defect is visible is the pair of files, side by side.
//
// What makes this a trap rather than carelessness: in the Designer, creating a
// handler through the UI writes the binding for you, so the binding is invisible
// work the tool normally does. Editing the XML directly, nothing binds by name --
// the agent had in fact bound its two commands correctly with `<Action>`, so it
// knew one idiom and assumed events followed the same naming convention.
//
// The event names, and the compiler directive each one requires, are not
// conventions: harvested from 401 form+module pairs in a БП 3.0.203.18 dump, the
// directive was unanimous for every event below (OnCreateAtServer 396/396,
// OnOpen 293/293, OnChange 1331/1332). Wrong directive is a real error, not a
// style choice.

/**
 * Russian handler name -> the XML event that binds it, and the directive it needs.
 *
 * Platform-level, not configuration-level: the managed-form event model is the
 * same in every configuration, which is why this table lives here and not in a
 * pack. Cross-checked on a УТ 11.5 dump as well as a БП 3.0 one -- same events,
 * same directives, same signatures.
 *
 * `parameters` is an exact match before binding, and real code is not perfectly
 * uniform: the УТ dump has `BeforeClose` handlers with 2 parameters beside 27
 * with 4, and one `OnClose` with none. An older signature is therefore reported
 * rather than bound, which is the safe direction -- binding a handler the event
 * cannot call would replace "does nothing" with an error.
 */
export const KNOWN_EVENTS: Readonly<
  Record<string, { readonly event: string; readonly directive: string; readonly parameters: number }>
> = {
  ПриСозданииНаСервере: { event: "OnCreateAtServer", directive: "&НаСервере", parameters: 2 },
  ПриЧтенииНаСервере: { event: "OnReadAtServer", directive: "&НаСервере", parameters: 1 },
  ПослеЗаписиНаСервере: { event: "AfterWriteAtServer", directive: "&НаСервере", parameters: 2 },
  ПриОткрытии: { event: "OnOpen", directive: "&НаКлиенте", parameters: 1 },
  ПередЗакрытием: { event: "BeforeClose", directive: "&НаКлиенте", parameters: 4 },
  ПриЗакрытии: { event: "OnClose", directive: "&НаКлиенте", parameters: 1 },
  ОбработкаОповещения: { event: "NotificationProcessing", directive: "&НаКлиенте", parameters: 3 },
  ПослеЗаписи: { event: "AfterWrite", directive: "&НаКлиенте", parameters: 1 },
}

/**
 * Event names that also appear as the tail of an item handler.
 *
 * `ПолеОрганизацияПриИзменении` is the OnChange handler of the item
 * `ПолеОрганизация`; the platform's own forms name them this way throughout
 * (OnChange 1332 occurrences, Click 911). A procedure ending in one of these is
 * very probably meant to be an item handler, so an unbound one is worth naming
 * even though the item cannot be inferred with certainty.
 */
const ITEM_EVENT_SUFFIXES = [
  "ПриИзменении",
  "Нажатие",
  "ОбработкаВыбора",
  "НачалоВыбора",
  "Открытие",
  "ПриАктивизацииСтроки",
  "ОбработкаНавигационнойСсылки",
  "АвтоПодборТекста",
  "ОкончаниеВводаТекста",
  "ПередНачаломДобавления",
  "ПередУдалением",
  "Выбор",
] as const

export interface ModuleProcedure {
  readonly name: string
  /** The directive above it, or null when it carries none. */
  readonly directive: string | null
  /** 1-based, so a finding can be pointed at. */
  readonly line: number
  /** A handler is always a Процедура; a Функция with a handler's name is not one. */
  readonly isProcedure: boolean
  /** Declared parameters. An event fires with a fixed count, so this has to match. */
  readonly parameters: number
}

/**
 * Procedures and functions declared in a form module, with their directives.
 *
 * Line-based rather than a BSL parser: the declaration and its directive are
 * both single lines, and a dependency-free module is what the plugin can carry.
 */
export function parseModuleProcedures(bsl: string): readonly ModuleProcedure[] {
  const found: ModuleProcedure[] = []
  let pending: string | null = null
  bsl.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^﻿/, "").trim()
    if (line.startsWith("&")) {
      pending = line.split("(")[0]!.trim()
      return
    }
    const declaration = /^(Процедура|Функция|Procedure|Function)\s+([0-9A-Za-zА-Яа-яЁё_]+)\s*\(([^)]*)\)/i.exec(line)
    if (!declaration) return
    found.push({
      name: declaration[2]!,
      directive: pending,
      line: index + 1,
      isProcedure: /^(?:Процедура|Procedure)$/i.test(declaration[1]!),
      parameters: declaration[3]!.split(",").filter((part) => part.trim().length > 0).length,
    })
    pending = null
  })
  return found
}

export interface FormBindings {
  /** `<Event name="OnCreateAtServer">ПриСозданииНаСервере</Event>` */
  readonly events: readonly { readonly event: string; readonly procedure: string }[]
  /** `<Action>КомандаПрименить</Action>` inside a `<Command>`. */
  readonly actions: readonly string[]
}

/**
 * `<Event name="X"><Handler>P</Handler></Event>` -- bound to nothing.
 *
 * 2026-09-25, observed live. An agent editing the XML by hand wrote the
 * procedure as a `<Handler>` child instead of the element's text, and a
 * build-and-dump round trip proved what the platform does with it: it keeps the
 * event, canonicalises the name, and DISCARDS the child, leaving
 * `<Event name="OnCreateAtServer"></Event>`. So the form has an event with no
 * handler, which looks bound in the source and is not bound at all -- a worse
 * failure than the missing block, because the source reads as correct.
 *
 * Repaired rather than only reported: the transformation is exact, and the
 * alternative is that the binder adds a second, correct `<Event>` beside a
 * broken one.
 */
const MALFORMED_EVENT = /<Event(\s+name="[^"]*")\s*>\s*<Handler>([^<]*)<\/Handler>\s*<\/Event>/g

export function repairMalformedEvents(xml: string): { readonly xml: string; readonly repaired: readonly string[] } {
  const repaired = [...xml.matchAll(MALFORMED_EVENT)].map((match) => match[2]!.trim()).filter(Boolean)
  if (!repaired.length) return { xml, repaired: [] }
  return { xml: xml.replace(MALFORMED_EVENT, (_all, name, handler) => `<Event${name}>${handler.trim()}</Event>`), repaired }
}

export function parseFormBindings(xml: string): FormBindings {
  return {
    events: [...xml.matchAll(/<Event\s+name="([^"]+)"\s*>([^<]+)<\/Event>/g)].map((match) => ({
      event: match[1]!,
      procedure: match[2]!.trim(),
    })),
    actions: [...xml.matchAll(/<Action>([^<]+)<\/Action>/g)].map((match) => match[1]!.trim()),
  }
}

export interface BindingFinding {
  readonly kind: "unbound" | "missing" | "directive"
  readonly procedure: string
  readonly detail: string
}

/**
 * Everything wrong with the wiring between one form's XML and its module.
 *
 * Three directions, because each fails differently:
 *
 *   unbound   -- the procedure exists and nothing calls it. Silent: the form
 *                works, minus whatever the handler was for. This is the one that
 *                shipped on 09-25.
 *   missing   -- the XML names a procedure the module does not have. Loud, at
 *                runtime, in front of the user.
 *   directive -- bound, but on the wrong side. `ПриСозданииНаСервере` under
 *                `&НаКлиенте` cannot touch the infobase and fails when it tries.
 */
export function inspectFormBindings(form: { readonly xml: string; readonly module: string }): readonly BindingFinding[] {
  const bindings = parseFormBindings(form.xml)
  const procedures = parseModuleProcedures(form.module)
  const declared = new Map(procedures.map((procedure) => [procedure.name, procedure]))
  const bound = new Set([...bindings.events.map((entry) => entry.procedure), ...bindings.actions])

  const findings: BindingFinding[] = []

  for (const procedure of procedures) {
    if (bound.has(procedure.name)) continue
    const known = KNOWN_EVENTS[procedure.name]
    if (known) {
      findings.push({
        kind: "unbound",
        procedure: procedure.name,
        detail:
          `строка ${procedure.line}: это обработчик события формы, но в Form.xml его никто не вызывает. ` +
          `Добавь в <Events> формы: <Event name="${known.event}">${procedure.name}</Event>`,
      })
      continue
    }
    const suffix = ITEM_EVENT_SUFFIXES.find(
      (tail) => procedure.name.length > tail.length && procedure.name.endsWith(tail),
    )
    if (suffix) {
      findings.push({
        kind: "unbound",
        procedure: procedure.name,
        detail:
          `строка ${procedure.line}: имя выглядит как обработчик «${suffix}» элемента ` +
          `«${procedure.name.slice(0, -suffix.length)}», но в Form.xml его никто не вызывает. ` +
          `Событие привязывается в <Events> того элемента, а не по имени процедуры.`,
      })
    }
  }

  for (const entry of bindings.events) {
    const procedure = declared.get(entry.procedure)
    if (!procedure) {
      findings.push({
        kind: "missing",
        procedure: entry.procedure,
        detail: `<Event name="${entry.event}"> ссылается на процедуру, которой в модуле формы нет — при открытии формы будет ошибка.`,
      })
      continue
    }
    const known = KNOWN_EVENTS[entry.procedure]
    if (known && procedure.directive && procedure.directive !== known.directive) {
      findings.push({
        kind: "directive",
        procedure: entry.procedure,
        detail: `строка ${procedure.line}: директива ${procedure.directive}, а событию ${known.event} нужна ${known.directive}.`,
      })
    }
  }

  for (const action of bindings.actions) {
    if (declared.has(action)) continue
    findings.push({
      kind: "missing",
      procedure: action,
      detail: "<Action> команды ссылается на процедуру, которой в модуле формы нет — команда упадёт при нажатии.",
    })
  }

  return findings
}

export interface BindResult {
  /** The form XML with the missing bindings added, or the input unchanged. */
  readonly xml: string
  readonly bound: readonly { readonly event: string; readonly procedure: string }[]
  /** Handlers straightened out of a `<Handler>` child into the element's text. */
  readonly repaired: readonly string[]
}

/**
 * Adds the bindings that can be added without guessing.
 *
 * 2026-09-25. Reporting alone still costs a rebuild, and a rebuild is a DESIGNER
 * launch that closes the toolkit and has to be restarted -- minutes, for a line
 * of XML. So the binding goes in BEFORE the build and one build produces a
 * correct artefact.
 *
 * Only form-level events, only an exact name from KNOWN_EVENTS, only a
 * `Процедура`, and only when the parameter count matches what the event fires
 * with. Every one of those conditions is doing work:
 *
 *   - an item handler's name implies its item (`ПолеОрганизацияПриИзменении`)
 *     but the item may not exist or may be named differently, and binding it to
 *     the wrong element changes behaviour silently. Those stay reported.
 *   - a `Функция` named like a handler is not one.
 *   - arity is fixed per event (OnCreateAtServer 2 in 393/393 real forms), and
 *     binding a wrong-signature procedure converts "silently does nothing" into
 *     "errors in front of the user" -- strictly worse than leaving it reported.
 *
 * Insertion point is where the platform puts it: a form-level `<Events>` block
 * sits immediately before `<ChildItems>` (392 of 400 sampled forms), after
 * `</AutoCommandBar>` when one is present. Tabs, because that is what the
 * platform writes.
 */
export function bindFormEvents(form: { readonly xml: string; readonly module: string }): BindResult {
  // First straighten any `<Handler>` child into text content, so a hand-written
  // event that the platform would silently empty counts as bound and is not
  // duplicated by a second entry below.
  const repair = repairMalformedEvents(form.xml)
  form = { xml: repair.xml, module: form.module }
  const bindings = parseFormBindings(form.xml)
  const bound = new Set([...bindings.events.map((entry) => entry.procedure), ...bindings.actions])
  const additions = parseModuleProcedures(form.module).flatMap((procedure) => {
    if (bound.has(procedure.name) || !procedure.isProcedure) return []
    const known = KNOWN_EVENTS[procedure.name]
    if (!known || procedure.parameters !== known.parameters) return []
    return [{ event: known.event, procedure: procedure.name }]
  })
  if (!additions.length) return { xml: form.xml, bound: [], repaired: repair.repaired }

  const lines = additions.map((entry) => `\t\t<Event name="${entry.event}">${entry.procedure}</Event>`)

  // An existing block just gains entries; its own indentation is already right.
  if (/<Events>/.test(form.xml)) {
    return {
      xml: form.xml.replace("<Events>", `<Events>\n${lines.join("\n")}`),
      bound: additions,
      repaired: repair.repaired,
    }
  }

  const block = `\t<Events>\n${lines.join("\n")}\n\t</Events>\n`
  // `<ChildItems>` of the FORM, not of a nested item: the form's own is the one
  // at a single tab of indentation.
  for (const marker of ["\n\t<ChildItems>", "\n\t<Commands>", "\n\t<Attributes>"]) {
    if (form.xml.includes(marker)) {
      return {
        xml: form.xml.replace(marker, `\n${block}${marker.slice(1)}`),
        bound: additions,
        repaired: repair.repaired,
      }
    }
  }
  if (/<\/Form>/.test(form.xml)) {
    return { xml: form.xml.replace("</Form>", `${block}</Form>`), bound: additions, repaired: repair.repaired }
  }
  // Nothing recognisable to anchor to: leave the file alone rather than corrupt it.
  return { xml: form.xml, bound: [], repaired: repair.repaired }
}

/** Said in the build's result, because a file changed that the agent did not change. */
export function describeBindings(
  byForm: readonly {
    readonly form: string
    readonly bound: readonly { readonly event: string; readonly procedure: string }[]
    readonly repaired?: readonly string[]
  }[],
): string | null {
  const touched = byForm.filter((entry) => entry.bound.length > 0 || (entry.repaired?.length ?? 0) > 0)
  if (!touched.length) return null
  const lines = [
    "",
    "Привязаны обработчики событий формы (правка внесена в Form.xml до сборки, сборка уже с ней —",
    "это сделал инструмент, а не ты):",
  ]
  for (const entry of touched) {
    for (const item of entry.bound) {
      lines.push(`- ${entry.form}: <Event name="${item.event}">${item.procedure}</Event>`)
    }
    // Said separately: the source LOOKED bound, which is why it is worth naming.
    for (const procedure of entry.repaired ?? []) {
      lines.push(
        `- ${entry.form}: у «${procedure}» имя процедуры перенесено из вложенного <Handler> в текст элемента —` +
          " платформа <Handler> отбрасывает, и событие оставалось без обработчика.",
      )
    }
  }
  lines.push(
    "",
    "В конфигураторе это делает интерфейс при создании обработчика; в XML по имени не",
    "привязывается ничто, поэтому процедура без такой строки — мёртвый код. Если какая-то из них",
    "не должна была вызываться, убери строку из `<Events>` и процедуру из модуля.",
  )
  return lines.join("\n")
}

/**
 * What the agent is told, appended to the build's own result.
 *
 * Not a refusal: the build succeeded, and an unbound procedure can be
 * deliberate. But it has to arrive with the build rather than when a person
 * opens the form, because that is the whole failure -- nothing else ever says it.
 */
export function describeFormBindings(
  byForm: readonly { readonly form: string; readonly findings: readonly BindingFinding[] }[],
): string | null {
  const broken = byForm.filter((entry) => entry.findings.length > 0)
  if (!broken.length) return null
  const lines = [
    "",
    "⚠ Проверка привязки обработчиков (по Form.xml и Module.bsl):",
    "",
    "В конфигураторе обработчик привязывается сам, когда ты его создаёшь через интерфейс. В XML",
    "по имени не привязывается ничто: процедура без ссылки на неё — мёртвый код, который",
    "компилируется и не выполняется, поэтому ни сборка, ни `1c_check_epf` этого не видят.",
  ]
  for (const entry of broken) {
    lines.push("", `**${entry.form}**`)
    for (const finding of entry.findings) lines.push(`- ${finding.procedure}: ${finding.detail}`)
  }
  return lines.join("\n")
}
