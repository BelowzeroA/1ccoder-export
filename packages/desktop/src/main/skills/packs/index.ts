// Configuration packs: knowledge that is true for one configuration family only.
//
// 2026-09-25, skills_rebuild_plan.md Part 2 (Layer 3). The general skills and
// prompts must hold in every base they reach, so a БП catalog name has no
// place in them -- it is false in УТ. A pack is where such names live, and it
// reaches a session only when the session's profile runs that configuration:
// agents.ts gives each pack its own profile agent, and that agent alone may
// load the pack's skills. Routing is by the detected configuration name
// (profiles/configuration.ts), never by the agent's choice.
//
// Every statement in a pack must have been checked against a dump or a live
// base of that configuration, and `verifiedOn` names the releases that were.

import type { SkillContext, SkillFile } from "../content"
import { bp30 } from "./bp30"

export const PACK_SKILL_PREFIX = "1ccoder-cfg-"

export interface ConfigurationPack {
  /** Short and stable: it is part of agent and skill names. */
  readonly id: string
  /** How the agent is told which configuration this is. */
  readonly title: string
  /** `Метаданные.Имя` values this pack serves. */
  readonly configurations: readonly string[]
  /** Configuration releases the pack's statements were checked on. */
  readonly verifiedOn: readonly string[]
  /**
   * Names that exist in this configuration family only. The agent-text lint
   * forbids them everywhere outside this pack.
   */
  readonly identifiers: readonly string[]
  readonly skills: (context: SkillContext) => SkillFile[]
  /**
   * Configuration-specific lines a guard appends to its generic refusal, under
   * «Для этой конфигурации». Absent keys mean the generic text stands alone.
   */
  readonly hints: { readonly overwrite?: string; readonly bulk?: string }
}

export const PACKS: readonly ConfigurationPack[] = [bp30]

/** The pack for a configuration, by `Метаданные.Имя`; none for anything unknown. */
export function packFor(configurationName: string | undefined): ConfigurationPack | undefined {
  if (!configurationName) return undefined
  return PACKS.find((pack) => pack.configurations.includes(configurationName))
}

/** Skill names start with this, so one permission rule can allow or deny a pack. */
export function packSkillPrefix(pack: ConfigurationPack): string {
  return `${PACK_SKILL_PREFIX}${pack.id}-`
}

/** The hint text a guard appends, or "" when the pack has none. */
export function packHint(pack: ConfigurationPack | undefined, key: keyof ConfigurationPack["hints"]): string {
  const hint = pack?.hints[key]
  return hint ? `\n\nДля этой конфигурации (${pack!.title}):\n${hint}` : ""
}
