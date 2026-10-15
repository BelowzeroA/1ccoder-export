// What an object of the configuration consists of, read from its dump.
//
// 2026-09-29, debrief15.md §15.24 item 34. Run 4 needed the attributes of
// Документ.ПриемНаРаботу before the toolkit was up, so `get_metadata` was not
// there, and nine calls went on parsing the object's XML in PowerShell: the
// namespaces returned nothing, a Substring threw, and so on. The dump's layout
// is fixed and tab-indented by the platform, so it is read here once.

import { join } from "node:path"

/** Russian and English names of a metadata kind → the dump's directory. */
const KINDS: Record<string, string> = {
  справочник: "Catalogs",
  catalog: "Catalogs",
  документ: "Documents",
  document: "Documents",
  журналдокументов: "DocumentJournals",
  documentjournal: "DocumentJournals",
  перечисление: "Enums",
  enum: "Enums",
  обработка: "DataProcessors",
  dataprocessor: "DataProcessors",
  отчет: "Reports",
  report: "Reports",
  регистрсведений: "InformationRegisters",
  informationregister: "InformationRegisters",
  регистрнакопления: "AccumulationRegisters",
  accumulationregister: "AccumulationRegisters",
  регистррасчета: "CalculationRegisters",
  calculationregister: "CalculationRegisters",
  регистрбухгалтерии: "AccountingRegisters",
  accountingregister: "AccountingRegisters",
  планвидовхарактеристик: "ChartsOfCharacteristicTypes",
  chartofcharacteristictypes: "ChartsOfCharacteristicTypes",
  планвидоврасчета: "ChartsOfCalculationTypes",
  chartofcalculationtypes: "ChartsOfCalculationTypes",
  плансчетов: "ChartsOfAccounts",
  chartofaccounts: "ChartsOfAccounts",
  планобмена: "ExchangePlans",
  exchangeplan: "ExchangePlans",
  бизнеспроцесс: "BusinessProcesses",
  businessprocess: "BusinessProcesses",
  задача: "Tasks",
  task: "Tasks",
  константа: "Constants",
  constant: "Constants",
}

export interface DumpReader {
  readonly readText: (path: string) => string | null
  readonly list: (dir: string) => readonly string[] | null
}

/** «Документ.ПриемНаРаботу» (or Документы., Document.) → its kind directory and name. */
function parseName(object: string): { dir: string; name: string } | null {
  const match = /^\s*([^.\s]+)\s*\.\s*([^.\s]+)\s*$/.exec(object)
  if (!match) return null
  const kind = match[1]!.toLowerCase().replace(/ы$|и$/, "")
  const dir = KINDS[kind] ?? KINDS[match[1]!.toLowerCase()] ?? KINDS[`${kind}а`]
  return dir ? { dir, name: match[2]! } : null
}

const synonymOf = (block: string) =>
  /<Synonym>[\s\S]*?<v8:lang>ru<\/v8:lang>\s*<v8:content>([^<]*)<\/v8:content>/.exec(block)?.[1] ?? ""

/** A property's type as it reads in code: `CatalogRef.Организации`, `Строка(100)`, `Число(15,2)`. */
function typeOf(block: string): string {
  const type = /<Type>([\s\S]*?)<\/Type>/.exec(block)?.[1] ?? ""
  const names = [...type.matchAll(/<v8:(?:Type|TypeSet)>([^<]+)<\/v8:(?:Type|TypeSet)>/g)].map((match) => {
    const name = match[1]!.replace(/^(?:cfg|xs|v8):/, "")
    if (name === "string") {
      const length = /<v8:Length>(\d+)</.exec(type)?.[1] ?? "0"
      return length === "0" ? "Строка(неогр.)" : `Строка(${length})`
    }
    if (name === "decimal") {
      return `Число(${/<v8:Digits>(\d+)</.exec(type)?.[1] ?? "?"},${/<v8:FractionDigits>(\d+)</.exec(type)?.[1] ?? "0"})`
    }
    if (name === "dateTime") {
      const parts = /<v8:DateFractions>(\w+)</.exec(type)?.[1] ?? "DateTime"
      return parts === "Date" ? "Дата" : parts === "Time" ? "Время" : "Дата и время"
    }
    if (name === "boolean") return "Булево"
    return name
  })
  return names.join(" | ") || "—"
}

