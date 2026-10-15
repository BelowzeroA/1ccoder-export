// Loads that "succeed" without loading everything.
//
// 2026-09-27, debrief14.md §14.5. Two ways a load from XML reports «успешно»
// while part of the source never reaches the base:
//
// 1. Announced. The configurator skips a part, prints why, and still exits 0:
//    «объект метаданных Command не был загружен поскольку не является
//    подчиненным для объекта Subsystem», «Неверное свойство объекта метаданных.
//    Свойство Placement не входит в состав объекта метаданных CommonCommand».
//    Three times in one session the tool answered «успешно… загружено».
// 2. Silent. A form element whose tag the platform doesn't know is dropped with
//    no message at all. `SpreadsheetDocumentField` for `SpreadSheetDocumentField`
//    cost a session about 50 minutes: the form loaded, the report ran, and the
//    result field simply wasn't there.
//
// The first is read from the output after the load. The second is checked
// before it, when the files are still the only place the mistake exists.

/** A line of configurator output that says something was left out. */
const DROPPED =
  /не был загружен|не загружен|Неверное свойство объекта метаданных|ошибка формата документа|Неизвестный объект/i

/** The configurator's messages about skipped parts, each once (it repeats them). */
export function droppedParts(output: string): string[] {
  const seen = new Set<string>()
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (line && DROPPED.test(line)) seen.add(line)
  }
  return [...seen]
}

export function partialLoadNote(dropped: readonly string[]): string {
  return [
    "Загрузка прошла ЧАСТИЧНО: конфигуратор вернул код 0, но пропустил то, что названо ниже, — в базе этого нет.",
    "«Успешно» здесь значит только, что конфигуратор не прервался.",
    ...dropped.map((line) => `- ${line}`),
    "Исправь файлы и загрузи снова.",
  ].join("\n")
}

/**
 * Every tag that occurs directly under `<ChildItems>` in the forms of three
 * standard configurations: БП 3.0.205.22 (8 492 forms), УТ 11.5.7.390 (3 786)
 * and КА 2.6.1.64 (10 834), scanned 2026-09-27. All three use the same set;
 * `SpreadSheetDocumentField` occurs 4 319 times, `SpreadsheetDocumentField`
 * never. Plus three platform elements none of them uses.
 */
export const FORM_ELEMENT_TAGS: ReadonlySet<string> = new Set([
  "Button",
  "ButtonGroup",
  "CalendarField",
  "ChartField",
  "CheckBoxField",
  "ColumnGroup",
  "CommandBar",
  "FormattedDocumentField",
  "GanttChartField",
  "GraphicalSchemaField",
  "HTMLDocumentField",
  "InputField",
  "LabelDecoration",
  "LabelField",
  "PDFDocumentField",
  "Page",
  "Pages",
  "PeriodField",
  "PictureDecoration",
  "PictureField",
  "PlannerField",
  "Popup",
  "ProgressBarField",
  "RadioButtonField",
  "SearchControlAddition",
  "SearchStringAddition",
  "SpreadSheetDocumentField",
  "Table",
  "TextDocumentField",
  "TrackBarField",
  "UsualGroup",
  // Not in the three dumps.
  "DendrogramField",
  "GeographicalSchemaField",
  "ViewStatusAddition",
])

export interface FormTagFinding {
  readonly tag: string
  /** The element's `name` attribute, when it has one. */
  readonly name?: string
  /** A known tag this one is almost certainly meant to be. */
  readonly suggestion?: string
}

/** Elements in a `Form.xml` whose tag is not a known form element. */
export function unknownFormTags(xml: string): FormTagFinding[] {
  const findings: FormTagFinding[] = []
  const stack: string[] = []
  // Comments, CDATA and declarations first, so a tag inside them isn't read as one.
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][\s\S]*?>|<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g
  for (const match of xml.matchAll(tokens)) {
    const [, closing, qualified, attributes = "", selfClosing] = match
    if (!qualified) continue
    const local = qualified.includes(":") ? qualified.slice(qualified.indexOf(":") + 1) : qualified
    if (closing) {
      stack.pop()
      continue
    }
    if (stack.at(-1) === "ChildItems" && !FORM_ELEMENT_TAGS.has(local)) {
      const name = /\bname="([^"]*)"/.exec(attributes)?.[1]
      const suggestion = nearestTag(local)
      findings.push({ tag: local, ...(name ? { name } : {}), ...(suggestion ? { suggestion } : {}) })
    }
    if (!selfClosing) stack.push(local)
  }
  return findings
}

