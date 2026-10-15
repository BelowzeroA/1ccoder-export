// No write to the infobase without a decision by the user.
//
// 2026-09-23/24, debrief9.md §9.5 and failures_to_tools.md G6. Twice now, a loop
// has rewritten every invoice in the base -- 8 567 documents, on 09-21 and again
// on 09-23 -- and on neither occasion was anybody asked. The second time three
// other organisations' documents were given one organisation's heading and terms, because
// the query bounded nothing but the title. The prose rule «explain a write and
// wait» had been in PROFILE_PROMPT since 09-20 both times.
//
// The reason prose could not hold is structural, and `bulk.ts:25` recorded it:
// `1c_execute_code` is an MCP tool, so it never passes through `infobase_write`,
// and a `tool.execute.before` hook has no `ctx` and therefore cannot ask -- it
// can only throw. So the shape of the fix is forced:
//
//   1. The hook refuses a base write from `1c_execute_code` and names the tool
//      that can ask.
//   2. `1c_write_code` is a real plugin tool, so it HAS `ctx.ask`. It puts the
//      scale and the scope in front of the user and, on approval, records a
//      single-use approval for exactly that code.
//   3. The hook lets an approved snippet through, once.
//
// Execution stays where it already works. The plugin does not gain a second path
// to the base -- it gains the decision. That also means this needs nothing from
// the toolkit's HTTP surface, which matters: the toolkit is patched and frozen
// (user, 2026-09-22), and on 09-24 its REST shape could not even be probed.
//
// `bulk.ts` still decides whether a write looks unbounded. Its verdict is no
// longer only a refusal: it becomes a warning inside the ask, because the user
// overriding a guard on purpose is a legitimate outcome and being unable to is
// how guards get worked around.

/** BSL identifiers are Cyrillic as often as not, so `\w` is useless here. */
const IDENT = "[0-9A-Za-zА-Яа-яЁё_]"

/**
 * Calls that hand back a MUTABLE object from the base.
 *
 * This is the pivot of the whole detection. A bare search for `Записать(` is
 * unusable: the 09-23 session made six legitimate `Записать` calls that never
 * touched the base -- `Макет.Записать(путь, MXL)`, `ПечатнаяФорма.Записать(PDF)`,
 * `ТабличныйДокумент.Записать(...)` -- and a guard that fires on read-only work
 * is one the agent learns to route around. So instead: find the variables that
 * received a base object, and look for writes to THOSE.
 */
const PRODUCERS = [
  "ПолучитьОбъект",
  "GetObject",
  "СоздатьЭлемент",
  "CreateItem",
  "СоздатьГруппу",
  "CreateFolder",
  "СоздатьДокумент",
  "CreateDocument",
  "СоздатьМенеджерЗаписи",
  "CreateRecordManager",
  "СоздатьНаборЗаписей",
  "CreateRecordSet",
  "СоздатьУзел",
  "СоздатьЗадачу",
  "СоздатьБизнесПроцесс",
  "СоздатьСчет",
  "СоздатьВидРасчета",
] as const

