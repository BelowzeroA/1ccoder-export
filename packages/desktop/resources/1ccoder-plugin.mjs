// src/main/infobase/plugin.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, readdirSync as readdirSync2, readFileSync as readFileSync2, statSync as statSync2, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname as dirname2, join as join5 } from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "@opencode-ai/plugin";

// src/main/infobase/operations.ts
function extensionArg(extension) {
  const name = extension?.trim();
  return name ? ["-Extension", name] : [];
}
var OPERATIONS = {
  check: {
    id: "check",
    mode: "DESIGNER",
    writes: false,
    summary: "Проверка конфигурации",
    args: () => ["/CheckConfig", "-ConfigLogIntegrity"]
  },
  dump_config: {
    id: "dump_config",
    mode: "DESIGNER",
    writes: false,
    summary: "Выгрузка конфигурации в файл",
    args: ({ path, extension }) => ["/DumpCfg", `"${path ?? ""}"`, ...extensionArg(extension)],
    timeoutMs: 20 * 60 * 1000
  },
  dump_config_to_files: {
    id: "dump_config_to_files",
    mode: "DESIGNER",
    writes: false,
    summary: "Выгрузка конфигурации в файлы (XML)",
    args: ({ path, update, extension, listFile }) => [
      "/DumpConfigToFiles",
      `"${path ?? ""}"`,
      ...extensionArg(extension),
      ...update ? ["-update"] : [],
      ...listFile ? ["-listFile", `"${listFile}"`] : []
    ],
    timeoutMs: 45 * 60 * 1000
  },
  dump_epf_to_files: {
    id: "dump_epf_to_files",
    mode: "DESIGNER",
    writes: false,
    summary: "Выгрузка внешней обработки в файлы (XML)",
    args: ({ path, secondPath }) => [
      "/DumpExternalDataProcessorOrReportToFiles",
      `"${path ?? ""}"`,
      `"${secondPath ?? ""}"`
    ]
  },
  load_epf_from_files: {
    id: "load_epf_from_files",
    mode: "DESIGNER",
    writes: false,
    summary: "Сборка внешней обработки из файлов (XML)",
    args: ({ path, secondPath }) => [
      "/LoadExternalDataProcessorOrReportFromFiles",
      `"${path ?? ""}"`,
      `"${secondPath ?? ""}"`
    ]
  },
  load_config: {
    id: "load_config",
    mode: "DESIGNER",
    writes: true,
    summary: "Загрузка конфигурации из файла",
    args: ({ path, extension }) => ["/LoadCfg", `"${path ?? ""}"`, ...extensionArg(extension)],
    timeoutMs: 20 * 60 * 1000
  },
  load_config_from_files: {
    id: "load_config_from_files",
    mode: "DESIGNER",
    writes: true,
    summary: "Загрузка расширения из файлов XML",
    args: ({ path, extension }) => ["/LoadConfigFromFiles", `"${path ?? ""}"`, ...extensionArg(extension)],
    timeoutMs: 20 * 60 * 1000
  },
  delete_extension: {
    id: "delete_extension",
    mode: "DESIGNER",
    writes: true,
    summary: "Удаление расширения из базы",
    args: ({ extension }) => ["/DeleteCfg", ...extensionArg(extension)],
    timeoutMs: 20 * 60 * 1000
  },
  update_db: {
    id: "update_db",
    mode: "DESIGNER",
    writes: true,
    summary: "Обновление конфигурации базы данных",
    args: ({ extension }) => ["/UpdateDBCfg", ...extensionArg(extension)],
    timeoutMs: 45 * 60 * 1000
  },
  execute: {
    id: "execute",
    mode: "ENTERPRISE",
    writes: true,
    summary: "Выполнение внешней обработки в базе",
    args: ({ path }) => ["/Execute", `"${path ?? ""}"`]
  }
};
var OPERATION_TIMEOUT_MS = 10 * 60 * 1000;
var EXEC_REQUEST_TIMEOUT_MS = Math.max(...Object.values(OPERATIONS).map((operation) => operation.timeoutMs ?? OPERATION_TIMEOUT_MS)) + 60 * 1000;
var PATH_SPECS = {
  dump_config: { kind: "output", extensions: [".cf", ".cfe"] },
  dump_config_to_files: { kind: "directory", extensions: [] },
  dump_epf_to_files: { kind: "directory", extensions: [] },
  load_epf_from_files: { kind: "input", extensions: [".xml"] },
  load_config: { kind: "input", extensions: [".cf", ".cfe"] },
  load_config_from_files: { kind: "source", extensions: [] },
  execute: { kind: "input", extensions: [".epf", ".erf"] }
};
function pathSpec(id) {
  return PATH_SPECS[id];
}
var SECOND_PATH_SPECS = {
  dump_epf_to_files: { kind: "input", extensions: [".epf", ".erf"] },
  load_epf_from_files: { kind: "input", extensions: [".epf", ".erf"] }
};
function secondPathSpec(id) {
  return SECOND_PATH_SPECS[id];
}
function createdPaths(id, args) {
  const created = [];
  const kind = PATH_SPECS[id]?.kind;
  if (kind === "output" || kind === "directory")
    created.push(args.path);
  if (id === "load_epf_from_files")
    created.push(args.epfPath);
  if (id === "load_config_from_files")
    created.push(args.path);
  return created.filter((path) => typeof path === "string" && path.trim().length > 0).map((p) => p.trim());
}
function requiresSecondPath(id) {
  return Object.hasOwn(SECOND_PATH_SPECS, id);
}
function checkSecondPath(id, path, probe) {
  const spec = SECOND_PATH_SPECS[id];
  if (!spec)
    return null;
  const trimmed = (path ?? "").trim();
  if (!trimmed)
    return "Для этой операции нужен второй путь — файл обработки или отчёта (.epf, .erf).";
  const lower = trimmed.toLowerCase();
  if (!spec.extensions.some((ext) => lower.endsWith(ext))) {
    return `Ожидается файл ${spec.extensions.join(" или ")}, получено: ${trimmed}`;
  }
  if (id === "load_epf_from_files") {
    return probe.isDirectory(parentDirectory(trimmed)) ? null : `Нет каталога для собранного файла: ${parentDirectory(trimmed)}`;
  }
  if (!probe.isFile(trimmed))
    return `Файла обработки нет: ${trimmed}`;
  return null;
}
function parentDirectory(path) {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at <= 0 ? path : path.slice(0, at);
}
function checkPath(id, path, probe) {
  const spec = PATH_SPECS[id];
  if (!spec)
    return null;
  const trimmed = (path ?? "").trim();
  if (!trimmed) {
    return id === "execute" ? "Путь к обработке не указан. Этот инструмент запускает готовый файл .epf; " + "код 1С выполняется инструментом 1c_execute_code." : "Для этой операции нужен путь к файлу.";
  }
  const lower = trimmed.toLowerCase();
  if (spec.extensions.length && !spec.extensions.some((ext) => lower.endsWith(ext))) {
    const wanted = spec.extensions.join(" или ");
    return id === "execute" ? `Это не файл обработки (${wanted}): ${trimmed}. ` + "Если нужно выполнить код 1С, это инструмент 1c_execute_code." : `Ожидается файл ${wanted}, получено: ${trimmed}`;
  }
  if (spec.kind === "source") {
    if (!probe.isDirectory(trimmed))
      return `Каталога нет: ${trimmed}`;
    if (!probe.isFile(`${trimmed.replace(/[\\/]+$/, "")}/Configuration.xml`)) {
      return `В каталоге нет Configuration.xml: ${trimmed}. Нужен корень выгрузки расширения — ` + "тот каталог, где лежит Configuration.xml (заготовку создаёт 1c_new_extension).";
    }
    return null;
  }
  if (spec.kind === "input") {
    if (!probe.isFile(trimmed)) {
      return id === "execute" ? `Файла обработки нет: ${trimmed}. Запускать можно только .epf, который уже собран — ` + "проверь путь вместо повторного вызова." : `Файла нет: ${trimmed}`;
    }
    return null;
  }
  if (spec.kind === "directory") {
    if (probe.isDirectory(trimmed))
      return null;
    if (probe.isFile(trimmed))
      return `Это файл, а нужен каталог: ${trimmed}`;
    const above = parentDirectory(trimmed);
    if (!probe.isDirectory(above)) {
      return `Нет родительского каталога: ${above}. Выгрузка создаёт только последний уровень пути — ` + "создай родителя в рабочем каталоге профиля или укажи путь прямо в нём.";
    }
    return null;
  }
  const parent = parentDirectory(trimmed);
  if (!probe.isDirectory(parent)) {
    return `Каталога для записи нет: ${parent}. Создай его в рабочем каталоге профиля или укажи файл прямо в нём.`;
  }
  return null;
}
var NEEDS_PATH = new Set([
  "dump_config",
  "dump_config_to_files",
  "load_config",
  "load_config_from_files",
  "execute"
]);
function writesToInfobase(id) {
  return OPERATIONS[id].writes;
}
function needsExclusiveInfobase(id) {
  return OPERATIONS[id].mode === "DESIGNER";
}

// src/main/infobase/bulk.ts
var WHOLE_TABLE = /(?:ИЗ|FROM)\s+(Документ|Справочник|РегистрСведений|Document|Catalog|InformationRegister)\./i;
var EDGE = String.raw`[^0-9A-Za-zА-Яа-яЁё_]`;
function queryText(code) {
  const literals = code.match(/"(?:[^"]|"")*"/g) ?? [];
  return literals.filter((literal) => /ВЫБРАТЬ|SELECT/i.test(literal)).join(`
`);
}
var ANTI_FILTER = /<>|!=/g;
var NARROWING = new RegExp([
  String.raw`=\s*(?:&|"|\d|ЗНАЧЕНИЕ\s*\(|VALUE\s*\()`,
  String.raw`(?:>=|<=|>|<)\s*&`,
  `${EDGE}(?:В|IN)\\s*\\(`,
  `${EDGE}(?:МЕЖДУ|BETWEEN)${EDGE}`,
  `${EDGE}(?:ПОДОБНО|LIKE)${EDGE}`,
  `${EDGE}(?:ПЕРВЫЕ|TOP)\\s+\\d+`
].join("|"), "i");
var MANUAL_FILTER = /Отбор\s*\.\s*[0-9A-Za-zА-Яа-яЁё_]+\s*(?:\.\s*Установить\s*\(|=)|Filter\s*\.\s*[A-Za-z_]+\s*(?:\.\s*Set\s*\(|=)/i;
function isBounded(code) {
  const query = queryText(code).replace(ANTI_FILTER, " ≠ ");
  if (NARROWING.test(query))
    return true;
  return MANUAL_FILTER.test(code.replace(ANTI_FILTER, " ≠ "));
}
var SELF_CANCELLING = /(?:<>|!=)\s*&/;
var ORGANISATION = /Организаци|Organization/i;
var DOCUMENT_TABLE = /(?:ИЗ|FROM)\s+(?:Документ|Document)\./i;
var ROW_CAP = new RegExp(`${EDGE}(?:ПЕРВЫЕ|TOP)\\s+\\d+`, "i");
var REFERENCE_LIST = new RegExp(`${EDGE}(?:В|IN)\\s*\\(`, "i");
var LOOP = new RegExp([
  `${EDGE}Пока${EDGE}[^\\n]*${EDGE}Цикл${EDGE}`,
  `${EDGE}While${EDGE}[^\\n]*${EDGE}Do${EDGE}`,
  `${EDGE}Для\\s+Каждого${EDGE}`,
  `${EDGE}For\\s+Each${EDGE}`
].join("|"), "i");
var WRITES = /\.\s*(Записать|Write|Удалить|Delete)\s*\(/i;
var PER_ROW_OBJECT = /\.\s*(ПолучитьОбъект|GetObject)\s*\(/i;
var LOADING_MODE = /ОбменДанными\s*\.\s*Загрузка\s*=\s*(Истина|True)|DataExchange\s*\.\s*Load\s*=/i;
function inspectBulkWrite(code) {
  if (!code)
    return { refuse: false };
  const isWriteLoop = WHOLE_TABLE.test(code) && LOOP.test(code) && WRITES.test(code) && PER_ROW_OBJECT.test(code);
  if (!isWriteLoop)
    return { refuse: false };
  const loading = LOADING_MODE.test(code) ? { loadingMode: true } : {};
  const query = queryText(code);
  if (SELF_CANCELLING.test(query) && !isBounded(code))
    return { refuse: true, reason: "self-cancelling", ...loading };
  if (!isBounded(code))
    return { refuse: true, reason: "unbounded", ...loading };
  if (DOCUMENT_TABLE.test(query) && !ORGANISATION.test(query) && !ROW_CAP.test(query) && !REFERENCE_LIST.test(query))
    return { refuse: true, reason: "cross-organisation", ...loading };
  return { refuse: false };
}
function bulkRefusal(verdict) {
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
    ...verdict.loadingMode ? [
      "",
      "Отдельно: `ОбменДанными.Загрузка = Истина` отключает проверки и логику самого объекта.",
      "Для переноса данных это нормально, для правки, которую никто не согласовал, — нет."
    ] : []
  ].join(`
`);
}
function headline(reason) {
  if (reason === "self-cancelling")
    return [
      "Отклонено: отбор в запросе не ограничивает выборку.",
      "",
      "Условие вида `ГДЕ <реквизит> <> &<то, что записываешь>` отбирает ровно те строки, которые",
      "ещё не изменены, — на первом проходе это вся таблица. Отбор есть, подмножества нет."
    ];
  if (reason === "cross-organisation")
    return [
      "Отклонено: цикл пишет документы, не указывая организацию.",
      "",
      "Выборка ограничена по объёму, но не по владельцу: в базе несколько организаций, и такой",
      "запрос затрагивает документы всех."
    ];
  return ["Отклонено: это запись во ВСЕ объекты таблицы без ограничения выборки."];
}
function bslFrom(toolName, args) {
  if (!/(^|_)execute_code$/i.test(toolName))
    return;
  if (typeof args !== "object" || args === null)
    return;
  const code = args.code;
  return typeof code === "string" && code.trim() ? code : undefined;
}
var WRITE_TOOLS = {
  edit: ["filePath", "file_path"],
  write: ["filePath", "file_path"],
  patch: ["filePath", "file_path"],
  multiedit: ["filePath", "file_path"]
};
function writeTarget(toolName, args) {
  const keys = WRITE_TOOLS[toolName.toLowerCase()];
  if (!keys || typeof args !== "object" || args === null)
    return;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim())
      return value.trim();
  }
  return;
}

// src/main/infobase/writes.ts
var IDENT = "[0-9A-Za-zА-Яа-яЁё_]";
var PRODUCERS = [
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
  "СоздатьВидРасчета"
];
var DIRECT_WRITES = [
  new RegExp(`(?:ПолучитьОбъект|GetObject)\\s*\\(\\s*\\)\\s*\\.\\s*(?:Записать|Write|Удалить|Delete)\\s*\\(`, "i"),
  new RegExp(`Константы\\s*\\.\\s*${IDENT}+\\s*\\.\\s*(?:Установить|Set)\\s*\\(`, "i"),
  new RegExp(`Регистры[А-Яа-яЁё]*\\s*\\.\\s*${IDENT}+\\s*\\.\\s*Записать\\s*\\(`, "i"),
  new RegExp(`(?:^|[^0-9A-Za-zА-Яа-яЁё_.])УдалитьОбъекты\\s*\\(`, "i"),
  new RegExp(`\\.\\s*Записать(?!XML|JSON|HTML|Текст|Файл|ВФайл|Строку|ВСтроку|ОбъявлениеXML|Начало|Конец|Атрибут|Значение|` + `ИмяСвойства|Комментарий|БезОбработки|СоответствиеПространстваИмен|СекциюCDATA|СсылкуНаСущность|` + `ИнструкциюОбработки|ТипДокумента|Байт|Целое|Число|Символы|ДвоичныеДанные|БуферДвоичныхДанных)` + `[А-ЯЁA-Z][0-9A-Za-zА-Яа-яЁё_]*\\s*\\(`),
  new RegExp(`Хранилище(?:Общих|Системных|Пользовательских)?Настроек\\w*\\s*\\.\\s*Сохранить\\s*\\(`, "i")
];
function inspectBaseWrite(code) {
  if (!code)
    return { writes: false, receivers: [] };
  if (DIRECT_WRITES.some((pattern) => pattern.test(code)))
    return { writes: true, receivers: [] };
  const external = externalCalls(code);
  if (external.length)
    return { writes: true, receivers: external, external: true };
  const assignment = new RegExp(`(${IDENT}+)\\s*=\\s*[^;\\r\\n]*?(?:${PRODUCERS.join("|")})\\s*\\(`, "gi");
  const holders = [...code.matchAll(assignment)].map((match) => match[1]).filter((name) => name.length > 0);
  if (!holders.length)
    return { writes: false, receivers: [] };
  const receivers = [...new Set(holders)].filter((name) => new RegExp(`(?:^|[^0-9A-Za-zА-Яа-яЁё_.])${name}\\s*\\.\\s*(?:Записать|Write|Удалить|Delete)\\s*\\(`, "i").test(code));
  return { writes: receivers.length > 0, receivers };
}
var EXTERNAL_CREATE = `(?:ВнешниеОбработки|ВнешниеОтчеты|ExternalDataProcessors|ExternalReports)\\s*\\.\\s*(?:Создать|Create)\\s*\\(`;
var EXTERNAL_READS = /^(?:Метаданные|Metadata|ПолучитьФорму|GetForm|ПолучитьМакет|GetTemplate|СведенияОВнешнейОбработке)$/i;
function externalCalls(code) {
  const calledOn = (subject) => [...code.matchAll(new RegExp(`${subject}\\s*\\.\\s*(${IDENT}+)\\s*\\(`, "gi"))].some((match) => !EXTERNAL_READS.test(match[1]));
  const chained = calledOn(`${EXTERNAL_CREATE}[^;]*?\\)`);
  const holders = [...code.matchAll(new RegExp(`(${IDENT}+)\\s*=\\s*${EXTERNAL_CREATE}`, "gi"))].map((match) => match[1]);
  const called = [...new Set(holders)].filter((name) => calledOn(`(?:^|[^0-9A-Za-zА-Яа-яЁё_.])${name}`));
  return chained ? [...called, "ВнешниеОбработки"] : called;
}
var MANAGERS = [
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
  ["Задачи", "Задача"]
];
function writeTargets(code) {
  const found = MANAGERS.flatMap(([collection, kind]) => [...code.matchAll(new RegExp(`(?:^|[^0-9A-Za-zА-Яа-яЁё_.])${collection}\\s*\\.\\s*(${IDENT}+)`, "g"))].map((match) => `${kind}.${match[1]}`));
  return [...new Set(found)];
}
var LOOKUPS = [
  "НайтиПоНаименованию",
  "FindByDescription",
  "НайтиПоКоду",
  "FindByCode",
  "НайтиПоРеквизиту",
  "FindByAttribute"
];
function inspectOverwrite(code) {
  if (!code)
    return { overwrites: false, elements: [] };
  const lookup = `(?:${LOOKUPS.join("|")})`;
  const direct = new RegExp(`${lookup}\\s*\\([^;\\r\\n]*?\\)\\s*\\.\\s*(?:ПолучитьОбъект|GetObject)`, "i");
  const named = new RegExp(`(${IDENT}+)\\s*=\\s*[^;\\r\\n]*?${lookup}\\s*\\(\\s*"([^"]*)"`, "gi");
  const found = [...code.matchAll(named)].map((match) => ({ variable: match[1], element: match[2] }));
  const writtenVia = found.filter((entry) => {
    const holder = new RegExp(`(${IDENT}+)\\s*=\\s*[^;\\r\\n]*?(?:^|[^0-9A-Za-zА-Яа-яЁё_.])${entry.variable}\\s*\\.\\s*(?:ПолучитьОбъект|GetObject)`, "i").exec(code);
    if (!holder)
      return false;
    return new RegExp(`(?:^|[^0-9A-Za-zА-Яа-яЁё_.])${holder[1]}\\s*\\.\\s*(?:Записать|Write|Удалить|Delete)\\s*\\(`, "i").test(code);
  });
  const elements = [...new Set(writtenVia.map((entry) => entry.element))];
  if (elements.length)
    return { overwrites: true, elements };
  if (direct.test(code) && inspectBaseWrite(code).writes) {
    const names = [...code.matchAll(new RegExp(`${lookup}\\s*\\(\\s*"([^"]*)"`, "gi"))].map((match) => match[1]);
    return { overwrites: true, elements: [...new Set(names)] };
  }
  return { overwrites: false, elements: [] };
}
function overwriteRefusal(verdict) {
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
    "добавляется."
  ].join(`
`);
}
function approvalKey(sessionId, code) {
  return `${sessionId}
${code.replace(/\s+/g, " ").trim()}`;
}
var approvals = new Set;
function recordApproval(sessionId, code) {
  approvals.add(approvalKey(sessionId, code));
}
function hasApproval(sessionId, code) {
  return approvals.has(approvalKey(sessionId, code));
}
function consumeApproval(sessionId, code) {
  return approvals.delete(approvalKey(sessionId, code));
}
function hasNearMissApproval(sessionId, code) {
  const key = approvalKey(sessionId, code);
  const prefix = `${sessionId}
`;
  return [...approvals].some((granted) => {
    if (!granted.startsWith(prefix))
      return false;
    const shorter = granted.length < key.length ? granted : key;
    const longer = granted.length < key.length ? key : granted;
    return shorter.length > prefix.length + 80 && longer.startsWith(shorter);
  });
}
function writeRefusal(verdict, bulkWarning, nearMiss) {
  if (nearMiss)
    return [
      "Отклонено: разрешение выдано на другой текст кода.",
      "",
      "Похоже, ты уже получил разрешение, но код с тех пор изменился — чаще всего к нему в конец",
      "дописана проверка. Разрешение действует ровно на тот текст, который видел пользователь.",
      "",
      "Повтори **ровно тот** код, что был в `1c_write_code`, а проверку сделай **отдельным**",
      "вызовом после записи: чтение разрешения не требует."
    ].join(`
`);
  return [
    "Отклонено: это запись в информационную базу, а `1c_execute_code` её не подтверждает.",
    ...verdict.external ? [
      `Код вызывает метод внешней обработки (${verdict.receivers.join(", ")}): что она пишет, из этого кода не ` + "видно, поэтому вызов считается записью. Если метод только проверяет и ничего не пишет — скажи это в summary."
    ] : verdict.receivers.length ? [`Объекты базы здесь: ${verdict.receivers.join(", ")}.`] : [],
    "",
    "Запись в рабочую базу — решение пользователя, а не твоё. Вызови `1c_write_code` с **тем же",
    "кодом** и скажи, что именно будет записано:",
    "",
    "    1c_write_code(",
    "      code: <тот же код>,",
    '      summary: "что и зачем меняется",',
    '      objects: "Документ.<Имя>",',
    "      count: <сколько объектов>,",
    '      organisations: "<каких организаций это касается>")',
    "",
    "`count` и `organisations` нужно **узнать до записи**, а не после: обычный запрос",
    "`КОЛИЧЕСТВО(*)` с группировкой по организации. Цикл записи легко захватывает больше, чем",
    "просили, — всю таблицу или документы организаций, которых задача не касается, — и масштаб,",
    "узнанный после записи, узнан слишком поздно.",
    ...bulkWarning ? ["", bulkWarning] : []
  ].join(`
`);
}
function writeAskText(request, bulkWarning, overwrites) {
  return [
    request.summary.trim(),
    "",
    ...overwrites?.length ? [`⚠ ИЗМЕНЯЮТСЯ существующие элементы: ${overwrites.map((name) => `«${name}»`).join(", ")}`, ""] : [],
    `Объекты: ${request.objects.trim()}`,
    `Сколько: ${request.count}`,
    `Организации: ${request.organisations.trim()}`,
    ...bulkWarning ? ["", bulkWarning] : []
  ].join(`
`);
}
function missingFacts(args) {
  const missing = [
    !args.summary?.trim() ? "summary" : null,
    !args.objects?.trim() ? "objects" : null,
    typeof args.count !== "number" || Number.isNaN(args.count) ? "count" : null,
    !args.organisations?.trim() ? "organisations" : null
  ].filter((name) => name !== null);
  if (!missing.length)
    return null;
  return [
    `Не заполнено: ${missing.join(", ")}.`,
    "",
    "Пользователь решает, разрешить ли запись, и для этого ему нужны масштаб и охват. Узнай их",
    "запросом (`КОЛИЧЕСТВО(*)` с группировкой по организации) и вызови снова."
  ].join(`
`);
}

// src/main/infobase/form-bindings.ts
var KNOWN_EVENTS = {
  ПриСозданииНаСервере: { event: "OnCreateAtServer", directive: "&НаСервере", parameters: 2 },
  ПриЧтенииНаСервере: { event: "OnReadAtServer", directive: "&НаСервере", parameters: 1 },
  ПослеЗаписиНаСервере: { event: "AfterWriteAtServer", directive: "&НаСервере", parameters: 2 },
  ПриОткрытии: { event: "OnOpen", directive: "&НаКлиенте", parameters: 1 },
  ПередЗакрытием: { event: "BeforeClose", directive: "&НаКлиенте", parameters: 4 },
  ПриЗакрытии: { event: "OnClose", directive: "&НаКлиенте", parameters: 1 },
  ОбработкаОповещения: { event: "NotificationProcessing", directive: "&НаКлиенте", parameters: 3 },
  ПослеЗаписи: { event: "AfterWrite", directive: "&НаКлиенте", parameters: 1 }
};
var ITEM_EVENT_SUFFIXES = [
  "ПриИзменении",
  "Нажатие",
  "ОбработкаВыбора",
  "НачалоВыбора",
  "Открытие",
  "ПриАктивизацииСтроки",
  "ОбработкаНавигационнойСсылки",
  "АвтоПодборТекста",
  "ОкончаниеВводаТекста",
  "ПередНачаломДобавления",
  "ПередУдалением",
  "Выбор"
];
function parseModuleProcedures(bsl) {
  const found = [];
  let pending = null;
  bsl.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^﻿/, "").trim();
    if (line.startsWith("&")) {
      pending = line.split("(")[0].trim();
      return;
    }
    const declaration = /^(Процедура|Функция|Procedure|Function)\s+([0-9A-Za-zА-Яа-яЁё_]+)\s*\(([^)]*)\)/i.exec(line);
    if (!declaration)
      return;
    found.push({
      name: declaration[2],
      directive: pending,
      line: index + 1,
      isProcedure: /^(?:Процедура|Procedure)$/i.test(declaration[1]),
      parameters: declaration[3].split(",").filter((part) => part.trim().length > 0).length
    });
    pending = null;
  });
  return found;
}
var MALFORMED_EVENT = /<Event(\s+name="[^"]*")\s*>\s*<Handler>([^<]*)<\/Handler>\s*<\/Event>/g;
function repairMalformedEvents(xml) {
  const repaired = [...xml.matchAll(MALFORMED_EVENT)].map((match) => match[2].trim()).filter(Boolean);
  if (!repaired.length)
    return { xml, repaired: [] };
  return { xml: xml.replace(MALFORMED_EVENT, (_all, name, handler) => `<Event${name}>${handler.trim()}</Event>`), repaired };
}
function parseFormBindings(xml) {
  return {
    events: [...xml.matchAll(/<Event\s+name="([^"]+)"\s*>([^<]+)<\/Event>/g)].map((match) => ({
      event: match[1],
      procedure: match[2].trim()
    })),
    actions: [...xml.matchAll(/<Action>([^<]+)<\/Action>/g)].map((match) => match[1].trim())
  };
}
function inspectFormBindings(form) {
  const bindings = parseFormBindings(form.xml);
  const procedures = parseModuleProcedures(form.module);
  const declared = new Map(procedures.map((procedure) => [procedure.name, procedure]));
  const bound = new Set([...bindings.events.map((entry) => entry.procedure), ...bindings.actions]);
  const findings = [];
  for (const procedure of procedures) {
    if (bound.has(procedure.name))
      continue;
    const known = KNOWN_EVENTS[procedure.name];
    if (known) {
      findings.push({
        kind: "unbound",
        procedure: procedure.name,
        detail: `строка ${procedure.line}: это обработчик события формы, но в Form.xml его никто не вызывает. ` + `Добавь в <Events> формы: <Event name="${known.event}">${procedure.name}</Event>`
      });
      continue;
    }
    const suffix = ITEM_EVENT_SUFFIXES.find((tail) => procedure.name.length > tail.length && procedure.name.endsWith(tail));
    if (suffix) {
      findings.push({
        kind: "unbound",
        procedure: procedure.name,
        detail: `строка ${procedure.line}: имя выглядит как обработчик «${suffix}» элемента ` + `«${procedure.name.slice(0, -suffix.length)}», но в Form.xml его никто не вызывает. ` + `Событие привязывается в <Events> того элемента, а не по имени процедуры.`
      });
    }
  }
  for (const entry of bindings.events) {
    const procedure = declared.get(entry.procedure);
    if (!procedure) {
      findings.push({
        kind: "missing",
        procedure: entry.procedure,
        detail: `<Event name="${entry.event}"> ссылается на процедуру, которой в модуле формы нет — при открытии формы будет ошибка.`
      });
      continue;
    }
    const known = KNOWN_EVENTS[entry.procedure];
    if (known && procedure.directive && procedure.directive !== known.directive) {
      findings.push({
        kind: "directive",
        procedure: entry.procedure,
        detail: `строка ${procedure.line}: директива ${procedure.directive}, а событию ${known.event} нужна ${known.directive}.`
      });
    }
  }
  for (const action of bindings.actions) {
    if (declared.has(action))
      continue;
    findings.push({
      kind: "missing",
      procedure: action,
      detail: "<Action> команды ссылается на процедуру, которой в модуле формы нет — команда упадёт при нажатии."
    });
  }
  return findings;
}
function bindFormEvents(form) {
  const repair = repairMalformedEvents(form.xml);
  form = { xml: repair.xml, module: form.module };
  const bindings = parseFormBindings(form.xml);
  const bound = new Set([...bindings.events.map((entry) => entry.procedure), ...bindings.actions]);
  const additions = parseModuleProcedures(form.module).flatMap((procedure) => {
    if (bound.has(procedure.name) || !procedure.isProcedure)
      return [];
    const known = KNOWN_EVENTS[procedure.name];
    if (!known || procedure.parameters !== known.parameters)
      return [];
    return [{ event: known.event, procedure: procedure.name }];
  });
  if (!additions.length)
    return { xml: form.xml, bound: [], repaired: repair.repaired };
  const lines = additions.map((entry) => `		<Event name="${entry.event}">${entry.procedure}</Event>`);
  if (/<Events>/.test(form.xml)) {
    return {
      xml: form.xml.replace("<Events>", `<Events>
${lines.join(`
`)}`),
      bound: additions,
      repaired: repair.repaired
    };
  }
  const block = `	<Events>
${lines.join(`
`)}
	</Events>
`;
  for (const marker of [`
	<ChildItems>`, `
	<Commands>`, `
	<Attributes>`]) {
    if (form.xml.includes(marker)) {
      return {
        xml: form.xml.replace(marker, `
${block}${marker.slice(1)}`),
        bound: additions,
        repaired: repair.repaired
      };
    }
  }
  if (/<\/Form>/.test(form.xml)) {
    return { xml: form.xml.replace("</Form>", `${block}</Form>`), bound: additions, repaired: repair.repaired };
  }
  return { xml: form.xml, bound: [], repaired: repair.repaired };
}
function describeBindings(byForm) {
  const touched = byForm.filter((entry) => entry.bound.length > 0 || (entry.repaired?.length ?? 0) > 0);
  if (!touched.length)
    return null;
  const lines = [
    "",
    "Привязаны обработчики событий формы (правка внесена в Form.xml до сборки, сборка уже с ней —",
    "это сделал инструмент, а не ты):"
  ];
  for (const entry of touched) {
    for (const item of entry.bound) {
      lines.push(`- ${entry.form}: <Event name="${item.event}">${item.procedure}</Event>`);
    }
    for (const procedure of entry.repaired ?? []) {
      lines.push(`- ${entry.form}: у «${procedure}» имя процедуры перенесено из вложенного <Handler> в текст элемента —` + " платформа <Handler> отбрасывает, и событие оставалось без обработчика.");
    }
  }
  lines.push("", "В конфигураторе это делает интерфейс при создании обработчика; в XML по имени не", "привязывается ничто, поэтому процедура без такой строки — мёртвый код. Если какая-то из них", "не должна была вызываться, убери строку из `<Events>` и процедуру из модуля.");
  return lines.join(`
`);
}
function describeFormBindings(byForm) {
  const broken = byForm.filter((entry) => entry.findings.length > 0);
  if (!broken.length)
    return null;
  const lines = [
    "",
    "⚠ Проверка привязки обработчиков (по Form.xml и Module.bsl):",
    "",
    "В конфигураторе обработчик привязывается сам, когда ты его создаёшь через интерфейс. В XML",
    "по имени не привязывается ничто: процедура без ссылки на неё — мёртвый код, который",
    "компилируется и не выполняется, поэтому ни сборка, ни `1c_check_epf` этого не видят."
  ];
  for (const entry of broken) {
    lines.push("", `**${entry.form}**`);
    for (const finding of entry.findings)
      lines.push(`- ${finding.procedure}: ${finding.detail}`);
  }
  return lines.join(`
`);
}

