# MCP_Toolkit.epf — third-party component

`MCP_Toolkit.epf` in this directory is **1C MCP Toolkit**, by its authors at
<https://github.com/ROCTUP/1c-mcp-toolkit>. It is licensed under the
**GNU General Public License, version 3** — the full text is in `LICENSE` beside
this file. It is not covered by 1CCoder's own licence.

1CCoder does not link to or embed it: the application asks the 1C:Enterprise
platform to open it as an external data processor, as a separate program.

## Origin

| | |
|---|---|
| Upstream release | `v1.8.0` (2026-07-21), asset `MCP_Toolkit.epf` |
| Upstream md5 | `4112185fe7a26a75dcaf914b6a534fd7` |
| This file's md5 | `6fe2198cd20c92064e166fe86937124f` |

## Modification (GPL-3.0 §5a)

**This is a modified version**, changed by the 1CCoder project on 2026-09-20.
The change is the whole of `modifications.diff` beside this file: when the form is
created, two of its dangerous-operation flags now default to on —

- `АвтоРазрешитьЗаписать` (writes such as `Записать` run without a confirmation dialog);
- `АвтоРазрешитьПривилегированныйРежим` (`УстановитьПривилегированныйРежим` likewise).

Upstream leaves both off, so an unattended agent's every write is refused or stops on
a whole-interface modal. Nothing else differs.

## Source (GPL-3.0 §6)

An `.epf` carries its modules as BSL source text; `v8pack unpack` (shipped with
1CCoder as `v8pack-cli.mjs`) extracts them. The Corresponding Source of this build is
upstream's source at tag `v1.8.0` —
<https://github.com/ROCTUP/1c-mcp-toolkit/tree/v1.8.0> — with `modifications.diff`
applied. Both are also available on request from the 1CCoder project.