/** Writes that need no intermediate variable to be a write. */
const DIRECT_WRITES = [
  // Ссылка.ПолучитьОбъект().Записать() in one breath.
  new RegExp(`(?:ПолучитьОбъект|GetObject)\\s*\\(\\s*\\)\\s*\\.\\s*(?:Записать|Write|Удалить|Delete)\\s*\\(`, "i"),
  // Константы.X.Установить(значение)
  new RegExp(`Константы\\s*\\.\\s*${IDENT}+\\s*\\.\\s*(?:Установить|Set)\\s*\\(`, "i"),
  // РегистрыСведений.X.Записать(...) at manager level.
  new RegExp(`Регистры[А-Яа-яЁё]*\\s*\\.\\s*${IDENT}+\\s*\\.\\s*Записать\\s*\\(`, "i"),
  // УдалитьОбъекты(Массив) and the like.
  new RegExp(`(?:^|[^0-9A-Za-zА-Яа-яЁё_.])УдалитьОбъекты\\s*\\(`, "i"),
  // 2026-09-25, observed live. A library procedure writes without ever handing
  // back an object, so producer tracking cannot see it:
  //
  //   УправлениеПечатью.ЗаписатьМакет("ОбщийМакет.ПФ_MXL_СчетЗаказ", ДвоичныеДанные);
  //
  // went through `1c_execute_code` unrefused, unasked and unjournalled -- all
  // three layers read the same predicate. The bitter part is that this is the
  // BETTER idiom: the skill sends the agent to the configuration's own API
  // instead of hand-rolling a record manager, and the guard was built around the
  // hand-rolled shape it no longer uses.
  //
  // A named `ЗаписатьX(` is a write; a bare `Записать(` is ambiguous (a
  // spreadsheet and a text document both have one) and stays with the producer
  // tracking above. The excluded suffixes are serialisation and file output,
  // which is why they must not be caught: `СериализаторXDTO.ЗаписатьXML`,
  // `ЗаписатьТекст`, `ЗаписатьФайл`.
  //
  // 2026-09-29, debrief16.md §16.1: `ЗаписьXML.ЗаписатьОбъявлениеXML()` in a
  // read-only composition probe was journalled as a write. The writer objects
  // (ЗаписьXML, ЗаписьJSON, ЗаписьFastInfoset, ЗаписьДанных) name their
  // methods `Записать<что>`, and every one of them writes to the writer.
  //
  // This is a heuristic and cannot be complete -- any library call may write
  // anything -- so it is a second net, not a proof.
  new RegExp(
    `\\.\\s*Записать(?!XML|JSON|HTML|Текст|Файл|ВФайл|Строку|ВСтроку|ОбъявлениеXML|Начало|Конец|Атрибут|Значение|` +
      `ИмяСвойства|Комментарий|БезОбработки|СоответствиеПространстваИмен|СекциюCDATA|СсылкуНаСущность|` +
      `ИнструкциюОбработки|ТипДокумента|Байт|Целое|Число|Символы|ДвоичныеДанные|БуферДвоичныхДанных)` +
      `[А-ЯЁA-Z][0-9A-Za-zА-Яа-яЁё_]*\\s*\\(`,
  ),
  // Settings storages: a save here is a change other users see.
  new RegExp(`Хранилище(?:Общих|Системных|Пользовательских)?Настроек\\w*\\s*\\.\\s*Сохранить\\s*\\(`, "i"),
] as const

export interface WriteVerdict {
  readonly writes: boolean
  /** The variables holding base objects that get written, for the message. */
  readonly receivers: readonly string[]
  /** The receivers are external processings: what they write is in their own module. */
  readonly external?: boolean
}

/**
 * Does this BSL write to the infobase?
 *
 * Deliberately conservative in one direction only: a missed write is a write
 * nobody was asked about, so the producer list errs towards catching. A false
 * positive costs one extra tool call through `1c_write_code`, which is the
 * intended route anyway.
 */
export function inspectBaseWrite(code: string): WriteVerdict {
  if (!code) return { writes: false, receivers: [] }

  if (DIRECT_WRITES.some((pattern) => pattern.test(code))) return { writes: true, receivers: [] }

  const external = externalCalls(code)
  if (external.length) return { writes: true, receivers: external, external: true }

  // `Объ = Выборка.Ссылка.ПолучитьОбъект();` -> "Объ"
  const assignment = new RegExp(
    `(${IDENT}+)\\s*=\\s*[^;\\r\\n]*?(?:${PRODUCERS.join("|")})\\s*\\(`,
    "gi",
  )
  const holders = [...code.matchAll(assignment)].map((match) => match[1]!).filter((name) => name.length > 0)
  if (!holders.length) return { writes: false, receivers: [] }

  const receivers = [...new Set(holders)].filter((name) =>
    new RegExp(`(?:^|[^0-9A-Za-zА-Яа-яЁё_.])${name}\\s*\\.\\s*(?:Записать|Write|Удалить|Delete)\\s*\\(`, "i").test(
      code,
    ),
  )
  return { writes: receivers.length > 0, receivers }
}

