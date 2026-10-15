// Which configuration a profile's infobase runs.
//
// 2026-09-25, skills_rebuild_plan.md Part 2.2. Nothing recorded it, so every
// piece of configuration knowledge had to be written as if it held everywhere
// -- and БП catalog names ended up in text that УТ sessions read. Knowing the
// configuration is what lets a pack of configuration-specific skills reach only
// the sessions it is true for.
//
// Two sources, both deterministic. The toolkit, when it is up, answers in one
// read-only call (see mcp/configuration-probe.ts). A configuration dump answers
// from its files, which is also the only source available before the toolkit
// has ever run. Pure: no Electron, no filesystem of its own.

import { parseConnectionString } from "./v8i"

export type ConfigurationSource = "toolkit" | "dump"

export interface InfobaseConfiguration {
  /** Метаданные.Имя, e.g. "БухгалтерияПредприятия". */
  readonly name: string
  /** Метаданные.Версия, e.g. "3.0.205.22". */
  readonly version: string
  /** The БСП version, when the configuration has one. */
  readonly bspVersion?: string
  readonly source: ConfigurationSource
  readonly detectedAt: number
}

/** Name and version from a dump's root `Configuration.xml`. */
export function parseConfigurationXml(xml: string): { name: string; version: string } | null {
  // <InternalInfo> comes first and holds generated type names, not the
  // configuration's own; the name we want is the first one under <Properties>.
  const properties = xml.indexOf("<Properties>")
  if (properties < 0) return null
  const rest = xml.slice(properties)
  const name = /<Name>([^<]+)<\/Name>/.exec(rest)?.[1]?.trim()
  if (!name) return null
  const version = /<Version>([^<]*)<\/Version>/.exec(rest)?.[1]?.trim() ?? ""
  return { name, version }
}

/**
 * The БСП version from `CommonModules/ОбновлениеИнформационнойБазыБСП/Ext/Module.bsl`.
 *
 * `СтандартныеПодсистемыСервер.ВерсияБиблиотеки()` computes it at run time, so
 * the literal lives in the subsystem description instead:
 * `Описание.Имя = "СтандартныеПодсистемы"; Описание.Версия = "3.1.12.297";`.
 */
export function parseBspVersion(moduleText: string): string | undefined {
  const at = moduleText.search(/Описание\.Имя\s*=\s*"СтандартныеПодсистемы"/)
  if (at < 0) return undefined
  return /Описание\.Версия\s*=\s*"([^"]+)"/.exec(moduleText.slice(at, at + 400))?.[1]
}

export interface DumpReader {
  /** The file's text, or null when it does not exist. */
  readonly read: (path: string) => Promise<string | null>
}

/** The configuration a dump directory describes, or null when it is not a dump. */
export async function configurationFromDump(
  dumpDir: string,
  reader: DumpReader,
  now: () => number = Date.now,
): Promise<InfobaseConfiguration | null> {
  const root = dumpDir.replace(/[\\/]+$/, "")
  const xml = await reader.read(`${root}/Configuration.xml`)
  // An extension's dump has the same root file, marked by its purpose; it
  // describes the extension, not the base (debrief13.md §13.12).
  if (xml?.includes("ConfigurationExtensionPurpose")) return null
  const parsed = xml ? parseConfigurationXml(xml) : null
  if (!parsed) return null
  const bspModule = await reader.read(`${root}/CommonModules/ОбновлениеИнформационнойБазыБСП/Ext/Module.bsl`)
  const bspVersion = bspModule ? parseBspVersion(bspModule) : undefined
  return { ...parsed, ...(bspVersion ? { bspVersion } : {}), source: "dump", detectedAt: now() }
}

/** The one-line form `1c_profile_info` and the UI show. */
export function describeConfiguration(configuration: InfobaseConfiguration | undefined): string {
  if (!configuration) return "не определена — появится после запуска тулкита или выгрузки конфигурации"
  const bsp = configuration.bspVersion ? `, БСП ${configuration.bspVersion}` : ", без БСП"
  return `${configuration.name} ${configuration.version}${bsp}`
}

/**
 * Whether a connection string names the profile's own infobase.
 *
 * The toolkit on the port may be one the user opened on a different base, and
 * recording that base's configuration against this profile would route the
 * session to the wrong pack. `СтрокаСоединенияИнформационнойБазы()` answers in
 * 1C's own syntax -- `File="C:\Bases\Acc";` or `Srvr="host";Ref="db";` -- and
 * the comparison ignores case, quoting, slash direction and a trailing slash.
 */
export function sameInfobase(
  connectionString: string,
  profile: { kind: "file" | "server"; filePath?: string; serverCluster?: string; serverDatabase?: string },
): boolean {
  const fields = parseConnectionString(connectionString)
  if (profile.kind === "file") {
    const file = fields.get("file")
    return Boolean(file && profile.filePath && matchesMasked(normalisePath(file), normalisePath(profile.filePath)))
  }
  const server = fields.get("srvr")
  const ref = fields.get("ref")
  return Boolean(
    server &&
      ref &&
      matchesMasked(server.toLowerCase(), (profile.serverCluster ?? "").trim().toLowerCase()) &&
      matchesMasked(ref.toLowerCase(), (profile.serverDatabase ?? "").trim().toLowerCase()),
  )
}

// 2026-10-13, debrief18.md §18.1. The toolkit masks fragments of its replies
// that look like personal data, the connection string included: a base folder
// named after a sole trader came back as `D:\1C_DB\WORK\[ORG-00001]`, and every
// check refused the profile's own base as «другая информационная база». A token
// stands for any text inside one path segment; the rest must match exactly.
// Same token shape as infobase/toolkit-calls.ts MASK_TOKEN (lower-cased here).
const MASK_TOKEN = /\[[a-z]{2,}-\d{3,}\]/

function matchesMasked(reported: string, expected: string): boolean {
  if (!MASK_TOKEN.test(reported)) return reported === expected
  const pattern = reported
    .split(MASK_TOKEN)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^\\\\]+")
  return new RegExp(`^${pattern}$`).test(expected)
}

function normalisePath(path: string): string {
  return path.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
}
