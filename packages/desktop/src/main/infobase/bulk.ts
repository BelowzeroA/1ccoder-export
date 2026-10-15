// Refusing an unfiltered bulk write to the infobase.
//
// 2026-09-23, debrief7.md §6.9 and D11. On 09-21 the agent ran this, in one
// `1c_execute_code` call, with no confirmation asked:
//
//   Запрос.Текст = "ВЫБРАТЬ Т.Ссылка ИЗ Документ.СчетНаОплатуПокупателю КАК Т";
//   Пока Выборка.Следующий() Цикл
//     Объект = Выборка.Ссылка.ПолучитьОбъект();
//     Объект.ЗаголовокСчета = …;
//     Объект.ОбменДанными.Загрузка = Истина;   // no validation, no business logic
//     Объект.Записать();
//   КонецЦикла;
//
// 8 567 documents rewritten. 948 of them belonged to a different legal entity,
// because the query had no organisation filter. The user had answered this exact
// question on 09-20 -- «Нет, только новые» -- and was not asked this time. The
// distribution was then measured by the agent itself, reported as «Все счета
// обновлены», and reduced in the closing summary to one clause.
//
// Why a guard and not a prompt rule: the prompt already said to explain a write
// and wait, and `PROFILE_PROMPT` has said so since 09-20. It failed at the point
// of use, which is what D11 is about -- rules recalled retrospectively do not
// prevent anything. This is the narrowest structural stop that covers the harm.
//
// Deliberately NOT a general "confirm every write" gate. `tool.execute.before`
// can only refuse, never ask, so a broad gate would forbid the ordinary writes
// this app exists to make. The pattern below is specific: iterate every object
// of a type, with no filter, and write each one.

/** Table references that mean "every object of this type". */
const WHOLE_TABLE =
  /(?:ИЗ|FROM)\s+(Документ|Справочник|РегистрСведений|Document|Catalog|InformationRegister)\./i

// NOTE on `\b`: JavaScript defines a word boundary against [A-Za-z0-9_] only,
// so `\bГДЕ\b` never matches Cyrillic -- both sides of a Cyrillic word are
// non-word characters, and without a \w on either side there is no boundary.
// The first version of this file used `\b` throughout and therefore matched
// nothing at all; the tests are what caught it. Patterns below use explicit
// delimiter classes instead.
const EDGE = String.raw`[^0-9A-Za-zА-Яа-яЁё_]`

/**
 * The query text a snippet runs, and nothing else.
 *
 * 2026-09-23, debrief9.md §9.5. Boundedness has to be judged on the query, not
 * on the whole snippet: a loop body is full of `=` assignments
 * (`Объ.ЗаголовокСчета = РефЗаголовок`) and reading those as filters would make
 * every bulk write look narrowed. BSL string literals are double-quoted with
 * `""` as the escape, so the literals carrying ВЫБРАТЬ are the query.
 */
function queryText(code: string): string {
  const literals = code.match(/"(?:[^"]|"")*"/g) ?? []
  return literals.filter((literal) => /ВЫБРАТЬ|SELECT/i.test(literal)).join("\n")
}

/**
 * Operators that EXCLUDE rather than narrow.
 *
 * `ГДЕ ЗаголовокСчета <> &Заголовок` is the filter that let the 09-23 run
 * through: its complement is exactly the set of rows already written, so on the
 * first pass it excludes nothing and selects the entire table. Stripped before
 * looking for narrowing operators, so that `<>` can never be mistaken for one
 * (it contains a `>`).
 */
const ANTI_FILTER = /<>|!=/g

/**
 * Evidence that a query selects a bounded, named subset.
 *
 * This is the predicate D11 got wrong. The old test was `!FILTERED` -- "does a
 * ГДЕ appear anywhere" -- and a `ГДЕ` whose complement is what you just wrote
 * satisfies it while selecting all 8 567 rows. What matters is not the presence
 * of a filter but whether it names a subset: an equality or range against a
 * parameter or literal, a membership list, a LIKE, or an explicit row cap.
 */
const NARROWING = new RegExp(
  [
    // = &Параметр, = "литерал", = 42, = ЗНАЧЕНИЕ(…), = НАЧАЛОПЕРИОДА(…)
    String.raw`=\s*(?:&|"|\d|ЗНАЧЕНИЕ\s*\(|VALUE\s*\()`,
    // >= & / <= & / > & / < & -- a range endpoint
    String.raw`(?:>=|<=|>|<)\s*&`,
    `${EDGE}(?:В|IN)\\s*\\(`,
    `${EDGE}(?:МЕЖДУ|BETWEEN)${EDGE}`,
    `${EDGE}(?:ПОДОБНО|LIKE)${EDGE}`,
    `${EDGE}(?:ПЕРВЫЕ|TOP)\\s+\\d+`,
  ].join("|"),
  "i",
)