// 2026-10-13, debrief18.md §18.1. A loader built as an external processing was
// run through `ВнешниеОбработки.Подключить` → `Создать` → `Обработка.Загрузить(...)`
// and the gate said «записи в базу не видно»: the writes are in the processing's
// own module, which this code never shows. A method call on such an object is
// treated as a write, except the ones that only read its structure.
const EXTERNAL_CREATE = `(?:ВнешниеОбработки|ВнешниеОтчеты|ExternalDataProcessors|ExternalReports)\\s*\\.\\s*(?:Создать|Create)\\s*\\(`
const EXTERNAL_READS = /^(?:Метаданные|Metadata|ПолучитьФорму|GetForm|ПолучитьМакет|GetTemplate|СведенияОВнешнейОбработке)$/i

/** The variables holding a created external processing that get a method called, or "ВнешниеОбработки" for a chained call. */
function externalCalls(code: string): readonly string[] {
  const calledOn = (subject: string) =>
    [...code.matchAll(new RegExp(`${subject}\\s*\\.\\s*(${IDENT}+)\\s*\\(`, "gi"))].some((match) => !EXTERNAL_READS.test(match[1]!))
  const chained = calledOn(`${EXTERNAL_CREATE}[^;]*?\\)`)
  const holders = [...code.matchAll(new RegExp(`(${IDENT}+)\\s*=\\s*${EXTERNAL_CREATE}`, "gi"))].map((match) => match[1]!)
  const called = [...new Set(holders)].filter((name) => calledOn(`(?:^|[^0-9A-Za-zА-Яа-яЁё_.])${name}`))
  return chained ? [...called, "ВнешниеОбработки"] : called
}

// The managers' collection names, as written in code, and the object kind each holds.
const MANAGERS: readonly (readonly [string, string])[] = [
  ["Справочники", "Справочник"],
  ["Документы", "Документ"],
  ["РегистрыСведений", "РегистрСведений"],
  ["РегистрыНакопления", "РегистрНакопления"],
  ["РегистрыБухгалтерии", "РегистрБухгалтерии"],
  ["РегистрыРасчета", "РегистрРасчета"],
  ["Константы", "Константа"],
  ["ПланыВидовХарактеристик", "ПланВидовХарактеристик"],
  ["ПланыСчетов", "ПланСчетов"],
  ["ПланыВидовРасчета", "ПланВидовРасчета"],
  ["ПланыОбмена", "ПланОбмена"],
  ["БизнесПроцессы", "БизнесПроцесс"],
  ["Задачи", "Задача"],
]

/**
 * The configuration objects the code names, as `Справочник.<Имя>`.
 *
 * 2026-09-28, debrief15.md §15.18: with the profile's standing permission on,
 * no approval call carries the scope, and all 8 journal entries of a run read
 * «Объекты: не указано». What the code itself names is the next best thing:
 * not proof of what was written, but enough to know where to look.
 */
export function writeTargets(code: string): readonly string[] {
  const found = MANAGERS.flatMap(([collection, kind]) =>
    [...code.matchAll(new RegExp(`(?:^|[^0-9A-Za-zА-Яа-яЁё_.])${collection}\\s*\\.\\s*(${IDENT}+)`, "g"))].map(
      (match) => `${kind}.${match[1]}`,
    ),
  )
  return [...new Set(found)]
}

