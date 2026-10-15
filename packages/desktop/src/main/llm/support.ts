// Where a pilot asks for help -- more credits, above all. Shared by the relay's
// in-band refusal and the renderer's credits note, so the two cannot disagree.
// Set per build (ONECCODER_SUPPORT_CONTACT, see ../endpoints.ts).
export { SUPPORT_CONTACT } from "../endpoints"

/**
 * How the relay's refusal to keep retrying begins (relay.ts, TRANSIENT_FAILURE_LIMIT).
 * Auto-resume looks for it: resuming would undo the very stop it announces.
 */
export const RETRIES_STOPPED = "1CCoder остановил повторы"

/**
 * How the relay's message for a blocked account begins (relay.ts,
 * accountBlockedMessage). Auto-resume looks for it: only a person can lift a
 * block, and every resume would be one more refused request.
 */
export const ACCOUNT_BLOCKED = "Доступ к 1CCoder для этой учётной записи приостановлен"