/** A selection filter set through the object model rather than in a query. */
const MANUAL_FILTER = /Отбор\s*\.\s*[0-9A-Za-zА-Яа-яЁё_]+\s*(?:\.\s*Установить\s*\(|=)|Filter\s*\.\s*[A-Za-z_]+\s*(?:\.\s*Set\s*\(|=)/i

/**
 * Does the code restrict itself to a bounded subset?
 *
 * Narrowing operators are looked for only in the query text; a manual `Отбор`
 * counts wherever it appears, because that form has no query to inspect.
 */
function isBounded(code: string): boolean {
  const query = queryText(code).replace(ANTI_FILTER, " ≠ ")
  if (NARROWING.test(query)) return true
  // A query-less selection: Выбрать() with a filter set on the manager.
  return MANUAL_FILTER.test(code.replace(ANTI_FILTER, " ≠ "))
}

/**
 * A filter built from the very value being written.
 *
 * Worth naming separately because it is not a mistake about syntax, it is a
 * mistake about logic, and the refusal should say so: the author believed they
 * had scoped the write.
 */
const SELF_CANCELLING = /(?:<>|!=)\s*&/

/**
 * Whether the target table is scoped to one organisation.
 *
 * In a base with several legal entities, a loop that writes documents without
 * naming an organisation crosses a tenancy boundary. On 09-23 that is how three
 * other organisations' invoices came to carry one organisation's heading and terms. A
 * period-only filter is bounded in volume and still unbounded in tenancy, so
 * this is checked separately from `isBounded`.
 */
const ORGANISATION = /Организаци|Organization/i
const DOCUMENT_TABLE = /(?:ИЗ|FROM)\s+(?:Документ|Document)\./i

/**
 * Bounds that make the tenancy question moot.
 *
 * A row cap or an explicit list of references is small and enumerated, so it
 * cannot quietly span every legal entity in the base. A period or an attribute
 * range can, which is why those still have to name an organisation.
 */
const ROW_CAP = new RegExp(`${EDGE}(?:ПЕРВЫЕ|TOP)\\s+\\d+`, "i")
const REFERENCE_LIST = new RegExp(`${EDGE}(?:В|IN)\\s*\\(`, "i")

/** A loop that walks a selection. */
const LOOP = new RegExp(
  [
    `${EDGE}Пока${EDGE}[^\\n]*${EDGE}Цикл${EDGE}`,
    `${EDGE}While${EDGE}[^\\n]*${EDGE}Do${EDGE}`,
    `${EDGE}Для\\s+Каждого${EDGE}`,
    `${EDGE}For\\s+Each${EDGE}`,
  ].join("|"),
  "i",
)

/** A write inside it. */
const WRITES = /\.\s*(Записать|Write|Удалить|Delete)\s*\(/i

/** Getting a mutable object per row -- what turns a read loop into a write loop. */
const PER_ROW_OBJECT = /\.\s*(ПолучитьОбъект|GetObject)\s*\(/i

/** Validation and business logic switched off for the write. */
const LOADING_MODE = /ОбменДанными\s*\.\s*Загрузка\s*=\s*(Истина|True)|DataExchange\s*\.\s*Load\s*=/i

export interface BulkVerdict {
  readonly refuse: boolean
  /** Why, so the refusal can say the one thing the author got wrong. */
  readonly reason?: "unbounded" | "self-cancelling" | "cross-organisation"
  /** Set when the code also disables the object's own checks. */
  readonly loadingMode?: boolean
}

/**
 * Whether this BSL is a write loop that nobody bounded.
 *
 * The shape is fixed: a whole-table reference, a loop, a write, and a mutable
 * object fetched per row. What changed on 2026-09-23 (debrief9.md §9.5) is the
 * test applied to that shape. It used to be "no filter appears anywhere", which
 * a `ГДЕ ЗаголовокСчета <> &Заголовок` satisfied while selecting all 8 567 rows.
 * Now the code has to show a bounded subset, and a documents loop has to say
 * whose documents.
 */
export function inspectBulkWrite(code: string): BulkVerdict {
  if (!code) return { refuse: false }
  const isWriteLoop =
    WHOLE_TABLE.test(code) && LOOP.test(code) && WRITES.test(code) && PER_ROW_OBJECT.test(code)
  if (!isWriteLoop) return { refuse: false }

  const loading = LOADING_MODE.test(code) ? { loadingMode: true } : {}
  const query = queryText(code)

  // Checked before boundedness: a self-cancelling filter usually LOOKS bounded
  // to whoever wrote it, and naming that specifically is the whole point.
  if (SELF_CANCELLING.test(query) && !isBounded(code))
    return { refuse: true, reason: "self-cancelling", ...loading }

  if (!isBounded(code)) return { refuse: true, reason: "unbounded", ...loading }

  // Bounded in volume, still unbounded in tenancy -- unless the bound is small
  // and enumerated, which a cap or a reference list is.
  if (
    DOCUMENT_TABLE.test(query) &&
    !ORGANISATION.test(query) &&
    !ROW_CAP.test(query) &&
    !REFERENCE_LIST.test(query)
  )
    return { refuse: true, reason: "cross-organisation", ...loading }

  return { refuse: false }
}

/**
 * What the agent is told.
 *
 * Names the two things that actually went wrong -- no filter, nobody asked --
 * and gives the way forward, because a refusal the agent cannot act on gets
 * worked around. The `ОбменДанными.Загрузка` line is separate: it is a
 * legitimate migration idiom and a bad default for a change nobody authorised.
 */
export function bulkRefusal(verdict: BulkVerdict): string {
  return [
    ...headline(verdict.reason),
    "",
    "Цикл с записью по всей таблице — самый короткий путь изменить больше, чем просили: отбор в",
    "запросе может выглядеть ограничивающим и всё равно выбирать всё, а документы других",
    "организаций меняются молча, без единого вопроса пользователю.",
    "",
    "Что сделать:",
    "1. Ограничь выборку так, чтобы она называла подмножество: конкретная организация, период,",
    "   список ссылок, `ПЕРВЫЕ N`. Условие вида «не равно тому, что я записываю» подмножество не",
    "   называет — оно выбирает всё, что ещё не изменено, то есть всю таблицу.",
    "2. Для документов укажи организацию. Если в базе их несколько, правка «всех документов» —",
    "   это правка чужих данных.",
    "3. Посчитай, сколько объектов затронешь (`КОЛИЧЕСТВО(*)` с группировкой по организации),",
    "   покажи это пользователю и дождись ответа. Это его решение, а не твоё.",
    "4. Проверь, нужна ли правка истории вообще. Часто хватает поменять то, откуда значение",
    "   берут новые документы (значение по умолчанию, настройку): новые заполнятся сами, старые",
    "   останутся как были.",
    ...(verdict.loadingMode
      ? [
          "",
          "Отдельно: `ОбменДанными.Загрузка = Истина` отключает проверки и логику самого объекта.",
          "Для переноса данных это нормально, для правки, которую никто не согласовал, — нет.",
        ]
      : []),
  ].join("\n")
}

/** The first line names the specific fault, because "добавь отбор" answers only one of three. */
function headline(reason: BulkVerdict["reason"]): readonly string[] {
  if (reason === "self-cancelling")
    return [
      "Отклонено: отбор в запросе не ограничивает выборку.",
      "",
      "Условие вида `ГДЕ <реквизит> <> &<то, что записываешь>` отбирает ровно те строки, которые",
      "ещё не изменены, — на первом проходе это вся таблица. Отбор есть, подмножества нет.",
    ]
  if (reason === "cross-organisation")
    return [
      "Отклонено: цикл пишет документы, не указывая организацию.",
      "",
      "Выборка ограничена по объёму, но не по владельцу: в базе несколько организаций, и такой",
      "запрос затрагивает документы всех.",
    ]
  return ["Отклонено: это запись во ВСЕ объекты таблицы без ограничения выборки."]
}

/** The BSL a toolkit tool call is about to run, or undefined when it is not one. */
export function bslFrom(toolName: string, args: unknown): string | undefined {
  // Only the code tool: a query cannot write, and the .epf launcher is guarded
  // by the permission gate already.
  if (!/(^|_)execute_code$/i.test(toolName)) return undefined
  if (typeof args !== "object" || args === null) return undefined
  const code = (args as Record<string, unknown>).code
  return typeof code === "string" && code.trim() ? code : undefined
}

/**
 * Tools that write a file, and the argument each one names it with.
 *
 * Lives here rather than in plugin.ts because opencode's loader treats EVERY
 * export of a plugin module as a plugin and throws on the first one that is not
 * a function (`getLegacyPlugins` in packages/opencode/src/plugin/index.ts). A
 * plugin module must therefore export its default and nothing else.
 */
const WRITE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  edit: ["filePath", "file_path"],
  write: ["filePath", "file_path"],
  patch: ["filePath", "file_path"],
  multiedit: ["filePath", "file_path"],
}

/** The file a write tool is about to touch, or undefined if this is not one. */
export function writeTarget(toolName: string, args: unknown): string | undefined {
  const keys = WRITE_TOOLS[toolName.toLowerCase()]
  if (!keys || typeof args !== "object" || args === null) return undefined
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}
