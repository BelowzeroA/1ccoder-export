// 1CCoder-specific UI strings for AutoMode (Phase 5).
//
// Same arrangement as the auth gate's dictionary (../auth/i18n.ts) and for the
// same reason: packages/app/src/i18n/parity.test.ts requires every English key
// to exist in all 61 locales, and this product ships Russian-first and needs
// only ru + en. Parity is enforced at compile time instead -- `ru` is typed as
// Record<keyof typeof en, string>, so a missing key fails `tsc`.

export const en = {
  "automode.name": "AutoMode",
  "automode.mode.auto": "AutoMode",
  "automode.mode.manual": "Manual mode",

  "automode.offer.title": "Turn AutoMode on for this project?",
  "automode.offer.body":
    "In AutoMode the assistant gets on with the work: it reads and edits files, runs commands and reaches directories outside the project without asking each time.",
  "automode.offer.asksTitle": "It will still stop and ask before:",
  "automode.offer.asksDestructive": "deleting files in bulk, formatting disks and other destructive commands",
  "automode.offer.asksGit": "git push and rewriting history — reset --hard, rebase",
  "automode.offer.asksInfobase": "writing to a bound 1C infobase",
  "automode.offer.scope":
    "The answer is remembered for this project only. Other projects are asked separately, and you can change this at any time from the mode button in the corner of the window.",
  "automode.offer.enable": "Turn AutoMode on",
  "automode.offer.decline": "Stay in manual mode",
  "automode.offer.project": "Project",

  "automode.panel.autoTitle": "AutoMode is on",
  "automode.panel.autoBody": "Commands and edits run without a prompt, except the three cases listed below.",
  "automode.panel.manualTitle": "Manual mode",
  "automode.panel.manualBody": "Every command and edit asks for confirmation first.",
  "automode.panel.alwaysAsks": "Always asks:",
  "automode.panel.enable": "Turn AutoMode on",
  "automode.panel.disable": "Switch to manual mode",
  "automode.panel.close": "Close",
  "automode.panel.scope": "This setting applies to this project only.",
}

export type AutoModeStringKey = keyof typeof en

export const ru: Record<AutoModeStringKey, string> = {
  "automode.name": "Автоматический режим",
  "automode.mode.auto": "Автоматический режим",
  "automode.mode.manual": "Ручной режим",

  "automode.offer.title": "Включить автоматический режим для этого проекта?",
  "automode.offer.body":
    "В автоматическом режиме помощник работает не останавливаясь: читает и правит файлы, выполняет команды и обращается к каталогам вне проекта, не спрашивая каждый раз.",
  "automode.offer.asksTitle": "Он всё равно остановится и спросит перед тем, как:",
  "automode.offer.asksDestructive": "массово удалять файлы, форматировать диски и выполнять другие разрушающие команды",
  "automode.offer.asksGit": "выполнять git push и переписывать историю — reset --hard, rebase",
  "automode.offer.asksInfobase": "записывать данные в подключённую информационную базу 1С",
  "automode.offer.scope":
    "Ответ запоминается только для этого проекта. Про другие проекты вопрос будет задан отдельно, а изменить решение можно в любой момент — кнопкой режима в углу окна.",
  "automode.offer.enable": "Включить автоматический режим",
  "automode.offer.decline": "Оставить ручной режим",
  "automode.offer.project": "Проект",

  "automode.panel.autoTitle": "Автоматический режим включён",
  "automode.panel.autoBody": "Команды и правки выполняются без подтверждения, кроме трёх случаев ниже.",
  "automode.panel.manualTitle": "Ручной режим",
  "automode.panel.manualBody": "Каждая команда и правка запрашивает подтверждение.",
  "automode.panel.alwaysAsks": "Всегда спрашивает:",
  "automode.panel.enable": "Включить автоматический режим",
  "automode.panel.disable": "Перейти в ручной режим",
  "automode.panel.close": "Закрыть",
  "automode.panel.scope": "Настройка действует только для этого проекта.",
}

/**
 * Russian is the product default (see Phase 1); any locale other than an
 * explicit "en" falls back to Russian rather than English, for the same reason
 * as the auth gate: a 1CCoder user who picked another language is still better
 * served by the language this product is actually written in.
 */
export function autoModeDict(locale: string | undefined): Record<AutoModeStringKey, string> {
  return locale === "en" ? { ...en } : ru
}

export function createAutoModeTranslator(locale: string | undefined) {
  const dict = autoModeDict(locale)
  return (key: AutoModeStringKey) => dict[key]
}
