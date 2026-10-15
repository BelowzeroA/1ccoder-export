import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

import {
  configurationFromDump,
  describeConfiguration,
  parseBspVersion,
  parseConfigurationXml,
  sameInfobase,
  type DumpReader,
} from "./configuration"
import { ProfileStore, type StoreDeps, type StoredProfile } from "./profile-store"

// 2026-09-25, skills_rebuild_plan.md Part 2.2.

const CONFIGURATION_XML = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
	<Configuration uuid="x">
		<InternalInfo>
			<xr:ContainedObject><xr:ClassId>1</xr:ClassId></xr:ContainedObject>
			<xr:GeneratedType name="Name" category="Object"/>
		</InternalInfo>
		<Properties>
			<Name>БухгалтерияПредприятия</Name>
			<Synonym/>
			<Vendor>Фирма "1С"</Vendor>
			<Version>3.0.205.22</Version>
		</Properties>
	</Configuration>
</MetaDataObject>`

const BSP_MODULE = `Процедура ПриДобавленииПодсистемы(Описание) Экспорт
	Описание.Имя    = "СтандартныеПодсистемы";
	Описание.Версия = "3.1.12.297";
КонецПроцедуры`

describe("reading a configuration dump", () => {
  test("takes the name from Properties, not from InternalInfo", () => {
    expect(parseConfigurationXml(CONFIGURATION_XML)).toEqual({ name: "БухгалтерияПредприятия", version: "3.0.205.22" })
  })

  test("is not fooled by something that is not a configuration", () => {
    expect(parseConfigurationXml("<MetaDataObject/>")).toBeNull()
  })

  test("finds the БСП version in the subsystem description", () => {
    expect(parseBspVersion(BSP_MODULE)).toBe("3.1.12.297")
    expect(parseBspVersion("Процедура А() КонецПроцедуры")).toBeUndefined()
  })

  test("assembles both, and says where it came from", async () => {
    const files: Record<string, string> = {
      "D:/dump/Configuration.xml": CONFIGURATION_XML,
      "D:/dump/CommonModules/ОбновлениеИнформационнойБазыБСП/Ext/Module.bsl": BSP_MODULE,
    }
    const reader: DumpReader = { read: async (path) => files[path] ?? null }
    expect(await configurationFromDump("D:/dump/", reader, () => 7)).toEqual({
      name: "БухгалтерияПредприятия",
      version: "3.0.205.22",
      bspVersion: "3.1.12.297",
      source: "dump",
      detectedAt: 7,
    })
  })

  // debrief13.md §13.12: an extension's dump was recorded as the base's
  // configuration, and the session lost its configuration pack.
  test("an extension's dump is not the base's configuration", async () => {
    const extension = CONFIGURATION_XML.replace(
      "<Properties>",
      "<Properties><ConfigurationExtensionPurpose>Patch</ConfigurationExtensionPurpose>",
    )
    expect(extension).toContain("ConfigurationExtensionPurpose")
    const reader: DumpReader = { read: async (path) => (path.endsWith("Configuration.xml") ? extension : null) }
    expect(await configurationFromDump("D:/ext", reader)).toBeNull()
  })

  test("a configuration without БСП is still a configuration", async () => {
    const reader: DumpReader = { read: async (path) => (path.endsWith("Configuration.xml") ? CONFIGURATION_XML : null) }
    const found = await configurationFromDump("D:/dump", reader)
    expect(found?.name).toBe("БухгалтерияПредприятия")
    expect(found?.bspVersion).toBeUndefined()
  })

  test("a directory that is not a dump is nothing", async () => {
    expect(await configurationFromDump("D:/empty", { read: async () => null })).toBeNull()
  })

  // The dumps skills_cleansing.md was verified against, when DUMP_BP30,
  // DUMP_UT11 and DUMP_KA2 point at them (e.g. in .env.test.local). Skipped
  // elsewhere rather than faked: the point is the real files.
  const REAL = [
    { dir: process.env.DUMP_BP30 ?? "", name: "БухгалтерияПредприятия", version: "3.0.205.22", bsp: "3.1.12.297" },
    { dir: process.env.DUMP_UT11 ?? "", name: "УправлениеТорговлей", version: "11.5.7.390", bsp: "3.1.5.366" },
    { dir: process.env.DUMP_KA2 ?? "", name: "КомплекснаяАвтоматизация", version: "2.6.1.64", bsp: "3.1.12.310" },
  ]
  for (const real of REAL) {
    test.skipIf(!real.dir || !existsSync(`${real.dir}/Configuration.xml`))(`reads the real ${real.name} dump`, async () => {
      const reader: DumpReader = { read: async (path) => (existsSync(path) ? readFileSync(path, "utf8") : null) }
      const found = await configurationFromDump(real.dir, reader)
      expect(found).toMatchObject({ name: real.name, version: real.version, bspVersion: real.bsp })
    })
  }
})

describe("the line the agent reads", () => {
  test("names configuration, version and БСП", () => {
    expect(
      describeConfiguration({ name: "УправлениеТорговлей", version: "11.5.7.390", bspVersion: "3.1.5.366", source: "toolkit", detectedAt: 1 }),
    ).toBe("УправлениеТорговлей 11.5.7.390, БСП 3.1.5.366")
  })

  test("says how it will become known when it is not", () => {
    expect(describeConfiguration(undefined)).toContain("не определена")
  })
})

// The toolkit on the port may belong to another base; only a match may be
// recorded against the profile.
describe("sameInfobase", () => {
  const file = { kind: "file" as const, filePath: "C:\\Bases\\Acc" }
  const server = { kind: "server" as const, serverCluster: "srv1c", serverDatabase: "acc_prod" }

  test("matches a file base however it is spelled", () => {
    expect(sameInfobase('File="C:\\Bases\\Acc";', file)).toBe(true)
    expect(sameInfobase('File="c:/bases/acc/";', file)).toBe(true)
  })

  test("rejects another file base", () => {
    expect(sameInfobase('File="C:\\Bases\\Trade";', file)).toBe(false)
  })

  test("matches a server base by cluster and database", () => {
    expect(sameInfobase('Srvr="SRV1C";Ref="ACC_PROD";', server)).toBe(true)
    expect(sameInfobase('Srvr="srv1c";Ref="acc_test";', server)).toBe(false)
  })

  // debrief18.md: the toolkit masks parts of its replies that look like personal
  // data, a base folder named after a person included.
  test("a masked fragment stands for one path segment's text, the rest must match", () => {
    const person = { kind: "file" as const, filePath: "D:\\1C_DB\\WORK\\ИП Иванова" }
    expect(sameInfobase('File="D:\\1C_DB\\WORK\\[ORG-00001]";', person)).toBe(true)
    expect(sameInfobase('File="D:\\1C_DB\\OTHER\\[ORG-00001]";', person)).toBe(false)
    // A token does not swallow a separator: it can't stand for a deeper path.
    expect(sameInfobase('File="D:\\[ORG-00001]";', person)).toBe(false)
    expect(sameInfobase('Srvr="srv1c";Ref="[ORG-00002]";', server)).toBe(true)
  })

  test("a file answer never matches a server profile, nor the reverse", () => {
    expect(sameInfobase('File="C:\\Bases\\Acc";', server)).toBe(false)
    expect(sameInfobase('Srvr="srv1c";Ref="acc_prod";', file)).toBe(false)
  })
})

describe("the profile store keeps what was detected", () => {
  function store(seed: StoredProfile[]) {
    let rows = seed
    const deps: StoreDeps = {
      read: () => rows.map((row) => ({ ...row })),
      write: (next) => {
        rows = next
      },
      secrets: { available: () => true, encrypt: (plain) => plain, decrypt: (cipher) => cipher },
      now: () => 5,
      newId: () => "new",
    }
    return new ProfileStore(deps)
  }
  const base: StoredProfile = {
    id: "p1",
    accountEmail: "a@b",
    name: "БП",
    platformPath: "C:\\1cv8.exe",
    kind: "file",
    filePath: "C:\\Bases\\Acc",
    workingDirectory: "C:\\Work",
    userName: "Админ",
    createdAt: 1,
    updatedAt: 1,
  }
  const configuration = { name: "БухгалтерияПредприятия", version: "3.0.205.22", source: "toolkit" as const, detectedAt: 3 }
  const draft = { id: "p1", name: "БП", platformPath: "C:\\1cv8.exe", kind: "file" as const, workingDirectory: "C:\\Work", userName: "Админ" }

  test("records it and hands it out with the profile", () => {
    const profiles = store([base])
    profiles.recordConfiguration("p1", configuration)
    expect(profiles.get("p1")?.configuration).toEqual(configuration)
  })

  test("keeps it across a rename", () => {
    const profiles = store([{ ...base, configuration }])
    profiles.save("a@b", { ...draft, name: "Бухгалтерия", filePath: "C:\\Bases\\Acc" })
    expect(profiles.get("p1")?.configuration).toEqual(configuration)
  })

  test("drops it when the profile points at another base", () => {
    const profiles = store([{ ...base, configuration }])
    profiles.save("a@b", { ...draft, filePath: "C:\\Bases\\Trade" })
    expect(profiles.get("p1")?.configuration).toBeUndefined()
  })
})