/** Blocks of one element kind at one depth: `\t\t\t<Attribute uuid=…>` … `\t\t\t</Attribute>`. */
function blocks(xml: string, tag: string, depth: number): string[] {
  const tabs = "\t".repeat(depth)
  return [...xml.matchAll(new RegExp(`^${tabs}<${tag} uuid="[^"]*">([\\s\\S]*?)^${tabs}</${tag}>`, "gm"))].map((match) => match[1]!)
}

const nameOf = (block: string) => /<Name>([^<]+)<\/Name>/.exec(block)?.[1] ?? "?"

function field(block: string): string {
  const synonym = synonymOf(block)
  return `- ${nameOf(block)}${synonym && synonym !== nameOf(block) ? ` «${synonym}»` : ""}: ${typeOf(block)}`
}

export function describeDumpObject(root: string, object: string, reader: DumpReader): string {
  const parsed = parseName(object)
  if (!parsed) {
    return `Не понял имя «${object}». Нужно «Вид.Имя»: Документ.ПриемНаРаботу, Справочник.Сотрудники, РегистрСведений.…`
  }
  const file = join(root, parsed.dir, `${parsed.name}.xml`)
  const text = reader.readText(file)
  if (text === null) {
    const names = (reader.list(join(root, parsed.dir)) ?? []).filter((item) => item.endsWith(".xml")).map((item) => item.slice(0, -4))
    const near = names.filter((item) => item.toLowerCase().includes(parsed.name.toLowerCase().slice(0, 6))).slice(0, 15)
    return `В выгрузке ${root} нет ${parsed.dir}\\${parsed.name}.xml.${near.length ? ` Похожие: ${near.join(", ")}.` : ""}`
  }
  // CRLF, as the platform writes, needs no normalising: every pattern is anchored per line.
  const xml = text.replace(/^\uFEFF/, "")
  const properties = /^\t\t<Properties>([\s\S]*?)^\t\t<\/Properties>/m.exec(xml)?.[1] ?? ""
  const children = /^\t\t<ChildObjects>([\s\S]*?)^\t\t<\/ChildObjects>/m.exec(xml)?.[1] ?? ""
  const list = (tag: string) => [...children.matchAll(new RegExp(`^\\t{3}<${tag}>([^<]+)</${tag}>`, "gm"))].map((match) => match[1]!)

  const section = (title: string, lines: readonly string[]) => (lines.length ? [`${title} (${lines.length}):`, ...lines] : [])
  const tabular = blocks(children, "TabularSection", 3).map((block) => {
    const own = /^\t{4}<Properties>([\s\S]*?)^\t{4}<\/Properties>/m.exec(block)?.[1] ?? block
    const columns = blocks(block, "Attribute", 5).map((column) => `  ${field(column)}`)
    const synonym = synonymOf(own)
    return [`- ${nameOf(own)}${synonym ? ` «${synonym}»` : ""}:`, ...columns].join("\n")
  })
  const commands = blocks(children, "Command", 3).map(nameOf)
  const enumValues = blocks(children, "EnumValue", 3).map((block) => {
    const synonym = synonymOf(block)
    return `- ${nameOf(block)}${synonym ? ` «${synonym}»` : ""}`
  })
  const modules = ["ObjectModule.bsl", "ManagerModule.bsl", "RecordSetModule.bsl", "ValueManagerModule.bsl"].flatMap((module) => {
    const path = join(root, parsed.dir, parsed.name, "Ext", module)
    const body = reader.readText(path)
    return body === null ? [] : [`${module} (${body.split("\n").length} стр.): ${path}`]
  })

  const synonym = synonymOf(properties)
  return [
    `${object.trim()}${synonym ? ` «${synonym}»` : ""} — ${file}`,
    ...section("Измерения", blocks(children, "Dimension", 3).map(field)),
    ...section("Ресурсы", blocks(children, "Resource", 3).map(field)),
    ...section("Реквизиты", blocks(children, "Attribute", 3).map(field)),
    ...section("Табличные части", tabular),
    ...section("Значения", enumValues),
    ...(list("Form").length ? [`Формы: ${list("Form").join(", ")}`] : []),
    ...(list("Template").length ? [`Макеты: ${list("Template").join(", ")}`] : []),
    ...(commands.length ? [`Команды: ${commands.join(", ")}`] : []),
    ...(modules.length ? ["Модули:", ...modules.map((module) => `- ${module}`)] : []),
    "Стандартные реквизиты (Ссылка, Номер, Дата, Проведен, Наименование, Код…) в выгрузке не перечислены — они есть всегда.",
  ].join("\n")
}
