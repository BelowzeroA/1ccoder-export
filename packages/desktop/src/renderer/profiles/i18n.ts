// 1CCoder UI strings for developer profiles.
//
// Fork-local for the same reason the auth strings are (see ../auth/i18n.ts):
// packages/app/src/i18n/parity.test.ts requires every English key to exist in
// 61 locales across three dictionaries, so putting product copy there would
// mean thousands of translations for a product that ships Russian-first.
//
// Parity is still enforced at compile time -- `ru` is typed as
// Record<keyof typeof en, string>, so a missing key fails tsc.

export const en = {
  "profiles.title": "Developer profiles",
  "profiles.subtitle": "Everything a session needs to work with one infobase",
  /** The home screen's left pane, where opencode lists projects. */
  "profiles.home.title": "Profiles",
  "profiles.close": "Close",

  "profiles.list.empty": "No profiles yet.",
  "profiles.list.emptyHint": "Create one from an infobase found on this machine, or fill it in by hand.",
  "profiles.list.verifiedAt": "Verified {{when}}",
  "profiles.list.neverVerified": "Not verified yet",
  "profiles.list.hasPassword": "Password saved",
  "profiles.list.noPassword": "No password saved",

  "profiles.action.create": "New profile",
  "profiles.action.edit": "Edit",
  "profiles.action.delete": "Delete",
  "profiles.action.deleteConfirm": "Delete this profile?",
  "profiles.action.deleteYes": "Delete",
  "profiles.action.cancel": "Cancel",
  "profiles.action.browse": "Browse…",
  "profiles.picker.platform": "Choose the 1C thick client (1cv8.exe)",
  "profiles.picker.infobase": "Choose the infobase folder",
  "profiles.picker.workingDirectory": "Choose the working folder",
  "profiles.action.save": "Verify and save",
  "profiles.action.verify": "Check",
  "profiles.action.rescan": "Scan again",

  "profiles.form.newTitle": "New profile",
  "profiles.form.editTitle": "Edit profile",
  "profiles.field.name": "Name",
  "profiles.field.platform": "1C platform",
  "profiles.field.platformPick": "Choose a platform",
  "profiles.field.platformManual": "Path to the thick client (1cv8.exe)",
  "profiles.field.kind": "Infobase type",
  "profiles.field.kindFile": "File",
  "profiles.field.kindServer": "Server",
  "profiles.field.filePath": "Infobase folder",
  "profiles.field.serverCluster": "Server cluster",
  "profiles.field.serverDatabase": "Database name",
  "profiles.field.workingDirectory": "Working directory",
  "profiles.field.workingDirectoryHint": "where the agent keeps this profile's files; created if missing",
  "profiles.field.userName": "User name",
  "profiles.field.password": "Password",
  "profiles.field.passwordKeep": "leave blank to keep the saved one",
  "profiles.field.passwordOptional": "may be blank if the infobase has no users",
  "profiles.field.allowWrite": "Write to the infobase without asking",
  "profiles.field.allowWriteHint":
    "the agent will write to this infobase without asking you each time; every write is still logged",
  "profiles.field.required": "Fill this in",

  "profiles.discovery.title": "Found on this machine",
  "profiles.discovery.infobases": "Registered infobases",
  "profiles.discovery.none": "No 1C installation was found.",
  "profiles.discovery.noneHint": "You can still enter a profile by hand.",
  "profiles.discovery.noInfobases": "No registered infobases were found.",
  "profiles.discovery.scanning": "Scanning…",
  "profiles.discovery.skipped": "{{count}} entry(ies) skipped: folders and connection types we cannot open",
  "profiles.discovery.training": "training edition",

  "profiles.verify.running": "Checking…",
  "profiles.verify.title": "Verification",
  "profiles.verify.passed": "Everything checks out.",
  "profiles.verify.blocked": "The profile was not saved.",
  "profiles.verify.warned": "Saved, with warnings.",
  "profiles.verify.saved": "Saved.",
  "profiles.verify.passwordNotStored":
    "This machine cannot encrypt stored secrets, so the password was not saved. You will be asked for it when it is needed.",

  "profiles.check.platform": "Platform",
  "profiles.check.infobase": "Infobase",
  "profiles.check.workspace": "Working directory",
  "profiles.check.credentials": "Sign-in",
  "profiles.check.admin": "Administrative rights",

  "profiles.status.pass": "OK",
  "profiles.status.fail": "Failed",
  "profiles.status.inconclusive": "Unclear",

  "profiles.code.platform-missing": "No file at this path.",
  "profiles.code.platform-not-thick": "This is not a thick client. The Designer cannot be run with it.",
  "profiles.code.platform-ok-standard": "Thick client found.",
  "profiles.code.platform-ok-training": "Thick client found (training edition).",
  "profiles.code.infobase-dir-missing": "This folder does not exist.",
  "profiles.code.infobase-not-a-base": "This folder holds no infobase (1Cv8.1CD is missing).",
  "profiles.code.infobase-ok": "Infobase found.",
  "profiles.code.cluster-unreachable":
    "The cluster did not answer. It may be behind a firewall; the sign-in check will tell us more.",
  "profiles.code.workspace-missing": "No working directory given.",
  "profiles.code.workspace-not-writable": "This directory could not be created or written to.",
  "profiles.code.workspace-created": "Created.",
  "profiles.code.workspace-ok": "Ready.",
  "profiles.code.infobase-missing": "1C could not find the infobase.",
  "profiles.code.credentials-ok": "Signed in successfully.",
  "profiles.code.credentials-rejected": "1C rejected this user name or password.",
  "profiles.code.credentials-timeout": "1C did not answer in time, so this proves nothing either way.",
  "profiles.code.credentials-spawn-failed": "The platform could not be started.",
  "profiles.code.credentials-unrecognised":
    "1C reported a failure we cannot classify. It says nothing about the password — the infobase may be locked by another Designer.",
  "profiles.code.admin-implied-by-designer":
    "A Designer session opened, which in most configurations implies administrative rights.",
  "profiles.code.admin-unknown": "Could not be established.",

  "session.caption.label": "Developer profile",
  "session.caption.none": "not chosen",
  /** Beside the model picker on a running session: read-only, so it stands alone. */
  "session.note.none": "No profile",
  "session.picker.title": "Choose a developer profile",
  "session.picker.subtitle": "It decides what this session can do with 1C.",
  "session.picker.withoutTitle": "Without a profile",
  "session.picker.withoutHint":
    "Edit processings, reports and extensions as files. No infobase, and no running 1C code.",
  "session.picker.start": "Start",
  "session.picker.checking": "Checking the profile…",
  "session.picker.failedTitle": "This profile does not work right now.",
  "session.picker.startAnyway": "Start without a profile",
  "session.picker.editProfile": "Open profiles",
  "session.picker.noProfiles": "There are no profiles yet.",
  "session.picker.create": "Create one",
  "session.picker.change": "Change",
  "profiles.error.unknown": "Something went wrong. Try again.",
} as const

