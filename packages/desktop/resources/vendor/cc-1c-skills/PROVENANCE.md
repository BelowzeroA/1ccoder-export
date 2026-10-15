# Vendored from cc-1c-skills

Source: https://github.com/Nikolay-Shirokov/cc-1c-skills — MIT, see `LICENSE`.
Vendored 2026-09-21. Files are copied unmodified except for one substitution at
install time (below).

## What is here, and why only this much

The upstream project is ~80 skills covering the whole 1C development cycle. Only
the MXL group is taken, because only it covers something we cannot:

| | |
|---|---|
| `skills/mxl-info` | read a макет's areas, parameters and column sets without reading the XML |
| `skills/mxl-validate` | check indices, palette references and area bounds after an edit |
| `skills/mxl-decompile` | Template.xml → JSON DSL |
| `skills/mxl-compile` | JSON DSL → Template.xml |
| `reference/1c-spreadsheet-spec.md` | the MXL XML format, with corpus statistics from ~11 000 real макеты |
| `reference/mxl-dsl-spec.md` | the JSON DSL the two scripts speak |

Deliberately **not** taken:

- **`/db-*` (13 skills)** — they create infobases and drive `.cf`/`.dt` load
  through the configurator, entirely outside `needsExclusiveInfobase()`. That
  guard exists because a DESIGNER run against a base the MCP Toolkit held once
  truncated `RuntimeCacheStorage`. Installing them would hand the agent thirteen
  documented routes around our own interlock.
- **`/web-*`** — conflicts with how this app manages the Enterprise window.
- **`hooks/`** — Claude Code's hook format, which this fork cannot load.
  `support-guard.mjs` was worth having, so it is reimplemented in
  `src/main/infobase/support.ts` rather than copied.
- **The Python script variants** — this app targets Windows and ships no Python;
  only the `.ps1` files are vendored, so there is no second path to pick wrongly.

## The one modification

Upstream SKILL.md files invoke their scripts as
`powershell.exe -NoProfile -File "${CLAUDE_SKILL_DIR}/scripts/<name>.ps1"`.
Nothing defines `CLAUDE_SKILL_DIR` in this fork, so the installer
(`src/main/skills/index.ts`) rewrites it to the skill's real installed directory
while copying. Source files here keep the placeholder.

## Updating

Re-copy from upstream and re-run the tests: `installVendoredSkills` asserts that
no `CLAUDE_SKILL_DIR` survives installation, so a new file carrying the
placeholder fails loudly rather than producing a command that cannot run.

## Why the tooling is second, not first

Editing MXL XML by hand is expensive and usually avoidable: most layout problems
are a property on the cell or the row, and the object model sets those in one
call. The rules in `1ccoder-ib-print-forms` §5 come first for that reason, and
this toolkit is here for the residue and for reading — not as an invitation.