/**
 * Looking an existing element up by name or code.
 *
 * 2026-09-24. This is the second half of F9, and it has now happened three
 * times: 09-20 §4, 09-21 §6.8 and 09-23, twice in the same call --
 *
 *   Справочники.ЗаголовкиСчетовПокупателям.НайтиПоНаименованию("Счет-договор")
 *     -> Наименование = "СЧЁТ-ДОГОВОР"; Записать()
 *   Справочники.ДополнительныеУсловия.НайтиПоНаименованию("Счет-оферта")
 *     -> Наименование = "Условия поставки (оферта) …"; ТекстУсловий = <9 958 симв.>; Записать()
 *
 * -- with B3's «additive by default» loaded every time. Neither element belonged
 * to the task. For `ЗаголовкиСчетовПокупателям` the `Наименование` IS the text
 * that prints, so renaming one silently changes the output of every document
 * still pointing at it; the same holds for `ТекстУсловий`. The additive version
 * costs one extra line -- create an element, point the organisation's default at
 * it -- and leaves everything else exactly as it was.
 *
 * `СоздатьЭлемент` is deliberately NOT here: creating is the behaviour being
 * asked for, and it must stay frictionless or the guard teaches the wrong lesson.
 */
const LOOKUPS = [
  "НайтиПоНаименованию",
  "FindByDescription",
  "НайтиПоКоду",
  "FindByCode",
  "НайтиПоРеквизиту",
  "FindByAttribute",
] as const

export interface OverwriteVerdict {
  readonly overwrites: boolean
  /** The lookup arguments, so the refusal can name the element by name. */
  readonly elements: readonly string[]
}

/**
 * Is this code about to change an element it found by name, rather than add one?
 *
 * Scoped to catalog lookups on purpose. A mass update of documents found by
 * query is also a change to existing data, but there "create a new one instead"
 * is not an alternative, and a refusal has to be actionable to be obeyed --
 * volume and scope cover that case (`inspectBulkWrite`).
 */
export function inspectOverwrite(code: string): OverwriteVerdict {
  if (!code) return { overwrites: false, elements: [] }
  const lookup = `(?:${LOOKUPS.join("|")})`

  // Two shapes: the lookup and ПолучитьОбъект in one expression, or a reference
  // variable in between.
  const direct = new RegExp(`${lookup}\\s*\\([^;\\r\\n]*?\\)\\s*\\.\\s*(?:ПолучитьОбъект|GetObject)`, "i")

  const named = new RegExp(`(${IDENT}+)\\s*=\\s*[^;\\r\\n]*?${lookup}\\s*\\(\\s*"([^"]*)"`, "gi")
  const found = [...code.matchAll(named)].map((match) => ({ variable: match[1]!, element: match[2]! }))

  const writtenVia = found.filter((entry) => {
    // Реф -> Объ = Реф.ПолучитьОбъект() -> Объ.Записать()
    const holder = new RegExp(
      `(${IDENT}+)\\s*=\\s*[^;\\r\\n]*?(?:^|[^0-9A-Za-zА-Яа-яЁё_.])${entry.variable}\\s*\\.\\s*(?:ПолучитьОбъект|GetObject)`,
      "i",
    ).exec(code)
    if (!holder) return false
    return new RegExp(
      `(?:^|[^0-9A-Za-zА-Яа-яЁё_.])${holder[1]!}\\s*\\.\\s*(?:Записать|Write|Удалить|Delete)\\s*\\(`,
      "i",
    ).test(code)
  })

  const elements = [...new Set(writtenVia.map((entry) => entry.element))]
  if (elements.length) return { overwrites: true, elements }

  // The chained form carries no variable to follow, so the presence of a write
  // anywhere is the best available signal.
  if (direct.test(code) && inspectBaseWrite(code).writes) {
    const names = [...code.matchAll(new RegExp(`${lookup}\\s*\\(\\s*"([^"]*)"`, "gi"))].map((match) => match[1]!)
    return { overwrites: true, elements: [...new Set(names)] }
  }
  return { overwrites: false, elements: [] }
}

/**
 * Said instead of the plain write refusal when an existing element is at stake.
 *
 * It leads with the additive alternative rather than with the prohibition,
 * because the additive version is genuinely cheaper and the agent has three
 * times chosen the mutation while believing it was tidying up.
 */