export type ProfilesStringKey = keyof typeof en

export const ru: Record<ProfilesStringKey, string> = {
  "profiles.title": "Профили разработчика",
  "profiles.subtitle": "Всё, что нужно сеансу для работы с одной информационной базой",
  "profiles.home.title": "Профили",
  "profiles.close": "Закрыть",

  "profiles.list.empty": "Профилей пока нет.",
  "profiles.list.emptyHint": "Создайте профиль из найденной на компьютере базы или заполните поля вручную.",
  "profiles.list.verifiedAt": "Проверен {{when}}",
  "profiles.list.neverVerified": "Ещё не проверялся",
  "profiles.list.hasPassword": "Пароль сохранён",
  "profiles.list.noPassword": "Пароль не сохранён",

  "profiles.action.create": "Новый профиль",
  "profiles.action.edit": "Изменить",
  "profiles.action.delete": "Удалить",
  "profiles.action.deleteConfirm": "Удалить профиль?",
  "profiles.action.deleteYes": "Удалить",
  "profiles.action.cancel": "Отмена",
  "profiles.action.browse": "Обзор…",
  "profiles.picker.platform": "Выберите толстый клиент 1С (1cv8.exe)",
  "profiles.picker.infobase": "Выберите каталог информационной базы",
  "profiles.picker.workingDirectory": "Выберите рабочий каталог",
  "profiles.action.save": "Проверить и сохранить",
  "profiles.action.verify": "Проверить",
  "profiles.action.rescan": "Искать заново",

  "profiles.form.newTitle": "Новый профиль",
  "profiles.form.editTitle": "Изменение профиля",
  "profiles.field.name": "Название",
  "profiles.field.platform": "Платформа 1С",
  "profiles.field.platformPick": "Выберите платформу",
  "profiles.field.platformManual": "Путь к толстому клиенту (1cv8.exe)",
  "profiles.field.kind": "Тип информационной базы",
  "profiles.field.kindFile": "Файловая",
  "profiles.field.kindServer": "Серверная",
  "profiles.field.filePath": "Каталог информационной базы",
  "profiles.field.serverCluster": "Кластер серверов",
  "profiles.field.serverDatabase": "Имя базы данных",
  "profiles.field.workingDirectory": "Рабочий каталог",
  "profiles.field.workingDirectoryHint": "здесь агент хранит файлы этого профиля; будет создан, если его нет",
  "profiles.field.userName": "Имя пользователя",
  "profiles.field.password": "Пароль",
  "profiles.field.passwordKeep": "оставьте пустым, чтобы сохранить прежний",
  "profiles.field.passwordOptional": "может быть пустым, если в базе нет пользователей",
  "profiles.field.allowWrite": "Записывать в базу без подтверждения",
  "profiles.field.allowWriteHint":
    "агент будет записывать в эту базу, не спрашивая каждый раз; каждая запись по-прежнему попадает в журнал",
  "profiles.field.required": "Заполните поле",

  "profiles.discovery.title": "Найдено на этом компьютере",
  "profiles.discovery.infobases": "Зарегистрированные базы",
  "profiles.discovery.none": "Установленная 1С не найдена.",
  "profiles.discovery.noneHint": "Профиль всё равно можно заполнить вручную.",
  "profiles.discovery.noInfobases": "Зарегистрированные информационные базы не найдены.",
  "profiles.discovery.scanning": "Поиск…",
  "profiles.discovery.skipped": "Пропущено записей: {{count}} — папки и типы подключения, которые мы не открываем",
  "profiles.discovery.training": "учебная версия",

  "profiles.verify.running": "Проверка…",
  "profiles.verify.title": "Проверка",
  "profiles.verify.passed": "Все проверки пройдены.",
  "profiles.verify.blocked": "Профиль не сохранён.",
  "profiles.verify.warned": "Сохранено, но с предупреждениями.",
  "profiles.verify.saved": "Сохранено.",
  "profiles.verify.passwordNotStored":
    "На этом компьютере недоступно шифрование секретов, поэтому пароль не сохранён. Он будет запрошен, когда понадобится.",

  "profiles.check.platform": "Платформа",
  "profiles.check.infobase": "Информационная база",
  "profiles.check.workspace": "Рабочий каталог",
  "profiles.check.credentials": "Вход",
  "profiles.check.admin": "Права администратора",

  "profiles.status.pass": "OK",
  "profiles.status.fail": "Ошибка",
  "profiles.status.inconclusive": "Неясно",

  "profiles.code.platform-missing": "По этому пути файла нет.",
  "profiles.code.platform-not-thick": "Это не толстый клиент. Конфигуратор им не запустить.",
  "profiles.code.platform-ok-standard": "Толстый клиент найден.",
  "profiles.code.platform-ok-training": "Толстый клиент найден (учебная версия).",
  "profiles.code.infobase-dir-missing": "Такого каталога нет.",
  "profiles.code.infobase-not-a-base": "В каталоге нет информационной базы (не найден 1Cv8.1CD).",
  "profiles.code.infobase-ok": "Информационная база найдена.",
  "profiles.code.cluster-unreachable":
    "Кластер не ответил. Возможно, порт закрыт межсетевым экраном; проверка входа скажет больше.",
  "profiles.code.workspace-missing": "Рабочий каталог не указан.",
  "profiles.code.workspace-not-writable": "Каталог не удалось создать или в него нет доступа на запись.",
  "profiles.code.workspace-created": "Создан.",
  "profiles.code.workspace-ok": "Готов.",
  "profiles.code.infobase-missing": "1С не нашла информационную базу.",
  "profiles.code.credentials-ok": "Вход выполнен.",
  "profiles.code.credentials-rejected": "1С отклонила это имя пользователя или пароль.",
  "profiles.code.credentials-timeout":
    "1С не ответила вовремя — это ничего не доказывает ни в ту, ни в другую сторону.",
  "profiles.code.credentials-spawn-failed": "Не удалось запустить платформу.",
  "profiles.code.credentials-unrecognised":
    "1С сообщила об ошибке, которую мы не смогли распознать. О пароле это ничего не говорит — базу мог занять другой конфигуратор.",
  "profiles.code.admin-implied-by-designer":
    "Сеанс конфигуратора открылся, что в большинстве конфигураций означает наличие прав администратора.",
  "profiles.code.admin-unknown": "Определить не удалось.",

  "session.caption.label": "Профиль разработчика",
  "session.caption.none": "не выбран",
  "session.note.none": "Профиль не выбран",
  "session.picker.title": "Выберите профиль разработчика",
  "session.picker.subtitle": "От него зависит, что сеанс сможет делать с 1С.",
  "session.picker.withoutTitle": "Без профиля",
  "session.picker.withoutHint":
    "Правка обработок, отчётов и расширений как файлов. Без информационной базы и без запуска кода 1С.",
  "session.picker.start": "Начать",
  "session.picker.checking": "Проверка профиля…",
  "session.picker.failedTitle": "Сейчас этот профиль не работает.",
  "session.picker.startAnyway": "Начать без профиля",
  "session.picker.editProfile": "Открыть профили",
  "session.picker.noProfiles": "Профилей пока нет.",
  "session.picker.create": "Создать",
  "session.picker.change": "Изменить",
  "profiles.error.unknown": "Что-то пошло не так. Попробуйте ещё раз.",
}

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  )
}

/**
 * Russian is the product default (Phase 1); anything other than an explicit
 * "en" falls back to Russian rather than English.
 */
export function createProfilesTranslator(locale: string | undefined) {
  const dict: Record<ProfilesStringKey, string> = locale === "en" ? { ...en } : ru
  return (key: ProfilesStringKey, params?: Record<string, string | number>) => interpolate(dict[key], params)
}

/**
 * Maps a check code from the main process onto a string key, falling back to
 * the raw code when we meet one we have no copy for -- showing "profiles.code.x"
 * is ugly, but inventing a reassuring message for an unknown state is worse.
 */
export function checkCodeKey(code: string): ProfilesStringKey | null {
  const key = `profiles.code.${code}` as ProfilesStringKey
  return key in en ? key : null
}
