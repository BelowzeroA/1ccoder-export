// Asking a running toolkit which configuration its infobase runs.
//
// 2026-09-25, skills_rebuild_plan.md Part 2.2. One read-only `execute_code`
// call returns the configuration name and version, the БСП version when there
// is one, and the connection string -- the last so the answer is recorded only
// when the toolkit on the port is serving this profile's own infobase. A
// toolkit the user opened on another base answers just as readily, and its
// configuration recorded here would route the session to the wrong pack.

import { sameInfobase, type InfobaseConfiguration } from "../profiles/configuration"
import { callToolkitTool, findMarkedLine, type ToolkitCallOptions } from "./toolkit-client"

const MARKER = "1ccoder-configuration"

/**
 * Nothing here is on the toolkit's list of refused calls, and nothing writes.
 * `ВерсияБиблиотеки` is wrapped because a configuration without БСП has no
 * such module -- that is an answer ("no БСП"), not a failure.
 */
export const CONFIGURATION_CODE = [
  `Результат = "${MARKER}|" + Метаданные.Имя + "|" + Метаданные.Версия + "|";`,
  "Попытка",
  "\tРезультат = Результат + СтандартныеПодсистемыСервер.ВерсияБиблиотеки();",
  "Исключение",
  "КонецПопытки;",
  "Результат = Результат + \"|\" + СтрокаСоединенияИнформационнойБазы();",
].join("\n")

export interface ProbedConfiguration {
  readonly configuration: InfobaseConfiguration
  readonly connectionString: string
}

/** Extracts the answer from the toolkit's reply, however it wrapped the result. */
export function parseProbeReply(text: string, now: () => number = Date.now): ProbedConfiguration | null {
  const line = findMarkedLine(text, MARKER)
  if (!line) return null
  const [, name, version, bspVersion, ...rest] = line.split("|")
  if (!name) return null
  return {
    configuration: {
      name: name.trim(),
      version: (version ?? "").trim(),
      ...(bspVersion?.trim() ? { bspVersion: bspVersion.trim() } : {}),
      source: "toolkit",
      detectedAt: now(),
    },
    // The connection string itself contains no "|", but join defensively.
    connectionString: rest.join("|").trim(),
  }
}

export type ProbeOutcome =
  | { readonly ok: true; readonly configuration: InfobaseConfiguration }
  | { readonly ok: false; readonly reason: "other-infobase" | "unreadable" | "failed"; readonly detail?: string }

/** Asks the toolkit, and keeps the answer only if it is about this profile's infobase. */
export async function probeConfiguration(
  profile: { kind: "file" | "server"; filePath?: string; serverCluster?: string; serverDatabase?: string },
  options: ToolkitCallOptions & { now?: () => number } = {},
): Promise<ProbeOutcome> {
  let text: string
  try {
    text = await callToolkitTool("execute_code", { code: CONFIGURATION_CODE }, options)
  } catch (error) {
    return { ok: false, reason: "failed", detail: String(error) }
  }
  const probed = parseProbeReply(text, options.now)
  if (!probed) return { ok: false, reason: "unreadable", detail: text.slice(0, 300) }
  if (!sameInfobase(probed.connectionString, profile)) {
    return { ok: false, reason: "other-infobase", detail: probed.connectionString }
  }
  return { ok: true, configuration: probed.configuration }
}