export function overwriteRefusal(verdict: OverwriteVerdict): string {
  return [
    "Отклонено: код меняет существующий элемент справочника, найденный по имени.",
    `Элементы: ${verdict.elements.map((name) => `«${name}»`).join(", ")}.`,
    "",
    "Эти элементы создал не ты, и на них могут ссылаться уже существующие документы и настройки.",
    "Бывают справочники, у которых наименование или текст **печатаются** (заголовки, тексты",
    "условий и т. п.): переименовав такой элемент, ты меняешь вид всех документов, которые на него",
    "ссылаются, — и в отчёте об этом не будет ни слова, потому что ты этого не заметишь.",
    "",
    "**Сначала — добавить, а не править.** Обычный путь:",
    "",
    "1. `СоздатьЭлемент()` — новый элемент с нужным наименованием и текстом;",
    "2. переключить на него то, что ссылалось на старый: значение по умолчанию (например, у",
    "   организации), настройку — то, откуда его берут новые документы;",
    "3. старые элементы оставить как есть — они ничему не мешают.",
    "",
    "Так новые документы заполняются сами, а старые печатаются по-прежнему. Если пользователь не",
    "просил менять уже созданные документы — не меняй их.",
    "",
    "Если изменить именно этот элемент действительно нужно — так бывает, когда элемент заведён",
    "как заготовка под эту задачу, — вызови `1c_write_code` с `allow_overwrite: true` и назови в",
    "`summary`, что было в нём раньше. Пользователь должен увидеть, что меняется, а не что",
    "добавляется.",
  ].join("\n")
}

/**
 * The key an approval is filed under.
 *
 * Whitespace is normalised so that reformatting between the approval and the
 * run does not silently lose the grant, but nothing else is: a different write
 * is a different decision. Scoped by session, because a grant is a thing this
 * user said in this conversation.
 */
export function approvalKey(sessionId: string, code: string): string {
  return `${sessionId}\n${code.replace(/\s+/g, " ").trim()}`
}

/**
 * Approvals, held once each.
 *
 * Module-level and single-use on purpose. A grant that persisted would turn the
 * always-ask class into one of the classes it was deliberately separated from
 * (`plugin.ts:346`), and the failure being fixed is precisely a write that
 * happened without anybody deciding on it.
 */
const approvals = new Set<string>()

export function recordApproval(sessionId: string, code: string): void {
  approvals.add(approvalKey(sessionId, code))
}

/** Whether an approval for exactly this code is waiting to be used. Doesn't use it. */
export function hasApproval(sessionId: string, code: string): boolean {
  return approvals.has(approvalKey(sessionId, code))
}

/** True once, then the approval is gone. */
export function consumeApproval(sessionId: string, code: string): boolean {
  return approvals.delete(approvalKey(sessionId, code))
}

/**
 * Is there a grant for something very close to this code?
 *
 * Observed live on 2026-09-24: the approved snippet with a verification tail
 * appended. Distinguishing that from an unapproved write lets the refusal say
 * the useful thing instead of repeating the general lecture. Prefix-matching in
 * both directions, since the change may be an addition or a removal.
 */
export function hasNearMissApproval(sessionId: string, code: string): boolean {
  const key = approvalKey(sessionId, code)
  const prefix = `${sessionId}\n`
  return [...approvals].some((granted) => {
    if (!granted.startsWith(prefix)) return false
    const shorter = granted.length < key.length ? granted : key
    const longer = granted.length < key.length ? key : granted
    // Long enough that a shared opening is evidence of the same write, not of
    // two snippets that merely start with the same assignment.
    return shorter.length > prefix.length + 80 && longer.startsWith(shorter)
  })
}

/** Test seam: approvals outlive nothing, but a test must not inherit them. */
export function clearApprovals(): void {
  approvals.clear()
}

/**
 * What the agent is told when it tries to write through the wrong door.
 *
 * It names the exact next call, because a refusal the agent cannot act on gets
 * worked around -- and on 09-23, with the guards absent, "worked around" meant
 * writing its own MCP client and reaching the base by a path nothing watches.
 */
