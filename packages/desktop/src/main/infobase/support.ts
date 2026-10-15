// Whether a file in a configuration dump belongs to a vendor object on support.
//
// 2026-09-21, debrief6.md §9 C5. Rung 5 of the mechanism ladder -- editing the
// configuration -- takes the base off support, so typical updates stop
// installing by the normal route. Three sessions were told that in prose, in
// the print-forms skill and in the agent prompt, and prose is the wrong
// instrument: the ladder holds only while the agent chooses to honour it, and
// the moment a макет is hard to change the cheapest-looking move is to edit the
// dump. Now that `dump_config_to_files` exists (C2) that dump is one call away,
// so the guard has to be structural.
//
// The decoding is a port of support-guard.mjs / support-state.mjs from
// cc-1c-skills (Nikolay-Shirokov/cc-1c-skills, MIT), whose `hooks.json` format
// this fork cannot load. Behaviour kept; shape changed to fit our plugin, and
// filesystem access injected so it is testable without a 1.8 GB dump on disk.
//
// Never throws and never guesses: anything it cannot decode is allowed. A guard
// that blocks on its own bugs would be worse than no guard, because the way
// round it is to stop using the dump at all.

/** The filesystem questions the decoder needs. Injected to keep it pure. */
export interface SupportProbe {
  readonly isFile: (path: string) => boolean
  readonly isDirectory: (path: string) => boolean
  readonly readText: (path: string) => string | null
  readonly readBytes: (path: string) => Uint8Array | null
}

export type SupportCode = "capability-off" | "locked"

export interface SupportVerdict {
  readonly blocked: boolean
  readonly code?: SupportCode
  /** The configuration root, when one was found. */
  readonly configDir?: string
}

/** How far up the tree to look for a configuration root before giving up. */
const MAX_CLIMB = 12

// The root element of an autonomous .epf/.erf dump. Such an object is never part
// of a configuration on support even when its dump sits inside the config tree,
// so the climb stops here rather than attributing it to the enclosing config.
const EXTERNAL_ROOT = /<MetaDataObject\b[^>]*>\s*<(?:\w+:)?(?:ExternalDataProcessor|ExternalReport)\b/

const UUID = /\buuid="([0-9a-fA-F-]{36})"/

function parentOf(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return at <= 0 ? path : path.slice(0, at)
}

function join(dir: string, ...parts: string[]): string {
  return [dir, ...parts].join("\\")
}

function isExternalObjectRoot(path: string, probe: SupportProbe): boolean {
  if (!probe.isFile(path)) return false
  const head = probe.readText(path)
  return head !== null && EXTERNAL_ROOT.test(head.slice(0, 1000))
}

/**
 * The uuid of an object's root element.
 *
 * The first `uuid="..."` in the file is it: the `<MetaDataObject>` wrapper
 * carries none, so the first match belongs to the object itself.
 */
