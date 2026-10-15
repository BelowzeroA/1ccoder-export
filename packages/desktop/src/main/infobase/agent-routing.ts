// Which agent a turn runs as.
//
// 2026-09-27, debrief14.md §14.6. From 2026-09-23 18:48 UTC on, every session
// ran as opencode's default `build`, bound profile or not. The desktop switched
// the agent on the session record (use-session-profile.ts applyAgent), but the
// composer sends every prompt with its own current agent, and our agents are
// hidden from its list, so that was always `build`; opencode then wrote `build`
// back onto the session. The profile prompt and the configuration packs never
// reached the model, and nothing said so for four days.
//
// So the decision is made here, per message, where every prompt passes: the
// composer, auto-resume, any API client. The binding decides, as it does for
// the renderer (agents.ts agentForBinding).

import { agentForBinding, DEFAULT_AGENT, isProfileAgent, NOPROFILE_AGENT } from "../skills/agents"

/** What the relay's `profile` answer says about a session, as far as routing cares. */
export type BindingFacts =
  | { readonly ok: true; readonly configuration?: { readonly name?: string } }
  | { readonly ok: false; readonly reason?: string }

export type RoutingDecision =
  | { readonly kind: "keep" }
  | { readonly kind: "switch"; readonly from: string; readonly to: string }
  /** The binding calls for an agent the sidecar doesn't have. */
  | { readonly kind: "missing"; readonly from: string; readonly wanted: string }

/**
 * The agent a message should run as.
 *
 * Only a prompt that arrived on the default agent, or on one of our own, is
 * rerouted. Anything else (`plan`, a custom agent) is a choice somebody made on
 * purpose and stays. An unknown binding (the relay didn't answer, the profile
 * was deleted) changes nothing: no answer is not evidence.
 *
 * `registered` is the sidecar's agent list; undefined means it couldn't be read,
 * and then nothing is switched, since a turn on a missing agent fails outright.
 */
export function routeAgent(
  requested: string | undefined,
  binding: BindingFacts | undefined,
  registered: ReadonlySet<string> | undefined,
): RoutingDecision {
  const from = requested ?? DEFAULT_AGENT
  if (from !== DEFAULT_AGENT && from !== NOPROFILE_AGENT && !isProfileAgent(from)) return { kind: "keep" }
  if (!binding) return { kind: "keep" }

  let wanted: string
  if (binding.ok) wanted = agentForBinding("bound", binding.configuration?.name)
  else if (binding.reason === "no-profile") wanted = NOPROFILE_AGENT
  else return { kind: "keep" }

  if (wanted === from) return { kind: "keep" }
  if (!registered) return { kind: "keep" }
  if (!registered.has(wanted)) return { kind: "missing", from, wanted }
  return { kind: "switch", from, to: wanted }
}