/** The known tag an unknown one differs from only by case or a couple of letters. */
export function nearestTag(tag: string): string | undefined {
  const lower = tag.toLowerCase()
  let best: { tag: string; distance: number } | undefined
  for (const known of FORM_ELEMENT_TAGS) {
    if (known.toLowerCase() === lower) return known
    const distance = editDistance(lower, known.toLowerCase())
    if (distance <= 2 && (!best || distance < best.distance)) best = { tag: known, distance }
  }
  return best?.tag
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]
}

export interface FormFileFindings {
  /** Relative to the loaded source, for the message. */
  readonly file: string
  readonly findings: readonly FormTagFinding[]
}

function element(finding: FormTagFinding): string {
  return `<${finding.tag}${finding.name ? ` name="${finding.name}"` : ""}>`
}

/**
 * The refusal when a tag is a near miss of a known one, else null. The load
 * would "succeed" without that element, so nothing is gained by running it.
 */
export function formTagRefusal(files: readonly FormFileFindings[]): string | null {
  const misses = files.flatMap((file) =>
    file.findings.filter((finding) => finding.suggestion).map((finding) => ({ file: file.file, finding })),
  )
  if (misses.length === 0) return null
  return [
    "Загрузка не запущена: в формах есть элементы с тегом, которого платформа не знает. Такой элемент загрузчик",
    "молча пропускает — загрузка «успешна», а на форме его нет.",
    ...misses.map(({ file, finding }) => `- ${file}: ${element(finding)} — правильно ${finding.suggestion}`),
    "Исправь теги и повтори загрузку.",
  ].join("\n")
}

// Namespace prefixes. 2026-09-26, debrief14.md §14.5: a load failed with only
// «Исключение XDTO произошло при чтении файла- …Template.xml», and it took
// several loads, bisecting the file, to find the cause: a type value
// `cfg:EnumRef.…` in a schema whose root never declared `xmlns:cfg`. A prefix
// used in an element or attribute name, in `xsi:type`, or in the text of a
// `…Type` element must be declared somewhere in the file.