function rootUuid(path: string, probe: SupportProbe): string | null {
  if (!probe.isFile(path)) return null
  const text = probe.readText(path)
  if (text === null) return null
  return UUID.exec(text)?.[1] ?? null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Decides whether editing `target` would break the base's support.
 *
 * Walks up from the target collecting two things: the uuid of the metadata
 * object it belongs to, and the configuration root that owns it (the directory
 * holding `Ext/ParentConfigurations.bin` or `Configuration.xml`). The .bin then
 * says, per object, whether the vendor left it editable.
 */
export function decideSupport(target: string, probe: SupportProbe): SupportVerdict {
  try {
    // An autonomous external object carries no support state of its own.
    if (isExternalObjectRoot(target, probe)) return { blocked: false }

    let elementUuid = rootUuid(target, probe)
    let configDir: string | undefined
    let binPath: string | undefined

    let dir = probe.isDirectory(target) ? target : parentOf(target)
    for (let step = 0; step < MAX_CLIMB && dir; step++) {
      // Crossed out of an .epf/.erf dump: not part of any configuration.
      if (isExternalObjectRoot(`${dir}.xml`, probe)) return { blocked: false }
      // A sub-element (a form, a template) inherits the support state of the
      // object above it, whose uuid lives in `<ObjectDir>.xml`.
      if (!elementUuid) elementUuid = rootUuid(`${dir}.xml`, probe)
      if (!configDir) {
        const candidate = join(dir, "Ext", "ParentConfigurations.bin")
        if (probe.isFile(candidate) || probe.isFile(join(dir, "Configuration.xml"))) {
          configDir = dir
          binPath = candidate
        }
      }
      if (elementUuid && configDir) break
      const up = parentOf(dir)
      if (up === dir) break
      dir = up
    }

    if (!configDir) return { blocked: false }
    // A file with no uuid of its own -- a new object, or a loose file in the
    // dump -- is judged by the configuration's own record.
    if (!elementUuid) elementUuid = rootUuid(join(configDir, "Configuration.xml"), probe)
    if (!binPath || !probe.isFile(binPath)) return { blocked: false }

    const bytes = probe.readBytes(binPath)
    if (!bytes || bytes.length <= 32) return { blocked: false }
    const body =
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
    const text = new TextDecoder("utf-8").decode(body)

    // Header: `{6,<capability>,<count>,` -- capability 1 means the vendor
    // switched off modification for the whole configuration, count 0 means the
    // base carries no support records at all.
    const header = /^\{6,(\d+),(\d+),/.exec(text)
    if (!header) return { blocked: false }
    const capability = Number.parseInt(header[1]!, 10)
    const records = Number.parseInt(header[2]!, 10)
    if (records === 0) return { blocked: false }

    if (capability === 1) return { blocked: true, code: "capability-off", configDir }

    if (!elementUuid) return { blocked: false }
    // Per-object rule: `<state>,0,<uuid>`, state 0 meaning "on the vendor's
    // lock". The same uuid can appear more than once; the strictest wins.
    const rule = new RegExp(`([0-2]),0,${escapeRegExp(elementUuid.toLowerCase())}`, "g")
    let strictest: number | null = null
    for (let m = rule.exec(text); m !== null; m = rule.exec(text)) {
      const state = Number.parseInt(m[1]!, 10)
      if (strictest === null || state < strictest) strictest = state
    }
    if (strictest === 0) return { blocked: true, code: "locked", configDir }
    return { blocked: false }
  } catch {
    // Any decode failure allows the edit -- see the file header.
    return { blocked: false }
  }
}

/**
 * What the agent is told when an edit is refused.
 *
 * Names the mechanism and the alternative, not just the refusal: the failure
 * this guard exists to stop was never "the agent did not know editing the
 * configuration was heavy", it was that the heavy option was the nearest one to
 * hand. A refusal that does not point somewhere lighter gets worked around.
 */
export function supportRefusal(verdict: SupportVerdict, target: string): string {
  const where = verdict.configDir ? ` (конфигурация: ${verdict.configDir})` : ""
  const cause =
    verdict.code === "capability-off"
      ? "у конфигурации выключена возможность изменения — она целиком на поддержке поставщика"
      : "объект на замке поставщика"
  return [
    `Правка отклонена: ${cause}${where}.`,
    `Файл: ${target}`,
    "",
    "Менять его напрямую — это снять базу с поддержки: типовые обновления перестанут",
    "ставиться штатно, и вернуть это обратно дорого. Почти всегда задача решается легче:",
    "данными в справочниках, пользовательским макетом печати",
    "(`РегистрСведений.ПользовательскиеМакетыПечати`) или расширением — см. навык",
    "1ccoder-ib-print-forms, «Лестница механизмов».",
    "",
    "Если правка конфигурации действительно нужна — это решение пользователя, а не твоё:",
    "назови цену вслух и спроси.",
  ].join("\n")
}
