// The minimal XML tree of a new configuration extension, ready for
// /LoadConfigFromFiles -Extension.
//
// 2026-09-26, debrief14.md §14.3. Building an extension from scratch goes
// through XML: the platform builds the container, so hashes, versions and
// bindings are right by construction. Established on a scratch base:
//   - the load CREATES a missing extension; no seed .cfe is needed;
//   - Configuration.xml must carry InternalInfo, or the load fails with
//     «Отсутствует внутренняя информация (узел InternalInfo)»; the seven
//     ContainedObject class ids below, with fresh object ids, are accepted and
//     kept as given;
//   - the language is adopted from the base: its uuid differs per
//     configuration (БП and КА disagree), so it is read from the base's dump,
//     as are the format version and the compatibility modes;
//   - ConfigDumpInfo.xml is not needed on input.

import { randomUUID } from "node:crypto"

/** Class ids of the objects every extension's Configuration contains, taken from a real extension. */
const CONTAINED_CLASS_IDS = [
  "9cd510cd-abfc-11d4-9434-004095e12fc7",
  "9fcd25a0-4822-11d4-9414-008048da11f9",
  "e3687481-0a87-462c-a166-9f34594f9bba",
  "9de14907-ec23-4a07-96f0-85521cb6b53b",
  "51f2d5d8-ea4d-4064-8892-82951750031e",
  "e68182ea-4237-4383-967f-90c1e3370bc7",
  "fb282519-d103-4dd3-bc12-cb271d631dfc",
] as const

export type ExtensionPurpose = "Customization" | "AddOn" | "Patch"

/** What a new extension has to agree with its base on. */
export interface BaseFacts {
  readonly formatVersion: string
  readonly compatibilityMode: string
  readonly interfaceCompatibilityMode: string
  readonly scriptVariant: string
  readonly language: { readonly name: string; readonly uuid: string; readonly code: string }
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]

/**
 * The facts from a main-configuration dump, or a reason they could not be read.
 * An extension's dump is refused: its language is itself adopted.
 */
export function baseFactsFromDump(root: string, readText: (path: string) => string | null): BaseFacts | string {
  const dir = root.trim().replace(/[\\/]+$/, "")
  const configuration = readText(`${dir}/Configuration.xml`)
  if (!configuration) return `В ${dir} нет Configuration.xml — нужен корень выгрузки основной конфигурации.`
  if (configuration.includes("ConfigurationExtensionPurpose")) {
    return `${dir} — выгрузка расширения, а нужна выгрузка основной конфигурации.`
  }
  const formatVersion = /<MetaDataObject\b[^>]*\bversion="([^"]+)"/.exec(configuration)?.[1]
  const compatibilityMode = tag(configuration, "CompatibilityMode")
  const languageName = tag(configuration, "DefaultLanguage")?.replace(/^Language\./, "")
  if (!formatVersion || !compatibilityMode || !languageName) {
    return `В ${dir}/Configuration.xml не найдены версия формата, режим совместимости или основной язык.`
  }
  const language = readText(`${dir}/Languages/${languageName}.xml`)
  const languageUuid = language ? /<Language uuid="([^"]+)"/.exec(language)?.[1] : undefined
  if (!language || !languageUuid) return `Не прочитан язык ${languageName}: ${dir}/Languages/${languageName}.xml`
  return {
    formatVersion,
    compatibilityMode,
    interfaceCompatibilityMode: tag(configuration, "InterfaceCompatibilityMode") ?? "TaxiEnableVersion8_2",
    scriptVariant: tag(configuration, "ScriptVariant") ?? "Russian",
    language: { name: languageName, uuid: languageUuid, code: tag(language, "LanguageCode") ?? "ru" },
  }
}

/** A name the platform accepts for a metadata object: a letter or `_`, then letters, digits, `_`. */
export function isMetadataName(name: string): boolean {
  return /^[A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*$/.test(name)
}

const NAMESPACES =
  'xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" ' +
  'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" ' +
  'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" ' +
  'xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" ' +
  'xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" ' +
  'xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" ' +
  'xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" ' +
  'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Relative path → file content (UTF-8 with BOM, as the platform writes them). */
export function extensionSkeleton(
  base: BaseFacts,
  extension: { readonly name: string; readonly prefix: string; readonly synonym?: string; readonly purpose?: ExtensionPurpose },
  newId: () => string = randomUUID,
): Record<string, string> {
  const head = `﻿<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject ${NAMESPACES} version="${base.formatVersion}">`
  const contained = CONTAINED_CLASS_IDS.map(
    (classId) =>
      `\t\t\t<xr:ContainedObject>\n\t\t\t\t<xr:ClassId>${classId}</xr:ClassId>\n\t\t\t\t<xr:ObjectId>${newId()}</xr:ObjectId>\n\t\t\t</xr:ContainedObject>`,
  ).join("\n")
  const synonym = extension.synonym
    ? `<Synonym>\n\t\t\t\t<v8:item>\n\t\t\t\t\t<v8:lang>${base.language.code}</v8:lang>\n\t\t\t\t\t<v8:content>${escapeXml(extension.synonym)}</v8:content>\n\t\t\t\t</v8:item>\n\t\t\t</Synonym>`
    : "<Synonym/>"
  const configuration = [
    head,
    `\t<Configuration uuid="${newId()}">`,
    "\t\t<InternalInfo>",
    contained,
    "\t\t</InternalInfo>",
    "\t\t<Properties>",
    "\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>",
    `\t\t\t<Name>${extension.name}</Name>`,
    `\t\t\t${synonym}`,
    "\t\t\t<Comment/>",
    `\t\t\t<ConfigurationExtensionPurpose>${extension.purpose ?? "Customization"}</ConfigurationExtensionPurpose>`,
    "\t\t\t<KeepMappingToExtendedConfigurationObjectsByIDs>true</KeepMappingToExtendedConfigurationObjectsByIDs>",
    `\t\t\t<NamePrefix>${extension.prefix}</NamePrefix>`,
    `\t\t\t<ConfigurationExtensionCompatibilityMode>${base.compatibilityMode}</ConfigurationExtensionCompatibilityMode>`,
    "\t\t\t<DefaultRunMode>ManagedApplication</DefaultRunMode>",
    `\t\t\t<ScriptVariant>${base.scriptVariant}</ScriptVariant>`,
    `\t\t\t<DefaultLanguage>Language.${base.language.name}</DefaultLanguage>`,
    `\t\t\t<InterfaceCompatibilityMode>${base.interfaceCompatibilityMode}</InterfaceCompatibilityMode>`,
    "\t\t</Properties>",
    "\t\t<ChildObjects>",
    `\t\t\t<Language>${base.language.name}</Language>`,
    "\t\t</ChildObjects>",
    "\t</Configuration>",
    "</MetaDataObject>",
    "",
  ].join("\n")
  const language = [
    head,
    `\t<Language uuid="${newId()}">`,
    "\t\t<InternalInfo/>",
    "\t\t<Properties>",
    "\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>",
    `\t\t\t<Name>${base.language.name}</Name>`,
    "\t\t\t<Comment/>",
    `\t\t\t<ExtendedConfigurationObject>${base.language.uuid}</ExtendedConfigurationObject>`,
    `\t\t\t<LanguageCode>${base.language.code}</LanguageCode>`,
    "\t\t</Properties>",
    "\t</Language>",
    "</MetaDataObject>",
    "",
  ].join("\n")
  return { "Configuration.xml": configuration, [`Languages/${base.language.name}.xml`]: language }
}