// src/main/infobase/mxl.ts
var int = (value) => {
  if (value === undefined)
    return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};
var oneBased = (value) => value === null || value < 0 ? null : value + 1;
function describeFormat(body, fonts, lines) {
  const tag = (name) => new RegExp(`^\\t\\t<${name}>([^<]*)</${name}>`, "m").exec(body)?.[1];
  const line = (value) => value === undefined ? undefined : lines[Number(value)] ?? `линия ${value}`;
  const parts = [];
  const font = tag("font");
  if (font !== undefined)
    parts.push(`шрифт ${fonts[Number(font)] ?? `№${font}`}`);
  const border = line(tag("border"));
  if (border)
    parts.push(`рамка: ${border}`);
  const sides = [
    ["слева", "leftBorder"],
    ["сверху", "topBorder"],
    ["справа", "rightBorder"],
    ["снизу", "bottomBorder"]
  ].flatMap(([side, name]) => {
    const value = line(tag(name));
    return value ? [`${side} ${value}`] : [];
  });
  if (sides.length)
    parts.push(`границы: ${sides.join(", ")}`);
  const width = tag("width");
  if (width)
    parts.push(`ширина ${width}`);
  const height = tag("height");
  if (height)
    parts.push(`высота ${height}`);
  const horizontal = tag("horizontalAlignment");
  if (horizontal)
    parts.push(`по горизонтали ${horizontal}`);
  const placement = tag("textPlacement");
  if (placement)
    parts.push(placement === "Wrap" ? "перенос" : `размещение ${placement}`);
  parts.push(`заполнение ${tag("fillType") ?? "Text"}`);
  const format = /<v8:content>([^<]*)<\/v8:content>/.exec(body)?.[1];
  if (format)
    parts.push(`формат «${format}»`);
  return parts.join("; ");
}
function parseMxlTemplate(xml) {
  const formatBodies = [...xml.matchAll(/^\t<format>([\s\S]*?)^\t<\/format>/gm)].map((match) => match[1] ?? "");
  const formatHeights = formatBodies.map((body) => int(/<height>(-?\d+)<\/height>/.exec(body)?.[1]));
  const lines = [...xml.matchAll(/^\t<line\s([^>]*)>([\s\S]*?)^\t<\/line>/gm)].map((match) => {
    const width = /width="(\d+)"/.exec(match[1] ?? "")?.[1] ?? "?";
    const style = />(\w+)<\/v8ui:style>/.exec(match[2] ?? "")?.[1] ?? "?";
    return style === "None" ? "нет" : `${style === "Solid" ? "сплошная" : style} ${width}`;
  });
  const fonts = [...xml.matchAll(/<font\s([^>]*)\/?>/g)].flatMap((match) => {
    const attributes = match[1] ?? "";
    const face = /faceName="([^"]*)"/.exec(attributes)?.[1];
    if (!face)
      return [];
    const size = /height="([^"]*)"/.exec(attributes)?.[1] ?? "?";
    const bold = /bold="true"/.test(attributes) ? " bold" : "";
    const italic = /italic="true"/.test(attributes) ? " italic" : "";
    return [`${face} ${size}${bold}${italic}`];
  });
  const rows = [];
  const duplicates = [];
  for (const item of xml.matchAll(/^\t<rowsItem>([\s\S]*?)^\t<\/rowsItem>/gm)) {
    const block = item[1] ?? "";
    const from = int(/<index>(\d+)<\/index>/.exec(block)?.[1]);
    if (from === null)
      continue;
    const to = int(/<indexTo>(\d+)<\/indexTo>/.exec(block)?.[1]) ?? from;
    const empty = /<empty>\s*true\s*<\/empty>/.test(block);
    const declaredFormat = int(/<formatIndex>(\d+)<\/formatIndex>/.exec(block)?.[1]);
    const formatIndex = declaredFormat === 0 ? null : declaredFormat;
    const height = formatIndex === null ? null : formatHeights[formatIndex - 1] ?? null;
    const cells = [];
    const seen = new Set;
    let column = -1;
    for (const cell of block.matchAll(/<c>\s*(?:<i>(\d+)<\/i>)?([\s\S]*?)<\/c>\s*<\/c>/g)) {
      const declared = int(cell[1]);
      column = declared === null ? column + 1 : declared;
      if (seen.has(column))
        duplicates.push({ row: from + 1, column: column + 1 });
      seen.add(column);
      const inner = cell[2] ?? "";
      const format = int(/<f>(\d+)<\/f>/.exec(inner)?.[1]) ?? undefined;
      const parameter = /<parameter>([^<]*)<\/parameter>/.exec(inner)?.[1];
      const items = [...inner.matchAll(/<v8:lang>([^<]*)<\/v8:lang>\s*<v8:content>([^<]*)<\/v8:content>/g)];
      const text = (items.find((item2) => item2[1] === "ru") ?? items[0])?.[2]?.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
      if (parameter || text) {
        cells.push({
          column: column + 1,
          ...parameter ? { parameter } : {},
          ...text ? { text } : {},
          ...format ? { format } : {}
        });
      }
    }
    for (let index = from;index <= to; index++)
      rows.push({ index: index + 1, empty, formatIndex, height, cells });
  }
  const areas = [...xml.matchAll(/<namedItem[^>]*>([\s\S]*?)<\/namedItem>/g)].flatMap((item) => {
    const block = item[1] ?? "";
    const name = /<name>([^<]*)<\/name>/.exec(block)?.[1];
    if (!name)
      return [];
    return [
      {
        name,
        kind: /<type>([^<]*)<\/type>/.exec(block)?.[1] ?? "unknown",
        firstRow: oneBased(int(/<beginRow>(-?\d+)<\/beginRow>/.exec(block)?.[1])),
        lastRow: oneBased(int(/<endRow>(-?\d+)<\/endRow>/.exec(block)?.[1])),
        firstColumn: oneBased(int(/<beginColumn>(-?\d+)<\/beginColumn>/.exec(block)?.[1])),
        lastColumn: oneBased(int(/<endColumn>(-?\d+)<\/endColumn>/.exec(block)?.[1]))
      }
    ];
  });
  const unmerges = [...xml.matchAll(/<verticalUnmerge>([\s\S]*?)<\/verticalUnmerge>/g)].map((item) => {
    const block = item[1] ?? "";
    return {
      row: int(/<r>(-?\d+)<\/r>/.exec(block)?.[1]),
      column: int(/<c>(-?\d+)<\/c>/.exec(block)?.[1]),
      w: int(/<w>(\d+)<\/w>/.exec(block)?.[1]) ?? 0
    };
  });
  const merges = [...xml.matchAll(/<merge>([\s\S]*?)<\/merge>/g)].flatMap((item) => {
    const block = item[1] ?? "";
    const row = int(/<r>(-?\d+)<\/r>/.exec(block)?.[1]);
    const col = int(/<c>(-?\d+)<\/c>/.exec(block)?.[1]);
    if (col === null)
      return [];
    const w = int(/<w>(\d+)<\/w>/.exec(block)?.[1]) ?? 0;
    const size = { column: col + 1, rows: (int(/<h>(\d+)<\/h>/.exec(block)?.[1]) ?? 0) + 1, columns: w + 1 };
    if (row === -1) {
      const exceptRows = unmerges.filter((u) => u.column === col && u.w === w && u.row !== null).map((u) => u.row + 1);
      return [{ row: null, ...size, exceptRows }];
    }
    if (unmerges.some((u) => u.row === row && u.column === col))
      return [];
    return [{ row: oneBased(row), ...size }];
  });
  const columnWidths = [];
  for (const item of xml.matchAll(/<columnsItem>([\s\S]*?)<\/columnsItem>/g)) {
    const index = int(/<index>(\d+)<\/index>/.exec(item[1] ?? "")?.[1]);
    const format = int(/<formatIndex>(\d+)<\/formatIndex>/.exec(item[1] ?? "")?.[1]);
    if (index === null)
      continue;
    columnWidths[index] = format ? int(/<width>(\d+)<\/width>/.exec(formatBodies[format - 1] ?? "")?.[1]) : null;
  }
  const formats = formatBodies.map((body) => describeFormat(body, fonts, lines));
  return { rows, areas, merges, formatHeights, fonts, formats, duplicates, columnWidths: [...columnWidths].map((value) => value ?? null) };
}
function hidingMerge(template, row, column) {
  for (const merge of template.merges) {
    const inColumns = column >= merge.column && column < merge.column + merge.columns;
    if (!inColumns)
      continue;
    if (merge.row === null) {
      if (column !== merge.column && !(merge.exceptRows ?? []).includes(row))
        return merge;
      continue;
    }
    const inRows = row >= merge.row && row < merge.row + merge.rows;
    if (inRows && !(row === merge.row && column === merge.column))
      return merge;
  }
  return null;
}
function mergeLabel(merge) {
  const columns = merge.columns > 1 ? `колонки ${merge.column}–${merge.column + merge.columns - 1}` : `колонка ${merge.column}`;
  if (merge.row !== null)
    return `строка ${merge.row}, колонка ${merge.column}: ${merge.rows} стр. × ${merge.columns} кол.`;
  const except = merge.exceptRows?.length ? `, кроме строк ${merge.exceptRows.join(", ")}` : "";
  return `${columns} объединены во всех строках${except}`;
}
function hiddenCells(template) {
  return template.rows.flatMap((row) => row.cells.flatMap((cell) => {
    const anchor = hidingMerge(template, row.index, cell.column);
    return anchor ? [{ row: row.index, column: cell.column, anchor }] : [];
  }));
}
function mergeTailRows(template) {
  const tails = new Map;
  for (const merge of template.merges) {
    if (merge.row === null || merge.rows < 2)
      continue;
    for (let offset = 1;offset < merge.rows; offset++)
      tails.set(merge.row + offset, merge.row);
  }
  return tails;
}
function describeMxlTemplate(template, area) {
  const tails = mergeTailRows(template);
  const areas = area ? template.areas.filter((item) => item.name === area) : template.areas;
  const lines = [];
  if (area && areas.length === 0) {
    const names = template.areas.map((item) => item.name).join(", ");
    return `Область «${area}» не найдена. Есть: ${names}`;
  }
  lines.push(`Строк: ${template.rows.length}, областей: ${template.areas.length}, объединений: ${template.merges.length}`);
  lines.push("Всё ниже — в нумерации 1С, с единицы.");
  if (template.duplicates.length) {
    lines.push("", "**Макет повреждён: две ячейки в одной колонке** — " + template.duplicates.map((cell) => `строка ${cell.row}, колонка ${cell.column}`).join("; ") + ". Какую из них напечатает платформа, не определено. Оставь одну.");
  }
  const hidden = hiddenCells(template);
  if (hidden.length) {
    lines.push("", "**Не напечатается** — ячейки с содержимым внутри объединения, не в его левом верхнем углу: " + hidden.map((cell) => `строка ${cell.row}, колонка ${cell.column} (${mergeLabel(cell.anchor)})`).join("; ") + ".");
  }
  lines.push("", "## Области");
  for (const item of areas) {
    const rowsPart = item.firstRow === null ? "все строки" : `строки ${item.firstRow}..${item.lastRow}`;
    const colsPart = item.firstColumn === null ? "все колонки" : `колонки ${item.firstColumn}..${item.lastColumn}`;
    lines.push(`- ${item.name} (${item.kind}): ${rowsPart}, ${colsPart}`);
  }
  const shown = areas.filter((item) => item.firstRow !== null);
  const inScope = (row) => !area || shown.some((item) => row.index >= (item.firstRow ?? 0) && row.index <= (item.lastRow ?? 0));
  lines.push("", "## Строки");
  for (const row of template.rows.filter(inScope)) {
    const notes = [];
    const anchor = tails.get(row.index);
    if (anchor !== undefined)
      notes.push(`**продолжение ячейки из строки ${anchor}** — писать сюда нельзя, объединение сломается`);
    if (row.formatIndex === null)
      notes.push("нет формата, а значит и своей высоты");
    else if (row.height === null)
      notes.push(`формат ${row.formatIndex}, высота в нём не задана`);
    else
      notes.push(`высота ${row.height}`);
    if (row.empty)
      notes.push("помечена пустой");
    const content = row.cells.map((cell) => `кол.${cell.column}${cell.format ? ` [ф${cell.format}]` : ""}: ${cell.parameter ? `<${cell.parameter}>` : JSON.stringify(cell.text)}`).join("; ");
    lines.push(`- строка ${row.index}: ${notes.join(", ")}${content ? ` | ${content}` : ""}`);
  }
  const used = [...new Set(template.rows.filter(inScope).flatMap((row) => row.cells.flatMap((cell) => cell.format ? [cell.format] : [])))].sort((a, b) => a - b);
  if (used.length) {
    lines.push("", "## Форматы ячеек выше");
    lines.push("[фN] — N-й формат палитры, с единицы. Здесь — что в нём задано; чего нет, то наследуется.");
    for (const index of used)
      lines.push(`- ф${index}: ${template.formats[index - 1] ?? "нет такого формата"}`);
  }
  if (template.fonts.length) {
    lines.push("", "## Шрифты макета");
    lines.push("Номера — с нуля: так их считает `<font>N</font>` в формате.");
    lines.push(template.fonts.map((font, index) => `${index}: ${font}`).join(" | "));
    lines.push("", "Это палитра, а не соответствие ячейкам. Один формат обслуживает всех: ячейка (`<f>`),", "строка и колонка (`<formatIndex>`) и документ (`<defaultFormatIndex>`) индексируют одну", "палитру, поэтому у формата ячейки шрифта может не быть вовсе — он наследуется. **Действующее", "оформление ячейки спрашивай у объектной модели, а не у XML:**", "", '    Ячейка = Макет.Область("R23C2");', '    Результат = Ячейка.Шрифт.Имя + "/" + Ячейка.Шрифт.Размер + "/жирный=" + Ячейка.Шрифт.Жирный', '        + " гор=" + Ячейка.ГоризонтальноеПоложение + " перенос=" + Ячейка.РазмещениеТекста;', "", "Курсив — это `Шрифт.Наклонный`, не «Курсив». Границы печатай целиком (`Строка(Ячейка.ГраницаСнизу)`):", "у линии нет свойства `СтильЛинии`.");
  }
  const rowsShown = template.rows.filter(inScope).map((row) => row.index);
  const onRows = template.merges.filter((merge) => merge.row !== null && rowsShown.some((index) => index >= merge.row && index < merge.row + merge.rows));
  if (onRows.length) {
    lines.push("", "## Объединения в строках выше");
    lines.push("Печатается только левая верхняя ячейка объединения. Вертикальные — те, из-за которых строка может выглядеть свободной.");
    for (const merge of onRows) {
      const span = merge.rows > 1 ? ` (занимает строки ${merge.row}..${merge.row + merge.rows - 1})` : "";
      lines.push(`- ${mergeLabel(merge)}${span}`);
    }
  }
  const byColumns = template.merges.filter((merge) => merge.row === null);
  if (byColumns.length) {
    lines.push("", "## Объединения колонок (во всех строках)");
    lines.push("В каждой строке эти колонки — одна ячейка с углом в первой из них: текст в остальных не печатается. " + "Отменить объединение в нужных строках — `unmerge_columns` в 1c_mxl_edit.");
    for (const merge of byColumns)
      lines.push(`- ${mergeLabel(merge)}`);
  }
  if (template.columnWidths.some((width) => width !== null)) {
    lines.push("", "## Ширины колонок");
    lines.push(template.columnWidths.map((width, index) => `${index + 1}: ${width ?? "—"}`).join(" | ") + " (в 1/8 символа: 72 — это 9 символов)");
  }
  return lines.join(`
`);
}

// src/main/infobase/mxl-edit.ts
var ROWS_ITEM = /^\t<rowsItem>[\s\S]*?^\t<\/rowsItem>/gm;
var CELL = /<c>\s*(?:<i>(\d+)<\/i>)?([\s\S]*?)<\/c>\s*<\/c>/g;
var FORMAT = /^\t<format>([\s\S]*?)^\t<\/format>\n?/gm;
var FONT = /^\t<font\s[^>]*\/>\n?/gm;
var LINE = /^\t<line\s[\s\S]*?^\t<\/line>\n?/gm;
var MERGE = /^\t<merge>[\s\S]*?^\t<\/merge>\n?/gm;
var FORMAT_TAG_ORDER = [
  "print",
  "drawingBorder",
  "drawingHaveLeftBorder",
  "drawingHaveTopBorder",
  "drawingHaveRightBorder",
  "drawingHaveBottomBorder",
  "font",
  "leftBorder",
  "topBorder",
  "rightBorder",
  "bottomBorder",
  "border",
  "height",
  "borderColor",
  "width",
  "autoWidthCalculation",
  "widthWeightFactor",
  "horizontalAlignment",
  "verticalAlignment",
  "textColor",
  "backColor",
  "patternColor",
  "pattern",
  "textPlacement",
  "fillType",
  "protection",
  "hidden",
  "textOrientation",
  "detailsUse",
  "bySelectedColumns",
  "markNegatives",
  "containsValue",
  "valueType",
  "format",
  "controlType",
  "hyperLink",
  "autoMarkIncomplete",
  "indent",
  "autoIndent",
  "editFormat",
  "columnSizeChange",
  "mask",
  "picIndex",
  "pictureSizeMode",
  "picHorizontalAlignment",
  "picVerticalAlignment",
  "textPosition"
];
function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function unescapeXml(text) {
  return text.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}
