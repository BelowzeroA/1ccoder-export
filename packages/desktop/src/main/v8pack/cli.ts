// v8pack as a command line tool, for the agent to invoke.
//
// Bundled to a standalone .mjs at build time (scripts/build-v8pack-cli.ts) and
// copied onto disk beside the generated skills, so it can be run without
// assuming Node is installed on the user's machine: the skills invoke it
// through Electron's own binary with ELECTRON_RUN_AS_NODE=1.
//
// Deliberately dependency-free -- node:zlib, node:fs and node:crypto only --
// so bundling it is a copy rather than a build with a tree of packages behind
// it.

import { readFile } from "node:fs/promises"

import { readContainerRaw, extractModuleText } from "./container"
import { listEditable, packContainer, unpackContainer } from "./tree"

const USAGE = `v8pack — 1C:Enterprise container tool (1CCoder)

  unpack <container> <dir>   Unpack .epf/.erf/.cfe into an editable directory
  pack   <dir> <container>   Rebuild a container from an unpacked directory
  list   <dir>               List the editable files in an unpacked directory
  info   <container>         Show what a container holds, without unpacking

Edit the .bsl files under <dir>/modules, then pack. Entries you did not touch
are copied through byte for byte; only what changed is rebuilt.
`

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv

  switch (command) {
    case "unpack": {
      if (args.length < 2) return usage()
      const manifest = await unpackContainer(args[0]!, args[1]!)
      const objectModules = manifest.entries.filter((entry) => entry.kind === "module").length
      const formModules = manifest.entries.filter((entry) => entry.kind === "form").length
      // Counted apart because "0 modules" on a processing whose work is all on
      // its form used to read as a broken tool, and sent the agent looking for
      // the code by hand.
      const counted = [
        `${objectModules} object module(s)`,
        ...(formModules > 0 ? [`${formModules} form module(s)`] : []),
      ].join(", ")
      console.log(`Unpacked ${manifest.entries.length} entries (${counted}) into ${args[1]}`)
      console.log(`Edit files under ${args[1]}/modules, then: pack ${args[1]} <output>`)
      return 0
    }

    case "pack": {
      if (args.length < 2) return usage()
      const result = await packContainer(args[0]!, args[1]!)
      console.log(`Wrote ${args[1]} (${result.bytes} bytes)`)
      console.log(
        result.rebuilt.length === 0
          ? "Nothing changed: the container is byte-identical to the original."
          : `Rebuilt ${result.rebuilt.length} entr${result.rebuilt.length === 1 ? "y" : "ies"}: ${result.rebuilt.join(", ")}`,
      )
      for (const form of result.unbound) {
        console.log(
          `WARNING: ${form.entry}: ${form.handlers.join(", ")} — в модуле есть, но форма это событие не подключает. ` +
            "Платформа такой обработчик не вызовет: v8pack меняет только текст модуля. " +
            "Подключить событие можно XML-кругом (1c_dump_epf_to_files → 1c_load_epf_from_files, " +
            "подключение делается при сборке) или взяв заготовку, где оно уже подключено.",
        )
      }
      return 0
    }

    case "list": {
      if (args.length < 1) return usage()
      for (const file of await listEditable(args[0]!)) console.log(file)
      return 0
    }

    case "info": {
      if (args.length < 1) return usage()
      const raw = readContainerRaw(await readFile(args[0]!))
      console.log(`page size ${raw.pageSize}, ${raw.entries.length} entries`)
      for (const entry of raw.entries) {
        const module = extractModuleText(entry.content) !== null
        console.log(
          `  ${entry.name}  ${entry.content.length} B${entry.deflate ? " (deflated)" : ""}${module ? "  [module]" : ""}`,
        )
      }
      return 0
    }

    default:
      return usage()
  }
}

function usage(): number {
  console.log(USAGE)
  return 1
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