/** Prefixes a file uses and never declares. */
export function undeclaredPrefixes(xml: string): string[] {
  const declared = new Set(["xml", "xmlns", ...[...xml.matchAll(/\bxmlns:([\w.-]+)\s*=/g)].map((match) => match[1])])
  const used = new Set<string>()
  const add = (prefix: string | undefined) => {
    if (prefix && !declared.has(prefix)) used.add(prefix)
  }
  const body = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, "")
  for (const match of body.matchAll(/<\/?([\w.-]+):[\w.-]+/g)) add(match[1])
  for (const match of body.matchAll(/\s([\w.-]+):[\w.-]+\s*=\s*["']/g)) add(match[1])
  for (const match of body.matchAll(/\b(?:xsi:)?type\s*=\s*["']([\w.-]+):/g)) add(match[1])
  for (const match of body.matchAll(/<(?:[\w.-]+:)?\w*Type\b[^>]*>\s*([\w.-]+):[^<\s]/g)) add(match[1])
  return [...used]
}

export interface PrefixFindings {
  readonly file: string
  readonly prefixes: readonly string[]
}

/** Refused: the platform would fail to read the file and name only the file. */
export function prefixRefusal(files: readonly PrefixFindings[]): string | null {
  if (files.length === 0) return null
  return [
    "Загрузка не запущена: в файлах используются префиксы пространств имён, которые нигде в файле не",
    "объявлены. Платформа такой файл не прочитает и назовёт только его имя, без места:",
    ...files.map((file) => `- ${file.file}: ${file.prefixes.map((prefix) => `\`${prefix}:\``).join(", ")}`),
    "Объяви префикс (`xmlns:<префикс>=\"…\"`) в корне файла — с тем же адресом, что и в таком же файле",
    "выгрузки базы, — или используй уже объявленный.",
  ].join("\n")
}

// Command modules. 2026-09-27, debrief14.md §14.5: three commands loaded, showed
// in their section, and did nothing when clicked. Their modules declared
// `Процедура ОбработчикКоманды(…)`, and the platform calls only
// `ОбработкаКоманды`. Nothing reported it: the module compiled, the load
// succeeded, and a test that opened the form directly passed.
//
// Every command with a handler in БП 3.0.205.22, УТ 11.5.7.390 and КА 2.6.1.64
// (3 268 of 3 271) declares `&НаКлиенте Процедура ОбработкаКоманды` with two
// parameters. The other three modules are empty: obsolete commands.

/** The handler itself, or an extension's interception of it (`&Вместо("ОбработкаКоманды")`). */
const HANDLER = /(?:Процедура|Procedure)\s+(?:ОбработкаКоманды|CommandProcessing)\s*\(([^)]*)\)/i
const INTERCEPTED =
  /&(?:Перед|После|Вместо|ИзменениеИКонтроль|Before|After|Around|ChangeAndValidate)\s*\(\s*"(?:ОбработкаКоманды|CommandProcessing)"\s*\)/i
const ANY_METHOD = /^\s*(?:Процедура|Функция|Procedure|Function)\s/im

export type CommandModuleFinding =
  /** Code, but nothing the platform calls: the command does nothing. */
  | { readonly kind: "no-handler" }
  /** A handler that differs from every standard one. */
  | { readonly kind: "unusual"; readonly directive: string; readonly parameters: number }

/** What is wrong with a command module's text, or null. */
export function commandModuleFinding(bsl: string): CommandModuleFinding | null {
  const code = bsl.replace(/\/\/[^\r\n]*/g, "")
  if (!ANY_METHOD.test(code)) return null
  if (INTERCEPTED.test(code)) return null
  const handler = HANDLER.exec(code)
  if (!handler) return { kind: "no-handler" }
  const lines = code.slice(0, handler.index).trimEnd().split(/\r?\n/)
  const previous = lines.at(-1)?.trim() ?? ""
  const directive = previous.startsWith("&") ? previous : ""
  const parameters = (handler[1] ?? "").split(",").filter((parameter) => parameter.trim()).length
  const client = /^&(?:НаКлиенте|AtClient)$/i.test(directive)
  return client && parameters === 2 ? null : { kind: "unusual", directive, parameters }
}

export interface CommandModuleFindings {
  readonly file: string
  readonly finding: CommandModuleFinding
}

const STANDARD_HANDLER =
  "&НаКлиенте\nПроцедура ОбработкаКоманды(ПараметрКоманды, ПараметрыВыполненияКоманды)"

/** Refused: a command module with code but no handler would load and do nothing. */
export function commandModuleRefusal(files: readonly CommandModuleFindings[]): string | null {
  const missing = files.filter((file) => file.finding.kind === "no-handler")
  if (missing.length === 0) return null
  return [
    "Загрузка не запущена: в модулях команд нет обработчика, который вызывает платформа. Такая команда",
    "загрузится, появится в интерфейсе и ничего не будет делать при нажатии:",
    ...missing.map((file) => `- ${file.file}`),
    "Платформа вызывает только процедуру с этим именем:",
    STANDARD_HANDLER,
  ].join("\n")
}

/** A note after the load: a handler unlike every standard one may not be called as expected. */
export function commandModuleWarning(files: readonly CommandModuleFindings[]): string | null {
  const unusual = files.flatMap((file) =>
    file.finding.kind === "unusual" ? [{ file: file.file, finding: file.finding }] : [],
  )
  if (unusual.length === 0) return null
  return [
    "Внимание: обработчик команды объявлен не так, как во всех командах типовых конфигураций:",
    ...unusual.map(
      ({ file, finding }) =>
        `- ${file}: ${finding.directive || "без директивы"}, параметров ${finding.parameters}`,
    ),
    "Стандартное объявление:",
    STANDARD_HANDLER,
    "Проверь команду нажатием (через её навигационную ссылку), а не открытием формы.",
  ].join("\n")
}

/** A note for tags that are unknown but not a near miss: they may be real, so the load runs. */
export function formTagWarning(files: readonly FormFileFindings[]): string | null {
  const unknown = files.flatMap((file) =>
    file.findings.filter((finding) => !finding.suggestion).map((finding) => ({ file: file.file, finding })),
  )
  if (unknown.length === 0) return null
  return [
    "Внимание: в формах есть элементы, которых нет в формах типовых конфигураций. Если какого-то из них не",
    "окажется на форме в базе — платформа его не знает и пропустила без сообщения:",
    ...unknown.map(({ file, finding }) => `- ${file}: ${element(finding)}`),
  ].join("\n")
}