var isMerge = (edit) => ("merge" in edit);
var isUnmerge = (edit) => ("unmerge" in edit);
var isUnmergeColumns = (edit) => ("unmerge_columns" in edit);
var isCell = (edit) => !isMerge(edit) && !isUnmerge(edit) && !isUnmergeColumns(edit);
function findRow(xml, row) {
  for (const match of xml.matchAll(ROWS_ITEM)) {
    const block = match[0];
    const from = Number(/<index>(\d+)<\/index>/.exec(block)?.[1]);
    if (from + 1 === row)
      return { start: match.index ?? 0, block };
  }
  return null;
}
function cellsOf(block) {
  const cells = [];
  let column = -1;
  for (const cell of block.matchAll(new RegExp(CELL.source, "gd"))) {
    const declared = cell[1] === undefined ? null : Number(cell[1]);
    column = declared === null ? column + 1 : declared;
    const [innerStart, innerEnd] = cell.indices[2];
    const outerStart = cell.index ?? 0;
    cells.push({
      column: column + 1,
      declared: declared !== null,
      outerStart,
      outerEnd: outerStart + cell[0].length,
      innerStart,
      innerEnd,
      inner: cell[2] ?? ""
    });
  }
  return cells;
}
function textOf(inner) {
  const items = [...inner.matchAll(/<v8:lang>([^<]*)<\/v8:lang>\s*<v8:content>([^<]*)<\/v8:content>/g)];
  const text = (items.find((item) => item[1] === "ru") ?? items[0])?.[2];
  return text === undefined ? undefined : unescapeXml(text);
}
function cellLabel(cell) {
  const parameter = /<parameter>([^<]*)<\/parameter>/.exec(cell.inner)?.[1];
  if (parameter)
    return `кол. ${cell.column} <${parameter}>`;
  const raw = textOf(cell.inner);
  if (raw === undefined)
    return `кол. ${cell.column} (пусто)`;
  const text = raw.replace(/\s+/g, " ").trim();
  return `кол. ${cell.column} «${text.length > 30 ? `${text.slice(0, 30)}…` : text}»`;
}
var hasContent = (cell) => /<parameter>|<v8:content>[^<]/.test(cell.inner);
function missingCells(xml, edits) {
  const cellEdits = edits.filter(isCell);
  const creating = new Set(cellEdits.filter((edit) => edit.create).map((edit) => `${edit.row}:${edit.column}`));
  const problems = cellEdits.flatMap((edit) => {
    const found = findRow(xml, edit.row);
    if (!found)
      return [`- строка ${edit.row}: строки с ячейками в макете нет (пустые строки ячеек не имеют)`];
    const cells = cellsOf(found.block);
    if (cells.some((item) => item.column === edit.column) || creating.has(`${edit.row}:${edit.column}`))
      return [];
    const present = cells.map(cellLabel).join("; ") || "ячеек нет";
    return [
      `- строка ${edit.row}, колонка ${edit.column}: такой ячейки нет. В строке: ${present}. ` + "Создать — `create: true` (формат можно взять у соседней: `like`)."
    ];
  });
  if (!problems.length)
    return null;
  return [`Не найдено ячеек: ${problems.length} из ${cellEdits.length}.`, ...problems].join(`
`);
}
function chunksOf(body) {
  return [...body.matchAll(/^\t\t<(\w+)>[\s\S]*?<\/\1>\n/gm)].map((match) => ({ tag: match[1], text: match[0] }));
}
function setTag(body, tag, value) {
  const chunks = chunksOf(body).filter((chunk) => chunk.tag !== tag);
  if (value !== null) {
    const rank = (name) => {
      const index = FORMAT_TAG_ORDER.indexOf(name);
      return index < 0 ? FORMAT_TAG_ORDER.length : index;
    };
    const at = chunks.findIndex((chunk2) => rank(chunk2.tag) > rank(tag));
    const chunk = { tag, text: `		<${tag}>${value}</${tag}>
` };
    chunks.splice(at < 0 ? chunks.length : at, 0, chunk);
  }
  return chunks.map((chunk) => chunk.text).join("");
}
var tagValue = (body, tag) => body === undefined ? undefined : new RegExp(`^\\t\\t<${tag}>([^<]*)</${tag}>`, "m").exec(body)?.[1];
var fillTypeOf = (body) => tagValue(body, "fillType") ?? "Text";
function palettes(xml) {
  return {
    formats: [...xml.matchAll(FORMAT)],
    fonts: [...xml.matchAll(FONT)],
    lines: [...xml.matchAll(LINE)]
  };
}
var bodyOf = (match) => match?.[1] === undefined ? undefined : match[1].replace(/^\n/, "");
function internFormat(xml, body) {
  const { formats } = palettes(xml);
  const existing = formats.findIndex((item) => bodyOf(item) === body);
  if (existing >= 0)
    return { xml, index: existing + 1 };
  const last = formats.at(-1);
  if (!last)
    return { error: "В макете нет палитры форматов — править нечего." };
  const at = (last.index ?? 0) + last[0].length;
  return { xml: xml.slice(0, at) + `	<format>
${body}	</format>
` + xml.slice(at), index: formats.length + 1 };
}
function internFont(xml, entry) {
  const { fonts } = palettes(xml);
  const existing = fonts.findIndex((item) => item[0].trimEnd() === entry);
  if (existing >= 0)
    return { xml, index: existing };
  const last = fonts.at(-1);
  const at = (last.index ?? 0) + last[0].length;
  return { xml: xml.slice(0, at) + `${entry}
` + xml.slice(at), index: fonts.length };
}
function thinLine(xml) {
  const { lines } = palettes(xml);
  const existing = lines.findIndex((item) => /width="1"/.test(item[0]) && /SpreadsheetDocumentCellLineType">Solid</.test(item[0]));
  if (existing >= 0)
    return { xml, index: existing };
  const last = lines.at(-1);
  if (!last)
    return { error: "В макете нет палитры линий — подчеркнуть нечем." };
  const at = (last.index ?? 0) + last[0].length;
  const entry = `	<line width="1" gap="false">
` + `		<v8ui:style xsi:type="v8ui:SpreadsheetDocumentCellLineType">Solid</v8ui:style>
` + `	</line>
`;
  return { xml: xml.slice(0, at) + entry + xml.slice(at), index: lines.length };
}
function effectiveFont(xml, cellFormat, rowBlock) {
  const { formats, fonts } = palettes(xml);
  const byFormat = (index) => index && index > 0 ? formats[index - 1]?.[1] : undefined;
  const rowFormat = byFormat(Number(/<formatIndex>(\d+)<\/formatIndex>/.exec(rowBlock)?.[1]));
  const defaultFormat = byFormat(Number(/<defaultFormatIndex>(\d+)<\/defaultFormatIndex>/.exec(xml)?.[1]));
  const font = [cellFormat, rowFormat, defaultFormat].map((body) => tagValue(body, "font")).find((value) => value !== undefined);
  const entry = fonts[Number(font ?? 0)]?.[0].trimEnd();
  return entry ?? null;
}
function styled(xml, body, style, rowBlock) {
  let next = body;
  let out = xml;
  if (style.bold !== undefined || style.size !== undefined) {
    const font = effectiveFont(out, body || undefined, rowBlock);
    if (!font)
      return { error: "В макете нет палитры шрифтов — сменить шрифт нечему." };
    if (!/faceName=/.test(font)) {
      return { error: "Шрифт ячейки задан стилем конфигурации, а не явно — размер и жирность этим инструментом не поменять." };
    }
    const bold = style.bold === undefined ? font : font.replace(/bold="[^"]*"/, `bold="${style.bold}"`);
    const changed = style.size === undefined ? bold : bold.replace(/height="[^"]*"/, `height="${style.size}"`);
    const interned = internFont(out, changed);
    out = interned.xml;
    next = setTag(next, "font", String(interned.index));
  }
  if (style.underline !== undefined) {
    const collapsed = tagValue(next, "border");
    if (collapsed !== undefined) {
      next = setTag(next, "border", null);
      for (const side of ["leftBorder", "topBorder", "rightBorder", "bottomBorder"])
        next = setTag(next, side, collapsed);
    }
    if (style.underline) {
      const line = thinLine(out);
      if ("error" in line)
        return line;
      out = line.xml;
      next = setTag(next, "bottomBorder", String(line.index));
    } else {
      next = setTag(next, "bottomBorder", null);
    }
  }
  if (style.align !== undefined)
    next = setTag(next, "horizontalAlignment", style.align);
  if (style.wrap !== undefined)
    next = setTag(next, "textPlacement", style.wrap ? "Wrap" : null);
  return { xml: out, body: next };
}
function mergesOf(xml) {
  return [...xml.matchAll(MERGE)].flatMap((match) => {
    const block = match[0];
    const number = (tag) => Number(new RegExp(`<${tag}>(-?\\d+)</${tag}>`).exec(block)?.[1] ?? 0);
    if (number("r") < 0)
      return [];
    return {
      row: number("r") + 1,
      column: number("c") + 1,
      rows: number("h") + 1,
      columns: number("w") + 1,
      start: match.index ?? 0,
      text: block
    };
  });
}
var columnMergesOf = (xml) => parseMxlTemplate(xml).merges.filter((merge) => merge.row === null);
function columnMergeClash(xml, box) {
  const rows = Array.from({ length: box.rows }, (_, offset) => box.row + offset);
  return columnMergesOf(xml).find((merge) => box.column < merge.column + merge.columns && merge.column < box.column + box.columns && rows.some((row) => !(merge.exceptRows ?? []).includes(row))) ?? null;
}
var overlaps = (a, b) => a.row < b.row + b.rows && b.row < a.row + a.rows && a.column < b.column + b.columns && b.column < a.column + a.columns;
var boxText = (box) => `строка ${box.row}, колонка ${box.column}: ${box.rows} стр. × ${box.columns} кол.`;
function mergeXml(box) {
  return [
    "\t<merge>",
    `		<r>${box.row - 1}</r>`,
    `		<c>${box.column - 1}</c>`,
    ...box.rows > 1 ? [`		<h>${box.rows - 1}</h>`] : [],
    ...box.columns > 1 ? [`		<w>${box.columns - 1}</w>`] : [],
    "\t</merge>",
    ""
  ].join(`
`);
}
function applyMerge(xml, box) {
  if (box.rows < 1 || box.columns < 1 || box.rows * box.columns < 2) {
    return { error: `Объединение ${boxText(box)}: нужно хотя бы две ячейки.` };
  }
  const merges = mergesOf(xml);
  const same = merges.find((item) => item.row === box.row && item.column === box.column);
  const clashing = merges.filter((item) => item !== same && overlaps(item, box));
  if (clashing.length) {
    return {
      error: `Объединение ${boxText(box)} задевает другие: ${clashing.map(boxText).join("; ")}. ` + "Сначала разъедини их (`unmerge`) или выбери другой размер."
    };
  }
  const columnMerge = columnMergeClash(xml, box);
  if (columnMerge) {
    return {
      error: `Объединение ${boxText(box)} попадает на объединение колонок: ${mergeLabel(columnMerge)}. ` + "В этих строках его сначала надо отменить (`unmerge_columns`)."
    };
  }
  const hidden = [];
  for (let row = box.row;row < box.row + box.rows; row++) {
    const found = findRow(xml, row);
    if (!found)
      continue;
    for (const cell of cellsOf(found.block)) {
      const inside = cell.column >= box.column && cell.column < box.column + box.columns;
      const anchor = row === box.row && cell.column === box.column;
      if (inside && !anchor && hasContent(cell))
        hidden.push(`строка ${row}, ${cellLabel(cell)}`);
    }
  }
  if (hidden.length) {
    return {
      error: `Объединение ${boxText(box)} накроет ячейки с содержимым: ${hidden.join("; ")}. Внутри объединения ` + "печатается только левая верхняя ячейка — остальное пропадёт. Очисти их или выбери другой размер."
    };
  }
  if (same)
    return { xml: xml.slice(0, same.start) + mergeXml(box) + xml.slice(same.start + same.text.length) };
  const last = merges.at(-1);
  const at = last ? last.start + last.text.length : (() => {
    const vg = /^\t<vgRows>\d+<\/vgRows>\n/m.exec(xml);
    return vg ? (vg.index ?? 0) + vg[0].length : -1;
  })();
  if (at < 0)
    return { error: "Не нашёл, куда записать объединение: в макете нет ни объединений, ни <vgRows>." };
  return { xml: xml.slice(0, at) + mergeXml(box) + xml.slice(at) };
}
function applyUnmerge(xml, row, column) {
  const merges = mergesOf(xml);
  const found = merges.find((item) => item.row === row && item.column === column);
  if (!found) {
    const near = merges.filter((item) => item.row === row).map(boxText).join("; ") || "нет";
    return { error: `Объединения с левой верхней ячейкой в строке ${row}, колонке ${column} нет. В этой строке: ${near}.` };
  }
  return { xml: xml.slice(0, found.start) + xml.slice(found.start + found.text.length) };
}
function applyUnmergeColumns(xml, edit) {
  const merges = columnMergesOf(xml);
  const merge = merges.find((item) => edit.column >= item.column && edit.column < item.column + item.columns);
  if (!merge) {
    const listed = merges.map(mergeLabel).join("; ") || "их в макете нет";
    return { error: `Колонка ${edit.column} не входит ни в одно объединение колонок. Объединения колонок: ${listed}.` };
  }
  const rows = Array.from({ length: edit.rows ?? 1 }, (_, offset) => edit.row + offset).filter((row) => !(merge.exceptRows ?? []).includes(row));
  const entries = rows.map((row) => [
    "\t<verticalUnmerge>",
    `		<r>${row - 1}</r>`,
    `		<c>${merge.column - 1}</c>`,
    ...merge.columns > 1 ? [`		<w>${merge.columns - 1}</w>`] : [],
    "\t</verticalUnmerge>",
    ""
  ].join(`
`)).join("");
  const last = [...xml.matchAll(/^\t<verticalUnmerge>[\s\S]*?^\t<\/verticalUnmerge>\n/gm)].at(-1) ?? [...xml.matchAll(MERGE)].at(-1);
  if (!last)
    return { error: "Не нашёл, куда записать отмену объединения." };
  const at = (last.index ?? 0) + last[0].length;
  return { xml: xml.slice(0, at) + entries + xml.slice(at), rows };
}
function createCell(xml, row, column, format) {
  const found = findRow(xml, row);
  if (!found)
    return { error: `Строки ${row} с ячейками в макете нет.` };
  if (/<indexTo>/.test(found.block))
    return { error: `Строка ${row} — часть диапазона пустых строк; ячейку в неё не добавить.` };
  const cells = cellsOf(found.block);
  const indent = "\t\t\t";
  const cell = [
    `${indent}<c>`,
    `${indent}	<i>${column - 1}</i>`,
    `${indent}	<c>`,
    ...format ? [`${indent}		<f>${format}</f>`] : [],
    `${indent}	</c>`,
    `${indent}</c>`
  ].join(`
`);
  const next = cells.find((item) => item.column > column);
  let block = found.block;
  if (next) {
    const fixed = next.declared ? "" : `
${indent}	<i>${next.column - 1}</i>`;
    const head = block.slice(0, next.outerStart);
    const nextCell = block.slice(next.outerStart, next.outerEnd).replace(/^<c>/, `<c>${fixed}`);
    block = `${head}${cell.trimStart()}
${indent}${nextCell}${block.slice(next.outerEnd)}`;
  } else {
    const last = cells.at(-1);
    if (last)
      block = `${block.slice(0, last.outerEnd)}
${cell}${block.slice(last.outerEnd)}`;
    else {
      const opened = /<row>\n/.exec(block);
      if (!opened)
        return { error: `Строка ${row}: не нашёл, куда вставить ячейку.` };
      const at = (opened.index ?? 0) + opened[0].length;
      block = `${block.slice(0, at)}${cell}
${block.slice(at)}`.replace(/\n\t*<empty>true<\/empty>/, "");
    }
  }
  return { xml: xml.slice(0, found.start) + block + xml.slice(found.start + found.block.length) };
}
function applyCell(xml, edit) {
  let out = xml;
  const exists = () => cellsOf(findRow(out, edit.row)?.block ?? "").some((item) => item.column === edit.column);
  const source = edit.like ? cellsOf(findRow(out, edit.like.row)?.block ?? "").find((item) => item.column === edit.like.column) : undefined;
  if (edit.like && !source)
    return { error: `Ячейки-образца (строка ${edit.like.row}, колонка ${edit.like.column}) нет.` };
  const likeFormat = source ? Number(/<f>(\d+)<\/f>/.exec(source.inner)?.[1] ?? 0) || null : null;
  let created = false;
  if (!exists()) {
    const made = createCell(out, edit.row, edit.column, likeFormat);
    if ("error" in made)
      return made;
    out = made.xml;
    created = true;
  }
  const wanted = edit.text !== undefined ? "Text" : edit.template !== undefined ? "Template" : edit.parameter !== undefined ? "Parameter" : null;
  const row = findRow(out, edit.row);
  const cell = cellsOf(row.block).find((item) => item.column === edit.column);
  const formatIndex = Number(/<f>(\d+)<\/f>/.exec(cell.inner)?.[1] ?? "0");
  const current = formatIndex > 0 ? bodyOf(palettes(out).formats[formatIndex - 1]) : undefined;
  const start = likeFormat !== null && !created ? bodyOf(palettes(out).formats[likeFormat - 1]) : current;
  let body = start ?? "";
  if (wanted && fillTypeOf(start) !== wanted)
    body = setTag(body, "fillType", wanted === "Text" ? null : wanted);
  if (edit.style) {
    const result = styled(out, body, edit.style, row.block);
    if ("error" in result)
      return result;
    out = result.xml;
    body = result.body;
  }
  let newFormat = null;
  if (body !== (current ?? "")) {
    if (!body.trim())
      newFormat = 0;
    else {
      const interned = internFormat(out, body);
      if ("error" in interned)
        return interned;
      out = interned.xml;
      newFormat = interned.index;
    }
  }
  const again = findRow(out, edit.row);
  const target = cellsOf(again.block).find((item) => item.column === edit.column);
  const indent = /\n(\t+)<f>/.exec(target.inner)?.[1] ?? "\t\t\t\t\t";
  let inner = target.inner;
  const content = wanted !== null || edit.clear;
  if (content) {
    inner = inner.replace(/\n\t*<parameter>[^<]*<\/parameter>/g, "").replace(/\n\t*<tl>[\s\S]*?<\/tl>/g, "").replace(/\n\t*<tl\/>/g, "");
  }
  if (newFormat === 0)
    inner = inner.replace(/\n\t*<f>\d+<\/f>/, "");
  else if (newFormat !== null) {
    inner = /<f>\d+<\/f>/.test(inner) ? inner.replace(/<f>\d+<\/f>/, `<f>${newFormat}</f>`) : inner.replace(/<c>/, `<c>
${indent}<f>${newFormat}</f>`);
  }
  const value = edit.parameter !== undefined ? `
${indent}<parameter>${escapeXml(edit.parameter)}</parameter>` : edit.text !== undefined || edit.template !== undefined ? [
    `
${indent}<tl>`,
    `${indent}	<v8:item>`,
    `${indent}		<v8:lang>ru</v8:lang>`,
    `${indent}		<v8:content>${escapeXml(edit.text ?? edit.template ?? "")}</v8:content>`,
    `${indent}	</v8:item>`,
    `${indent}</tl>`
  ].join(`
`) : "";
  if (value)
    inner = /<f>\d+<\/f>/.test(inner) ? inner.replace(/(<f>\d+<\/f>)/, `$1${value}`) : inner.replace(/<c>/, `<c>${value}`);
  out = out.slice(0, again.start + target.innerStart) + inner + out.slice(again.start + target.innerEnd);
  const described = [
    ...created ? ["создана"] : [],
    ...edit.parameter !== undefined ? [`параметр <${edit.parameter}>`] : edit.text !== undefined ? [`текст ${JSON.stringify(edit.text)}`] : edit.template !== undefined ? [`шаблон ${JSON.stringify(edit.template)}`] : edit.clear ? ["пусто"] : [],
    ...edit.style ? [`оформление ${JSON.stringify(edit.style)}`] : []
  ].join(", ");
  return { xml: out, change: `строка ${edit.row}, колонка ${edit.column}: ${described}${newFormat === 0 ? " (без своего формата)" : newFormat !== null ? ` (формат ${newFormat})` : ""}` };
}
function malformed(edit) {
  if (!isCell(edit))
    return null;
  const kinds = [edit.text !== undefined, edit.template !== undefined, edit.parameter !== undefined, edit.clear === true];
  if (kinds.filter(Boolean).length > 1)
    return `Строка ${edit.row}, колонка ${edit.column}: не больше одного из text, template, parameter, clear.`;
  if (!kinds.some(Boolean) && !edit.style && !edit.create) {
    return `Строка ${edit.row}, колонка ${edit.column}: нечего менять — нужно одно из text, template, parameter, clear или style.`;
  }
  return null;
}
function editMxlCells(file, edits) {
  const crlf = file.includes(`\r
`);
  const original = crlf ? file.replace(/\r\n/g, `
`) : file;
  const bad = edits.map(malformed).find((error) => error !== null);
  if (bad)
    return { ok: false, error: bad };
  const missing = missingCells(original, edits);
  if (missing)
    return { ok: false, error: missing };
  let xml = original;
  const changes = [];
  for (const edit of edits) {
    if (isMerge(edit)) {
      const result2 = applyMerge(xml, edit.merge);
      if ("error" in result2)
        return { ok: false, error: result2.error };
      xml = result2.xml;
      changes.push(`объединение: ${boxText(edit.merge)}`);
      continue;
    }
    if (isUnmerge(edit)) {
      const result2 = applyUnmerge(xml, edit.unmerge.row, edit.unmerge.column);
      if ("error" in result2)
        return { ok: false, error: result2.error };
      xml = result2.xml;
      changes.push(`разъединено: строка ${edit.unmerge.row}, колонка ${edit.unmerge.column}`);
      continue;
    }
    if (isUnmergeColumns(edit)) {
      const result2 = applyUnmergeColumns(xml, edit.unmerge_columns);
      if ("error" in result2)
        return { ok: false, error: result2.error };
      xml = result2.xml;
      changes.push(result2.rows.length ? `объединение колонок отменено в строках ${result2.rows.join(", ")}` : "объединение колонок в этих строках уже отменено — ничего не менял");
      continue;
    }
    const result = applyCell(xml, edit);
    if ("error" in result)
      return { ok: false, error: result.error };
    xml = result.xml;
    changes.push(result.change);
  }
  const before = parseMxlTemplate(original);
  const after = parseMxlTemplate(xml);
  const key = (box) => `${box.row}:${box.column}:${box.rows}:${box.columns}:${[...box.exceptRows ?? []].sort((a, b) => a - b).join(",")}`;
  const expected = new Map(before.merges.map((box) => [`${box.row}:${box.column}`, box]));
  for (const edit of edits) {
    if (isMerge(edit))
      expected.set(`${edit.merge.row}:${edit.merge.column}`, edit.merge);
    if (isUnmerge(edit))
      expected.delete(`${edit.unmerge.row}:${edit.unmerge.column}`);
    if (isUnmergeColumns(edit)) {
      const cancel = edit.unmerge_columns;
      const added = Array.from({ length: cancel.rows ?? 1 }, (_, offset) => cancel.row + offset);
      for (const [at, box] of expected) {
        if (box.row !== null || cancel.column < box.column || cancel.column >= box.column + box.columns)
          continue;
        expected.set(at, { ...box, exceptRows: [...new Set([...box.exceptRows ?? [], ...added])] });
      }
    }
  }
  const sameMerges = JSON.stringify([...expected.values()].map(key).sort()) === JSON.stringify(after.merges.map(key).sort());
  const sameShape = before.rows.length === after.rows.length && JSON.stringify(before.areas) === JSON.stringify(after.areas);
  if (!sameMerges || !sameShape)
    return { ok: false, error: "После правки геометрия макета не та, что заказана — правка отменена." };
  if (/^\t<format>\n\t<\/format>/m.test(xml) && !/^\t<format>\n\t<\/format>/m.test(original)) {
    return { ok: false, error: "После правки в палитре оказался пустой формат — правка отменена." };
  }
  const wasHidden = new Set(hiddenCells(before).map((cell) => `${cell.row}:${cell.column}`));
  const nowHidden = hiddenCells(after).filter((cell) => !wasHidden.has(`${cell.row}:${cell.column}`));
  if (nowHidden.length) {
    return {
      ok: false,
      error: "После правки не напечатаются ячейки с содержимым — в объединении печатается только его первая ячейка: " + nowHidden.map((cell) => `строка ${cell.row}, колонка ${cell.column} (${mergeLabel(cell.anchor)})`).join("; ") + ". Правка отменена. " + (nowHidden.some((cell) => cell.anchor.row === null) ? "Объединение колонок в нужных строках отменяет `unmerge_columns`." : "Объединение разъединяет `unmerge`.")
    };
  }
  const duplicated = after.duplicates.filter((cell) => !before.duplicates.some((item) => item.row === cell.row && item.column === cell.column));
  if (duplicated.length)
    return { ok: false, error: "После правки в строке оказались две ячейки в одной колонке — правка отменена." };
  const out = crlf ? xml.replace(/\n/g, `\r
`).replace(/<v8:content>[\s\S]*?<\/v8:content>/g, (text) => text.replace(/\r\n/g, `
`)) : xml;
  return { ok: true, xml: out, changes };
}

// src/main/infobase/shell.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
var SHELL_ENV = {
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1"
};
var ENCODING_PREAMBLE = "$OutputEncoding=New-Object System.Text.UTF8Encoding $false; " + "try{[Console]::OutputEncoding=$OutputEncoding}catch{}; ";
function hasEncodingSetup(command) {
  return /OutputEncoding/.test(command);
}
function withEncoding(command, platform = process.platform) {
  if (platform !== "win32")
    return command;
  if (!command.trim() || hasEncodingSetup(command))
    return command;
  return ENCODING_PREAMBLE + command;
}
var RECURSIVE_CONTENT_SEARCH = /Get-ChildItem[^|]*-Recurse[^|]*\|[^|]*Select-String/i;
var PLATFORM_EXECUTABLE = /1cv8c?(?:\.exe)?/i;
var PLATFORM_MODE = /(?:^|[\s"'`(,])(DESIGNER|ENTERPRISE)(?=[\s"'`),]|$)/i;
var GUARDED_SWITCHES = [
  [/\/DumpConfigToFiles/i, "1c_dump_config_to_files"],
  [/\/DumpCfg/i, "1c_dump_config"],
  [/\/LoadConfigFromFiles/i, "1c_load_config_from_files"],
  [/\/LoadCfg/i, "1c_load_config"],
  [/\/DeleteCfg/i, "1c_delete_extension"],
  [/\/UpdateDBCfg/i, "1c_update_db"],
  [/\/Check(?:Config|Modules)/i, "1c_check_config"],
  [/\/DumpExternalDataProcessorOrReportToFiles/i, "1c_dump_epf_to_files"],
  [/\/LoadExternalDataProcessorOrReportFromFiles/i, "1c_load_epf_from_files"],
  [/MCP_Toolkit/i, "1c_toolkit_start"],
  [/\/Execute/i, "1c_run_epf"]
];
function platformLaunchRefusal(command) {
  if (!PLATFORM_EXECUTABLE.test(command))
    return null;
  const mode = PLATFORM_MODE.exec(command)?.[1]?.toUpperCase();
  if (!mode)
    return null;
  const replacement = GUARDED_SWITCHES.find(([pattern]) => pattern.test(command))?.[1];
  const hasExtensionScope = /-Extension\b/i.test(command);
  return [
    `Отклонено: это 1CCoder не пропускает запуск платформы (${mode}) через оболочку — команда не выполнялась.`,
    "",
    "Запуск из оболочки обходит всё, что делают инструменты 1c_*: конфигуратор не может работать",
    "с базой, которую держит сеанс MCP Toolkit, и инструмент сначала закрывает тулкит, передаёт",
    "учётные данные профиля, читает журнал /Out именно этого запуска и не даёт поднять тулкит,",
    "пока операция идёт. Команда из оболочки ничего из этого не делает.",
    "",
    replacement ? `Для этой операции есть инструмент: \`${replacement}\`.` + (hasExtensionScope ? " Команда ограничена расширением — передай его имя параметром `extension`, тогда инструмент сделает" + " ровно то же самое (`-Extension`) со всеми проверками." : "") : "Для этой операции инструмента нет. Покажи пользователю команду и попроси запустить её самого — " + "с закрытым окном MCP Toolkit.",
    "",
    "Если инструмент сообщил об ошибке, это не повод идти в оболочку: сначала проверь, не появился ли",
    "результат (каталог выгрузки, собранный файл) — сообщение об ошибке связи не означает, что",
    "операция не выполнилась."
  ].join(`
`);
}
var RG_COMMAND = /(?:^|[;|&\n(])\s*(?:&\s*)?rg(?:\.exe)?(?=\s|$)/i;
var onPathCache = new Map;
function onPath(name, env = process.env) {
  const cached = onPathCache.get(name);
  if (cached !== undefined)
    return cached;
  const dirs = (env.PATH ?? env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  const found = dirs.some((dir) => names.some((file) => existsSync(join(dir, file))));
  onPathCache.set(name, found);
  return found;
}
function shellRefusal(command, rgAvailable = () => onPath("rg")) {
  const launch = platformLaunchRefusal(command);
  if (launch)
    return launch;
  if (RG_COMMAND.test(command) && !rgAvailable()) {
    return [
      "Отклонено: `rg` на этой машине не установлен — команда упала бы с «rg is not recognized».",
      "",
      "Тот же поиск делает инструмент `grep` (он сам на ripgrep), с `path` и `include`:",
      "",
      '    grep(pattern: "<что ищешь>", path: "<каталог>", include: "*.bsl")'
    ].join(`
`);
  }
  if (!RECURSIVE_CONTENT_SEARCH.test(command))
    return null;
  return [
    "Отклонено: рекурсивный поиск по содержимому через PowerShell.",
    "",
    "`Get-ChildItem -Recurse | Select-String` по дереву выгрузки конфигурации упирается в таймаут",
    "(десятки тысяч файлов — дольше лимита команды) и возвращает искажённые пути. Инструмент",
    "`grep` отвечает на тот же вопрос за секунды.",
    "",
    "Укажи `path` — без него `grep` ищет в рабочем каталоге, а не в выгрузке:",
    "",
    '    grep(pattern: "<что ищешь>", path: "<каталог выгрузки>\\\\cfg")'
  ].join(`
`);
}
function commandFrom(toolName, args) {
  if (toolName.toLowerCase() !== "bash")
    return;
  if (typeof args !== "object" || args === null)
    return;
  const command = args.command;
  return typeof command === "string" && command.trim() ? command : undefined;
}

// src/main/infobase/support.ts
var MAX_CLIMB = 12;
var EXTERNAL_ROOT = /<MetaDataObject\b[^>]*>\s*<(?:\w+:)?(?:ExternalDataProcessor|ExternalReport)\b/;
var UUID = /\buuid="([0-9a-fA-F-]{36})"/;
function parentOf(path) {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at <= 0 ? path : path.slice(0, at);
}
function join2(dir, ...parts) {
  return [dir, ...parts].join("\\");
}
function isExternalObjectRoot(path, probe) {
  if (!probe.isFile(path))
    return false;
  const head = probe.readText(path);
  return head !== null && EXTERNAL_ROOT.test(head.slice(0, 1000));
}
function rootUuid(path, probe) {
  if (!probe.isFile(path))
    return null;
  const text = probe.readText(path);
  if (text === null)
    return null;
  return UUID.exec(text)?.[1] ?? null;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function decideSupport(target, probe) {
  try {
    if (isExternalObjectRoot(target, probe))
      return { blocked: false };
    let elementUuid = rootUuid(target, probe);
    let configDir;
    let binPath;
    let dir = probe.isDirectory(target) ? target : parentOf(target);
    for (let step = 0;step < MAX_CLIMB && dir; step++) {
      if (isExternalObjectRoot(`${dir}.xml`, probe))
        return { blocked: false };
      if (!elementUuid)
        elementUuid = rootUuid(`${dir}.xml`, probe);
      if (!configDir) {
        const candidate = join2(dir, "Ext", "ParentConfigurations.bin");
        if (probe.isFile(candidate) || probe.isFile(join2(dir, "Configuration.xml"))) {
          configDir = dir;
          binPath = candidate;
        }
      }
      if (elementUuid && configDir)
        break;
      const up = parentOf(dir);
      if (up === dir)
        break;
      dir = up;
    }
    if (!configDir)
      return { blocked: false };
    if (!elementUuid)
      elementUuid = rootUuid(join2(configDir, "Configuration.xml"), probe);
    if (!binPath || !probe.isFile(binPath))
      return { blocked: false };
    const bytes = probe.readBytes(binPath);
    if (!bytes || bytes.length <= 32)
      return { blocked: false };
    const body = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? bytes.subarray(3) : bytes;
    const text = new TextDecoder("utf-8").decode(body);
    const header = /^\{6,(\d+),(\d+),/.exec(text);
    if (!header)
      return { blocked: false };
    const capability = Number.parseInt(header[1], 10);
    const records = Number.parseInt(header[2], 10);
    if (records === 0)
      return { blocked: false };
    if (capability === 1)
      return { blocked: true, code: "capability-off", configDir };
    if (!elementUuid)
      return { blocked: false };
    const rule = new RegExp(`([0-2]),0,${escapeRegExp(elementUuid.toLowerCase())}`, "g");
    let strictest = null;
    for (let m = rule.exec(text);m !== null; m = rule.exec(text)) {
      const state = Number.parseInt(m[1], 10);
      if (strictest === null || state < strictest)
        strictest = state;
    }
    if (strictest === 0)
      return { blocked: true, code: "locked", configDir };
    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}
function supportRefusal(verdict, target) {
  const where = verdict.configDir ? ` (конфигурация: ${verdict.configDir})` : "";
  const cause = verdict.code === "capability-off" ? "у конфигурации выключена возможность изменения — она целиком на поддержке поставщика" : "объект на замке поставщика";
  return [
    `Правка отклонена: ${cause}${where}.`,
    `Файл: ${target}`,
    "",
    "Менять его напрямую — это снять базу с поддержки: типовые обновления перестанут",
    "ставиться штатно, и вернуть это обратно дорого. Почти всегда задача решается легче:",
    "данными в справочниках, пользовательским макетом печати",
    "(`РегистрСведений.ПользовательскиеМакетыПечати`) или расширением — см. навык",
    "1ccoder-ib-print-forms, «Лестница механизмов».",
    "",
    "Если правка конфигурации действительно нужна — это решение пользователя, а не твоё:",
    "назови цену вслух и спроси."
  ].join(`
`);
}

// src/main/infobase/containment.ts
import { tmpdir } from "node:os";
function normalise(path) {
  return path.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
function tempDirectories(env = process.env) {
  return [tmpdir(), env.TEMP, env.TMP].filter((dir) => typeof dir === "string" && dir.trim().length > 0).map(normalise);
}
function insideTemp(path, temps = tempDirectories()) {
  const target = normalise(path);
  return temps.some((temp) => target === temp || target.startsWith(`${temp}\\`));
}
function insideDirectory(path, directory) {
  const target = normalise(path);
  const root = normalise(directory);
  return root.length > 0 && (target === root || target.startsWith(`${root}\\`));
}
function isAbsolutePath(path) {
  return /^[a-zA-Z]:[\\/]/.test(path.trim()) || /^[\\/]/.test(path.trim());
}
var ARG = String.raw`("[^"]*"|'[^']*'|[^\s"']+)`;
var V8PACK_WRITE = new RegExp(String.raw`v8pack(?:\.cmd|-cli\.mjs)?["']?\s+(?:pack|unpack)\s+${ARG}\s+${ARG}`, "i");
function v8packOutput(command) {
  const match = V8PACK_WRITE.exec(command);
  return match?.[2]?.replace(/^["']|["']$/g, "");
}
function outsideWorkingRefusal(path, workingDirectory) {
  const leaf = path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return [
    `Отклонено: ${path} — вне рабочего каталога профиля (${workingDirectory}). Операция не выполнялась.`,
    "",
    "Всё, что ты создаёшь (выгрузки, .cf/.cfe, собранные и распакованные контейнеры), кладётся в",
    "рабочий каталог — там пользователь это найдёт, и следующий сеанс тоже. Рядом с базой или рядом с",
    "существующей выгрузкой — не место для новых файлов, даже если туда можно писать.",
    `Повтори с путём внутри рабочего каталога, например: ${workingDirectory}\\${leaf || "<имя>"}`,
    "",
    "Читать можно откуда угодно: существующую выгрузку или файл, названный пользователем, открывай",
    "там, где они лежат. Если пользователь сам просил положить результат в другое место — сделай",
    "его в рабочем каталоге и предложи скопировать."
  ].join(`
`);
}
var TEMP_NAMES = [
  String.raw`\$env:(?:TEMP|TMP)\b`,
  String.raw`%(?:TEMP|TMP)%`,
  String.raw`\[(?:System\.)?IO\.Path\]::GetTempPath\(\)`,
  String.raw`\$env:LOCALAPPDATA[\\/]+Temp\b`,
  String.raw`\$TMPDIR\b`,
  String.raw`/tmp/`
];
function escapeRegExp2(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function shellTempWrite(command, temps = tempDirectories()) {
  const literal = temps.map((temp2) => escapeRegExp2(temp2).replace(/\\\\/g, String.raw`[\\/]+`) + String.raw`(?=[\\/"'\s;|)]|$)`);
  const direct = [...TEMP_NAMES, ...literal].join("|");
  const variables = [...command.matchAll(new RegExp(String.raw`\$(\w+)\s*=\s*[^;\n]*?(?:${direct})`, "gi"))].map((match) => String.raw`\$${match[1]}\b`);
  const temp = `(?:${[direct, ...variables].join("|")})`;
  const quote = String.raw`["']?`;
  const writes = [
    String.raw`(?<![-=<])>{1,2}\s*${quote}(${temp}[^"'\s;|]*)`,
    String.raw`\b(?:Out-File|Set-Content|Add-Content|Export-Csv|Export-Clixml|Tee-Object|New-Item|mkdir)\b[^|;\n]*?(?:\s|-\w+\s+)${quote}(${temp}[^"'\s;|]*)`,
    String.raw`\b(?:Copy-Item|Move-Item|copy|cp|move|mv)\b\s+(?:-\w+\s+)*${quote}[^"'\s]+${quote}\s+(?:-Destination\s+)?${quote}(${temp}[^"'\s;|]*)`,
    String.raw`-Destination(?:Path)?\s+${quote}(${temp}[^"'\s;|]*)`,
    String.raw`-OutFile\s+${quote}(${temp}[^"'\s;|]*)`,
    String.raw`WriteAll(?:Text|Lines|Bytes)\s*\(\s*${quote}(${temp}[^"',)]*)`,
    String.raw`ExtractTo(?:File|Directory)\s*\([^,]+,\s*${quote}(${temp}[^"',)]*)`
  ];
  for (const pattern of writes) {
    const match = new RegExp(pattern, "i").exec(command);
    if (match?.[1])
      return match[1];
  }
  return null;
}
function shellTempRefusal(target) {
  return [
    `Отклонено: команда пишет в системный временный каталог (${target}).`,
    "",
    "Промежуточные файлы (извлечённый текст, распакованные архивы, скрипты, копии для правки) клади в",
    "рабочий каталог профиля — его показывает 1c_profile_info; читать из временного каталога можно.",
    "Во временном каталоге пользователь результат не найдёт, очистка его сотрёт, а следующий сеанс",
    "либо сделает работу заново, либо прочитает старый остаток как актуальный."
  ].join(`
`);
}
function tempRefusal(path) {
  return [
    `Отклонено: ${path} — это системный временный каталог.`,
    "",
    "Всё, что ты создаёшь для задачи (выгрузки, распакованные обработки, извлечённый текст,",
    "промежуточные файлы), клади в рабочий каталог профиля — его показывает 1c_profile_info.",
    "Во временном каталоге пользователь результат не найдёт, очистка его сотрёт, а следующий",
    "сеанс либо сделает работу заново, либо прочитает старый остаток как актуальный."
  ].join(`
`);
}

// src/main/profiles/configuration.ts
function parseConfigurationXml(xml) {
  const properties = xml.indexOf("<Properties>");
  if (properties < 0)
    return null;
  const rest = xml.slice(properties);
  const name = /<Name>([^<]+)<\/Name>/.exec(rest)?.[1]?.trim();
  if (!name)
    return null;
  const version = /<Version>([^<]*)<\/Version>/.exec(rest)?.[1]?.trim() ?? "";
  return { name, version };
}
function describeConfiguration(configuration) {
  if (!configuration)
    return "не определена — появится после запуска тулкита или выгрузки конфигурации";
  const bsp = configuration.bspVersion ? `, БСП ${configuration.bspVersion}` : ", без БСП";
  return `${configuration.name} ${configuration.version}${bsp}`;
}

// src/main/infobase/dumps.ts
function existingDump(dir, probe) {
  const root = dir.trim().replace(/[\\/]+$/, "");
  if (!probe.isFile(`${root}/Configuration.xml`) || !probe.isFile(`${root}/ConfigDumpInfo.xml`))
    return null;
  const xml = probe.readText(`${root}/Configuration.xml`);
  const parsed = xml ? parseConfigurationXml(xml) : null;
  const counts = Object.fromEntries((probe.list(root) ?? []).filter((entry) => !entry.includes(".")).map((kind) => [kind, (probe.list(`${root}/${kind}`) ?? []).filter((name) => name.toLowerCase().endsWith(".xml")).length]).filter(([, count]) => count > 0));
  const dumpedAt = probe.mtimeMs(`${root}/ConfigDumpInfo.xml`);
  return {
    root,
    ...parsed ? { name: parsed.name, version: parsed.version } : {},
    ...dumpedAt !== null ? { dumpedAt } : {},
    counts
  };
}
function dumpNearby(parents, probe, configurationName) {
  const found = parents.map((parent) => parent.trim().replace(/[\\/]+$/, "")).filter((parent) => parent.length > 0).flatMap((parent) => (probe.list(parent) ?? []).map((entry) => `${parent}/${entry}`)).filter((dir) => !(probe.readText(`${dir}/Configuration.xml`) ?? "").includes("ConfigurationExtensionPurpose")).map((dir) => existingDump(dir, probe)).filter((dump) => dump !== null).filter((dump) => !configurationName || dump.name === configurationName);
  return found.sort((a, b) => (b.dumpedAt ?? 0) - (a.dumpedAt ?? 0))[0] ?? null;
}
function describeExistingDump(dump, now = Date.now(), elsewhere = false) {
  const age = dump.dumpedAt === undefined ? undefined : Math.max(0, Math.round((now - dump.dumpedAt) / 60000));
  const ageText = age === undefined ? "время выгрузки неизвестно" : age < 90 ? `выгружена ${age} мин назад` : `выгружена ${Math.round(age / 60)} ч назад`;
  const kinds = Object.entries(dump.counts).sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind} ${count}`).join(", ");
  return [
    elsewhere ? `Выгрузка этой конфигурации уже есть — конфигуратор не запускался: ${dump.root}` : `Выгрузка в этом каталоге уже есть — конфигуратор не запускался: ${dump.root}`,
    "",
    `Конфигурация: ${dump.name ?? "?"} ${dump.version ?? ""}`.trimEnd() + ` (${ageText}).`,
    kinds ? `Объекты: ${kinds}.` : "Объектов в выгрузке не найдено.",
    "",
    ...elsewhere ? [
      "Читай её там, где она лежит. Полная выгрузка основной конфигурации идёт десятки минут, а код",
      "расширений в неё не попадает вовсе — для него есть параметр `extension`. Если эта выгрузка",
      "устарела и нужна новая, повтори тот же вызов с `refresh: true`."
    ] : [
      "Читай её. Если конфигурация с тех пор менялась и нужна свежая выгрузка, вызови этот инструмент",
      "ещё раз с `refresh: true` — будут перезаписаны только изменившиеся файлы."
    ]
  ].join(`
`);
}

// src/main/infobase/dump-dirs.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join as join3 } from "node:path";
var nodeDumpProbe = {
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  mtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
  list: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return null;
    }
  }
};
function insideDump(path, probe = nodeDumpProbe) {
  let dir = dirname(path);
  for (let depth = 0;depth < 12; depth++) {
    if (probe.isFile(join3(dir, "ConfigDumpInfo.xml")) && probe.isFile(join3(dir, "Configuration.xml")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
  return null;
}
function dumpWriteRefusal(target, root) {
  return [
    `Отклонено: ${target} — внутри выгрузки конфигурации (${root}).`,
    "",
    "Выгрузка — справочник для чтения: её не правят. Свои файлы (расширение, обработку, заметки) клади в",
    "рабочий каталог профиля; новую выгрузку делает 1c_dump_config_to_files."
  ].join(`
`);
}

// src/main/endpoints.ts
var env = import.meta.env;
var SERVER_URLS = (env.ONECCODER_SERVER_URLS ?? "").split(",").map((url) => url.trim().replace(/\/+$/, "")).filter(Boolean);
var SUPPORT_CONTACT = env.ONECCODER_SUPPORT_CONTACT ?? "";

// src/main/llm/support.ts
var RETRIES_STOPPED = "1CCoder остановил повторы";
var ACCOUNT_BLOCKED = "Доступ к 1CCoder для этой учётной записи приостановлен";

// src/main/infobase/auto-resume.ts
var HUMAN_NEEDED = /not signed in|not authori[sz]ed|unauthori[sz]ed|forbidden|\b40[13]\b|billing|payment|quota|insufficient|balance|credit|subscription|usage limit|rejected|отклон/i;
function classifyError(error) {
  if (!error)
    return { resume: false, reason: "нет сведений об ошибке" };
  if (error.name === "MessageAbortedError")
    return { resume: false, reason: "ход остановлен пользователем" };
  if (error.name === "ProviderAuthError")
    return { resume: false, reason: "нужен вход или ключ доступа к модели" };
  const message = typeof error.data?.message === "string" ? error.data.message : "";
  if (message.includes(RETRIES_STOPPED))
    return { resume: false, reason: "повторы остановлены: связь с сервером 1CCoder нестабильна" };
  if (message.includes(ACCOUNT_BLOCKED))
    return { resume: false, reason: "доступ к 1CCoder приостановлен" };
  if (HUMAN_NEEDED.test(message))
    return { resume: false, reason: `ошибка требует человека: ${message.slice(0, 160)}` };
  return { resume: true };
}
function endedEmpty(messages) {
  const last = messages.at(-1);
  if (!last || last.info.role !== "assistant" || last.info.error)
    return false;
  const parts = last.parts;
  const said = parts.some((part) => part.type === "tool" || part.type === "text" && !!part.text?.trim());
  if (said)
    return false;
  return midWork(messages);
}
function midWork(messages) {
  const turnStart = messages.findLastIndex((message) => message.info.role === "user");
  return messages.slice(turnStart + 1, -1).some((message) => message.parts.some((part) => part.type === "tool"));
}
var NEXT_STEP = /(?<!\p{L})(проверю|сделаю|посмотрю|запущу|выполню|напечатаю|прочитаю|исправлю|поправлю|соберу|пересоберу|загружу|выгружу|добавлю|перейду|попробую|начну|займусь|сравню|открою|вызову|запишу|сохраню|создам|обновлю|удалю|найду|выясню|уточню)(?!\p{L})/iu;
function announcedStep(messages) {
  const last = messages.at(-1);
  if (!last || last.info.role !== "assistant" || last.info.error || last.info.finish !== "stop")
    return null;
  const parts = last.parts;
  if (parts.some((part) => part.type === "tool"))
    return null;
  const text = parts.findLast((part) => part.type === "text" && !!part.text?.trim())?.text?.trim() ?? "";
  if (!text || text.endsWith("?") || !midWork(messages))
    return null;
  const tail = text.split(/(?<=[.!?…])\s+|\n+/).at(-1)?.trim() ?? "";
  if (tail.endsWith(":"))
    return tail;
  const now = /^(сейчас|теперь|далее|дальше|затем|следующим шагом)(?!\p{L})/iu.test(tail);
  if (NEXT_STEP.test(tail) && !/(?<!\p{L})если(?!\p{L})/iu.test(tail) && (now || !/[.!]$/.test(tail)))
    return tail;
  return null;
}
var EMPTY_ANSWER = {
  data: { message: "модель вернула пустой ответ посреди работы, без текста и без вызова инструмента" }
};
function awaitsHuman(messages) {
  const last = messages.findLast((message) => message.info.role === "assistant");
  if (!last)
    return false;
  const parts = last.parts;
  if (parts.some((part) => part.type === "tool" && part.tool === "question" && part.state?.status !== "completed")) {
    return true;
  }
  const text = parts.findLast((part) => part.type === "text" && typeof part.text === "string")?.text?.trim() ?? "";
  return text.endsWith("?");
}
function userSpokeAfterFailure(messages) {
  return messages.at(-1)?.info.role === "user";
}
var RESUME_LIMIT = 3;
var RESUME_WINDOW_MS = 60 * 60 * 1000;
var RESUME_DELAYS_MS = [60000, 5 * 60000, 15 * 60000];

class ResumeBudget {
  now;
  delays;
  used = new Map;
  constructor(now = Date.now, delays = RESUME_DELAYS_MS) {
    this.now = now;
    this.delays = delays;
  }
  next(sessionID) {
    const recent = (this.used.get(sessionID) ?? []).filter((at) => this.now() - at < RESUME_WINDOW_MS);
    this.used.set(sessionID, recent);
    if (recent.length >= RESUME_LIMIT)
      return null;
    return { attempt: recent.length + 1, delayMs: this.delays[recent.length] ?? this.delays.at(-1) ?? 0 };
  }
  record(sessionID) {
    this.used.set(sessionID, [...this.used.get(sessionID) ?? [], this.now()]);
  }
}
function resumeText(attempt, error) {
  if (error.announced !== undefined) {
    return [
      `[1CCoder, автоматически — попытка ${attempt} из ${RESUME_LIMIT}] Ход закончился объявлением следующего шага без вызова: «${error.announced.slice(0, 200)}».`,
      "Сделай этот шаг сейчас — вызовом инструмента, не пересказом. Ход заканчивается, только когда задача",
      "выполнена (итоговый отчёт) или нужно решение пользователя (вопрос)."
    ].join(`
`);
  }
  const message = typeof error.data?.message === "string" ? error.data.message.slice(0, 200) : "без описания";
  return [
    `[1CCoder, автоматически — попытка ${attempt} из ${RESUME_LIMIT}] Ход прервался из-за ошибки, не требующей решения пользователя: ${message}.`,
    "Продолжай с того места, где остановился: сверься со своим списком задач и последними результатами,",
    "не повторяй уже сделанное. Если для продолжения нужно решение пользователя — спроси и остановись."
  ].join(`
`);
}
function exhaustedText(error) {
  const message = typeof error.data?.message === "string" ? error.data.message.slice(0, 200) : "без описания";
  return `[1CCoder] Автоматически продолжить не удалось: ${RESUME_LIMIT} попытки за час закончились той же ошибкой ` + `(${message}). Работа остановлена; продолжу по вашей команде.`;
}

// src/main/infobase/registration.ts
var EXPECTED_PLUGIN_TOOLS = [
  "1c_profile_info",
  "1c_toolkit_start",
  "1c_mxl_info",
  "1c_mxl_edit",
  "1c_compare_with_sample",
  "1c_dump_object",
  "1c_print_capabilities",
  "1c_write_code",
  "1c_check_epf",
  "1c_check_dcs",
  "1c_processes",
  "1c_close_dialog",
  "1c_session_writes",
  "1c_check_config",
  "1c_dump_config",
  "1c_dump_config_to_files",
  "1c_dump_epf_to_files",
  "1c_load_epf_from_files",
  "1c_load_config",
  "1c_load_config_from_files",
  "1c_delete_extension",
  "1c_new_extension",
  "1c_new_external",
  "1c_run_report",
  "1c_update_db",
  "1c_run_epf"
];

// src/main/mcp/toolkit.ts
var MCP_CLIENT_NAME = "1c";

// src/main/skills/packs/bp30.ts
var ID = "bp30";
var VERIFIED_ON = "3.0.205.22";
function frontmatter(name, description) {
  return ["---", `name: ${name}`, `description: ${description.replace(/\s+/g, " ").trim()}`, "---", ""].join(`
`);
}
function invoicePrint(_context) {
  const name = `1ccoder-cfg-${ID}-invoice-print`;
  return {
    name,
    body: [
      frontmatter(name, "Бухгалтерия предприятия 3.0: откуда счёт на оплату берёт заголовок и текст условий, как их " + "поменять для новых счетов, не трогая старые, и как устроен макет ПФ_MXL_СчетЗаказ. Читать " + "вместе с 1ccoder-ib-print-forms, когда задача про счёт покупателю."),
      "# Счёт на оплату в Бухгалтерии предприятия 3.0",
      "",
      `Проверено на БП ${VERIFIED_ON} (БСП 3.1.12). На другом релизе — сверься с базой, прежде чем`,
      "опираться на имена ниже.",
      "",
      "## Заголовок и текст условий — это данные, а не макет",
      "",
      "| Что печатается | Откуда берётся |",
      "|---|---|",
      "| Заголовок счёта | `Справочник.ЗаголовкиСчетовПокупателям` — печатается **наименование** элемента |",
      "| Текст условий внизу | `Справочник.ДополнительныеУсловия`, реквизит `ТекстУсловий` |",
      "",
      "Документ `СчетНаОплатуПокупателю` ссылается на них реквизитами `ЗаголовокСчета` и",
      "`ДополнительныеУсловия`. Новый счёт заполняет их из организации:",
      "`Организации.ЗаголовокСчетаПоУмолчанию` и `Организации.ДополнительныеУсловияПоУмолчанию`",
      "(через `Справочники.Организации.УсловияСчетаНаОплатуПоУмолчанию`).",
      "",
      "## Поменять для новых счетов, не трогая старые",
      "",
      "1. `Справочники.ЗаголовкиСчетовПокупателям.СоздатьЭлемент()` — новый заголовок, нужный текст в",
      "   `Наименование`; при необходимости так же новый элемент `ДополнительныеУсловия` с `ТекстУсловий`.",
      "2. У нужной организации — `ЗаголовокСчетаПоУмолчанию` (и `ДополнительныеУсловияПоУмолчанию`) на",
      "   новые элементы.",
      "3. Старые элементы и уже созданные счета не трогать.",
      "",
      "Переименовать существующий элемент — значит переписать заголовок у **всех** счетов, которые на",
      "него ссылаются, включая счета других организаций. Обновить сами счета циклом — то же самое, и",
      "это нужно, только если пользователь прямо попросил поменять уже выставленные.",
      "",
      "## Макет ПФ_MXL_СчетЗаказ",
      "",
      "Общий макет `ПФ_MXL_СчетЗаказ`. Его заголовок — ячейка, объединённая на две строки:",
      "",
      "```",
      "<merge><r>22</r><c>1</c><h>1</h><w>31</w></merge>",
      "```",
      "",
      "Это строки 23–24 в нумерации встроенного языка. Строка 24 выглядит свободной, но это хвост",
      "заголовка: запись в неё или `Объединить()` разрушают объединение, и заголовок печатается",
      "вертикально. Новую строку добавляй `ВставитьОбласть` (см. 1ccoder-ib-print-forms, §5), а",
      "структуру проверяй `1c_mxl_info` по выгрузке:",
      "",
      "```",
      '1c_mxl_info(path: "<выгрузка>\\\\cfg\\\\CommonTemplates\\\\ПФ_MXL_СчетЗаказ\\\\Ext\\\\Template.xml",',
      '            area: "Заголовок")',
      "```",
      "",
      "## Внешняя печатная форма",
      "",
      "`УправлениеПечатью.СформироватьВнешнююПечатнуюФорму` в этом релизе экспортная — шаг 2 проверки",
      "из 1ccoder-ib-print-forms, §7, здесь доступен."
    ].join(`
`)
  };
}
var bp30 = {
  id: ID,
  title: "Бухгалтерия предприятия 3.0",
  configurations: ["БухгалтерияПредприятия"],
  verifiedOn: [VERIFIED_ON],
  identifiers: [
    "ЗаголовкиСчетовПокупателям",
    "ДополнительныеУсловия",
    "ЗаголовокСчета",
    "СчетНаОплатуПокупателю",
    "ПФ_MXL_СчетЗаказ",
    "ТекстДополнительныхУсловий",
    "УсловияСчетаНаОплатуПоУмолчанию"
  ],
  skills: (context) => [invoicePrint(context)],
  hints: {
    overwrite: "заголовок и текст условий счёта печатаются из `ЗаголовкиСчетовПокупателям.Наименование` и\n" + "`ДополнительныеУсловия.ТекстУсловий`. Новые счета берут их из\n" + "`Организации.ЗаголовокСчетаПоУмолчанию` / `ДополнительныеУсловияПоУмолчанию` — переключи их на\n" + "новый элемент. Подробно — навык `1ccoder-cfg-bp30-invoice-print`.",
    bulk: `чтобы поменять заголовок или условия будущих счетов, документы переписывать не нужно:
` + "достаточно `Организации.ЗаголовокСчетаПоУмолчанию` / `ДополнительныеУсловияПоУмолчанию`.\n" + "Подробно — навык `1ccoder-cfg-bp30-invoice-print`."
  }
};

// src/main/skills/packs/index.ts
var PACKS = [bp30];
function packFor(configurationName) {
  if (!configurationName)
    return;
  return PACKS.find((pack) => pack.configurations.includes(configurationName));
}
function packHint(pack, key) {
  const hint = pack?.hints[key];
  return hint ? `

Для этой конфигурации (${pack.title}):
${hint}` : "";
}

// src/main/skills/agents.ts
var PROFILE_AGENT = "1ccoder-profile";
var NOPROFILE_AGENT = "1ccoder-noprofile";
var DEFAULT_AGENT = "build";
function agentForBinding(profileId, configurationName) {
  if (!profileId)
    return NOPROFILE_AGENT;
  const pack = packFor(configurationName);
  return pack ? packAgentName(pack) : PROFILE_AGENT;
}
function packAgentName(pack) {
  return `${PROFILE_AGENT}-${pack.id}`;
}
function isProfileAgent(name) {
  return name === PROFILE_AGENT || PACKS.some((pack) => name === packAgentName(pack));
}
var INFOBASE_SKILL_PREFIX = "1ccoder-ib-";
var PROFILE_PROMPT = [
  "Ты работаешь с 1С:Предприятие 8 в сеансе, к которому привязан профиль разработчика.",
  "",
  "Тебе доступны: путь к толстому клиенту платформы, информационная база, учётные данные",
  "и рабочий каталог профиля. Ты можешь запускать платформу в пакетном режиме и выполнять",
  "операции с информационной базой.",
  "",
  `Конкретные значения — \`${MCP_CLIENT_NAME}_profile_info\`: имя профиля, путь к платформе,`,
  "информационная база, пользователь, рабочий каталог и состояние MCP Toolkit. Вызови его,",
  "прежде чем что-то искать в файловой системе: угадывать путь к платформе или к базе не нужно.",
  "Пароль не отдаётся никогда — платформу за тебя запускает приложение.",
  "",
  "Любая запись в информационную базу требует подтверждения пользователя — это не",
  "формальность: для многих пользователей это живые рабочие данные, и откатить неудачную",
  "запись гораздо труднее, чем неудачную правку файла. Сначала объясни, что и зачем",
  "меняешь.",
  "",
  "Технически это работает так: `1c_execute_code` **не выполняет** запись в базу и откажет.",
  "Разрешение спрашивает `1c_write_code` — тот же код плюс `objects`, `count` и",
  "`organisations`. Значит, **масштаб и охват нужно узнать до записи**, а не после:",
  "`КОЛИЧЕСТВО(*)` с группировкой по организации — обычный запрос, он ничего не меняет.",
  "Разрешение одноразовое и действует только на этот код.",
  "",
  "Отдельно про охват: в базе может быть несколько организаций. Отбор вида",
  "«где реквизит не равен тому, что я записываю» подмножества не задаёт — он выбирает всё, что",
  "ещё не изменено, то есть всю таблицу. И прежде чем править историю, проверь, нужна ли она",
  "вообще: часто хватает поменять то, откуда значение берут новые документы (значение по",
  "умолчанию, настройку), — новые заполнятся сами, старые останутся как были.",
  "",
  "**Код, который пишет много объектов (загрузка, перенос, групповая правка), пишется так:**",
  "",
  "  - **Ошибка записи не глотается.** `Попытка … Исключение` вокруг записи кладёт текст ошибки",
  "    в протокол и считает строку неудачной. Объект, которому не досталась нужная ссылка (не",
  "    создался элемент справочника), не записывается с пустым полем — строка пропускается.",
  "  - **Пробный прогон идёт тем же путём, что запись.** Внутри транзакции, которая в конце",
  "    отменяется (`НачатьТранзакцию()` … `ОтменитьТранзакцию()`), — тогда он встретит те же ошибки",
  "    записи. Прогон, который только разбирает файлы и ничего не создаёт, проверяет разбор, а не",
  "    загрузку, — так и называй его. Для `1c_write_code` такой прогон тоже запись: скажи в",
  "    `summary`, что транзакция отменяется.",
  "  - **«Найти или создать» с кэшем** кладёт созданный элемент в кэш сразу после записи —",
  "    иначе следующая строка с тем же ключом создаст второй.",
  "  - **После записи сверь итог с данными:** сколько создано объектов каждого вида, заполнены ли",
  "    ссылки в строках. Если проверка нашла испорченное — первым же сообщением скажи пользователю,",
  "    что и сколько, и только потом разбирайся в причине.",
  "",
  "**Прерванный вопрос — не ответ.** Если `question` не вернул выбор, а пользователь просто",
  "написал «продолжай» или ответил в чате, считать это согласием на рекомендованный вариант",
  "нельзя — тем более после долгой паузы, когда список вариантов у него уже не перед",
  "глазами. Спроси заново, одной строкой. Если варианты отличались обратимостью, то",
  "молчание — это всегда обратимый вариант, а не рекомендованный.",
  "",
  "**Вопросы в одном вызове `question` должны быть независимы.** Если ответ на один делает",
  "другой невозможным — это один вопрос, а не два. А если выбранные варианты всё-таки",
  "противоречат друг другу, скажи об этом сразу и не решай противоречие молча в свою",
  "пользу.",
  "",
  "**Меняя данные, по умолчанию добавляй, а не перезаписывай.** Новый элемент справочника",
  "вместо правки существующего — так у пользователя остаётся путь назад. Перезапись",
  "предлагается явно и отдельно для каждого объекта, а не подразумевается для всех",
  "остальных, потому что про один из них ты спросил.",
  "",
  "Бывают справочники, у которых хранимое значение **печатается** — заголовки, тексты условий и",
  "подобное. Переименовав такой элемент или заменив его текст, ты меняешь вид всех документов,",
  "которые на него ссылаются, и в отчёте этого не будет: ты сам этого не заметишь. Найти элемент",
  "по имени и переписать его — почти всегда не то, что просили.",
  "",
  "Правильная последовательность: `СоздатьЭлемент()` → переключить на него то, откуда его берут",
  "новые документы (значение по умолчанию, настройку) → старые элементы не трогать. Поэтому",
  "`1c_write_code` отклоняет правку найденного по имени элемента, пока не передан",
  "`allow_overwrite: true`: это нужно, только если элемент заведён как заготовка именно под эту",
  "задачу, и тогда скажи в `summary`, что в нём было раньше.",
  "",
  "**Не разворачивай решение пользователя без спроса.** Если новая просьба противоречит",
  "тому, что он выбрал раньше, назови противоречие и спроси. Одна строка дешевле, чем",
  "работа не в ту сторону.",
  "",
  "**Называй цену, которой не видно в запросе на подтверждение.** Пользователь читает «загрузить",
  "конфигурацию» — а получает базу, которая больше не обновляется штатно. Если выбранный способ",
  "снимает конфигурацию с поддержки, скрывает типовую команду, требует сопровождения при каждом",
  "обновлении — скажи это словами и спроси, даже когда сама задача сомнений не вызывает.",
  "Подтверждение, в котором не назван необратимый эффект, — это не подтверждение.",
  "",
  `**Пиши пользователю по-русски.** Это язык задачи, базы и самого пользователя. Английский
` + `уместен только внутри кода и в именах файлов. Если задача пришла на другом языке — отвечай
` + "на нём.",
  "",
  "**Пометка на картинке — это и есть задание.** Рамка, стрелка, выделение: человек отметил",
  "ровно то, что нужно изменить. Границы самого скриншота заданием не являются — он снят",
  "пошире, чтобы было видно, куда смотреть. Рамка вокруг двух строк означает две строки, даже",
  "если ниже видно ещё пол-документа. Кажется, что помеченного мало для формулировки задачи, —",
  "спроси; не расширяй объём молча.",
  "",
  "**Прежде чем сказать «готово», перечитай, что обещал по ходу.** Каждое «проверю»,",
  "«уточню», «вернусь к этому» — обязательство: оно либо выполнено, либо названо",
  "невыполненным. Итог «всё готово и проверено», за которым осталось незакрытое обещание,",
  "хуже честного «сделал это, вот это осталось»: пользователь перестаёт перепроверять",
  "ровно тогда, когда это нужнее всего.",
  "",
  "**Ошибка про несуществующее поле, свойство или метод — это вопрос к источнику, а не повод",
  "угадать ещё раз.** У каждого такого вопроса есть инструмент, который отвечает точно:",
  "",
  `  «Поле не найдено "Т.X"» в запросе → ${MCP_CLIENT_NAME}_get_metadata по этому объекту;`,
  `  «Поле объекта не обнаружено (X)», «Ошибка при вызове метода контекста» → ${MCP_CLIENT_NAME}_get_bsl_syntax_help.`,
  "",
  `Состав объекта (реквизиты с типами, табличные части, формы, макеты, модули) без тулкита —`,
  `${MCP_CLIENT_NAME}_dump_object по выгрузке: «Документ.ПриемНаРаботу». XML выгрузки в оболочке не разбирай.`,
  "",
  "Справка по свойству не перечисляет значения перечисления — для них спрашивай сам тип",
  "(«Системные перечисления/…»). Один такой вызов стоит меньше, чем вторая догадка.",
  "",
  "**Одинаковая ошибка на одинаковый вызов дважды — сигнал идти за фактами, а не менять число.**",
  "Первая попытка после ошибки — гипотеза; вторая с тем же результатом означает, что гипотеза",
  "строится не на том. Текст ошибки — это не описание причины, и вычитать из него недостающий",
  "факт нельзя. Спроси источник: прочитай сам файл, выгрузи структуру, запроси базу, посмотри",
  "справку по синтаксису. Один запрос к источнику закрывает то, на что уходит час перебора.",
  "",
  "**Прежде чем делать дорогую вещь — проверь, нет ли её уже.** Один `Test-Path` дешевле десяти",
  "минут повторной выгрузки. И наоборот: **сообщение об ошибке от инструмента говорит о связи с",
  "ним, а не о том, что операция не выполнилась.** Долгая операция могла завершиться успешно и",
  "всё равно вернуть ошибку — сначала посмотри на результат на диске или в базе, потом делай выводы.",
  "",
  "**Проверяй то, что получилось, а не то, что операция прошла.** После сборки или выгрузки",
  "убедись, что артефакт — твой: сравни размер или хеш с исходником, прочитай из него то, что",
  "должен был положить. Файл, побайтово равный заготовке, из которой его копировали, не собран.",
  "",
  "**Что задача говорит о базе — проверь в базе.** Версию конфигурации, включённые опции, валюты,",
  "как хранятся данные — запросом (`Метаданные.Версия` и обычные запросы), а не по тексту задачи.",
  "Расхождения назови пользователю в начале, а не в итоге.",
  "",
  "**Факт, которого нет ни в базе, ни в выгрузке, ни в справке, после двух-трёх попыток — вопрос",
  "пользователю.** Идентификатор формата, файл-образец, путь: одна строка вопроса дешевле, чем поиск по",
  "всему диску, по рабочим каталогам других задач, по коду этого приложения и по файлам платформы, —",
  "туда не ходи. Сначала проверь, нет ли инструмента, который это делает. Перебор форматов, мест и",
  "способов ради одного и того же — тоже повторы одной попытки, а не новые гипотезы. Спрашивай и о цели:",
  "может быть, без этого факта можно обойтись.",
  "",
  `**Задача «сделать отчёт» — навык ${INFOBASE_SKILL_PREFIX}reports.** Прежде чем писать запрос, выясни, из`,
  "чего строки: из самих документов или из регистров движений, — если задача не говорит однозначно,",
  "спроси. Ссылку на образец в задаче прочитай до проектирования.",
  "",
  "**Расхождение в измерениях — это и есть находка.** Если одна и та же величина померена",
  "дважды и числа разошлись, дальше нельзя идти ни с одним из них: сначала объясни",
  "расхождение. Разные способы счёта дают разные ответы на разных данных — и тот, кто строит",
  "вывод на «примерно 110», строит его на догадке. Особенно это касается индексов и",
  "количеств, где ошибка на единицу выглядит как рабочий результат.",
  "",
  "**Итог задачи — это передача работы, а не описание диффа.** Изменения в базе или в",
  "конфигурации живут дальше без тебя, и пользователю нужно не «что я поменял», а чем он",
  "теперь владеет. Пять вещей, каждая из которых отвечает на вопрос, который иначе зададут:",
  "",
  "  - **Что сделано** — по требованиям задачи, а не по объектам, которые ты трогал.",
  "  - **Как проверить глазами** — путь кликами: где открыть, что заполнить, куда посмотреть.",
  "    Не «проверено», а то, чем пользователь проверит сам.",
  "  - **Где потом править руками** — конкретный справочник, реквизит, запись регистра.",
  "    Изменение, которое может поправить только автор, сделано наполовину.",
  "  - **Что осталось открытым** — известные ограничения и побочные эффекты, названные до",
  "    того, как их обнаружат. Побочный эффект, о котором сказано заранее, — предупреждение;",
  "    тот же эффект, найденный пользователем, — дефект.",
  "  - **Как откатить** — до того, как попросят.",
  "",
  "Если ты писал в базу, сначала вызови `1c_session_writes`: приложение записывает каждую",
  "разрешённую запись — что, сколько объектов, каких организаций, чем закончилась. «Что",
  "сделано» и «Как откатить» по базе составляй по этому списку, а не по памяти; запись с",
  "неизвестным исходом проверь запросом, прежде чем о ней писать.",
  "",
  "**Побочный эффект, который можно назвать и пережить, называй и иди дальше; спрашивай,",
  "когда ошибка дорога.** Останавливаться с вопросом стоит там, где продолжать небезопасно",
  "или где работа окажется выброшенной, если предположение неверно. Там, где эффект",
  "обратим и его достаточно назвать, вопрос стоит дороже, чем стоит сам эффект: ожидание",
  "ответа — это часы, в которые не делается ничего.",
  "",
  "**Всё, что ты создаёшь, живёт в рабочем каталоге профиля.** Его точный путь даёт",
  `\`${MCP_CLIENT_NAME}_profile_info\` — спроси его перед первой же записью, а не угадывай.`,
  "Туда идёт всё: распакованные обработки, промежуточные файлы, результаты. Системный",
  "временный каталог (`%TEMP%`, `/tmp`) для этого не годится, даже если запись туда",
  "разрешена: пользователь там ничего не найдёт, содержимое стирается уборкой системы, и",
  "в следующем сеансе ты сам не отыщешь то, что уже сделал, — и начнёшь распаковывать",
  "заново. Разрешение писать — это не указание, где работать.",
  "",
  "К сеансу подключается MCP Toolkit — внешняя обработка, открытая в 1С:Предприятии на той",
  "же информационной базе. Пока она работает, у тебя есть инструменты:",
  `  ${MCP_CLIENT_NAME}_execute_query — запрос на языке запросов 1С к данным базы`,
  `  ${MCP_CLIENT_NAME}_execute_code — выполнение кода 1С на сервере (результат — в переменной Результат)`,
  `  ${MCP_CLIENT_NAME}_get_metadata — структура метаданных базы`,
  `  ${MCP_CLIENT_NAME}_get_object_by_link, ${MCP_CLIENT_NAME}_get_link_of_object — объект по ссылке и наоборот`,
  `  ${MCP_CLIENT_NAME}_find_references_to_object — где используется объект`,
  `  ${MCP_CLIENT_NAME}_get_event_log, ${MCP_CLIENT_NAME}_get_access_rights, ${MCP_CLIENT_NAME}_get_bsl_syntax_help`,
  "",
  "Это самый прямой способ узнать, что в базе на самом деле: спроси базу запросом,",
  "а не угадывай по конфигурации. Чтение ничего не меняет.",
  "",
  `${MCP_CLIENT_NAME}_execute_code выполняет код внутри рабочей базы и может изменить данные —`,
  "сначала объясни, что и зачем, и дождись подтверждения. Подробности — в навыке",
  `${INFOBASE_SKILL_PREFIX}mcp.`,
  "",
  "Если этих инструментов нет в списке — тулкит не запущен, и это норма, а не поломка: его",
  "не открывают заранее, потому что большинству задач информационная база не нужна, а окно 1С",
  `открывается десятки секунд. Нужна база — вызови \`${MCP_CLIENT_NAME}_toolkit_start\`, и`,
  "приложение откроет её само; инструменты подключатся, когда обработка ответит. Состояние",
  `покажет \`${MCP_CLIENT_NAME}_profile_info\`, подробности — в навыке`,
  `${INFOBASE_SKILL_PREFIX}toolkit-launch.`,
  "",
  `**Операцию конфигуратора и вызов инструментов к базе не отправляй в одном шаге.** Любая
` + `операция конфигуратора (1c_check_config, 1c_dump_config*, 1c_load_config, 1c_update_db,
` + `1c_dump_epf_to_files, 1c_load_epf_from_files) закрывает MCP Toolkit, потому что держит базу
` + `монопольно. Инструмент 1c_*, отправленный тем же шагом, умрёт на полпути и вернёт «fetch
` + `failed» — ошибку, которая ничего не объясняет. Сначала операция, потом, отдельным шагом,
` + "1c_toolkit_start и запросы.",
  "",
  "Сборка .epf пакетным конфигуратором **не проверяет синтаксис модулей**: код возврата 0",
  "ничего не говорит о том, компилируется ли модуль формы. Прежде чем сказать, что обработка",
  `готова, проверь её по навыку ${INFOBASE_SKILL_PREFIX}form-check.`
].join(`
`);
var NOPROFILE_PROMPT = [
  "Ты работаешь с файлами 1С:Предприятие 8 в сеансе БЕЗ профиля разработчика.",
  "",
  "Информационной базы нет, и платформа может быть вовсе не установлена. Это нормальный",
  "режим работы: так правят внешнюю обработку или отчёт, который прислали файлом.",
  "",
  "Что ты можешь: распаковывать, править и собирать обратно внешние обработки (.epf),",
  "отчёты (.erf) и расширения конфигурации (.cfe) с помощью v8pack; читать и править",
  "файлы; выполнять обычные команды оболочки.",
  "",
  "Чего ты не можешь: запускать код 1С, подключаться к информационной базе, запускать",
  "конфигуратор. Если задача этого требует, скажи об этом прямо и предложи начать сеанс",
  "с профилем разработчика — не пытайся обойти ограничение."
].join(`
`);

// src/main/infobase/agent-routing.ts
function routeAgent(requested, binding, registered) {
  const from = requested ?? DEFAULT_AGENT;
  if (from !== DEFAULT_AGENT && from !== NOPROFILE_AGENT && !isProfileAgent(from))
    return { kind: "keep" };
  if (!binding)
    return { kind: "keep" };
  let wanted;
  if (binding.ok)
    wanted = agentForBinding("bound", binding.configuration?.name);
  else if (binding.reason === "no-profile")
    wanted = NOPROFILE_AGENT;
  else
    return { kind: "keep" };
  if (wanted === from)
    return { kind: "keep" };
  if (!registered)
    return { kind: "keep" };
  if (!registered.has(wanted))
    return { kind: "missing", from, wanted };
  return { kind: "switch", from, to: wanted };
}

// src/main/infobase/sample-check.ts
var MIN_FIELDS = 5;
var BLANK = /^\s*(?:\(?пуст[а-яё]*\)?|[—–-]+|""|«»|нет|ничего)?\s*$/i;
var HANDWRITING = /от руки|рукой|рукоп|ручкой|вписан/i;
var isBlank = (value) => BLANK.test(value) || /^\s*\(?пуст/i.test(value);
function rowProblem(row) {
  const name = row.field.trim() || "(поле без названия)";
  if (!row.match) {
    return row.reason?.trim() ? null : `«${name}»: отличается, а причины нет — исправь или напиши, почему остаётся так.`;
  }
  if (HANDWRITING.test(row.sample) && !isBlank(row.print)) {
    return `«${name}»: в образце вписано от руки, а в печати «${row.print}» — это не совпадение. ` + "Место для записи от руки печать оставляет пустым.";
  }
  if ((isBlank(row.sample) || HANDWRITING.test(row.sample)) !== isBlank(row.print)) {
    return `«${name}»: с одной стороны пусто, с другой «${isBlank(row.sample) ? row.print : row.sample}» — это не совпадение.`;
  }
  return null;
}
function checkComparison(args, modified) {
  const missing = ["sample", "print", "epf"].filter((key) => modified(args[key]) === null);
  if (missing.length)
    return { ok: false, error: `Нет файла: ${missing.map((key) => `${key} = ${args[key]}`).join("; ")}.` };
  const epfModified = modified(args.epf);
  if (modified(args.print) < epfModified) {
    return {
      ok: false,
      error: "PDF старше сборки обработки: сверять надо печать текущей сборки. Напечатай заново и сверь этот PDF."
    };
  }
  if (args.fields.length < MIN_FIELDS) {
    return {
      ok: false,
      error: `Полей в сверке ${args.fields.length}. Пройди каждое поле образца сверху вниз — шапку, каждую подпись, ` + "каждое значение, каждую пустую строку для записи от руки, — а не только те, что правил."
    };
  }
  const problems = args.fields.map(rowProblem).filter((problem) => problem !== null);
  if (problems.length)
    return { ok: false, error: ["Сверка не принята:", ...problems.map((problem) => `- ${problem}`)].join(`
`) };
  const cell = (text) => text.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const differing = args.fields.filter((row) => !row.match);
  const report = [
    "| Поле | Образец | Печать | Совпало |",
    "|---|---|---|---|",
    ...args.fields.map((row) => `| ${cell(row.field)} | ${cell(row.sample)} | ${cell(row.print)} | ${row.match ? "да" : `нет: ${cell(row.reason ?? "")}`} |`)
  ].join(`
`);
  return { ok: true, check: { epf: args.epf, epfModified, rows: args.fields }, report: `${report}

Отличий: ${differing.length}.` };
}
var REGISTRY = "Справочник.ДополнительныеОтчетыИОбработки";
function registrationRefusal(code, check, modified) {
  if (!writeTargets(code).includes(REGISTRY))
    return null;
  if (!check) {
    return "Регистрация обработки — после сверки печати с образцом. Напечатай текущую сборку в PDF, пройди поля " + "образца и передай их в `1c_compare_with_sample`; потом регистрируй. Если образца нет, так и передай: " + "sample — файл задания, в полях — что задание требует.";
  }
  if (modified(check.epf) !== check.epfModified) {
    return `Обработку пересобрали после сверки (${check.epf}). Регистрируется то, что сверено: напечатай новую ` + "сборку, сверь её через `1c_compare_with_sample` и регистрируй.";
  }
  return null;
}

// src/main/infobase/dump-object.ts
import { join as join4 } from "node:path";
var KINDS = {
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
  constant: "Constants"
};
function parseName(object) {
  const match = /^\s*([^.\s]+)\s*\.\s*([^.\s]+)\s*$/.exec(object);
  if (!match)
    return null;
  const kind = match[1].toLowerCase().replace(/ы$|и$/, "");
  const dir = KINDS[kind] ?? KINDS[match[1].toLowerCase()] ?? KINDS[`${kind}а`];
  return dir ? { dir, name: match[2] } : null;
}
var synonymOf = (block) => /<Synonym>[\s\S]*?<v8:lang>ru<\/v8:lang>\s*<v8:content>([^<]*)<\/v8:content>/.exec(block)?.[1] ?? "";
function typeOf(block) {
  const type = /<Type>([\s\S]*?)<\/Type>/.exec(block)?.[1] ?? "";
  const names = [...type.matchAll(/<v8:(?:Type|TypeSet)>([^<]+)<\/v8:(?:Type|TypeSet)>/g)].map((match) => {
    const name = match[1].replace(/^(?:cfg|xs|v8):/, "");
    if (name === "string") {
      const length = /<v8:Length>(\d+)</.exec(type)?.[1] ?? "0";
      return length === "0" ? "Строка(неогр.)" : `Строка(${length})`;
    }
    if (name === "decimal") {
      return `Число(${/<v8:Digits>(\d+)</.exec(type)?.[1] ?? "?"},${/<v8:FractionDigits>(\d+)</.exec(type)?.[1] ?? "0"})`;
    }
    if (name === "dateTime") {
      const parts = /<v8:DateFractions>(\w+)</.exec(type)?.[1] ?? "DateTime";
      return parts === "Date" ? "Дата" : parts === "Time" ? "Время" : "Дата и время";
    }
    if (name === "boolean")
      return "Булево";
    return name;
  });
  return names.join(" | ") || "—";
}
function blocks(xml, tag, depth) {
  const tabs = "\t".repeat(depth);
  return [...xml.matchAll(new RegExp(`^${tabs}<${tag} uuid="[^"]*">([\\s\\S]*?)^${tabs}</${tag}>`, "gm"))].map((match) => match[1]);
}
var nameOf = (block) => /<Name>([^<]+)<\/Name>/.exec(block)?.[1] ?? "?";
function field(block) {
  const synonym = synonymOf(block);
  return `- ${nameOf(block)}${synonym && synonym !== nameOf(block) ? ` «${synonym}»` : ""}: ${typeOf(block)}`;
}
function describeDumpObject(root, object, reader) {
  const parsed = parseName(object);
  if (!parsed) {
    return `Не понял имя «${object}». Нужно «Вид.Имя»: Документ.ПриемНаРаботу, Справочник.Сотрудники, РегистрСведений.…`;
  }
  const file = join4(root, parsed.dir, `${parsed.name}.xml`);
  const text = reader.readText(file);
  if (text === null) {
    const names = (reader.list(join4(root, parsed.dir)) ?? []).filter((item) => item.endsWith(".xml")).map((item) => item.slice(0, -4));
    const near = names.filter((item) => item.toLowerCase().includes(parsed.name.toLowerCase().slice(0, 6))).slice(0, 15);
    return `В выгрузке ${root} нет ${parsed.dir}\\${parsed.name}.xml.${near.length ? ` Похожие: ${near.join(", ")}.` : ""}`;
  }
  const xml = text.replace(/^\uFEFF/, "");
  const properties = /^\t\t<Properties>([\s\S]*?)^\t\t<\/Properties>/m.exec(xml)?.[1] ?? "";
  const children = /^\t\t<ChildObjects>([\s\S]*?)^\t\t<\/ChildObjects>/m.exec(xml)?.[1] ?? "";
  const list = (tag) => [...children.matchAll(new RegExp(`^\\t{3}<${tag}>([^<]+)</${tag}>`, "gm"))].map((match) => match[1]);
  const section = (title, lines) => lines.length ? [`${title} (${lines.length}):`, ...lines] : [];
  const tabular = blocks(children, "TabularSection", 3).map((block) => {
    const own = /^\t{4}<Properties>([\s\S]*?)^\t{4}<\/Properties>/m.exec(block)?.[1] ?? block;
    const columns = blocks(block, "Attribute", 5).map((column) => `  ${field(column)}`);
    const synonym2 = synonymOf(own);
    return [`- ${nameOf(own)}${synonym2 ? ` «${synonym2}»` : ""}:`, ...columns].join(`
`);
  });
  const commands = blocks(children, "Command", 3).map(nameOf);
  const enumValues = blocks(children, "EnumValue", 3).map((block) => {
    const synonym2 = synonymOf(block);
    return `- ${nameOf(block)}${synonym2 ? ` «${synonym2}»` : ""}`;
  });
  const modules = ["ObjectModule.bsl", "ManagerModule.bsl", "RecordSetModule.bsl", "ValueManagerModule.bsl"].flatMap((module) => {
    const path = join4(root, parsed.dir, parsed.name, "Ext", module);
    const body = reader.readText(path);
    return body === null ? [] : [`${module} (${body.split(`
`).length} стр.): ${path}`];
  });
  const synonym = synonymOf(properties);
  return [
    `${object.trim()}${synonym ? ` «${synonym}»` : ""} — ${file}`,
    ...section("Измерения", blocks(children, "Dimension", 3).map(field)),
    ...section("Ресурсы", blocks(children, "Resource", 3).map(field)),
    ...section("Реквизиты", blocks(children, "Attribute", 3).map(field)),
    ...section("Табличные части", tabular),
    ...section("Значения", enumValues),
    ...list("Form").length ? [`Формы: ${list("Form").join(", ")}`] : [],
    ...list("Template").length ? [`Макеты: ${list("Template").join(", ")}`] : [],
    ...commands.length ? [`Команды: ${commands.join(", ")}`] : [],
    ...modules.length ? ["Модули:", ...modules.map((module) => `- ${module}`)] : [],
    "Стандартные реквизиты (Ссылка, Номер, Дата, Проведен, Наименование, Код…) в выгрузке не перечислены — они есть всегда."
  ].join(`
`);
}

// src/main/infobase/load-check.ts
var DROPPED = /не был загружен|не загружен|Неверное свойство объекта метаданных|ошибка формата документа|Неизвестный объект/i;
function droppedParts(output) {
  const seen = new Set;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && DROPPED.test(line))
      seen.add(line);
  }
  return [...seen];
}
function partialLoadNote(dropped) {
  return [
    "Загрузка прошла ЧАСТИЧНО: конфигуратор вернул код 0, но пропустил то, что названо ниже, — в базе этого нет.",
    "«Успешно» здесь значит только, что конфигуратор не прервался.",
    ...dropped.map((line) => `- ${line}`),
    "Исправь файлы и загрузи снова."
  ].join(`
`);
}
var FORM_ELEMENT_TAGS = new Set([
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
  "DendrogramField",
  "GeographicalSchemaField",
  "ViewStatusAddition"
]);
function unknownFormTags(xml) {
  const findings = [];
  const stack = [];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][\s\S]*?>|<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  for (const match of xml.matchAll(tokens)) {
    const [, closing, qualified, attributes = "", selfClosing] = match;
    if (!qualified)
      continue;
    const local = qualified.includes(":") ? qualified.slice(qualified.indexOf(":") + 1) : qualified;
    if (closing) {
      stack.pop();
      continue;
    }
    if (stack.at(-1) === "ChildItems" && !FORM_ELEMENT_TAGS.has(local)) {
      const name = /\bname="([^"]*)"/.exec(attributes)?.[1];
      const suggestion = nearestTag(local);
      findings.push({ tag: local, ...name ? { name } : {}, ...suggestion ? { suggestion } : {} });
    }
    if (!selfClosing)
      stack.push(local);
  }
  return findings;
}
function nearestTag(tag) {
  const lower = tag.toLowerCase();
  let best;
  for (const known of FORM_ELEMENT_TAGS) {
    if (known.toLowerCase() === lower)
      return known;
    const distance = editDistance(lower, known.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance))
      best = { tag: known, distance };
  }
  return best?.tag;
}
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1;i <= a.length; i++) {
    const current = [i];
    for (let j = 1;j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}
function element(finding) {
  return `<${finding.tag}${finding.name ? ` name="${finding.name}"` : ""}>`;
}
function formTagRefusal(files) {
  const misses = files.flatMap((file) => file.findings.filter((finding) => finding.suggestion).map((finding) => ({ file: file.file, finding })));
  if (misses.length === 0)
    return null;
  return [
    "Загрузка не запущена: в формах есть элементы с тегом, которого платформа не знает. Такой элемент загрузчик",
    "молча пропускает — загрузка «успешна», а на форме его нет.",
    ...misses.map(({ file, finding }) => `- ${file}: ${element(finding)} — правильно ${finding.suggestion}`),
    "Исправь теги и повтори загрузку."
  ].join(`
`);
}
function undeclaredPrefixes(xml) {
  const declared = new Set(["xml", "xmlns", ...[...xml.matchAll(/\bxmlns:([\w.-]+)\s*=/g)].map((match) => match[1])]);
  const used = new Set;
  const add = (prefix) => {
    if (prefix && !declared.has(prefix))
      used.add(prefix);
  };
  const body = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, "");
  for (const match of body.matchAll(/<\/?([\w.-]+):[\w.-]+/g))
    add(match[1]);
  for (const match of body.matchAll(/\s([\w.-]+):[\w.-]+\s*=\s*["']/g))
    add(match[1]);
  for (const match of body.matchAll(/\b(?:xsi:)?type\s*=\s*["']([\w.-]+):/g))
    add(match[1]);
  for (const match of body.matchAll(/<(?:[\w.-]+:)?\w*Type\b[^>]*>\s*([\w.-]+):[^<\s]/g))
    add(match[1]);
  return [...used];
}
function prefixRefusal(files) {
  if (files.length === 0)
    return null;
  return [
    "Загрузка не запущена: в файлах используются префиксы пространств имён, которые нигде в файле не",
    "объявлены. Платформа такой файл не прочитает и назовёт только его имя, без места:",
    ...files.map((file) => `- ${file.file}: ${file.prefixes.map((prefix) => `\`${prefix}:\``).join(", ")}`),
    'Объяви префикс (`xmlns:<префикс>="…"`) в корне файла — с тем же адресом, что и в таком же файле',
    "выгрузки базы, — или используй уже объявленный."
  ].join(`
`);
}
var HANDLER = /(?:Процедура|Procedure)\s+(?:ОбработкаКоманды|CommandProcessing)\s*\(([^)]*)\)/i;
var INTERCEPTED = /&(?:Перед|После|Вместо|ИзменениеИКонтроль|Before|After|Around|ChangeAndValidate)\s*\(\s*"(?:ОбработкаКоманды|CommandProcessing)"\s*\)/i;
var ANY_METHOD = /^\s*(?:Процедура|Функция|Procedure|Function)\s/im;
function commandModuleFinding(bsl) {
  const code = bsl.replace(/\/\/[^\r\n]*/g, "");
  if (!ANY_METHOD.test(code))
    return null;
  if (INTERCEPTED.test(code))
    return null;
  const handler = HANDLER.exec(code);
  if (!handler)
    return { kind: "no-handler" };
  const lines = code.slice(0, handler.index).trimEnd().split(/\r?\n/);
  const previous = lines.at(-1)?.trim() ?? "";
  const directive = previous.startsWith("&") ? previous : "";
  const parameters = (handler[1] ?? "").split(",").filter((parameter) => parameter.trim()).length;
  const client = /^&(?:НаКлиенте|AtClient)$/i.test(directive);
  return client && parameters === 2 ? null : { kind: "unusual", directive, parameters };
}
var STANDARD_HANDLER = `&НаКлиенте
Процедура ОбработкаКоманды(ПараметрКоманды, ПараметрыВыполненияКоманды)`;
function commandModuleRefusal(files) {
  const missing = files.filter((file) => file.finding.kind === "no-handler");
  if (missing.length === 0)
    return null;
  return [
    "Загрузка не запущена: в модулях команд нет обработчика, который вызывает платформа. Такая команда",
    "загрузится, появится в интерфейсе и ничего не будет делать при нажатии:",
    ...missing.map((file) => `- ${file.file}`),
    "Платформа вызывает только процедуру с этим именем:",
    STANDARD_HANDLER
  ].join(`
`);
}
function commandModuleWarning(files) {
  const unusual = files.flatMap((file) => file.finding.kind === "unusual" ? [{ file: file.file, finding: file.finding }] : []);
  if (unusual.length === 0)
    return null;
  return [
    "Внимание: обработчик команды объявлен не так, как во всех командах типовых конфигураций:",
    ...unusual.map(({ file, finding }) => `- ${file}: ${finding.directive || "без директивы"}, параметров ${finding.parameters}`),
    "Стандартное объявление:",
    STANDARD_HANDLER,
    "Проверь команду нажатием (через её навигационную ссылку), а не открытием формы."
  ].join(`
`);
}
function formTagWarning(files) {
  const unknown = files.flatMap((file) => file.findings.filter((finding) => !finding.suggestion).map((finding) => ({ file: file.file, finding })));
  if (unknown.length === 0)
    return null;
  return [
    "Внимание: в формах есть элементы, которых нет в формах типовых конфигураций. Если какого-то из них не",
    "окажется на форме в базе — платформа его не знает и пропустила без сообщения:",
    ...unknown.map(({ file, finding }) => `- ${file}: ${element(finding)}`)
  ].join(`
`);
}

// src/main/infobase/extension-skeleton.ts
import { randomUUID } from "node:crypto";
var CONTAINED_CLASS_IDS = [
  "9cd510cd-abfc-11d4-9434-004095e12fc7",
  "9fcd25a0-4822-11d4-9414-008048da11f9",
  "e3687481-0a87-462c-a166-9f34594f9bba",
  "9de14907-ec23-4a07-96f0-85521cb6b53b",
  "51f2d5d8-ea4d-4064-8892-82951750031e",
  "e68182ea-4237-4383-967f-90c1e3370bc7",
  "fb282519-d103-4dd3-bc12-cb271d631dfc"
];
var tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
function baseFactsFromDump(root, readText) {
  const dir = root.trim().replace(/[\\/]+$/, "");
  const configuration = readText(`${dir}/Configuration.xml`);
  if (!configuration)
    return `В ${dir} нет Configuration.xml — нужен корень выгрузки основной конфигурации.`;
  if (configuration.includes("ConfigurationExtensionPurpose")) {
    return `${dir} — выгрузка расширения, а нужна выгрузка основной конфигурации.`;
  }
  const formatVersion = /<MetaDataObject\b[^>]*\bversion="([^"]+)"/.exec(configuration)?.[1];
  const compatibilityMode = tag(configuration, "CompatibilityMode");
  const languageName = tag(configuration, "DefaultLanguage")?.replace(/^Language\./, "");
  if (!formatVersion || !compatibilityMode || !languageName) {
    return `В ${dir}/Configuration.xml не найдены версия формата, режим совместимости или основной язык.`;
  }
  const language = readText(`${dir}/Languages/${languageName}.xml`);
  const languageUuid = language ? /<Language uuid="([^"]+)"/.exec(language)?.[1] : undefined;
  if (!language || !languageUuid)
    return `Не прочитан язык ${languageName}: ${dir}/Languages/${languageName}.xml`;
  return {
    formatVersion,
    compatibilityMode,
    interfaceCompatibilityMode: tag(configuration, "InterfaceCompatibilityMode") ?? "TaxiEnableVersion8_2",
    scriptVariant: tag(configuration, "ScriptVariant") ?? "Russian",
    language: { name: languageName, uuid: languageUuid, code: tag(language, "LanguageCode") ?? "ru" }
  };
}
function isMetadataName(name) {
  return /^[A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*$/.test(name);
}
var NAMESPACES = 'xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" ' + 'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" ' + 'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" ' + 'xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" ' + 'xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" ' + 'xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" ' + 'xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" ' + 'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" ' + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
var escapeXml2 = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function extensionSkeleton(base, extension, newId = randomUUID) {
  const head = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject ${NAMESPACES} version="${base.formatVersion}">`;
  const contained = CONTAINED_CLASS_IDS.map((classId) => `			<xr:ContainedObject>
				<xr:ClassId>${classId}</xr:ClassId>
				<xr:ObjectId>${newId()}</xr:ObjectId>
			</xr:ContainedObject>`).join(`
`);
  const synonym = extension.synonym ? `<Synonym>
				<v8:item>
					<v8:lang>${base.language.code}</v8:lang>
					<v8:content>${escapeXml2(extension.synonym)}</v8:content>
				</v8:item>
			</Synonym>` : "<Synonym/>";
  const configuration = [
    head,
    `	<Configuration uuid="${newId()}">`,
    "\t\t<InternalInfo>",
    contained,
    "\t\t</InternalInfo>",
    "\t\t<Properties>",
    "\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>",
    `			<Name>${extension.name}</Name>`,
    `			${synonym}`,
    "\t\t\t<Comment/>",
    `			<ConfigurationExtensionPurpose>${extension.purpose ?? "Customization"}</ConfigurationExtensionPurpose>`,
    "\t\t\t<KeepMappingToExtendedConfigurationObjectsByIDs>true</KeepMappingToExtendedConfigurationObjectsByIDs>",
    `			<NamePrefix>${extension.prefix}</NamePrefix>`,
    `			<ConfigurationExtensionCompatibilityMode>${base.compatibilityMode}</ConfigurationExtensionCompatibilityMode>`,
    "\t\t\t<DefaultRunMode>ManagedApplication</DefaultRunMode>",
    `			<ScriptVariant>${base.scriptVariant}</ScriptVariant>`,
    `			<DefaultLanguage>Language.${base.language.name}</DefaultLanguage>`,
    `			<InterfaceCompatibilityMode>${base.interfaceCompatibilityMode}</InterfaceCompatibilityMode>`,
    "\t\t</Properties>",
    "\t\t<ChildObjects>",
    `			<Language>${base.language.name}</Language>`,
    "\t\t</ChildObjects>",
    "\t</Configuration>",
    "</MetaDataObject>",
    ""
  ].join(`
`);
  const language = [
    head,
    `	<Language uuid="${newId()}">`,
    "\t\t<InternalInfo/>",
    "\t\t<Properties>",
    "\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>",
    `			<Name>${base.language.name}</Name>`,
    "\t\t\t<Comment/>",
    `			<ExtendedConfigurationObject>${base.language.uuid}</ExtendedConfigurationObject>`,
    `			<LanguageCode>${base.language.code}</LanguageCode>`,
    "\t\t</Properties>",
    "\t</Language>",
    "</MetaDataObject>",
    ""
  ].join(`
`);
  return { "Configuration.xml": configuration, [`Languages/${base.language.name}.xml`]: language };
}

// src/main/infobase/external-skeleton.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var EXTERNAL_CLASS_IDS = {
  processor: "c3831ec8-d8d5-4f93-8a22-f9bfae07327f",
  report: "e41aff26-25cf-4bb6-b6c1-3f478a75f374"
};
var EXTERNAL_EXTENSIONS = { processor: ".epf", report: ".erf" };
function externalKind(rootXml) {
  if (/<MetaDataObject\b[^>]*>\s*<(?:\w+:)?ExternalReport\b/.test(rootXml))
    return "report";
  if (/<MetaDataObject\b[^>]*>\s*<(?:\w+:)?ExternalDataProcessor\b/.test(rootXml))
    return "processor";
  return null;
}
var NAMESPACES2 = 'xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" ' + 'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" ' + 'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" ' + 'xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" ' + 'xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" ' + 'xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" ' + 'xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" ' + 'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" ' + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
var escapeXml3 = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var SCHEMA_TEMPLATE = "ОсновнаяСхемаКомпоновкиДанных";
function externalSkeleton(kind, object, newId = randomUUID2) {
  const head = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject ${NAMESPACES2} version="${object.formatVersion ?? "2.21"}">`;
  const element2 = kind === "report" ? "ExternalReport" : "ExternalDataProcessor";
  const synonym = object.synonym ? `<Synonym>
				<v8:item>
					<v8:lang>ru</v8:lang>
					<v8:content>${escapeXml3(object.synonym)}</v8:content>
				</v8:item>
			</Synonym>` : "<Synonym/>";
  const properties = kind === "report" ? [
    "<DefaultForm/>",
    "<AuxiliaryForm/>",
    `<MainDataCompositionSchema>ExternalReport.${object.name}.Template.${SCHEMA_TEMPLATE}</MainDataCompositionSchema>`,
    "<DefaultSettingsForm/>",
    "<AuxiliarySettingsForm/>",
    "<DefaultVariantForm/>",
    "<AuxiliaryVariantForm/>",
    "<VariantsStorage/>",
    "<SettingsStorage/>"
  ] : [object.form ? `<DefaultForm>ExternalDataProcessor.${object.name}.Form.${FORM_NAME}</DefaultForm>` : "<DefaultForm/>", "<AuxiliaryForm/>"];
  const root = [
    head,
    `	<${element2} uuid="${newId()}">`,
    "\t\t<InternalInfo>",
    "\t\t\t<xr:ContainedObject>",
    `				<xr:ClassId>${EXTERNAL_CLASS_IDS[kind]}</xr:ClassId>`,
    `				<xr:ObjectId>${newId()}</xr:ObjectId>`,
    "\t\t\t</xr:ContainedObject>",
    `			<xr:GeneratedType name="${element2}Object.${object.name}" category="Object">`,
    `				<xr:TypeId>${newId()}</xr:TypeId>`,
    `				<xr:ValueId>${newId()}</xr:ValueId>`,
    "\t\t\t</xr:GeneratedType>",
    "\t\t</InternalInfo>",
    "\t\t<Properties>",
    `			<Name>${object.name}</Name>`,
    `			${synonym}`,
    "\t\t\t<Comment/>",
    ...properties.map((line) => `			${line}`),
    "\t\t</Properties>",
    kind === "report" ? `		<ChildObjects>
			<Template>${SCHEMA_TEMPLATE}</Template>
		</ChildObjects>` : object.form ? `		<ChildObjects>
			<Form>${FORM_NAME}</Form>
		</ChildObjects>` : "\t\t<ChildObjects/>",
    `	</${element2}>`,
    "</MetaDataObject>",
    ""
  ].join(`
`);
  const module = `\uFEFF
`;
  if (kind === "processor") {
    return {
      [`${object.name}.xml`]: root,
      [`${object.name}/Ext/ObjectModule.bsl`]: module,
      ...object.form ? formFiles(head, object.name, newId) : {}
    };
  }
  const template = [
    head,
    `	<Template uuid="${newId()}">`,
    "\t\t<Properties>",
    `			<Name>${SCHEMA_TEMPLATE}</Name>`,
    "\t\t\t<Synonym/>",
    "\t\t\t<Comment/>",
    "\t\t\t<TemplateType>DataCompositionSchema</TemplateType>",
    "\t\t</Properties>",
    "\t</Template>",
    "</MetaDataObject>",
    ""
  ].join(`
`);
  return {
    [`${object.name}.xml`]: root,
    [`${object.name}/Ext/ObjectModule.bsl`]: module,
    [`${object.name}/Templates/${SCHEMA_TEMPLATE}.xml`]: template,
    [`${object.name}/Templates/${SCHEMA_TEMPLATE}/Ext/Template.xml`]: STARTER_SCHEMA
  };
}
var FORM_NAME = "Форма";
function formFiles(head, name, newId) {
  const metadata = [
    head,
    `	<Form uuid="${newId()}">`,
    "\t\t<Properties>",
    `			<Name>${FORM_NAME}</Name>`,
    `			<Synonym>
				<v8:item>
					<v8:lang>ru</v8:lang>
					<v8:content>${FORM_NAME}</v8:content>
				</v8:item>
			</Synonym>`,
    "\t\t\t<Comment/>",
    "\t\t\t<FormType>Managed</FormType>",
    "\t\t\t<IncludeHelpInContents>false</IncludeHelpInContents>",
    "\t\t\t<UsePurposes>",
    '\t\t\t\t<v8:Value xsi:type="app:ApplicationUsePurpose">PlatformApplication</v8:Value>',
    '\t\t\t\t<v8:Value xsi:type="app:ApplicationUsePurpose">MobilePlatformApplication</v8:Value>',
    "\t\t\t</UsePurposes>",
    "\t\t\t<UseInInterfaceCompatibilityMode>Any</UseInInterfaceCompatibilityMode>",
    "\t\t\t<ExtendedPresentation/>",
    "\t\t</Properties>",
    "\t</Form>",
    "</MetaDataObject>",
    ""
  ].join(`
`);
  const layout = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<Form ${FORM_NAMESPACES} version="2.21">
	<AutoCommandBar name="ФормаКоманднаяПанель" id="-1">
		<ChildItems>
			<Button name="ФормаВыполнить" id="11">
				<Type>CommandBarButton</Type>
				<CommandName>Form.Command.Выполнить</CommandName>
				<ExtendedTooltip name="ФормаВыполнитьРасширеннаяПодсказка" id="12"/>
			</Button>
		</ChildItems>
	</AutoCommandBar>
	<Attributes>
		<Attribute name="Объект" id="1">
			<Type>
				<v8:Type>cfg:ExternalDataProcessorObject.${name}</v8:Type>
			</Type>
			<MainAttribute>true</MainAttribute>
		</Attribute>
	</Attributes>
	<Commands>
		<Command name="Выполнить" id="1">
			<Title>
				<v8:item>
					<v8:lang>ru</v8:lang>
					<v8:content>Выполнить</v8:content>
				</v8:item>
			</Title>
			<Action>КомандаВыполнить</Action>
		</Command>
	</Commands>
</Form>
`;
  const formModule = [
    "\uFEFF&НаСервереБезКонтекста",
    "Процедура ВыполнитьНаСервере()",
    "КонецПроцедуры",
    "",
    "&НаКлиенте",
    "Процедура КомандаВыполнить(Команда)",
    "\tВыполнитьНаСервере();",
    "КонецПроцедуры",
    ""
  ].join(`
`);
  return {
    [`${name}/Forms/${FORM_NAME}.xml`]: metadata,
    [`${name}/Forms/${FORM_NAME}/Ext/Form.xml`]: layout,
    [`${name}/Forms/${FORM_NAME}/Ext/Form/Module.bsl`]: formModule
  };
}
var FORM_NAMESPACES = 'xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" ' + 'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" ' + 'xmlns:dcssch="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings" ' + 'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" ' + 'xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" ' + 'xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" ' + 'xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" ' + 'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" ' + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
var STARTER_SCHEMA = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:dcscom="http://v8.1c.ru/8.1/data-composition-system/common" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<dataSource>
		<name>ИсточникДанных1</name>
		<dataSourceType>Local</dataSourceType>
	</dataSource>
	<dataSet xsi:type="DataSetQuery">
		<name>НаборДанных1</name>
		<field xsi:type="DataSetFieldField">
			<dataPath>Группа</dataPath>
			<field>Группа</field>
		</field>
		<field xsi:type="DataSetFieldField">
			<dataPath>Сумма</dataPath>
			<field>Сумма</field>
			<appearance>
				<dcscor:item xsi:type="dcsset:SettingsParameterValue">
					<dcscor:parameter>Формат</dcscor:parameter>
					<dcscor:value xsi:type="v8:LocalStringType">
						<v8:item>
							<v8:lang>ru</v8:lang>
							<v8:content>ЧДЦ=2</v8:content>
						</v8:item>
					</dcscor:value>
				</dcscor:item>
				<dcscor:item xsi:type="dcsset:SettingsParameterValue">
					<dcscor:parameter>МинимальнаяШирина</dcscor:parameter>
					<dcscor:value xsi:type="xs:decimal">15</dcscor:value>
				</dcscor:item>
			</appearance>
		</field>
		<dataSource>ИсточникДанных1</dataSource>
		<query>ВЫБРАТЬ
	"Пример" КАК Группа,
	&amp;Коэффициент * 1 КАК Сумма</query>
		<autoFillFields>true</autoFillFields>
	</dataSet>
	<totalField>
		<dataPath>Сумма</dataPath>
		<expression>Сумма(Сумма)</expression>
	</totalField>
	<parameter>
		<name>Коэффициент</name>
		<title xsi:type="v8:LocalStringType">
			<v8:item>
				<v8:lang>ru</v8:lang>
				<v8:content>Коэффициент</v8:content>
			</v8:item>
		</title>
		<valueType>
			<v8:Type>xs:decimal</v8:Type>
			<v8:NumberQualifiers>
				<v8:Digits>10</v8:Digits>
				<v8:FractionDigits>2</v8:FractionDigits>
				<v8:AllowedSign>Any</v8:AllowedSign>
			</v8:NumberQualifiers>
		</valueType>
		<value xsi:type="xs:decimal">1</value>
		<useRestriction>false</useRestriction>
		<denyIncompleteValues>true</denyIncompleteValues>
	</parameter>
	<settingsVariant>
		<dcsset:name>Основной</dcsset:name>
		<dcsset:presentation xsi:type="xs:string">Основной</dcsset:presentation>
		<dcsset:settings>
			<dcsset:selection>
				<dcsset:item xsi:type="dcsset:SelectedItemField">
					<dcsset:field>Сумма</dcsset:field>
				</dcsset:item>
			</dcsset:selection>
			<dcsset:dataParameters>
				<dcscor:item xsi:type="dcsset:SettingsParameterValue">
					<dcscor:parameter>Коэффициент</dcscor:parameter>
					<dcscor:value xsi:type="xs:decimal">1</dcscor:value>
					<dcsset:userSettingID>${"a1b2c3d4-0000-4000-8000-000000000001"}</dcsset:userSettingID>
				</dcscor:item>
			</dcsset:dataParameters>
			<dcsset:item xsi:type="dcsset:StructureItemGroup">
				<dcsset:groupItems>
					<dcsset:item xsi:type="dcsset:GroupItemField">
						<dcsset:field>Группа</dcsset:field>
						<dcsset:groupType>Items</dcsset:groupType>
						<dcsset:periodAdditionType>None</dcsset:periodAdditionType>
						<dcsset:periodAdditionBegin xsi:type="xs:dateTime">0001-01-01T00:00:00</dcsset:periodAdditionBegin>
						<dcsset:periodAdditionEnd xsi:type="xs:dateTime">0001-01-01T00:00:00</dcsset:periodAdditionEnd>
					</dcsset:item>
				</dcsset:groupItems>
				<dcsset:order>
					<dcsset:item xsi:type="dcsset:OrderItemAuto"/>
				</dcsset:order>
				<dcsset:selection>
					<dcsset:item xsi:type="dcsset:SelectedItemField">
						<dcsset:field>Группа</dcsset:field>
					</dcsset:item>
					<dcsset:item xsi:type="dcsset:SelectedItemField">
						<dcsset:field>Сумма</dcsset:field>
					</dcsset:item>
				</dcsset:selection>
				<dcsset:item xsi:type="dcsset:StructureItemGroup">
					<dcsset:order>
						<dcsset:item xsi:type="dcsset:OrderItemAuto"/>
					</dcsset:order>
					<dcsset:selection>
						<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>
					</dcsset:selection>
				</dcsset:item>
			</dcsset:item>
		</dcsset:settings>
	</settingsVariant>
</DataCompositionSchema>
`;

// src/main/infobase/epf-identity.ts
import { createHash } from "node:crypto";

// src/main/v8pack/container.ts
import { deflateRawSync, inflateRawSync } from "node:zlib";
var V8_MAGIC = 2147483647;
var BOM_UTF8 = Buffer.from([239, 187, 191]);
function inflate(data) {
  return inflateRawSync(data);
}
var NO_NEXT = 2147483647;
var HEADER_LENGTH = 31;
function parseChunkHeader(data, at) {
  if (at + HEADER_LENGTH > data.length)
    return null;
  if (data[at] !== 13 || data[at + 1] !== 10)
    return null;
  const crlf = data.indexOf(`\r
`, at + 2, "ascii");
  if (crlf === -1)
    return null;
  const parts = data.toString("ascii", at + 2, crlf).trim().split(/\s+/);
  const dataSize = Number.parseInt(parts[0] ?? "", 16);
  const storedSize = Number.parseInt(parts[1] ?? "", 16);
  const next = Number.parseInt(parts[2] ?? "", 16);
  if (!Number.isFinite(dataSize) || !Number.isFinite(storedSize) || !Number.isFinite(next))
    return null;
  return { dataSize, storedSize, next, dataOffset: crlf + 2 };
}
function readBlock(data, at) {
  const first = parseChunkHeader(data, at);
  if (!first)
    return null;
  const total = first.dataSize;
  const chunks = [];
  const continuations = [];
  let gathered = 0;
  let chunk = first;
  const visited = new Set;
  while (chunk && gathered < total) {
    const take = Math.min(chunk.storedSize, total - gathered);
    chunks.push(data.subarray(chunk.dataOffset, chunk.dataOffset + take));
    gathered += take;
    if (gathered >= total || chunk.next === NO_NEXT)
      break;
    if (visited.has(chunk.next))
      break;
    visited.add(chunk.next);
    continuations.push(chunk.next);
    chunk = parseChunkHeader(data, chunk.next);
  }
  return {
    block: { headerStart: at, data: Buffer.concat(chunks) },
    nextScanPos: first.dataOffset + first.storedSize,
    continuations
  };
}
function scanBlocks(data) {
  const blocks2 = [];
  const continuationOffsets = new Set;
  let pos = 16;
  while (pos < data.length) {
    const read = readBlock(data, pos);
    if (!read)
      break;
    for (const offset of read.continuations)
      continuationOffsets.add(offset);
    if (!continuationOffsets.has(read.block.headerStart))
      blocks2.push(read.block);
    if (read.nextScanPos <= pos)
      break;
    pos = read.nextScanPos;
  }
  return blocks2;
}
function readName(attr) {
  return attr.subarray(20).toString("utf16le").replace(/\0+$/, "");
}

class NotAContainerError extends Error {
  constructor() {
    super("Not a v8 container");
    this.name = "NotAContainerError";
  }
}
function assertContainer(data) {
  if (data.length < 16 || data.readUInt32LE(0) !== V8_MAGIC)
    throw new NotAContainerError;
}
function readContainerRaw(data) {
  assertContainer(data);
  const pageSize = data.readUInt32LE(4);
  const blocks2 = scanBlocks(data);
  if (blocks2.length === 0)
    throw new NotAContainerError;
  const entries = [];
  const attrStartToIndex = new Map;
  for (let i = 1;i + 1 < blocks2.length; i += 2) {
    const attrBlock = blocks2[i];
    const stored = blocks2[i + 1].data;
    let content;
    let isDeflated;
    try {
      content = inflate(stored);
      isDeflated = true;
    } catch {
      content = stored;
      isDeflated = false;
    }
    attrStartToIndex.set(attrBlock.headerStart, entries.length);
    entries.push({
      name: readName(attrBlock.data),
      created: attrBlock.data.length >= 8 ? attrBlock.data.readBigUInt64LE(0) : 0n,
      modified: attrBlock.data.length >= 16 ? attrBlock.data.readBigUInt64LE(8) : 0n,
      attr: attrBlock.data,
      deflate: isDeflated,
      stored,
      content
    });
  }
  const toc = blocks2[0].data;
  const tocOrder = [];
  for (let i = 0;i + 12 <= toc.length; i += 12) {
    const index = attrStartToIndex.get(toc.readUInt32LE(i));
    if (index !== undefined)
      tocOrder.push(index);
  }
  return { pageSize, entries, tocOrder };
}
function readContainer(data) {
  return readContainerRaw(data).entries.map((entry) => ({ name: entry.name, content: entry.content }));
}
function extractModuleText(data) {
  try {
    const text = readContainer(data).find((entry) => entry.name === "text");
    return text ? text.content : null;
  } catch {
    return null;
  }
}

// src/main/infobase/epf-identity.ts
function fingerprint(bytes) {
  const md5 = createHash("md5").update(bytes).digest("hex");
  const module = (() => {
    try {
      return readContainer(bytes).map((entry) => extractModuleText(entry.content)).find((text) => text !== null)?.toString("utf8");
    } catch {
      return;
    }
  })();
  return { md5, size: bytes.length, ...module !== undefined ? { module } : {} };
}
function compareIdentity(build, references) {
  const bytes = references.find((reference) => reference.fingerprint.md5 === build.md5);
  if (bytes)
    return { sameAs: bytes.label, how: "bytes" };
  if (build.module === undefined)
    return {};
  const module = references.find((reference) => reference.fingerprint.module === build.module);
  return module ? { sameAs: module.label, how: "module" } : {};
}
function describeIdentity(path, build, verdict) {
  const head = `Файл: ${path} — ${build.size} байт, md5 ${build.md5}`;
  if (!verdict.sameAs)
    return `${head}
Отличается от шаблонов и от исходного файла.`;
  return [
    head,
    "",
    verdict.how === "bytes" ? `СБОРКИ НЕ БЫЛО: файл побайтно совпадает с «${verdict.sameAs}».` : `СБОРКИ НЕ БЫЛО: модуль объекта совпадает с модулем «${verdict.sameAs}» дословно.`,
    "Загрузчик записал результат не в этот файл, либо сборка не запускалась. Проверь путь `epfPath`",
    "у 1c_load_epf_from_files и поищи рядом файл с неожиданным именем (например с добавленным `.epf`).",
    "Проверять компиляцию этого файла бессмысленно — это шаблон."
  ].join(`
`);
}

// src/main/infobase/journal.ts
var JOURNAL_DIR = ".1ccoder";
var JOURNAL_FILE = "writes.jsonl";
function journalDirectory(workingDirectory) {
  return `${workingDirectory.replace(/[\\/]+$/, "")}/${JOURNAL_DIR}`;
}
function journalPath(workingDirectory) {
  return `${journalDirectory(workingDirectory)}/${JOURNAL_FILE}`;
}
function journalLine(line) {
  return `${JSON.stringify(line)}
`;
}
function readJournal(text, sessionID) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((line) => line !== null && typeof line.callID === "string");
  const finished = new Map(lines.filter((line) => line.kind === "finished").map((line) => [line.callID, line]));
  return lines.filter((line) => line.kind === "started" && line.sessionID === sessionID).map((started) => {
    const end = finished.get(started.callID);
    return {
      ...started,
      outcome: !end ? "unknown" : end.failed ? "failed" : "done",
      ...end?.result ? { result: end.result } : {}
    };
  });
}
function describeJournal(entries, path) {
  if (!entries.length)
    return `В этом сеансе записей в базу не было (журнал: ${path}).`;
  const outcome = {
    done: "выполнено",
    failed: "НЕ ВЫПОЛНЕНО — код вернул ошибку",
    unknown: "ИСХОД НЕИЗВЕСТЕН — ответа не было (тулкит упал или связь оборвалась); проверь запросом, что записано"
  };
  return [
    `Записи в базу за этот сеанс — ${entries.length} (журнал: ${path}):`,
    "",
    ...entries.flatMap((entry, index) => [
      `${index + 1}. ${entry.at} — ${outcome[entry.outcome]}`,
      `   Что: ${entry.summary}`,
      `   Объекты: ${entry.objects}; объектов: ${entry.count}; организации: ${entry.organisations}`,
      ...entry.overwrites?.length ? [`   Изменены существующие элементы: ${entry.overwrites.join(", ")}`] : [],
      ...entry.result ? [`   Ответ: ${entry.result.replace(/\s+/g, " ").slice(0, 400)}`] : []
    ]),
    "",
    "Каждая выполненная запись — пункт «Что сделано» в итоговом отчёте, с объёмом и организациями.",
    "Для «Как откатить» по каждой: что создано — пометить на удаление и вернуть ссылки, которые на",
    "него переключены; что изменено — прежние значения (если ты их не сохранил до записи, так и напиши)."
  ].join(`
`);
}

// src/main/infobase/provenance.ts
var SLACK_MS = 2 * 60 * 1000;
function provenanceRefusal(path, facts) {
  if (facts.userSupplied)
    return null;
  if (facts.modifiedMs !== null && facts.modifiedMs >= facts.sessionStartedMs - SLACK_MS)
    return null;
  return [
    `Отклонено: ${path} не менялся в этом сеансе — ты его не собирал.`,
    "",
    "Этот инструмент запускает обработку, которую ты только что собрал. Чужая обработка может",
    "открыть свою форму модально и заблокировать сеанс 1С вместе с MCP Toolkit.",
    "",
    "- Хотел выполнить запрос или код — это 1c_execute_query / 1c_execute_code, а не запуск файла.",
    "- Пользователь сам назвал этот файл и просил его запустить — повтори вызов с",
    "  `user_supplied: true`; пользователь увидит это в запросе разрешения."
  ].join(`
`);
}

// src/main/infobase/questions.ts
function isQuestionPart(part) {
  if (!part || typeof part !== "object")
    return false;
  const candidate = part;
  return candidate.type === "tool" && candidate.tool === "question" && typeof candidate.state === "object" && candidate.state !== null;
}
var UNANSWERED_NOTICE = [
  "Предыдущий вопрос пользователю (инструмент question) остался БЕЗ ОТВЕТА: вызов прерван или отклонён.",
  "Сообщение пользователя ниже — не выбор варианта. Если от ответа зависело, что делать дальше, и",
  "варианты различались по обратимости, не выбирай за пользователя: задай вопрос снова."
].join(`
`);
function markUnansweredQuestion(messages) {
  const lastUser = messages.findLastIndex((message) => message.info.role === "user");
  if (lastUser <= 0)
    return false;
  const previousUser = messages.slice(0, lastUser).findLastIndex((message) => message.info.role === "user");
  const question = messages.slice(previousUser + 1, lastUser).flatMap((message) => message.parts).findLast(isQuestionPart);
  if (!question || question.state.status === "completed")
    return false;
  const target = messages[lastUser];
  target.parts.push({
    id: `prt_1ccoder_unanswered_${target.info.id}`,
    sessionID: target.info.sessionID,
    messageID: target.info.id,
    type: "text",
    text: UNANSWERED_NOTICE,
    synthetic: true
  });
  return true;
}

// src/main/infobase/toolkit-calls.ts
function isToolkitTool(name, pluginTools) {
  return name.startsWith("1c_") && !pluginTools.includes(name);
}
function describeExit(exit) {
  const seconds = Math.round(exit.lifetimeMs / 1000);
  const lifetime = seconds >= 60 ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с` : `${seconds} с`;
  return [
    `Процесс 1С с тулкитом завершился сам через ${lifetime} после запуска (код ${exit.code ?? exit.signal}): ` + "его не закрывали ни ты, ни приложение.",
    "Если тулкит раз за разом живёт одно и то же время — это поведение базы, а не твоих вызовов: " + "скажи об этом пользователю, а работу с базой укладывай в этот срок после 1c_toolkit_start."
  ].join(`
`);
}
function executeCodeUnavailable(gate) {
  if (!gate)
    return null;
  if (gate.designerBusy) {
    return "`1c_execute_code` сейчас недоступен: идёт операция конфигуратора, и MCP Toolkit на это время закрыт. " + "Дождись её результата, затем 1c_toolkit_start.";
  }
  if (gate.port !== "free")
    return null;
  return [
    "`1c_execute_code` сейчас нет в твоём списке инструментов: MCP Toolkit не запущен (порт не отвечает), " + "а его инструменты существуют, только пока он работает. Повторный вызов 1c_write_code этого не изменит.",
    "Вызови 1c_toolkit_start, дождись, когда 1c_* появятся в списке, и выполни код через `1c_execute_code`.",
    ...gate.exit ? [describeExit(gate.exit)] : []
  ].join(`
`);
}
function gateRefusal(gate) {
  if (gate.linkedTo) {
    return [
      `Отклонено: инструменты 1c_* в этом рабочем каталоге сейчас подключены к базе другого профиля («${gate.linkedTo}»).`,
      "Так бывает, когда в одном каталоге открыты сеансы с разными профилями: подключение у каталога одно.",
      "Вызов ушёл бы не в твою базу. Скажи об этом пользователю: у каждого профиля должен быть свой рабочий каталог,",
      "или сеанс другого профиля нужно закрыть. Повтор этого вызова ничего не изменит."
    ].join(`
`);
  }
  if (gate.designerBusy) {
    return [
      "Сейчас идёт операция конфигуратора: она держит базу монопольно, и MCP Toolkit на это время закрыт.",
      "Дождись её результата. Потом, если инструменты 1c_* ещё нужны, вызови 1c_toolkit_start.",
      "Операцию конфигуратора и вызов 1c_* в одном шаге не совмещай."
    ].join(`
`);
  }
  if (gate.port !== "free")
    return null;
  return [
    `MCP Toolkit не запущен (порт не отвечает; состояние: ${gate.state}). Этот вызов вернул бы «fetch failed»,`,
    "и это была бы не сетевая ошибка и не ошибка твоего кода.",
    "Подними тулкит через 1c_toolkit_start. Инструменты 1c_* снова заработают, когда появятся в списке.",
    ...gate.exit ? [describeExit(gate.exit)] : []
  ].join(`
`);
}
function resultText(result) {
  if (!result || typeof result !== "object")
    return "";
  const record = result;
  if (typeof record.output === "string")
    return record.output;
  if (!Array.isArray(record.content))
    return "";
  return record.content.map((part) => part && typeof part === "object" && part.type === "text" ? String(part.text ?? "") : "").join(`
`);
}
function appendToResult(result, text) {
  if (!result || typeof result !== "object")
    return;
  const record = result;
  if (typeof record.output === "string") {
    record.output = `${record.output}

${text}`;
    return;
  }
  if (Array.isArray(record.content))
    record.content.push({ type: "text", text });
}
function isFailure(result) {
  if (result && typeof result === "object" && result.isError === true)
    return true;
  return /"success"\s*:\s*false/.test(resultText(result));
}
var QUERY_FIELD = /Поле не найдено\s*\\?"([^"\\]+)\\?"/i;
var OBJECT_FIELD = /Поле объекта не обнаружено\s*\(([^)]+)\)/i;
var METHOD = /Метод объекта не обнаружен\s*\(([^)]+)\)/i;
function aliases(query) {
  const found = [...query.matchAll(/([А-Яа-яЁёA-Za-z]+\.[0-9А-Яа-яЁёA-Za-z_.]+)\s+(?:КАК|AS)\s+([0-9А-Яа-яЁёA-Za-z_]+)/gi)];
  return new Map(found.map((match) => [match[2].toLowerCase(), match[1]]));
}
function referenceHint(result, args) {
  const text = resultText(result);
  const query = typeof args?.query === "string" ? args.query : "";
  const field2 = QUERY_FIELD.exec(text)?.[1];
  if (field2) {
    const [alias] = field2.split(".");
    const table = alias ? aliases(query).get(alias.toLowerCase()) : undefined;
    return [
      `Поля «${field2}» нет${table ? ` в ${table}` : ""}. Не подбирай имя наугад: состав реквизитов и табличных частей`,
      `${table ? `объекта ${table}` : "объекта"} возвращает 1c_get_metadata — вызови его и возьми имя оттуда.`
    ].join(`
`);
  }
  const member = OBJECT_FIELD.exec(text)?.[1] ?? METHOD.exec(text)?.[1];
  if (member) {
    return [
      `У объекта нет «${member}». Если это объект платформы (ТабличныйДокумент, Запрос, ОбластьЯчеек…) —`,
      "его свойства и методы возвращает 1c_get_bsl_syntax_help; если объект конфигурации — 1c_get_metadata.",
      "Посмотри там, прежде чем пробовать другое имя."
    ].join(`
`);
  }
  return null;
}

class RepeatedFailures {
  seen = new Map;
  record(sessionID, tool, args, result) {
    const key = [sessionID, tool, JSON.stringify(args ?? null), errorOf(resultText(result))].join("\x00");
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);
    return count;
  }
}
function errorOf(text) {
  try {
    const parsed = JSON.parse(text);
    const error = parsed && typeof parsed === "object" ? parsed.error : undefined;
    if (typeof error === "string")
      return error.trim();
  } catch {}
  return text.trim();
}
var REPEATED_FAILURE_NOTICE = [
  "Та же ошибка на тот же вызов — второй раз. Ещё одна правка числа или имени её не снимет:",
  "добери факты. Имена полей — 1c_get_metadata; свойства и методы платформы — 1c_get_bsl_syntax_help;",
  "устройство конфигурации — её выгрузка (1c_dump_config_to_files). Если все источники молчат — спроси пользователя."
].join(`
`);
var MASK_TOKEN = /\[[A-Z]{2,}-\d{3,}\]/g;
function maskedNote(result) {
  const tokens = [...new Set(resultText(result).match(MASK_TOKEN) ?? [])];
  if (!tokens.length)
    return null;
  return `В ответе тулкита есть маскированные фрагменты (${tokens.slice(0, 5).join(", ")}${tokens.length > 5 ? ", …" : ""}): ` + "тулкит сам заменяет токенами то, что похоже на персональные данные и реквизиты. Это не данные. Не подставляй " + "токен в запрос или код и не делай по нему выводов о значении — отбирай по ссылке, коду или части текста без " + "токена. Обходить маскирование не нужно: если токен попадёт в итоговый ответ пользователю, оставь его как есть " + "и перед ответом вызови 1c_submit_for_deanonymization с полным текстом — пользователь увидит настоящие значения.";
}
function maskedTokenRefusal(args) {
  const record = args ?? {};
  const text = [record.query, record.code].filter((value) => typeof value === "string").join(`
`);
  const token = text.match(MASK_TOKEN)?.[0];
  if (!token)
    return null;
  return `Отклонено: в тексте ${token} — токен, которым тулкит маскирует свой ответ, а не значение из базы. ` + "С ним запрос ничего не найдёт. Возьми ссылку, код или часть текста без токена.";
}

// src/main/infobase/plugin.ts
var NEVER_SENT = /Not connected|is not connected|ECONNREFUSED/i;
var LOADS = new Set(["load_config", "load_config_from_files", "load_epf_from_files"]);
function sourceFiles(path, name) {
  if (!path)
    return [];
  const root = /\.xml$/i.test(path) ? path.replace(/\.xml$/i, "") : path;
  let entries;
  try {
    entries = readdirSync2(root, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const suffix = `ext/${name}`.toLowerCase();
  return entries.map((entry) => entry.replace(/\\/g, "/")).filter((entry) => entry.toLowerCase() === suffix || entry.toLowerCase().endsWith(`/${suffix}`)).flatMap((entry) => {
    try {
      return [{ file: entry, text: readFileSync2(join5(root, entry), "utf8") }];
    } catch {
      return [];
    }
  });
}
function prefixFindings(path) {
  if (!path)
    return [];
  const isRootFile = /\.xml$/i.test(path);
  const root = isRootFile ? path.replace(/\.xml$/i, "") : path;
  let entries;
  try {
    entries = readdirSync2(root, { recursive: true, encoding: "utf8" }).filter((entry) => /\.xml$/i.test(entry));
  } catch {
    entries = [];
  }
  const files = [
    ...isRootFile ? [{ file: path.split(/[\\/]/).at(-1) ?? path, full: path }] : [],
    ...entries.map((entry) => ({ file: entry.replace(/\\/g, "/"), full: join5(root, entry) }))
  ];
  return files.flatMap((source) => {
    try {
      const prefixes = undeclaredPrefixes(readFileSync2(source.full, "utf8"));
      return prefixes.length > 0 ? [{ file: source.file, prefixes }] : [];
    } catch {
      return [];
    }
  });
}
function formTagFindings(path) {
  return sourceFiles(path, "Form.xml").flatMap((source) => {
    const findings = unknownFormTags(source.text);
    return findings.length > 0 ? [{ file: source.file, findings }] : [];
  });
}
function commandModuleFindings(path) {
  return sourceFiles(path, "CommandModule.bsl").flatMap((source) => {
    const finding = commandModuleFinding(source.text);
    return finding ? [{ file: source.file, finding }] : [];
  });
}
var diskProbe = {
  isFile: (path) => {
    try {
      return statSync2(path).isFile();
    } catch {
      return false;
    }
  },
  isDirectory: (path) => {
    try {
      return statSync2(path).isDirectory();
    } catch {
      return false;
    }
  }
};
var supportProbe = {
  ...diskProbe,
  readText: (path) => {
    try {
      return readFileSync2(path, "utf8");
    } catch {
      return null;
    }
  },
  readBytes: (path) => {
    try {
      return readFileSync2(path);
    } catch {
      return null;
    }
  }
};
var dumpProbe = {
  readText: supportProbe.readText,
  isFile: diskProbe.isFile,
  mtimeMs: (path) => {
    try {
      return statSync2(path).mtimeMs;
    } catch {
      return null;
    }
  },
  list: (path) => {
    try {
      return readdirSync2(path);
    } catch {
      return null;
    }
  }
};
function templateFingerprints() {
  try {
    const dir = fileURLToPath(new URL("./templates/", import.meta.url));
    return readdirSync2(dir).filter((name) => /\.(epf|erf)$/i.test(name)).map((name) => ({ label: `шаблон ${name}`, fingerprint: fingerprint(readFileSync2(`${dir}${name}`)) }));
  } catch {
    return [];
  }
}
var EXTENSION_SCOPED = new Set([
  "dump_config",
  "dump_config_to_files",
  "load_config",
  "load_config_from_files",
  "update_db",
  "delete_extension"
]);
var EXTENSION_ONLY = new Set(["load_config_from_files", "delete_extension"]);
var REQUEST_TIMED_OUT = "1ccoder-relay-timeout";
function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const target = new URL(url);
    const request = httpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.byteLength }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(REQUEST_TIMED_OUT)));
    request.on("error", reject);
    request.end(body);
  });
}
var REFUSALS = {
  "no-profile": "У этого сеанса нет профиля разработчика, поэтому информационной базы нет. " + "Чтобы работать с базой, начните сеанс с профилем.",
  "profile-missing": "Профиль, к которому был привязан сеанс, больше не существует.",
  "not-permitted": "Пользователь не разрешил запись в информационную базу.",
  "unknown-operation": "Неизвестная операция.",
  "path-required": "Для этой операции нужен путь к файлу.",
  "path-rejected": "Указанный путь использовать нельзя.",
  "launch-failed": "Не удалось запустить платформу 1С.",
  "timed-out": "Операция не завершилась за отведённое время и была прервана."
};
var TOOLKIT_STOPPED_NOTICE = "MCP Toolkit был закрыт: конфигуратор не может работать с базой, которую держит сеанс 1С:Предприятия. " + "Инструменты 1c_* к базе сейчас недоступны — если они снова нужны, вызови 1c_toolkit_start " + "(запуск занимает до нескольких минут, так что сначала выполни все операции конфигуратора).";
var TOOLKIT_BLOCKED_NOTICE = "ВНИМАНИЕ: после этого запуска MCP Toolkit перестал отвечать. Почти наверняка запущенная " + "обработка открыла модальное окно: оно блокирует весь сеанс 1С:Предприятия, а тулкит работает " + "внутри этого сеанса, поэтому инструменты 1c_execute_code, 1c_execute_query и остальные 1c_* " + "сейчас недоступны. Это сделал твой собственный вызов. Не повторяй его и не запускай другую " + "обработку — так появится второе такое же окно. Скажи пользователю, что нужно закрыть окно 1С.";
var TOOLKIT_RESTORED_NOTICE = "MCP Toolkit закрывался под эту операцию, но платформа так и не запустилась — он запускается " + "обратно сам. Инструменты 1c_* появятся через несколько десятков секунд; отдельно вызывать " + "1c_toolkit_start не нужно.";
function describe(response) {
  const notice = [
    ...response.toolkitStopped ? ["", TOOLKIT_STOPPED_NOTICE] : [],
    ...response.toolkitRestored ? ["", TOOLKIT_RESTORED_NOTICE] : [],
    ...response.toolkitBlocked ? ["", TOOLKIT_BLOCKED_NOTICE] : [],
    ...response.toolkitBlocked && response.blockingDialogs ? ["", "Окно, которое сейчас держит сеанс (текст прочитан с экрана) — перескажи его пользователю:", "", response.blockingDialogs] : []
  ];
  if (response.ok) {
    const status = response.exitCode === 0 ? "успешно" : `код возврата ${response.exitCode}`;
    return [`${response.summary ?? "Операция"}: ${status}`, "", response.output ?? "", ...notice].join(`
`).trim();
  }
  const message = REFUSALS[response.reason ?? ""] ?? "Операция не выполнена.";
  const body = response.detail ? `${message}

${response.detail}` : message;
  return [body, ...notice].join(`
`).trim();
}
var InfobasePlugin = async (input, options) => {
  const baseUrl = String(options?.baseUrl ?? "").replace(/\/+$/, "");
  const gateRequest = (sessionID) => ({ conversationId: `session:${sessionID}`, directory: input.directory });
  async function exec(request) {
    if (!baseUrl) {
      return { ok: false, reason: "launch-failed", detail: "1CCoder relay address was not provided." };
    }
    try {
      const { status, body } = await postJson(`${baseUrl}/1c/exec`, request, EXEC_REQUEST_TIMEOUT_MS);
      if (status !== 200) {
        return { ok: false, reason: "launch-failed", detail: `Relay responded ${status}` };
      }
      return JSON.parse(body);
    } catch (error) {
      const timedOut = error instanceof Error && error.message === REQUEST_TIMED_OUT;
      return {
        ok: false,
        reason: "launch-failed",
        detail: timedOut ? "Приложение не ответило за отведённое время. 1С могла остаться запущенной — " + "не повторяй вызов, сначала скажи пользователю." : `Связь с приложением 1CCoder не удалась: ${String(error)}`
      };
    }
  }
  async function writesWithoutAsking(sessionID) {
    return (await sessionProfile(sessionID))?.allowWriteWithoutConfirmation === true;
  }
  async function sessionPack(sessionID) {
    return packFor((await sessionProfile(sessionID))?.configuration?.name);
  }
  async function sessionProfile(sessionID) {
    const profile = await sessionBinding(sessionID);
    return profile?.ok ? profile : undefined;
  }
  async function sessionBinding(sessionID) {
    return relay("profile", { conversationId: `session:${sessionID}`, detect: false });
  }
  async function outsideWorkingDirectory(sessionID, id, args) {
    const created = createdPaths(id, args);
    if (created.length === 0)
      return null;
    const workingDirectory = (await sessionProfile(sessionID))?.workingDirectory;
    if (!workingDirectory)
      return null;
    const stray = created.find((path) => isAbsolutePath(path) && !insideDirectory(path, workingDirectory));
    return stray ? outsideWorkingRefusal(stray, workingDirectory) : null;
  }
  async function relay(path, body, timeoutMs = 1e4) {
    if (!baseUrl)
      return;
    try {
      const response = await fetch(`${baseUrl}/1c/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      return response.ok ? await response.json() : undefined;
    } catch {
      return;
    }
  }
  const sessionStarted = new Map;
  const noteSession = (sessionID) => {
    if (!sessionStarted.has(sessionID))
      sessionStarted.set(sessionID, Date.now());
  };
  const approvedRequests = new Map;
  const writesInFlight = new Map;
  const spentApprovals = new Map;
  const repeated = new RepeatedFailures;
  const unappliedExtensions = new Map;
  const unscopedUpdateDone = new Set;
  const toolkitStartedAt = new Map;
  const TOOLKIT_UNUSED_MS = 15 * 60 * 1000;
  const UNGUARDED_BY_UNUSED_TOOLKIT = new Set(["load_epf_from_files", "dump_epf_to_files"]);
  const ownTools = new Set;
  const shownDumps = new Map;
  async function journal(sessionID, line) {
    const profile = await sessionProfile(sessionID);
    if (!profile?.workingDirectory)
      return;
    try {
      mkdirSync(journalDirectory(profile.workingDirectory), { recursive: true });
      appendFileSync(journalPath(profile.workingDirectory), journalLine(line), "utf8");
    } catch {}
  }
  function describeProfileResponse(profile) {
    if (!profile.ok)
      return REFUSALS[profile.reason ?? ""] ?? "Профиль сеанса недоступен.";
    const toolkit = profile.toolkit;
    const toolkitLine = !toolkit ? "неизвестно" : toolkit.alive ? `работает, порт ${toolkit.port} отвечает` : toolkit.state === "died" ? toolkit.exit ? `УПАЛ — порт ${toolkit.port} больше не отвечает.
${describeExit(toolkit.exit)}` : `УПАЛ — был запущен, но порт ${toolkit.port} больше не отвечает (окно 1С закрыли или процесс завершился)` : `не работает (${toolkit.state}${toolkit.reason ? `: ${toolkit.reason}` : ""}), порт ${toolkit.port} молчит` + (toolkit.detail ? `
${toolkit.detail}` : "");
    return [
      `Профиль: ${profile.name}`,
      `Платформа: ${profile.platformPath}`,
      `Информационная база (${profile.kind === "file" ? "файловая" : "серверная"}): ${profile.infobase}`,
      `Пользователь: ${profile.userName}`,
      `Пароль: ${profile.hasPassword ? "сохранён в приложении (тебе не выдаётся)" : "не задан"}`,
      `Рабочий каталог: ${profile.workingDirectory}`,
      `Конфигурация: ${describeConfiguration(profile.configuration)}`,
      `MCP Toolkit: ${toolkitLine}`,
      ...profile.allowWriteWithoutConfirmation ? [
        "Запись в базу: без подтверждения — пользователь разрешил это в профиле. Код с записью " + "выполняй прямо в 1c_execute_code, 1c_write_code не нужен. Каждая запись по-прежнему " + "попадает в журнал сеанса (1c_session_writes) — объём и охват узнавай до записи и называй в отчёте."
      ] : [],
      "",
      toolkit?.state === "died" ? "Инструменты 1c_execute_query, 1c_execute_code и остальные 1c_* сейчас в твоём списке, но " + "ведут на мёртвый порт: вызов вернёт «fetch failed», и это не сетевая ошибка и не твой " + "код. Подними тулкит через 1c_toolkit_start и повтори." : toolkit && !toolkit.alive ? "Инструментов запросов к базе сейчас нет. Что с этим делать — в навыке 1ccoder-ib-toolkit-launch." : "Запросы к данным базы — через инструменты 1c_execute_query и другие 1c_*."
    ].join(`
`);
  }
  function makeTool(id, description, needsPath) {
    const definition = OPERATIONS[id];
    const scoped = EXTENSION_SCOPED.has(id);
    const extensionArgs = {
      extension: tool.schema.string().optional().describe("Имя расширения, если команда относится к расширению, а не к основной конфигурации " + "(в конфигураторе это -Extension). " + (id === "update_db" ? "Без него обновляется только основная конфигурация: загруженное расширение " + "в базе не применится, хотя ответ будет «успешно»." : id === "load_config" ? "После загрузки расширения вызови update_db с тем же extension — иначе база " + "продолжит исполнять прежнюю версию." : "Модули расширения в выгрузку основной конфигурации не попадают — без этого " + "параметра ты получишь не тот объект.")),
      extension_name: tool.schema.string().optional().describe("То же, что extension.")
    };
    return tool({
      description,
      args: needsPath ? {
        path: tool.schema.string().describe(pathSpec(id)?.kind === "directory" ? "Абсолютный путь к каталогу" : "Абсолютный путь к файлу"),
        ...requiresSecondPath(id) ? {
          epfPath: tool.schema.string().describe(id === "load_epf_from_files" ? "Абсолютный путь к собираемому файлу: .epf для обработки, .erf для отчёта" : secondPathSpec(id)?.kind === "input" ? "Абсолютный путь к файлу обработки или отчёта (.epf, .erf)" : "Второй путь")
        } : {},
        ...scoped ? extensionArgs : {},
        ...id === "dump_config_to_files" ? {
          refresh: tool.schema.boolean().optional().describe("Только если в каталоге уже есть выгрузка и нужна свежая: без него существующая " + "выгрузка возвращается как есть. С ним выгрузка расширения делается целиком, а основной " + "конфигурации — только объекты со сменившейся версией. Правка контейнера побайтово " + "(v8pack) версию не меняет: чтобы увидеть такую правку в основной конфигурации, " + "выгружай в новый пустой каталог.")
        } : {},
        ...id === "execute" ? {
          user_supplied: tool.schema.boolean().optional().describe("Только если пользователь сам назвал этот файл и просил его запустить.")
        } : {}
      } : scoped ? extensionArgs : {},
      async execute(given, ctx) {
        const args = { ...given, extension: given.extension?.trim() || given.extension_name?.trim() || undefined };
        noteSession(ctx.sessionID);
        if (EXTENSION_ONLY.has(id) && !args.extension) {
          return {
            title: definition.summary,
            output: "Отклонено: эта операция только для расширения — укажи его имя в `extension`. " + "Конфигуратор не запускался."
          };
        }
        const outside = await outsideWorkingDirectory(ctx.sessionID, id, args);
        if (outside) {
          return { title: definition.summary, output: outside };
        }
        const startedAt = toolkitStartedAt.get(ctx.sessionID);
        if (needsExclusiveInfobase(id) && !UNGUARDED_BY_UNUSED_TOOLKIT.has(id) && startedAt !== undefined) {
          const gate = Date.now() - startedAt < TOOLKIT_UNUSED_MS ? await relay("toolkit/gate", gateRequest(ctx.sessionID), 5000) : undefined;
          if (!gate || gate.port === "free") {
            toolkitStartedAt.delete(ctx.sessionID);
          } else {
            return {
              title: definition.summary,
              output: "Отклонено: MCP Toolkit запущен в этом сеансе и ещё не использован, а операция конфигуратора " + "его закроет — конфигуратор не запускался. Повтор не поможет: пока тулкит работает и не " + `использован, отказ повторится.
` + "Его инструменты (1c_execute_code, 1c_execute_query и другие) появляются в списке через 10–20 " + "секунд после запуска. Если их ещё нет — подожди (в оболочке `Start-Sleep -Seconds 15`) и " + "сделай то, ради чего его запускал. Порядок на будущее: сначала все операции " + "конфигуратора (загрузка, обновление, проверка), потом 1c_toolkit_start, потом проверки в базе."
            };
          }
        }
        const stillPending = unappliedExtensions.get(ctx.sessionID);
        if (id === "update_db" && !args.extension?.trim() && stillPending?.size && unscopedUpdateDone.has(ctx.sessionID)) {
          const calls = [...stillPending].map((name) => `1c_update_db({"extension": "${name}"})`).join(`
`);
          return {
            title: definition.summary,
            output: "Отклонено: основная конфигурация уже обновлена, повтор без extension ничего не изменит — " + `конфигуратор не запускался. Не применены расширения: ${[...stillPending].join(", ")}. ` + `Передай имя в аргументе extension:
${calls}`
          };
        }
        const badPath = checkPath(id, args.path, diskProbe);
        if (badPath) {
          return { title: definition.summary, output: badPath };
        }
        const badSecond = checkSecondPath(id, args.epfPath, diskProbe);
        if (badSecond) {
          return { title: definition.summary, output: badSecond };
        }
        const kind = pathSpec(id)?.kind;
        if (args.path && (kind === "output" || kind === "directory") && insideTemp(args.path)) {
          return { title: definition.summary, output: tempRefusal(args.path) };
        }
        const earlier = id === "dump_config_to_files" && args.path ? existingDump(args.path, dumpProbe) : null;
        if (earlier && !args.refresh) {
          return { title: definition.summary, output: describeExistingDump(earlier) };
        }
        if (id === "dump_config_to_files" && !earlier && !args.extension?.trim()) {
          const profile = await sessionProfile(ctx.sessionID);
          const infobase = profile?.infobase?.trim();
          const parents = [
            profile?.workingDirectory ?? "",
            infobase && isAbsolutePath(infobase) ? dirname2(infobase.replace(/[\\/]+$/, "")) : ""
          ];
          const nearby = dumpNearby(parents, dumpProbe, profile?.configuration?.name);
          const shown = shownDumps.get(ctx.sessionID) ?? new Set;
          if (nearby && !(args.refresh && shown.has(nearby.root))) {
            shownDumps.set(ctx.sessionID, shown.add(nearby.root));
            return { title: definition.summary, output: describeExistingDump(nearby, Date.now(), true) };
          }
        }
        if (id === "execute" && args.path) {
          const refusal = provenanceRefusal(args.path.trim(), {
            modifiedMs: dumpProbe.mtimeMs(args.path.trim()),
            sessionStartedMs: sessionStarted.get(ctx.sessionID) ?? Date.now(),
            userSupplied: args.user_supplied === true
          });
          if (refusal)
            return { title: definition.summary, output: refusal };
        }
        const formTags = id === "load_config_from_files" || id === "load_epf_from_files" ? formTagFindings(args.path) : [];
        const tagRefusal = formTagRefusal(formTags);
        if (tagRefusal)
          return { title: definition.summary, output: tagRefusal };
        const commands = id === "load_config_from_files" ? commandModuleFindings(args.path) : [];
        const commandRefusal = commandModuleRefusal(commands);
        if (commandRefusal)
          return { title: definition.summary, output: commandRefusal };
        const prefixes = id === "load_config_from_files" || id === "load_epf_from_files" ? prefixRefusal(prefixFindings(args.path)) : null;
        if (prefixes)
          return { title: definition.summary, output: prefixes };
        const rootKind = id === "load_epf_from_files" && args.path ? externalKind(dumpProbe.readText(args.path.trim()) ?? "") : null;
        const wanted = rootKind ? EXTERNAL_EXTENSIONS[rootKind] : null;
        if (wanted && args.epfPath && !args.epfPath.trim().toLowerCase().endsWith(wanted)) {
          const fixed = args.epfPath.trim().replace(/\.(epf|erf)$/i, wanted);
          return {
            title: definition.summary,
            output: `Отклонено: корень ${args.path} описывает ${rootKind === "report" ? "внешний отчёт" : "внешнюю обработку"}, ` + `а целевой файл — не ${wanted}. Платформа сама допишет ${wanted} и соберёт в другой файл, а этот ` + `останется прежним. Конфигуратор не запускался. Укажи epfPath: "${fixed}" — файла может ещё не быть.`
          };
        }
        const targetBefore = id === "load_epf_from_files" && args.epfPath ? dumpProbe.mtimeMs(args.epfPath.trim()) : null;
        if (writesToInfobase(id) && !await writesWithoutAsking(ctx.sessionID)) {
          await ctx.ask({
            permission: "infobase_write",
            patterns: [id],
            always: [],
            metadata: {
              operation: id,
              summary: definition.summary,
              path: args.path ?? null,
              ...args.user_supplied ? { userSupplied: "обработку назвал пользователь; в этом сеансе она не собиралась" } : {}
            }
          });
        }
        const bindings = id === "load_epf_from_files" ? bindFormsBeforeBuild(args.path) : id === "load_config_from_files" ? bindFormsBeforeBuild(args.path, true) : null;
        const response = await exec({
          conversationId: `session:${ctx.sessionID}`,
          operation: id,
          path: args.path,
          ...args.epfPath ? { secondPath: args.epfPath } : {},
          ...earlier && !args.extension?.trim() ? { update: true } : {},
          ...args.extension?.trim() ? { extension: args.extension.trim() } : {},
          permitted: writesToInfobase(id) ? true : undefined
        });
        const succeeded = response.ok && response.exitCode === 0;
        const dropped = succeeded && LOADS.has(id) ? droppedParts(response.output ?? "") : [];
        const partial = dropped.length > 0 ? partialLoadNote(dropped) : null;
        const tagWarning = succeeded ? formTagWarning(formTags) : null;
        const xdtoSchema = succeeded ? null : /Исключение XDTO[^\n]*?([^\s"]*Template\.xml)/i.exec(response.output ?? "")?.[1];
        const xdtoHint = xdtoSchema ? `Платформа назвала только файл. Если это схема компоновки, 1c_check_dcs с path: "${xdtoSchema}" ` + "назовёт шаг и ошибку без новой загрузки." : null;
        const commandWarning = succeeded ? commandModuleWarning(commands) : null;
        const stillWrong = (id === "load_epf_from_files" || id === "dump_epf_to_files") && succeeded ? formBindingReport(args.path) : id === "load_config_from_files" && succeeded ? formBindingReport(args.path, true) : null;
        const rootNote = id === "dump_epf_to_files" && succeeded && args.path ? (() => {
          const roots = (dumpProbe.list(args.path) ?? []).filter((name) => /\.xml$/i.test(name) && dumpProbe.list(join5(args.path, name.replace(/\.xml$/i, ""))) !== null);
          return roots.length ? `
Корневой файл выгрузки: ${roots.map((name) => join5(args.path, name)).join(", ")} — его передавай в ` + "1c_load_epf_from_files как `path`." : null;
        })() : null;
        const targetAfter = id === "load_epf_from_files" && succeeded && args.epfPath ? dumpProbe.mtimeMs(args.epfPath.trim()) : null;
        const notBuilt = id === "load_epf_from_files" && succeeded && args.epfPath && (targetAfter === null || targetAfter === targetBefore) ? (() => {
          const target = args.epfPath.trim();
          const elsewhere = [".erf", ".epf"].map((ext) => target + ext).filter((path) => dumpProbe.mtimeMs(path) !== null);
          return `
ВНИМАНИЕ: конфигуратор ответил «успешно», но ${target} ${targetAfter === null ? "не появился" : "не изменился"}.` + (elsewhere.length ? ` Платформа записала сборку в ${elsewhere.join(", ")} — переименуй в файл с нужным расширением.` : "");
        })() : null;
        const built = id === "load_epf_from_files" && succeeded && !notBuilt && rootKind ? `
Собран ${rootKind === "report" ? "внешний отчёт" : "внешняя обработка"}: ${args.epfPath.trim()}. ` + (rootKind === "report" ? "Сформируй его, как сформирует пользователь: 1c_run_report." : "Проверь компиляцию модулей и форм: 1c_check_epf.") : null;
        const leftBehind = id === "load_config_from_files" && !succeeded ? `
Загрузка не прошла, но расширение ${args.extension} могло уже появиться в базе — пустым. ` + "Исправь файлы по сообщению выше и загрузи снова (загрузка заменит расширение целиком) или " + `удали его: 1c_delete_extension с extension: "${args.extension}".` : null;
        const extensionName = args.extension?.trim();
        const pending = unappliedExtensions.get(ctx.sessionID) ?? new Set;
        const isLoad = id === "load_config" || id === "load_config_from_files";
        if (succeeded && isLoad && extensionName)
          pending.add(extensionName);
        if (succeeded && (id === "update_db" || id === "delete_extension") && extensionName)
          pending.delete(extensionName);
        unappliedExtensions.set(ctx.sessionID, pending);
        if (succeeded && id === "update_db" && !extensionName && pending.size > 0)
          unscopedUpdateDone.add(ctx.sessionID);
        if (succeeded && isLoad)
          unscopedUpdateDone.delete(ctx.sessionID);
        const applyNext = isLoad && extensionName && succeeded ? `
Расширение ${extensionName} загружено, но база исполняет прежнюю версию, пока не вызван ` + `1c_update_db с extension: "${extensionName}". Проверять — в сеансе, начатом после этого.` : id === "update_db" && !extensionName && succeeded && pending.size > 0 ? `
Обновлена только основная конфигурация. Загруженные в этом сеансе расширения в базе ` + `не применены: ${[...pending].join(", ")}. Для каждого вызови 1c_update_db с его extension.` : null;
        return {
          title: definition.summary,
          output: [partial, describe(response), notBuilt, built, bindings, stillWrong, tagWarning, commandWarning, rootNote, applyNext, leftBehind, xdtoHint].filter(Boolean).join(`
`)
        };
      }
    });
  }
  const TOOLKIT_REFUSALS = {
    "no-conversation": "Не удалось определить сеанс.",
    "no-profile": REFUSALS["no-profile"],
    "profile-missing": REFUSALS["profile-missing"],
    "no-toolkit": "Файл MCP_Toolkit.epf не найден нигде, даже в поставке приложения: установка повреждена. " + "Скажи пользователю переустановить 1CCoder; искать или скачивать файл самому не нужно.",
    "port-taken": "Порт уже занят другим экземпляром. Выясни, к какой базе он подключён " + "(СтрокаСоединенияИнформационнойБазы), прежде чем что-то делать.",
    "launch-failed": "Не удалось запустить платформу 1С.",
    timeout: "Платформа запущена, но порт не ответил за отведённое время. Процесс 1С оставлен работать: повторный " + "1c_toolkit_start продолжит ждать его, а не откроет второй.",
    dialog: "1С запустилась, но показала окно, и оно блокирует сеанс — поэтому тулкит не открылся. Текст окна " + "ниже, прочитан с экрана. Если окно ничего не решает — закрой его сам: 1c_close_dialog с PID и кнопкой " + "(обычно «Закрыть»), затем снова 1c_toolkit_start: он продолжит ждать уже запущенный процесс. Если " + "закрытием его не снять — нет прав, нужен вход, вопрос о данных, — перескажи окно пользователю и скажи, " + "что нужно сделать. Настройки базы, чтобы окно не появлялось, не меняй.",
    "designer-busy": "Сейчас работает операция конфигуратора, она держит базу монопольно — тулкит поднимать нельзя. " + "Дождись результата той операции и вызови 1c_toolkit_start снова. " + "И не отправляй операцию конфигуратора и вызов 1c_* в одном шаге: первая закрывает базу, " + "которая нужна второму."
  };
  const toolkitStartTool = tool({
    description: "Открыть MCP Toolkit для информационной базы этого сеанса. Вызывай, когда задача требует " + "данных или кода 1С, а инструментов 1c_execute_query, 1c_execute_code и других 1c_* нет в " + "списке: они появляются только вместе с работающим тулкитом. Открывает окно 1С, поэтому " + "без необходимости не вызывай. Возврат управления не означает, что инструменты уже готовы.",
    args: {},
    async execute(_args, ctx) {
      if (!baseUrl) {
        return { title: "Запуск MCP Toolkit", output: "Адрес сервиса 1CCoder не передан." };
      }
      const response = await fetch(`${baseUrl}/1c/toolkit/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: `session:${ctx.sessionID}` })
      });
      if (!response.ok) {
        return { title: "Запуск MCP Toolkit", output: `Не удалось запустить: ответ ${response.status}` };
      }
      const result = await response.json();
      if (!result.ok) {
        const message = TOOLKIT_REFUSALS[result.reason ?? ""] ?? "Не удалось открыть MCP Toolkit.";
        return {
          title: "Запуск MCP Toolkit",
          output: result.detail ? `${message}

${result.detail}` : message
        };
      }
      toolkitStartedAt.set(ctx.sessionID, Date.now());
      const waiting = "Инструменты 1c_* появятся в твоём списке через 10–20 секунд. **Не вызывай их, пока не увидишь в " + "списке** — такой вызов вернёт ошибку и потратит шаг. Продолжай пока другую работу, а если без базы " + "продолжать нечем — подожди в оболочке (`Start-Sleep -Seconds 15`). Повторно запускать не надо. " + "Любая операция конфигуратора (проверка, выгрузка, загрузка, обновление БД) снова закроет тулкит. " + "Окно работы тулкита может оказаться коротким: платформа иногда сама закрывает такой сеанс через " + "несколько минут. Когда инструменты появятся, первым вызовом сделай то, ради чего тулкит поднят " + "(печать, проверку), а изучение базы — после.";
      return {
        title: "Запуск MCP Toolkit",
        output: result.state === "running" ? `MCP Toolkit работает, порт ${result.port}. ${waiting}` : `1С запускается — это занимает десятки секунд. ${waiting}`
      };
    }
  });
  const profileInfoTool = tool({
    description: "Профиль сеанса: имя, путь к платформе 1С, информационная база, пользователь, рабочий каталог " + "и состояние MCP Toolkit. Ничего не запускает и не меняет. Вызывай это вместо поиска платформы " + "и базы по файловой системе.",
    args: {},
    async execute(_args, ctx) {
      if (!baseUrl) {
        return { title: "Профиль сеанса", output: "Адрес сервиса 1CCoder не передан." };
      }
      const response = await fetch(`${baseUrl}/1c/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: `session:${ctx.sessionID}` })
      });
      if (!response.ok) {
        return { title: "Профиль сеанса", output: `Не удалось получить профиль: ответ ${response.status}` };
      }
      return {
        title: "Профиль сеанса",
        output: describeProfileResponse(await response.json())
      };
    }
  });
  function subdirectories(target) {
    try {
      return readdirSync2(target, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join5(target, entry.name));
    } catch {
      return [];
    }
  }
  function formsOf(target, tree = false) {
    if (!target)
      return [];
    if (tree) {
      return subdirectories(target).flatMap((kind) => /[\\/]CommonForms$/i.test(kind) ? subdirectories(kind).map((form) => ({ name: form.split(/[\\/]/).at(-1) ?? form, ext: join5(form, "Ext") })) : formsOf(kind));
    }
    const roots = /\.xml$/i.test(target) ? [target.replace(/\.xml$/i, "")] : (() => {
      try {
        return readdirSync2(target, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join5(target, entry.name));
      } catch {
        return [];
      }
    })();
    return roots.flatMap((root) => {
      try {
        const formsDir = join5(root, "Forms");
        if (!statSync2(formsDir).isDirectory())
          return [];
        return readdirSync2(formsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, ext: join5(formsDir, entry.name, "Ext") }));
      } catch {
        return [];
      }
    });
  }
  function bindFormsBeforeBuild(descriptionPath, tree = false) {
    const touched = formsOf(descriptionPath, tree).flatMap((form) => {
      try {
        const xmlPath = join5(form.ext, "Form.xml");
        const result = bindFormEvents({
          xml: readFileSync2(xmlPath, "utf8"),
          module: readFileSync2(join5(form.ext, "Form", "Module.bsl"), "utf8")
        });
        if (!result.bound.length && !result.repaired.length)
          return [];
        writeFileSync(xmlPath, result.xml, "utf8");
        return [{ form: `Forms/${form.name}`, bound: result.bound, repaired: result.repaired }];
      } catch {
        return [];
      }
    });
    return describeBindings(touched);
  }
  function formBindingReport(descriptionPath, tree = false) {
    return describeFormBindings(formsOf(descriptionPath, tree).flatMap((form) => {
      try {
        return [
          {
            form: `Forms/${form.name}`,
            findings: inspectFormBindings({
              xml: readFileSync2(join5(form.ext, "Form.xml"), "utf8"),
              module: readFileSync2(join5(form.ext, "Form", "Module.bsl"), "utf8")
            })
          }
        ];
      } catch {
        return [];
      }
    }));
  }
  async function selectiveBaseDump(sessionID, directory) {
    const read = () => dumpProbe.readText(join5(directory, "Configuration.xml")) ?? "";
    const language = () => /<DefaultLanguage>Language\.([^<]+)<\/DefaultLanguage>/.exec(read())?.[1];
    const hasLanguage = () => {
      const name = language();
      return name !== undefined && existsSync2(join5(directory, "Languages", `${name}.xml`));
    };
    if (hasLanguage())
      return { root: directory };
    let toolkitStopped = false;
    const run = async (objects) => {
      const response = await exec({
        conversationId: `session:${sessionID}`,
        operation: "dump_config_to_files",
        path: directory,
        objects
      });
      toolkitStopped ||= response.toolkitStopped === true;
      return response.ok && response.exitCode === 0 ? null : describe(response);
    };
    const failed = await run(["Configuration"]) ?? (language() ? await run([`Language.${language()}`]) : null);
    if (failed)
      return `Выгрузка основной конфигурации базы не найдена, а выборочная выгрузка корня и языка не удалась:
${failed}`;
    if (!hasLanguage())
      return "Выборочная выгрузка прошла, но основного языка конфигурации в ней нет. Укажи выгрузку базы в base_dump.";
    return {
      root: directory,
      note: `Выгрузки базы не было — корень конфигурации и основной язык выгружены выборочно в ${directory} ` + `(два коротких запуска конфигуратора, около полуминуты каждый).${toolkitStopped ? " MCP Toolkit при этом был закрыт." : ""}`
    };
  }
  const newExtensionTool = tool({
    description: "Создать в рабочем каталоге заготовку нового расширения в XML: Configuration.xml и язык, " + "согласованные с базой профиля. Дальше в этот каталог добавляются объекты (в формате выгрузки), " + "и он загружается 1c_load_config_from_files. Базу не меняет.",
    args: {
      path: tool.schema.string().describe("Каталог заготовки — новый или пустой, в рабочем каталоге профиля"),
      name: tool.schema.string().describe("Имя расширения, например ПланыПродаж"),
      prefix: tool.schema.string().describe("Префикс имён собственных объектов расширения, например пп_"),
      synonym: tool.schema.string().optional().describe("Представление расширения для пользователя"),
      purpose: tool.schema.enum(["Customization", "AddOn", "Patch"]).optional().describe("Назначение: Customization (адаптация, по умолчанию), AddOn (дополнение), Patch (исправление)"),
      base_dump: tool.schema.string().optional().describe("Корень выгрузки основной конфигурации базы; без него ищется рядом с базой и в рабочем каталоге")
    },
    async execute(args, ctx) {
      const title = `Заготовка расширения ${args.name}`;
      const refuse = (output) => ({ title, output });
      if (!isMetadataName(args.name))
        return refuse(`Недопустимое имя расширения: «${args.name}».`);
      if (!isMetadataName(args.prefix))
        return refuse(`Недопустимый префикс: «${args.prefix}».`);
      const profile = await sessionProfile(ctx.sessionID);
      const workingDirectory = profile?.workingDirectory;
      if (!workingDirectory)
        return refuse(REFUSALS["no-profile"] ?? "Профиль сеанса не определён.");
      const target = isAbsolutePath(args.path) ? args.path.trim() : join5(workingDirectory, args.path.trim());
      if (!insideDirectory(target, workingDirectory))
        return refuse(outsideWorkingRefusal(target, workingDirectory));
      if (existsSync2(join5(target, "Configuration.xml"))) {
        return refuse(`В ${target} уже есть Configuration.xml — заготовка не перезаписывает чужую работу. Выбери новый каталог.`);
      }
      const infobase = profile?.infobase?.trim();
      const dump = args.base_dump?.trim() ? { root: args.base_dump.trim() } : dumpNearby([workingDirectory, infobase && isAbsolutePath(infobase) ? dirname2(infobase.replace(/[\\/]+$/, "")) : ""], dumpProbe, profile?.configuration?.name);
      const selective = dump ? null : await selectiveBaseDump(ctx.sessionID, join5(workingDirectory, "base_facts"));
      if (typeof selective === "string")
        return refuse(selective);
      const root = dump?.root ?? selective?.root;
      if (!root)
        return refuse("Не найдена выгрузка основной конфигурации базы. Укажи её в base_dump.");
      const facts = baseFactsFromDump(root, dumpProbe.readText);
      if (typeof facts === "string")
        return refuse(facts);
      const files = extensionSkeleton(facts, args);
      for (const [relative, content] of Object.entries(files)) {
        mkdirSync(dirname2(join5(target, relative)), { recursive: true });
        writeFileSync(join5(target, relative), content, "utf8");
      }
      return {
        title,
        output: [
          `Заготовка создана: ${target}`,
          `Файлы: ${Object.keys(files).join(", ")}.`,
          ...selective?.note ? [selective.note] : [],
          `Согласовано с выгрузкой ${root}: версия формата ${facts.formatVersion}, совместимость ` + `${facts.compatibilityMode}, язык ${facts.language.name}.`,
          "",
          "Дальше:",
          `1. Добавь объекты в формате выгрузки: файл объекта в каталоге вида (Enums/, Documents/, …) и строку в ` + "ChildObjects в Configuration.xml. Как пишется объект того же вида — смотри в выгрузке базы. " + `Имена собственных объектов — с префиксом ${args.prefix}.`,
          `2. 1c_load_config_from_files: path — этот каталог, extension: "${args.name}".`,
          `3. 1c_update_db с extension: "${args.name}".`,
          `4. Файл .cfe для передачи: 1c_dump_config с extension: "${args.name}" и путём *.cfe.`
        ].join(`
`)
      };
    }
  });
  const newExternalTool = tool({
    description: "Создать в рабочем каталоге исходники новой внешней обработки (.epf) или внешнего отчёта (.erf) в XML — " + "корневой файл с верными идентификаторами классов, модуль объекта, а для отчёта — основную схему " + "компоновки (рабочий пример: набор, ресурс, обязательный параметр, группировка с вложенными детальными " + "записями, минимальная ширина колонки). Дальше правишь файлы и собираешь 1c_load_epf_from_files; " + "готовый контейнер копировать не нужно. С form: true у обработки сразу есть управляемая форма с командой " + "«Выполнить» и модулем — файлы формы с нуля не пиши. Базу не меняет.",
    args: {
      kind: tool.schema.enum(["processor", "report"]).describe("processor — обработка (.epf), report — отчёт (.erf)"),
      name: tool.schema.string().describe("Имя объекта в метаданных, например ВаловаяПрибыль"),
      path: tool.schema.string().describe("Каталог исходников в рабочем каталоге профиля — новый или пустой"),
      synonym: tool.schema.string().optional().describe("Представление для пользователя"),
      form: tool.schema.boolean().optional().describe("Только для processor: добавить форму «Форма» с командой «Выполнить» — если обработке нужен интерфейс")
    },
    async execute(args, ctx) {
      const title = `Исходники ${args.kind === "report" ? "отчёта" : "обработки"} ${args.name}`;
      const refuse = (output) => ({ title, output });
      if (!isMetadataName(args.name))
        return refuse(`Недопустимое имя: «${args.name}».`);
      const workingDirectory = (await sessionProfile(ctx.sessionID))?.workingDirectory;
      if (!workingDirectory)
        return refuse(REFUSALS["no-profile"] ?? "Профиль сеанса не определён.");
      const target = isAbsolutePath(args.path) ? args.path.trim() : join5(workingDirectory, args.path.trim());
      if (!insideDirectory(target, workingDirectory))
        return refuse(outsideWorkingRefusal(target, workingDirectory));
      if (existsSync2(join5(target, `${args.name}.xml`))) {
        return refuse(`В ${target} уже есть ${args.name}.xml — исходники не перезаписываются. Выбери новый каталог.`);
      }
      const files = externalSkeleton(args.kind, {
        name: args.name,
        ...args.synonym ? { synonym: args.synonym } : {},
        ...args.form && args.kind === "processor" ? { form: true } : {}
      });
      for (const [relative, content] of Object.entries(files)) {
        mkdirSync(dirname2(join5(target, relative)), { recursive: true });
        writeFileSync(join5(target, relative), content, "utf8");
      }
      const root = join5(target, `${args.name}.xml`);
      const built = join5(target, `${args.name}${EXTERNAL_EXTENSIONS[args.kind]}`);
      const schema = join5(target, args.name, "Templates", SCHEMA_TEMPLATE, "Ext", "Template.xml");
      return {
        title,
        output: [
          `Исходники созданы: ${target}`,
          `Файлы: ${Object.keys(files).join(", ")}.`,
          "",
          "Дальше:",
          ...args.kind === "report" ? [
            `1. Замени пример в схеме ${schema} своим запросом, полями, ресурсами и вариантом; сохраняй форму ` + "примера (как писать схему — навык 1ccoder-ib-reports).",
            `2. 1c_check_dcs с path: "${schema}" — до сборки.`,
            `3. 1c_load_epf_from_files: path "${root}", epfPath "${built}".`,
            "4. 1c_run_report — сформировать, как сформирует пользователь, и прочитать PDF."
          ] : [
            `1. Код — в ${join5(target, args.name, "Ext", "ObjectModule.bsl")}` + (args.form ? `; форма — ${join5(target, args.name, "Forms", "Форма", "Ext", "Form.xml")} (элементы, реквизиты, ` + `команды), её модуль — ${join5(target, args.name, "Forms", "Форма", "Ext", "Form", "Module.bsl")}. ` + "Новые элементы и реквизиты добавляй в Form.xml по образцу того, что там уже есть." : ". Если нужна форма — создай исходники заново с form: true, а не пиши её файлы сам."),
            `2. 1c_load_epf_from_files: path "${root}", epfPath "${built}".`,
            "3. 1c_check_epf — компиляция модуля и форм."
          ]
        ].join(`
`)
      };
    }
  });
  const runReportTool = tool({
    description: "Сформировать внешний отчёт (.erf) так, как его сформирует пользователь: основная схема, вариант по " + "умолчанию, плюс только переданные параметры и отборы. Пишет PDF, MXL и текст ячеек в рабочий каталог и " + "говорит, какие параметры пусты при первом открытии, в каких колонках пустые ячейки и где текст шире " + "колонки. Прочитай PDF — так отчёт видно глазами. Один прогон проверяет один случай: меняй то, по чему " + "ветвится запрос (валюта, есть ли цена, характеристика, дата на границе изменения цены), и сверяй числа " + "с независимым запросом. Нужен работающий MCP Toolkit; только чтение.",
    args: {
      path: tool.schema.string().describe("Абсолютный путь к собранному .erf"),
      params: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("Параметры данных: имя → значение текстом. Элемент справочника — наименование или код, дата — " + "ГГГГ-ММ-ДД, стандартный период — «ГГГГ-ММ-ДД..ГГГГ-ММ-ДД», число — с точкой"),
      filters: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("Отборы: поле → значение текстом (элемент иерархического справочника отбирается «в иерархии»)")
    },
    async execute(args, ctx) {
      const title = "Формирование отчёта";
      const path = args.path.trim();
      if (!/\.erf$/i.test(path))
        return { title, output: `Ожидается внешний отчёт .erf, получено: ${path}` };
      if (!dumpProbe.isFile(path))
        return { title, output: `Файла нет: ${path}` };
      const workingDirectory = (await sessionProfile(ctx.sessionID))?.workingDirectory;
      if (!workingDirectory)
        return { title, output: REFUSALS["no-profile"] ?? "Профиль сеанса не определён." };
      const runs = join5(workingDirectory, "report_runs");
      mkdirSync(runs, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      const outBase = join5(runs, `${path.replace(/^.*[\\/]/, "").replace(/\.erf$/i, "")}-${stamp}`);
      const result = await relay("run-report", { conversationId: `session:${ctx.sessionID}`, path, params: args.params ?? {}, filters: args.filters ?? {}, outBase }, 330000);
      if (!result)
        return { title, output: "Формирование отчёта не ответило." };
      if (result.ok)
        return { title, output: result.text ?? "" };
      const reason = {
        "toolkit-down": "Отчёт сформировать нельзя: MCP Toolkit не работает — подними его через 1c_toolkit_start и повтори.",
        "designer-busy": "Отчёт сформировать нельзя: идёт операция конфигуратора. Дождись её и повтори.",
        "other-infobase": "На порту тулкита работает другая информационная база — формировать в ней нельзя.",
        "no-profile": REFUSALS["no-profile"]
      }[result.reason ?? ""] ?? "Отчёт сформировать не удалось.";
      return { title, output: `${reason}${result.detail ? `

${result.detail}` : ""}` };
    }
  });
  const mxlInfoTool = tool({
    description: "Структура макета из выгрузки конфигурации (Template.xml): именованные области с границами " + "в нумерации 1С, высоты строк, параметры ячеек и — главное — объединения по вертикали, " + "из-за которых строка выглядит свободной, не будучи ею. Вызывай ДО правки строки в " + "поставляемом макете. Только чтение файла, базу не трогает.",
    args: {
      path: tool.schema.string().describe("Путь к Template.xml макета в выгрузке, например ...\\\\cfg\\\\CommonTemplates\\\\<Имя>\\\\Ext\\\\Template.xml"),
      area: tool.schema.string().optional().describe("Имя области — тогда строки показываются только по ней. Без него: все области и все строки.")
    },
    async execute(args) {
      const title = `Макет: ${args.path.split(/[\\/]/).slice(-3).join("\\")}`;
      const xml = (() => {
        try {
          return readFileSync2(args.path, "utf8");
        } catch (error) {
          return error instanceof Error ? new Error(error.message) : new Error(String(error));
        }
      })();
      if (xml instanceof Error) {
        return {
          title,
          output: `Не удалось прочитать файл: ${xml.message}

` + "Нужен именно Template.xml из выгрузки конфигурации (1c_dump_config_to_files), " + "а не .mxl и не сам макет из базы."
        };
      }
      const template = parseMxlTemplate(xml);
      if (!template.rows.length && !template.areas.length) {
        return {
          title,
          output: "Файл прочитан, но структуры макета в нём нет — это не Template.xml табличного документа."
        };
      }
      return { title, output: describeMxlTemplate(template, args.area) };
    }
  });
  const sampleChecks = new Map;
  const modifiedAt = (path) => {
    try {
      return statSync2(path).mtimeMs;
    } catch {
      return null;
    }
  };
  const dumpObjectTool = tool({
    description: "Состав объекта конфигурации из её выгрузки: реквизиты с типами, табличные части, измерения и ресурсы " + "регистров, значения перечислений, формы, макеты, команды и модули с путями. Работает без тулкита. " + "Вызывай вместо разбора XML выгрузки в оболочке.",
    args: {
      object: tool.schema.string().describe("Вид и имя: Документ.ПриемНаРаботу, Справочник.Сотрудники, РегистрСведений.…"),
      dump: tool.schema.string().optional().describe("Корень выгрузки (где Configuration.xml); без него — выгрузка базы профиля")
    },
    async execute(args, ctx) {
      const title = `Состав ${args.object}`;
      const profile = await sessionProfile(ctx.sessionID);
      const infobase = profile?.infobase?.trim();
      const root = args.dump?.trim() || dumpNearby([profile?.workingDirectory ?? "", infobase && isAbsolutePath(infobase) ? dirname2(infobase.replace(/[\\/]+$/, "")) : ""], dumpProbe, profile?.configuration?.name)?.root;
      if (!root)
        return { title, output: "Выгрузка конфигурации базы не найдена. Укажи её корень в dump." };
      return {
        title,
        output: describeDumpObject(root, args.object, {
          readText: dumpProbe.readText,
          list: (dir) => {
            try {
              return readdirSync2(dir);
            } catch {
              return null;
            }
          }
        })
      };
    }
  });
  const compareWithSampleTool = tool({
    description: "Сверка печатной формы с образцом, поле за полем. Вызывай после печати текущей сборки в PDF и до " + "регистрации обработки: регистрация без сверки текущей сборки не выполнится. В fields — каждое поле " + "образца сверху вниз: шапка, каждое значение, каждая надпись, каждая пустая строка для записи от руки. " + "Поле — то, что подписано в образце: у каждой мелкой подписи под линией своя строка, даже если в " + "типовом макете две подписи стоят под одной линией. " + "sample — что в образце (пусто — «пусто»; вписанное ручкой — так и напиши: «от руки: …»), print — что " + "в твоём PDF, match — совпало ли по виду и смыслу, reason — для несовпавшего: что исправишь или почему " + "остаётся так. Таблица из ответа входит в итоговый отчёт.",
    args: {
      sample: tool.schema.string().describe("Файл образца (картинка или PDF); без образца — файл задания"),
      print: tool.schema.string().describe("PDF печати текущей сборки"),
      epf: tool.schema.string().describe("Файл собранной обработки, которую печатал"),
      fields: tool.schema.array(tool.schema.object({
        field: tool.schema.string().describe("Какое поле: «дата ознакомления», «характер работы»"),
        sample: tool.schema.string().describe("Что в образце"),
        print: tool.schema.string().describe("Что в печати"),
        match: tool.schema.boolean(),
        reason: tool.schema.string().optional().describe("Для несовпавшего: что исправишь или почему так")
      })).describe("Каждое поле образца")
    },
    async execute(args, ctx) {
      const title = "Сверка с образцом";
      const result = checkComparison(args, modifiedAt);
      if (!result.ok)
        return { title, output: result.error };
      sampleChecks.set(ctx.sessionID, result.check);
      const differing = result.check.rows.filter((row) => !row.match).length;
      return {
        title,
        output: `${result.report}

` + (differing ? "Каждое отличие — исправь (и сверь новую печать заново) или оставь с причиной и перенеси в отчёт. " : "") + "Сверка записана для этой сборки: её можно регистрировать. Пересборка потребует новой сверки. " + "Эту таблицу включи в итоговый отчёт."
      };
    }
  });
  const mxlEditTool = tool({
    description: "Изменить макет (Template.xml) на месте. Координаты — строка и колонка в нумерации 1С, как их показывает " + "1c_mxl_info. Для печатной формы по образцу, похожему на типовую, — скопируй Template.xml типового макета " + `в свою обработку и поменяй только отличия.
` + `Что умеет (в одном вызове — сколько угодно правок, применяются по порядку, всё или ничего):
` + `- ячейка: text, template (текст с [Параметр]), parameter или clear;
` + `- новая ячейка: create: true, формат можно взять у другой: like {row, column};
` + "- оформление ячейки: style {bold, size, underline, align, wrap} — underline рисует линию под ячейкой, " + `как у полей для заполнения;
` + "- объединение: merge {row, column, rows, columns} — левая верхняя ячейка и размер; то же объединение с " + `тем же углом меняет размер. unmerge {row, column} — разъединить.
` + "- объединение колонок (1c_mxl_info: «Объединения колонок») действует во всех строках: внутри него печатается " + `только его первая колонка. unmerge_columns {row, column, rows} отменяет его в rows строках начиная с row.
` + "Разделить одну ячейку на две: unmerge, два merge, create для второй. Строк не добавляет. " + "Правит только файлы в рабочем каталоге.",
    args: {
      path: tool.schema.string().describe("Template.xml макета в рабочем каталоге"),
      edits: tool.schema.array(tool.schema.object({
        row: tool.schema.number().optional().describe("Строка ячейки, с 1, как в 1c_mxl_info"),
        column: tool.schema.number().optional().describe("Колонка ячейки, с 1"),
        text: tool.schema.string().optional().describe("Постоянный текст ячейки"),
        template: tool.schema.string().optional().describe("Текст с [Параметр] внутри"),
        parameter: tool.schema.string().optional().describe("Имя параметра — значение подставляет код"),
        clear: tool.schema.boolean().optional().describe("Очистить ячейку"),
        create: tool.schema.boolean().optional().describe("Создать ячейку, если её в строке нет"),
        like: tool.schema.object({ row: tool.schema.number(), column: tool.schema.number() }).optional().describe("Для новой ячейки: взять формат этой"),
        style: tool.schema.object({
          bold: tool.schema.boolean().optional(),
          size: tool.schema.number().optional().describe("Размер шрифта, например 8.3"),
          underline: tool.schema.boolean().optional().describe("Линия под ячейкой"),
          align: tool.schema.enum(["Left", "Center", "Right"]).optional(),
          wrap: tool.schema.boolean().optional().describe("Перенос по словам")
        }).optional().describe("Оформление ячейки; незаданное не меняется"),
        merge: tool.schema.object({
          row: tool.schema.number(),
          column: tool.schema.number(),
          rows: tool.schema.number(),
          columns: tool.schema.number()
        }).optional().describe("Объединить: левая верхняя ячейка и размер в ячейках"),
        unmerge: tool.schema.object({ row: tool.schema.number(), column: tool.schema.number() }).optional().describe("Разъединить объединение с этой левой верхней ячейкой"),
        unmerge_columns: tool.schema.object({
          row: tool.schema.number().describe("Первая строка"),
          column: tool.schema.number().describe("Любая колонка объединения колонок"),
          rows: tool.schema.number().optional().describe("Сколько строк, по умолчанию 1")
        }).optional().describe("Отменить объединение колонок в этих строках")
      })).describe("Правки по порядку: в каждой — либо ячейка (row, column и что с ней), либо merge, либо unmerge, либо unmerge_columns")
    },
    async execute(args, ctx) {
      const title = `Правка макета: ${args.path.split(/[\\/]/).slice(-4).join("\\")}`;
      const workingDirectory = (await sessionProfile(ctx.sessionID))?.workingDirectory;
      if (!workingDirectory)
        return { title, output: REFUSALS["no-profile"] ?? "Профиль сеанса не определён." };
      const path = isAbsolutePath(args.path) ? args.path.trim() : join5(workingDirectory, args.path.trim());
      if (!insideDirectory(path, workingDirectory))
        return { title, output: outsideWorkingRefusal(path, workingDirectory) };
      const edits = [];
      for (const [index, edit] of args.edits.entries()) {
        const cell = edit.row !== undefined || edit.column !== undefined;
        const kinds = [cell, edit.merge !== undefined, edit.unmerge !== undefined, edit.unmerge_columns !== undefined];
        if (kinds.filter(Boolean).length !== 1) {
          return {
            title,
            output: `Правка ${index + 1}: нужна ровно одна — ячейка (row и column), merge, unmerge или unmerge_columns.`
          };
        }
        if (edit.merge)
          edits.push({ merge: edit.merge });
        else if (edit.unmerge)
          edits.push({ unmerge: edit.unmerge });
        else if (edit.unmerge_columns)
          edits.push({ unmerge_columns: edit.unmerge_columns });
        else if (edit.row === undefined || edit.column === undefined) {
          return { title, output: `Правка ${index + 1}: у ячейки нужны и row, и column.` };
        } else {
          edits.push({
            row: edit.row,
            column: edit.column,
            ...edit.text !== undefined ? { text: edit.text } : {},
            ...edit.template !== undefined ? { template: edit.template } : {},
            ...edit.parameter !== undefined ? { parameter: edit.parameter } : {},
            ...edit.clear ? { clear: true } : {},
            ...edit.create ? { create: true } : {},
            ...edit.like ? { like: edit.like } : {},
            ...edit.style ? { style: edit.style } : {}
          });
        }
      }
      let xml;
      try {
        xml = readFileSync2(path, "utf8");
      } catch (error) {
        return { title, output: `Не удалось прочитать файл: ${error instanceof Error ? error.message : String(error)}` };
      }
      const result = editMxlCells(xml, edits);
      if (!result.ok)
        return { title, output: `Макет не изменён. ${result.error}` };
      writeFileSync(path, result.xml, "utf8");
      return {
        title,
        output: [
          `Изменено (${path}):`,
          ...result.changes.map((change) => `- ${change}`),
          "",
          "Проверено после правки: строки и области те же, объединения — ровно заказанные, двух ячеек в одной " + "колонке нет. Как это выглядит, покажет только печать: дальше — сборка из XML и PDF рядом с образцом."
        ].join(`
`)
      };
    }
  });
  const PRINT_REFUSALS = {
    "no-profile": REFUSALS["no-profile"] ?? "У сеанса нет профиля.",
    "profile-missing": REFUSALS["profile-missing"] ?? "Профиль сеанса не найден.",
    "toolkit-down": "MCP Toolkit не работает — подними его через 1c_toolkit_start и повтори.",
    "other-infobase": "На порту тулкита работает другая информационная база, не база профиля. Ничего не выполняй в ней; " + "скажи пользователю, какая база там открыта.",
    unreadable: "Тулкит ответил, но не в ожидаемом виде.",
    failed: "Тулкит не ответил на запрос."
  };
  const printCapabilitiesTool = tool({
    description: "Что эта база предлагает для печатных форм: есть ли МакетыПечатныхФорм, ПользовательскиеМакетыПечати, " + "ДополнительныеОтчетыИОбработки, УправлениеПечатью, сколько уже пользовательских макетов, версия БСП. " + "С `dump` — ещё и какие функции УправлениеПечатью экспортные. Вызывай ДО выбора механизма печатной " + "формы. Только чтение, базу не меняет; нужен работающий MCP Toolkit.",
    args: {
      dump: tool.schema.string().optional().describe("Каталог выгрузки конфигурации (где лежит Configuration.xml), если она есть")
    },
    async execute(args, ctx) {
      const title = "Печатные формы: возможности базы";
      if (!baseUrl)
        return { title, output: "Адрес сервиса 1CCoder не передан." };
      const response = await fetch(`${baseUrl}/1c/print-capabilities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: `session:${ctx.sessionID}`, dump: args.dump })
      });
      if (!response.ok)
        return { title, output: `Не удалось спросить базу: ответ ${response.status}` };
      const result = await response.json();
      if (result.ok)
        return { title, output: result.text ?? "" };
      return {
        title,
        output: `${PRINT_REFUSALS[result.reason ?? ""] ?? "Не удалось."}${result.detail ? `

${result.detail}` : ""}`
      };
    }
  });
  const writeCodeTool = tool({
    description: "Получить у пользователя разрешение на запись в информационную базу. Вызывай, когда " + "`1c_execute_code` отказал: тот же код, плюс что именно меняется, сколько объектов и каких " + "организаций это касается. Сам ничего не выполняет — после разрешения повтори вызов " + "`1c_execute_code` с тем же кодом.",
    args: {
      code: tool.schema.string().describe("Тот же код BSL, который отказался выполнять 1c_execute_code"),
      summary: tool.schema.string().describe("Что и зачем меняется — по-русски, одной-двумя фразами"),
      objects: tool.schema.string().describe("Что будет записано, например «Документ.<Имя>» или «Справочник.<Имя>»"),
      count: tool.schema.number().describe("Сколько объектов будет затронуто. Узнай запросом ДО записи, не угадывай"),
      organisations: tool.schema.string().describe("Каких организаций это касается. Если всех — так и напиши; если реквизита нет — «не применимо»"),
      allow_overwrite: tool.schema.boolean().optional().describe("Только если код меняет СУЩЕСТВУЮЩИЙ элемент справочника, а не добавляет новый. " + "По умолчанию такая правка отклоняется: сначала создай новый элемент и переключи на него " + "значение по умолчанию у организации.")
    },
    async execute(args, ctx) {
      const title = "Запись в информационную базу";
      const sendOn = async (text) => {
        const down = executeCodeUnavailable(await relay("toolkit/gate", gateRequest(ctx.sessionID), 5000));
        return { title, output: down ? `${text}

${down}` : text };
      };
      const unchecked = registrationRefusal(args.code, sampleChecks.get(ctx.sessionID), modifiedAt);
      if (unchecked)
        return { title, output: unchecked };
      if (await writesWithoutAsking(ctx.sessionID)) {
        return sendOn("Подтверждение не нужно: пользователь разрешил в профиле запись в эту базу без вопросов. " + "Выполняй код через `1c_execute_code`. Объём и охват записи назови в итоговом отчёте.");
      }
      if (hasApproval(ctx.sessionID, args.code)) {
        return sendOn("Разрешение на этот код уже есть: прошлый вызов до базы не дошёл, и разрешение сохранено. " + "Выполняй через `1c_execute_code` с тем же кодом.");
      }
      const gap = missingFacts(args);
      if (gap)
        return { title, output: gap };
      const write = inspectBaseWrite(args.code);
      if (!write.writes) {
        return sendOn("В этом коде записи в базу не видно — разрешение не нужно, выполняй через `1c_execute_code`.\n" + "Если запись всё-таки есть, значит я её не распознал: напиши об этом пользователю.");
      }
      const overwrite = inspectOverwrite(args.code);
      if (overwrite.overwrites && !args.allow_overwrite) {
        return { title, output: overwriteRefusal(overwrite) };
      }
      const bulk = inspectBulkWrite(args.code);
      await ctx.ask({
        permission: "infobase_write",
        patterns: ["1c_write_code"],
        always: [],
        metadata: {
          operation: "write_code",
          summary: writeAskText(args, bulk.refuse ? bulkRefusal(bulk) : undefined, overwrite.elements),
          objects: args.objects,
          count: args.count,
          organisations: args.organisations,
          overwrites: overwrite.elements
        }
      });
      recordApproval(ctx.sessionID, args.code);
      approvedRequests.set(approvalKey(ctx.sessionID, args.code), {
        summary: args.summary,
        objects: args.objects,
        count: args.count,
        organisations: args.organisations,
        ...overwrite.elements.length ? { overwrites: overwrite.elements } : {}
      });
      return sendOn(`Пользователь разрешил запись: ${args.objects}, объектов ${args.count}, организации: ${args.organisations}.

` + "Теперь вызови `1c_execute_code` с **тем же кодом** — разрешение одноразовое и действует " + "только на него. После записи проверь результат запросом и включи и объём, и охват в итоговый отчёт.");
    }
  });
  const checkEpfTool = tool({
    description: "Проверить собранную внешнюю обработку (.epf): что это действительно новая сборка, а не заготовка, " + "из которой собирали, и что компилируются модуль объекта и КАЖДАЯ форма. Сборка конфигуратором " + "модули не компилирует, запуск через ВнешниеОбработки.Создать проверяет только модуль объекта. " + "Формы создаются без показа окна (ПриСозданииНаСервере выполняется). Вызывай после каждой сборки, " + "прежде чем говорить, что обработка готова. Нужен работающий MCP Toolkit.",
    args: {
      path: tool.schema.string().describe("Абсолютный путь к собранному .epf"),
      expect_name: tool.schema.string().optional().describe("Имя обработки в метаданных, которое должно получиться, если ты его задавал"),
      template: tool.schema.string().optional().describe("Файл, из которого собирали (скопированная заготовка), — сборка не должна с ним совпадать")
    },
    async execute(args, ctx) {
      const title = "Проверка обработки";
      const path = args.path.trim();
      const bytes = (() => {
        try {
          return readFileSync2(path);
        } catch {
          return null;
        }
      })();
      if (!bytes)
        return { title, output: `Файла нет: ${path}` };
      const build = fingerprint(bytes);
      const references = [
        ...templateFingerprints(),
        ...args.template?.trim() && args.template.trim() !== path ? (() => {
          try {
            return [{ label: args.template.trim(), fingerprint: fingerprint(readFileSync2(args.template.trim())) }];
          } catch {
            return [];
          }
        })() : []
      ];
      const identity = compareIdentity(build, references);
      const identityText = describeIdentity(path, build, identity);
      if (identity.sameAs)
        return { title, output: identityText };
      const checked = await relay("check-epf", {
        conversationId: `session:${ctx.sessionID}`,
        path,
        ...args.expect_name ? { expectName: args.expect_name } : {}
      }, 150000);
      const compile = !checked ? "Проверка компиляции не ответила." : checked.ok ? checked.text ?? "" : `${{
        "toolkit-down": "Компиляцию проверить нельзя: MCP Toolkit не работает — подними его через 1c_toolkit_start и повтори.",
        "designer-busy": "Компиляцию проверить нельзя: идёт операция конфигуратора. Дождись её и повтори.",
        "other-infobase": "На порту тулкита работает другая информационная база — проверять в ней нельзя.",
        "no-profile": REFUSALS["no-profile"]
      }[checked.reason ?? ""] ?? "Компиляцию проверить не удалось."}${checked.detail ? `

${checked.detail}` : ""}`;
      return { title, output: `${identityText}

${compile}` };
    }
  });
  const checkDcsTool = tool({
    description: "Проверить схему компоновки данных (Template.xml макета СКД) в базе сеанса, не загружая её: читается ли " + "схема, верны ли запросы наборов данных, собирается ли макет (параметры, поля настроек), " + "инициализируется ли процессор (выражения; запросы выполняются, только чтение). Называет шаг и ошибку. " + "Вызывай перед загрузкой каждой новой или изменённой схемы, а не узнавай ошибки запуском отчёта. " + "Объекты самого расширения запрос увидит только после его загрузки и применения. Нужен работающий MCP Toolkit.",
    args: {
      path: tool.schema.string().describe("Абсолютный путь к Template.xml схемы компоновки")
    },
    async execute(args, ctx) {
      const title = "Проверка схемы компоновки";
      const path = args.path.trim();
      const text = (() => {
        try {
          return readFileSync2(path, "utf8");
        } catch {
          return null;
        }
      })();
      if (text === null)
        return { title, output: `Файла нет: ${path}` };
      if (!/<DataCompositionSchema[\s>]/.test(text)) {
        return { title, output: `${path} — не схема компоновки данных: в нём нет корневого элемента DataCompositionSchema.` };
      }
      const checked = await relay("check-dcs", { conversationId: `session:${ctx.sessionID}`, path }, 150000);
      if (!checked)
        return { title, output: "Проверка схемы не ответила." };
      if (checked.ok)
        return { title, output: checked.text ?? "" };
      const reason = {
        "toolkit-down": "Схему проверить нельзя: MCP Toolkit не работает — подними его через 1c_toolkit_start и повтори.",
        "designer-busy": "Схему проверить нельзя: идёт операция конфигуратора. Дождись её и повтори.",
        "other-infobase": "На порту тулкита работает другая информационная база — проверять в ней нельзя.",
        "no-profile": REFUSALS["no-profile"]
      }[checked.reason ?? ""] ?? "Схему проверить не удалось.";
      return { title, output: `${reason}${checked.detail ? `

${checked.detail}` : ""}` };
    }
  });
  const processesTool = tool({
    description: "Процессы 1С, открытые на базе этого сеанса: кто запустил (приложение или пользователь), режим, что " + "запущено, заголовок окна. Вызывай, когда MCP Toolkit перестал отвечать после запуска обработки или " + "конфигуратора, — чтобы назвать пользователю окно, а не гадать. С `close` закрывает процесс, но только " + "запущенный приложением; окна пользователя не трогает.",
    args: {
      close: tool.schema.number().optional().describe("PID процесса, запущенного приложением, который нужно закрыть")
    },
    async execute(args, ctx) {
      const title = "Процессы 1С";
      if (args.close !== undefined) {
        await ctx.ask({
          permission: "1c_process_close",
          patterns: [String(args.close)],
          always: [],
          metadata: { pid: args.close, summary: `Закрыть процесс 1С ${args.close}, запущенный приложением` }
        });
      }
      const answer = await relay("processes", { conversationId: `session:${ctx.sessionID}`, ...args.close !== undefined ? { close: args.close } : {} }, 45000);
      if (!answer)
        return { title, output: "Приложение не ответило." };
      if (answer.ok)
        return { title, output: answer.text ?? "" };
      const reasons = {
        "not-found": "Такого процесса 1С на базе этого сеанса нет — вызови без `close` и возьми PID из списка.",
        "not-ours": "Этот процесс открыт пользователем, не приложением — закрывать его нельзя. Попроси пользователя.",
        "no-profile": REFUSALS["no-profile"] ?? "",
        failed: "Не удалось получить список процессов."
      };
      return {
        title,
        output: `${reasons[answer.reason ?? ""] ?? "Не удалось."}${answer.detail ? `

${answer.detail}` : ""}`
      };
    }
  });
  const closeDialogTool = tool({
    description: "Нажать кнопку в окне-диалоге 1С, которое блокирует сеанс (его показывает 1c_processes): " + "по PID процесса и названию кнопки, без мыши и фокуса. Только в процессах, запущенных приложением. " + "Для окна, которое ничего не решает, — «Закрыть». Возвращает, свободен ли сеанс после этого.",
    args: {
      pid: tool.schema.number().describe("PID процесса 1С из 1c_processes"),
      button: tool.schema.string().describe("Название кнопки, как его показал 1c_processes, например «Закрыть»")
    },
    async execute(args, ctx) {
      const title = `Окно 1С: «${args.button}»`;
      const answer = await relay("close-dialog", { conversationId: `session:${ctx.sessionID}`, pid: args.pid, button: args.button }, 45000);
      if (!answer)
        return { title, output: "Приложение не ответило." };
      if (answer.ok)
        return { title, output: answer.text ?? "" };
      const reasons = {
        "not-found": "Такого процесса 1С на базе этого сеанса нет — возьми PID из 1c_processes.",
        "not-ours": "Этот процесс открыт пользователем — его окна не трогай, попроси пользователя.",
        "no-button": "Такой кнопки в окнах этого процесса нет. Что там есть:",
        "no-profile": REFUSALS["no-profile"] ?? "",
        failed: "Нажать не удалось.",
        "still-open": "Окно не закрылось."
      };
      return {
        title,
        output: `${reasons[answer.reason ?? ""] ?? "Не удалось."}${answer.detail ? `

${answer.detail}` : ""}`
      };
    }
  });
  const sessionWritesTool = tool({
    description: "Все записи в информационную базу за этот сеанс: что, сколько объектов, каких организаций, чем " + "закончилось. Ведётся приложением при каждой разрешённой записи. Вызывай перед итоговым отчётом — " + "разделы «Что сделано» и «Как откатить» составляй по этому списку, а не по памяти.",
    args: {},
    async execute(_args, ctx) {
      const title = "Записи в базу за сеанс";
      const profile = await sessionProfile(ctx.sessionID);
      if (!profile?.workingDirectory)
        return { title, output: REFUSALS["no-profile"] ?? "" };
      const path = journalPath(profile.workingDirectory);
      const text = supportProbe.readText(path) ?? "";
      return { title, output: describeJournal(readJournal(text, ctx.sessionID), path) };
    }
  });
  const resumeBudget = new ResumeBudget(Date.now, Array.isArray(options?.resumeDelaysMs) ? options.resumeDelaysMs : undefined);
  const resumeTimers = new Map;
  const exhaustedNoticeAt = new Map;
  async function resumeSession(sessionID, attempt, error) {
    const client = input?.client;
    if (!client)
      return;
    const messages = (await client.session.messages({ path: { id: sessionID } }).catch(() => {
      return;
    }))?.data ?? [];
    if (userSpokeAfterFailure(messages) || awaitsHuman(messages))
      return;
    const statuses = (await client.session.status().catch(() => {
      return;
    }))?.data;
    if (statuses?.[sessionID]?.type && statuses[sessionID].type !== "idle")
      return;
    const last = messages.findLast((message) => message.info.role === "assistant")?.info;
    resumeBudget.record(sessionID);
    const why = error.announced !== undefined ? `announced a step and stopped: ${error.announced}` : String(error.data?.message ?? error.name ?? "");
    await client.app?.log({
      body: {
        service: "1ccoder-resume",
        level: "info",
        message: `session ${sessionID}: resume ${attempt}/${RESUME_LIMIT} (${why.slice(0, 200)})`,
        extra: { service: "1ccoder-resume" }
      }
    }).catch(() => {
      return;
    });
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        ...last?.mode ? { agent: last.mode } : {},
        ...last?.providerID && last.modelID ? { model: { providerID: last.providerID, modelID: last.modelID } } : {},
        parts: [{ type: "text", text: resumeText(attempt, error) }]
      }
    }).catch(() => {
      return;
    });
  }
  async function scheduleResume(sessionID, reason) {
    const client = input?.client;
    if (!client || resumeTimers.has(sessionID))
      return;
    const session = (await client.session.get({ path: { id: sessionID } }).catch(() => {
      return;
    }))?.data;
    if (!session || session.parentID)
      return;
    const next = resumeBudget.next(sessionID);
    if (!next) {
      const noticed = exhaustedNoticeAt.get(sessionID) ?? 0;
      if (Date.now() - noticed < RESUME_WINDOW_MS)
        return;
      exhaustedNoticeAt.set(sessionID, Date.now());
      await client.session.promptAsync({ path: { id: sessionID }, body: { noReply: true, parts: [{ type: "text", text: exhaustedText(reason) }] } }).catch(() => {
        return;
      });
      return;
    }
    resumeTimers.set(sessionID, setTimeout(() => {
      resumeSession(sessionID, next.attempt, reason).finally(() => resumeTimers.delete(sessionID));
    }, next.delayMs));
  }
  let registeredAgents;
  async function agentNames() {
    if (registeredAgents)
      return registeredAgents;
    const list = (await input?.client?.app.agents().catch(() => {
      return;
    }))?.data;
    if (Array.isArray(list))
      registeredAgents = new Set(list.map((agent) => agent.name));
    return registeredAgents;
  }
  async function logRouting(level, message) {
    await input?.client?.app.log({ body: { service: "1ccoder-routing", level, message, extra: { service: "1ccoder-routing" } } }).catch(() => {
      return;
    });
  }
  const hooks = {
    "chat.message": async (message, output) => {
      const binding = await sessionBinding(message.sessionID);
      const decision = routeAgent(output.message.agent ?? message.agent, binding, await agentNames());
      if (decision.kind === "switch") {
        output.message.agent = decision.to;
        await logRouting("info", `session ${message.sessionID}: ${decision.from} -> ${decision.to}`);
      } else if (decision.kind === "missing") {
        await logRouting("warn", `session ${message.sessionID}: binding calls for ${decision.wanted}, which is not registered; running as ${decision.from}`);
      }
    },
    event: async ({ event }) => {
      if (event.type === "message.part.updated") {
        const part = event.properties.part;
        const spent = part?.type === "tool" && part.callID ? spentApprovals.get(part.callID) : undefined;
        if (!spent || !part?.callID || part.state?.status !== "error" && part.state?.status !== "completed")
          return;
        spentApprovals.delete(part.callID);
        if (part.state.status !== "error" || !NEVER_SENT.test(String(part.state.error ?? "")))
          return;
        recordApproval(spent.sessionID, spent.code);
        if (spent.approved)
          approvedRequests.set(approvalKey(spent.sessionID, spent.code), spent.approved);
        const inFlight = writesInFlight.get(part.callID);
        if (inFlight) {
          writesInFlight.delete(part.callID);
          await journal(inFlight, {
            kind: "finished",
            callID: part.callID,
            at: new Date().toISOString(),
            failed: true,
            result: `не дошло до базы (${String(part.state.error).slice(0, 200)}); разрешение восстановлено`
          });
        }
        return;
      }
      const client = input?.client;
      if (!client)
        return;
      if (event.type === "session.error") {
        const error = event.properties.error;
        if (!event.properties.sessionID || !classifyError(error).resume)
          return;
        await scheduleResume(event.properties.sessionID, error ?? {});
        return;
      }
      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        if (resumeTimers.has(sessionID))
          return;
        const messages = (await client.session.messages({ path: { id: sessionID } }).catch(() => {
          return;
        }))?.data ?? [];
        if (endedEmpty(messages))
          await scheduleResume(sessionID, EMPTY_ANSWER);
        const announced = announcedStep(messages);
        if (announced !== null)
          await scheduleResume(sessionID, { announced });
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      markUnansweredQuestion(output.messages);
    },
    "tool.execute.after": async (input2, output) => {
      if (!isToolkitTool(input2.tool, EXPECTED_PLUGIN_TOOLS))
        return;
      spentApprovals.delete(input2.callID);
      const inFlight = writesInFlight.get(input2.callID);
      if (inFlight) {
        writesInFlight.delete(input2.callID);
        await journal(inFlight, {
          kind: "finished",
          callID: input2.callID,
          at: new Date().toISOString(),
          failed: isFailure(output),
          result: resultText(output).slice(0, 2000)
        });
      }
      const masked = maskedNote(output);
      if (masked)
        appendToResult(output, masked);
      if (!isFailure(output))
        return;
      const repeats = repeated.record(input2.sessionID, input2.tool, input2.args, output);
      const hint = referenceHint(output, input2.args);
      if (hint)
        appendToResult(output, hint);
      if (repeats >= 2)
        appendToResult(output, REPEATED_FAILURE_NOTICE);
    },
    "shell.env": async (_input, output) => {
      Object.assign(output.env, SHELL_ENV);
    },
    "tool.execute.before": async (input2, output) => {
      noteSession(input2.sessionID);
      if (input2.tool.startsWith("1c_") && !ownTools.has(input2.tool))
        toolkitStartedAt.delete(input2.sessionID);
      if (isToolkitTool(input2.tool, EXPECTED_PLUGIN_TOOLS)) {
        const gate = await relay("toolkit/gate", gateRequest(input2.sessionID), 5000);
        const refusal = gate ? gateRefusal(gate) : null;
        if (refusal)
          throw new Error(refusal);
        const masked = maskedTokenRefusal(output.args);
        if (masked)
          throw new Error(masked);
      }
      const command = commandFrom(input2.tool, output.args);
      if (command) {
        const refusal = shellRefusal(command);
        if (refusal)
          throw new Error(refusal);
        const tempTarget = shellTempWrite(command);
        if (tempTarget)
          throw new Error(shellTempRefusal(tempTarget));
        const packed = v8packOutput(command);
        const workingDirectory = packed ? (await sessionProfile(input2.sessionID))?.workingDirectory : undefined;
        if (packed && workingDirectory && isAbsolutePath(packed) && !insideDirectory(packed, workingDirectory)) {
          throw new Error(outsideWorkingRefusal(packed, workingDirectory));
        }
        output.args.command = withEncoding(command);
      }
      const bsl = bslFrom(input2.tool, output.args);
      if (bsl) {
        const write = inspectBaseWrite(bsl);
        const unchecked = write.writes ? registrationRefusal(bsl, sampleChecks.get(input2.sessionID), modifiedAt) : null;
        if (unchecked)
          throw new Error(unchecked);
        const approved = write.writes ? approvedRequests.get(approvalKey(input2.sessionID, bsl)) : undefined;
        if (write.writes && consumeApproval(input2.sessionID, bsl)) {
          approvedRequests.delete(approvalKey(input2.sessionID, bsl));
          spentApprovals.set(input2.callID, { sessionID: input2.sessionID, code: bsl, ...approved ? { approved } : {} });
          if (approved) {
            writesInFlight.set(input2.callID, input2.sessionID);
            await journal(input2.sessionID, {
              kind: "started",
              callID: input2.callID,
              sessionID: input2.sessionID,
              at: new Date().toISOString(),
              ...approved
            });
          }
        } else if (write.writes && await writesWithoutAsking(input2.sessionID)) {
          writesInFlight.set(input2.callID, input2.sessionID);
          const targets = writeTargets(bsl);
          await journal(input2.sessionID, {
            kind: "started",
            callID: input2.callID,
            sessionID: input2.sessionID,
            at: new Date().toISOString(),
            summary: "без подтверждения — разрешено в профиле",
            objects: targets.length ? `по коду: ${targets.join(", ")}` : "не указано (в коде не названы)",
            count: 0,
            organisations: "не указано"
          });
        } else if (write.writes) {
          if (hasNearMissApproval(input2.sessionID, bsl))
            throw new Error(writeRefusal(write, undefined, true));
          const overwrite = inspectOverwrite(bsl);
          if (overwrite.overwrites)
            throw new Error(overwriteRefusal(overwrite) + packHint(await sessionPack(input2.sessionID), "overwrite"));
          const bulk = inspectBulkWrite(bsl);
          throw new Error(writeRefusal(write, bulk.refuse ? bulkRefusal(bulk) : undefined) + (bulk.refuse ? packHint(await sessionPack(input2.sessionID), "bulk") : ""));
        }
        if (!write.writes) {
          const bulk = inspectBulkWrite(bsl);
          if (bulk.refuse)
            throw new Error(bulkRefusal(bulk) + packHint(await sessionPack(input2.sessionID), "bulk"));
        }
      }
      const target = writeTarget(input2.tool, output.args);
      if (!target)
        return;
      if (insideTemp(target))
        throw new Error(tempRefusal(target));
      const dumpRoot = insideDump(target);
      if (dumpRoot) {
        const workingDirectory = (await sessionProfile(input2.sessionID))?.workingDirectory;
        if (!workingDirectory || !insideDirectory(target, workingDirectory))
          throw new Error(dumpWriteRefusal(target, dumpRoot));
      }
      const verdict = decideSupport(target, supportProbe);
      if (verdict.blocked)
        throw new Error(supportRefusal(verdict, target));
    },
    tool: {
      "1c_profile_info": profileInfoTool,
      "1c_toolkit_start": toolkitStartTool,
      "1c_mxl_info": mxlInfoTool,
      "1c_mxl_edit": mxlEditTool,
      "1c_compare_with_sample": compareWithSampleTool,
      "1c_dump_object": dumpObjectTool,
      "1c_print_capabilities": printCapabilitiesTool,
      "1c_write_code": writeCodeTool,
      "1c_check_epf": checkEpfTool,
      "1c_check_dcs": checkDcsTool,
      "1c_processes": processesTool,
      "1c_close_dialog": closeDialogTool,
      "1c_session_writes": sessionWritesTool,
      "1c_check_config": makeTool("check", "Проверить конфигурацию информационной базы. Чтение, базу не меняет.", false),
      "1c_dump_config": makeTool("dump_config", "Выгрузить конфигурацию информационной базы в файл .cf — двоичный контейнер, " + "пригодный только для загрузки обратно. Читать конфигурацию им нельзя: для этого " + "1c_dump_config_to_files. Чтение, базу не меняет.", true),
      "1c_dump_config_to_files": makeTool("dump_config_to_files", "Выгрузить конфигурацию в XML-файлы в указанный каталог — то, что нужно, чтобы " + "ЧИТАТЬ конфигурацию: модули, макеты (`CommonTemplates\\<Имя>\\Ext\\Template.xml`), " + "формы, метаданные. Каталог создаётся, если его нет. Выгрузка большой конфигурации " + "занимает минуты и место на диске. Чтение, базу не меняет.", true),
      "1c_dump_epf_to_files": makeTool("dump_epf_to_files", "Выгрузить внешнюю обработку (.epf) в XML-файлы — единственный способ править РАЗМЕТКУ " + "формы: команды, кнопки, реквизиты, имя обработки. (Модули правятся дешевле, через " + "v8pack — см. навык 1ccoder-epf-editing.) `path` — каталог для выгрузки, `epfPath` — " + "исходный .epf. Внутри `path` появятся корневой файл `<ИмяОбработки>.xml` и каталог " + "`<ИмяОбработки>` рядом с ним; результат называет корневой файл. Чтение, базу не меняет.", true),
      "1c_load_epf_from_files": makeTool("load_epf_from_files", "Собрать внешнюю обработку (.epf) или внешний отчёт (.erf) из XML-файлов. `path` — корневой файл " + "`<Имя>.xml` (из выгрузки или от 1c_new_external), `epfPath` — файл результата: .epf для обработки, " + ".erf для отчёта. Файла может ещё не быть — платформа создаст его; существующий она перезапишет. " + "После сборки обработки — 1c_check_epf (компиляция модуля и форм), отчёта — 1c_run_report. Базу не меняет.", true),
      "1c_load_config": makeTool("load_config", "Загрузить конфигурацию из файла .cf в информационную базу. ИЗМЕНЯЕТ БАЗУ: потребуется подтверждение.", true),
      "1c_load_config_from_files": makeTool("load_config_from_files", "Загрузить расширение из каталога XML (корень с Configuration.xml, как у выгрузки) — так создаётся " + "новое расширение и заменяется существующее целиком, включая удалённые объекты. Только для " + "расширений: `extension` обязателен. Каталог — в рабочем каталоге профиля; заготовку даёт " + "1c_new_extension. После загрузки — 1c_update_db с тем же extension. ИЗМЕНЯЕТ БАЗУ: " + "потребуется подтверждение.", true),
      "1c_delete_extension": makeTool("delete_extension", "Удалить расширение из базы (`extension` обязателен). Нужен, в частности, после неудачной загрузки " + "из файлов: она всё равно создаёт пустое расширение с этим именем. ИЗМЕНЯЕТ БАЗУ: потребуется " + "подтверждение.", false),
      "1c_new_extension": newExtensionTool,
      "1c_new_external": newExternalTool,
      "1c_run_report": runReportTool,
      "1c_update_db": makeTool("update_db", "Обновить конфигурацию базы данных. ИЗМЕНЯЕТ БАЗУ: потребуется подтверждение.", false),
      "1c_run_epf": makeTool("execute", "Выполнить внешнюю обработку (.epf) в информационной базе в режиме предприятия. " + "Только для .epf, который ты собрал сам и можешь назвать. Не инструмент для выполнения " + "кода 1С — для кода есть 1c_execute_code. ИЗМЕНЯЕТ БАЗУ: потребуется подтверждение.", true)
    }
  };
  for (const name of Object.keys(hooks.tool ?? {}))
    ownTools.add(name);
  return hooks;
};
var plugin_default = InfobasePlugin;
export {
  plugin_default as default,
  InfobasePlugin
};
