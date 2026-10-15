// Is there already a configuration dump in this directory?
//
// 2026-09-25, failures_to_tools.md G3 (debrief7.md §6.2, D8). A dump is minutes
// of configurator time and gigabytes of disk. When the tool reported a failure
// for a dump that had in fact completed, the agent produced it again, into the
// directory that already held it, without looking -- it checked the existence
// of a small file ninety seconds earlier and not of the 6.8 GB tree. The rule
// "check before you produce" was prose; this makes the tool do the looking, so
// a second dump happens only when it is asked for by name (`refresh`), and then
// incrementally.

import { parseConfigurationXml } from "../profiles/configuration"

/** Filesystem questions, injected so this stays testable without a real dump. */
export interface DumpProbe {
  readonly readText: (path: string) => string | null
  readonly isFile: (path: string) => boolean
  readonly mtimeMs: (path: string) => number | null
  /** Names directly inside a directory, or null when it cannot be listed. */
  readonly list: (path: string) => readonly string[] | null
}

export interface ExistingDump {
  readonly root: string
  readonly name?: string
  readonly version?: string
  /** When ConfigDumpInfo.xml was last written -- i.e. when the dump finished. */
  readonly dumpedAt?: number
  /** Metadata objects per top-level kind, e.g. Catalogs → 412. */
  readonly counts: Readonly<Record<string, number>>
}

/**
 * The dump in `dir`, or null when there is none.
 *
 * Both files are required: `Configuration.xml` is written first, so a
 * directory holding it without `ConfigDumpInfo.xml` is an interrupted dump, and
 * reusing that would hand the agent a partial tree as if it were whole.
 */
export function existingDump(dir: string, probe: DumpProbe): ExistingDump | null {
  const root = dir.trim().replace(/[\\/]+$/, "")
  if (!probe.isFile(`${root}/Configuration.xml`) || !probe.isFile(`${root}/ConfigDumpInfo.xml`)) return null
  const xml = probe.readText(`${root}/Configuration.xml`)
  const parsed = xml ? parseConfigurationXml(xml) : null
  const counts = Object.fromEntries(
    (probe.list(root) ?? [])
      .filter((entry) => !entry.includes("."))
      .map((kind) => [kind, (probe.list(`${root}/${kind}`) ?? []).filter((name) => name.toLowerCase().endsWith(".xml")).length])
      .filter(([, count]) => (count as number) > 0),
  )
  const dumpedAt = probe.mtimeMs(`${root}/ConfigDumpInfo.xml`)
  return {
    root,
    ...(parsed ? { name: parsed.name, version: parsed.version } : {}),
    ...(dumpedAt !== null ? { dumpedAt } : {}),
    counts,
  }
}

// 2026-09-25, debrief13.md §13.7: the check above looks only in the target
// directory. The user's message named an existing dump beside the infobase; the
// agent asked for a new directory -- with `refresh: true` out of habit -- and
// started the whole configuration again. Users keep dumps next to the base or
// in the working directory, so those are looked at, one level deep.

/**
 * The newest complete dump of the main configuration directly inside any of
 * `parents`, or null. An extension's dump is never a match; neither is another
 * configuration's, when `configurationName` is known.
 */
export function dumpNearby(
  parents: readonly string[],
  probe: DumpProbe,
  configurationName?: string,
): ExistingDump | null {
  const found = parents
    .map((parent) => parent.trim().replace(/[\\/]+$/, ""))
    .filter((parent) => parent.length > 0)
    .flatMap((parent) => (probe.list(parent) ?? []).map((entry) => `${parent}/${entry}`))
    .filter((dir) => !(probe.readText(`${dir}/Configuration.xml`) ?? "").includes("ConfigurationExtensionPurpose"))
    .map((dir) => existingDump(dir, probe))
    .filter((dump): dump is ExistingDump => dump !== null)
    .filter((dump) => !configurationName || dump.name === configurationName)
  return found.sort((a, b) => (b.dumpedAt ?? 0) - (a.dumpedAt ?? 0))[0] ?? null
}

/** What the agent is told instead of a second dump. */
export function describeExistingDump(dump: ExistingDump, now: number = Date.now(), elsewhere = false): string {
  const age = dump.dumpedAt === undefined ? undefined : Math.max(0, Math.round((now - dump.dumpedAt) / 60_000))
  const ageText =
    age === undefined ? "время выгрузки неизвестно" : age < 90 ? `выгружена ${age} мин назад` : `выгружена ${Math.round(age / 60)} ч назад`
  const kinds = Object.entries(dump.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ")
  return [
    elsewhere
      ? `Выгрузка этой конфигурации уже есть — конфигуратор не запускался: ${dump.root}`
      : `Выгрузка в этом каталоге уже есть — конфигуратор не запускался: ${dump.root}`,
    "",
    `Конфигурация: ${dump.name ?? "?"} ${dump.version ?? ""}`.trimEnd() + ` (${ageText}).`,
    kinds ? `Объекты: ${kinds}.` : "Объектов в выгрузке не найдено.",
    "",
    ...(elsewhere
      ? [
          "Читай её там, где она лежит. Полная выгрузка основной конфигурации идёт десятки минут, а код",
          "расширений в неё не попадает вовсе — для него есть параметр `extension`. Если эта выгрузка",
          "устарела и нужна новая, повтори тот же вызов с `refresh: true`.",
        ]
      : [
          "Читай её. Если конфигурация с тех пор менялась и нужна свежая выгрузка, вызови этот инструмент",
          "ещё раз с `refresh: true` — будут перезаписаны только изменившиеся файлы.",
        ]),
  ].join("\n")
}
