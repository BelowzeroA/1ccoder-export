import { describe, expect, test } from "bun:test"

import { baseFactsFromDump, extensionSkeleton, isMetadataName } from "./extension-skeleton"

// debrief14.md §14.3.1. The shape below is the one verified on a scratch base:
// the generated tree loaded as a new extension, took an enumeration, was saved
// as .cfe and deleted again.

const ROOT = "C:/base"
const CONFIGURATION = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.21">',
  "<Configuration><Properties>",
  "<Name>Конфигурация</Name>",
  "<ScriptVariant>Russian</ScriptVariant>",
  "<DefaultLanguage>Language.Русский</DefaultLanguage>",
  "<InterfaceCompatibilityMode>TaxiEnableVersion8_2</InterfaceCompatibilityMode>",
  "<CompatibilityMode>Version8_3_27</CompatibilityMode>",
  "</Properties></Configuration></MetaDataObject>",
].join("\n")
const LANGUAGE =
  '<MetaDataObject><Language uuid="0663bf5b-bcba-4a40-a862-a0b3baa2d884"><Properties><Name>Русский</Name>' +
  "<LanguageCode>ru</LanguageCode></Properties></Language></MetaDataObject>"

const reader =
  (files: Record<string, string>) =>
  (path: string): string | null =>
    files[path] ?? null

describe("the base facts a new extension has to agree with", () => {
  test("are read from the main configuration's dump", () => {
    const facts = baseFactsFromDump(`${ROOT}/`, reader({ [`${ROOT}/Configuration.xml`]: CONFIGURATION, [`${ROOT}/Languages/Русский.xml`]: LANGUAGE }))
    expect(facts).toEqual({
      formatVersion: "2.21",
      compatibilityMode: "Version8_3_27",
      interfaceCompatibilityMode: "TaxiEnableVersion8_2",
      scriptVariant: "Russian",
      language: { name: "Русский", uuid: "0663bf5b-bcba-4a40-a862-a0b3baa2d884", code: "ru" },
    })
  })

  test("an extension's dump is refused: its language is adopted, not the base's", () => {
    const extension = CONFIGURATION.replace("<Properties>", "<Properties><ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose>")
    expect(baseFactsFromDump(ROOT, reader({ [`${ROOT}/Configuration.xml`]: extension }))).toContain("выгрузка расширения")
  })

  test("a missing dump or language is named, not guessed", () => {
    expect(baseFactsFromDump(ROOT, reader({}))).toContain("нет Configuration.xml")
    expect(baseFactsFromDump(ROOT, reader({ [`${ROOT}/Configuration.xml`]: CONFIGURATION }))).toContain("Languages/Русский.xml")
  })
})

describe("the skeleton", () => {
  const facts = {
    formatVersion: "2.21",
    compatibilityMode: "Version8_3_27",
    interfaceCompatibilityMode: "TaxiEnableVersion8_2",
    scriptVariant: "Russian",
    language: { name: "Русский", uuid: "0663bf5b-bcba-4a40-a862-a0b3baa2d884", code: "ru" },
  }
  let id = 0
  const files = extensionSkeleton(facts, { name: "ПланыПродаж", prefix: "пп_", synonym: "Планы <и> продажи" }, () => `id-${++id}`)
  const configuration = files["Configuration.xml"]!
  const language = files["Languages/Русский.xml"]!

  test("is exactly the two files the platform needs", () => {
    expect(Object.keys(files).toSorted()).toEqual(["Configuration.xml", "Languages/Русский.xml"])
  })

  test("carries InternalInfo -- without it the load fails", () => {
    expect(configuration.match(/<xr:ContainedObject>/g)).toHaveLength(7)
  })

  test("agrees with the base: format version, compatibility, adopted language", () => {
    expect(configuration).toContain('version="2.21"')
    expect(configuration).toContain("<ConfigurationExtensionCompatibilityMode>Version8_3_27</ConfigurationExtensionCompatibilityMode>")
    expect(configuration).toContain("<Language>Русский</Language>")
    expect(language).toContain("<ObjectBelonging>Adopted</ObjectBelonging>")
    expect(language).toContain("<ExtendedConfigurationObject>0663bf5b-bcba-4a40-a862-a0b3baa2d884</ExtendedConfigurationObject>")
  })

  test("names the extension and its prefix, and escapes the synonym", () => {
    expect(configuration).toContain("<Name>ПланыПродаж</Name>")
    expect(configuration).toContain("<NamePrefix>пп_</NamePrefix>")
    expect(configuration).toContain("<ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose>")
    expect(configuration).toContain("Планы &lt;и&gt; продажи")
  })

  test("starts with a BOM, as the platform's own files do", () => {
    expect(configuration.charCodeAt(0)).toBe(0xfeff)
  })
})

test("metadata names: a letter or underscore first, then letters, digits, underscores", () => {
  expect(isMetadataName("ПланыПродаж")).toBe(true)
  expect(isMetadataName("пп_")).toBe(true)
  expect(isMetadataName("1План")).toBe(false)
  expect(isMetadataName("План продаж")).toBe(false)
})