export function writeRefusal(verdict: WriteVerdict, bulkWarning?: string, nearMiss?: boolean): string {
  // 2026-09-24, observed live. The first approved write was refused on retry
  // because the agent had appended a verification section to the code, so the
  // text no longer matched the grant. It worked that out in one turn, but the
  // instinct to add a check is a good one and should not cost a turn: say what
  // happened, and say where the check belongs.
  if (nearMiss)
    return [
      "Отклонено: разрешение выдано на другой текст кода.",
      "",
      "Похоже, ты уже получил разрешение, но код с тех пор изменился — чаще всего к нему в конец",
      "дописана проверка. Разрешение действует ровно на тот текст, который видел пользователь.",
      "",
      "Повтори **ровно тот** код, что был в `1c_write_code`, а проверку сделай **отдельным**",
      "вызовом после записи: чтение разрешения не требует.",
    ].join("\n")
  return [
    "Отклонено: это запись в информационную базу, а `1c_execute_code` её не подтверждает.",
    ...(verdict.external
      ? [
          `Код вызывает метод внешней обработки (${verdict.receivers.join(", ")}): что она пишет, из этого кода не ` +
            "видно, поэтому вызов считается записью. Если метод только проверяет и ничего не пишет — скажи это в summary.",
        ]
      : verdict.receivers.length
        ? [`Объекты базы здесь: ${verdict.receivers.join(", ")}.`]
        : []),
    "",
    "Запись в рабочую базу — решение пользователя, а не твоё. Вызови `1c_write_code` с **тем же",
    "кодом** и скажи, что именно будет записано:",
    "",
    "    1c_write_code(",
    "      code: <тот же код>,",
    "      summary: \"что и зачем меняется\",",
    "      objects: \"Документ.<Имя>\",",
    "      count: <сколько объектов>,",
    "      organisations: \"<каких организаций это касается>\")",
    "",
    "`count` и `organisations` нужно **узнать до записи**, а не после: обычный запрос",
    "`КОЛИЧЕСТВО(*)` с группировкой по организации. Цикл записи легко захватывает больше, чем",
    "просили, — всю таблицу или документы организаций, которых задача не касается, — и масштаб,",
    "узнанный после записи, узнан слишком поздно.",
    ...(bulkWarning ? ["", bulkWarning] : []),
  ].join("\n")
}

export interface WriteRequest {
  readonly summary: string
  readonly objects: string
  readonly count: number
  readonly organisations: string
}

/**
 * The text the user decides on.
 *
 * Scale and scope first, because those are the two facts that were missing both
 * times. The user's answer on 09-20 to this very question was «Нет, только
 * новые» -- so the last line offers the alternative that answer implies.
 */
export function writeAskText(
  request: WriteRequest,
  bulkWarning?: string,
  overwrites?: readonly string[],
): string {
  return [
    request.summary.trim(),
    "",
    // Named first and in these words because "изменяется" and "добавляется" are
    // the distinction the user cares about and the one that got lost three times.
    ...(overwrites?.length
      ? [`⚠ ИЗМЕНЯЮТСЯ существующие элементы: ${overwrites.map((name) => `«${name}»`).join(", ")}`, ""]
      : []),
    `Объекты: ${request.objects.trim()}`,
    `Сколько: ${request.count}`,
    `Организации: ${request.organisations.trim()}`,
    ...(bulkWarning ? ["", bulkWarning] : []),
  ].join("\n")
}

/** Said when the agent has not established what it is about to change. */
export function missingFacts(args: Partial<WriteRequest>): string | null {
  const missing = [
    !args.summary?.trim() ? "summary" : null,
    !args.objects?.trim() ? "objects" : null,
    typeof args.count !== "number" || Number.isNaN(args.count) ? "count" : null,
    !args.organisations?.trim() ? "organisations" : null,
  ].filter((name): name is string => name !== null)
  if (!missing.length) return null
  return [
    `Не заполнено: ${missing.join(", ")}.`,
    "",
    "Пользователь решает, разрешить ли запись, и для этого ему нужны масштаб и охват. Узнай их",
    "запросом (`КОЛИЧЕСТВО(*)` с группировкой по организации) и вызови снова.",
  ].join("\n")
}
