// 1CCoder-specific UI strings for the authorization gate.
//
// These deliberately live OUTSIDE the three dictionaries covered by
// packages/app/src/i18n/parity.test.ts (app / ui / desktop). That test requires
// every English key to exist in all 61 locales, so adding auth copy there would
// mean ~1,500 translations for a product that ships Russian-first and is only
// ever expected to need ru + en. Keeping these strings in a file upstream does
// not have also means zero merge conflicts when rebasing onto upstream/dev.
//
// Parity is still enforced, just at compile time instead: `ru` is typed as
// Record<keyof typeof en, string>, so omitting a key fails `tsc`.

export const en = {
  "auth.welcome.title": "1CCoder",
  "auth.welcome.subtitle": "Sign in to continue",

  "auth.action.login": "Sign in",
  "auth.action.register": "Create account",
  "auth.action.back": "Back",

  "auth.register.title": "Create account",
  "auth.register.submit": "Send code",
  "auth.login.title": "Sign in",
  "auth.login.submit": "Send code",

  "auth.field.email": "Email",
  "auth.field.emailPlaceholder": "you@example.com",
  "auth.field.phone": "Phone",
  "auth.field.phoneOptional": "optional",
  "auth.field.phonePlaceholder": "+7 700 000 00 00",

  "auth.code.title": "Enter the code",
  "auth.code.sentTo": "We sent a 6-digit code to {{email}}",
  "auth.code.field": "Confirmation code",
  "auth.code.submit": "Confirm",
  "auth.code.resend": "Send the code again",
  "auth.code.resent": "A new code is on its way",

  "auth.busy": "Please wait…",

  "auth.account.menu": "Account",
  "auth.account.signedInAs": "Signed in as",
  "auth.account.profiles": "Developer profiles",
  "auth.account.signOut": "Sign out",
  "auth.account.about": "About",
  "auth.account.expiresIn": "Session ends in {{days}} d.",
  "auth.account.expiresToday": "Session ends today",

  "auth.about.title": "About",
  "auth.about.description": "1CCoder is a tool for developing and automating 1C tasks with an AI agent",
  "auth.about.version": "Version {{version}}",
  "auth.about.close": "Close",

  "auth.error.emailRequired": "Enter your email address",
  "auth.error.emailInvalid": "That does not look like an email address",
  "auth.error.codeRequired": "Enter the code from the email",
  "auth.error.codeFormat": "The code is 6 digits",
  "auth.error.network": "Cannot reach the server. Check your internet connection.",
  "auth.error.alreadyRegistered": "This email is already registered. Sign in instead.",
  "auth.error.noAccount": "No account found for this email. Create one instead.",
  "auth.error.incorrectCode": "Incorrect code. Please try again.",
  "auth.error.expiredCode": "The code has expired. Request a new one.",
  "auth.error.tooManyAttempts": "Too many incorrect attempts. Request a new code.",
  "auth.error.invalidToken": "This code is no longer valid. Start again.",
  "auth.error.rateLimited": "Too many attempts. Please try again later.",
  "auth.error.server": "The server is having trouble. Please try again later.",
  "auth.error.unknown": "Something went wrong. Please try again.",
  "auth.error.blocked": "Access to 1CCoder for this account is suspended. If this is a mistake, write to {{support}}.",
} as const

export type AuthStringKey = keyof typeof en

// Typed so that a missing or misspelled key is a compile error, which is the
// same guarantee the upstream parity test provides for the shared dictionaries.
export const ru: Record<AuthStringKey, string> = {
  "auth.welcome.title": "1CCoder",
  "auth.welcome.subtitle": "Войдите, чтобы продолжить",

  "auth.action.login": "Зайти в аккаунт",
  "auth.action.register": "Создать аккаунт",
  "auth.action.back": "Назад",

  "auth.register.title": "Создать аккаунт",
  "auth.register.submit": "Отправить код",
  "auth.login.title": "Зайти в аккаунт",
  "auth.login.submit": "Отправить код",

  "auth.field.email": "Электронная почта",
  "auth.field.emailPlaceholder": "you@example.com",
  "auth.field.phone": "Телефон",
  "auth.field.phoneOptional": "необязательно",
  "auth.field.phonePlaceholder": "+7 700 000 00 00",

  "auth.code.title": "Введите код",
  "auth.code.sentTo": "Мы отправили шестизначный код на {{email}}",
  "auth.code.field": "Код подтверждения",
  "auth.code.submit": "Подтвердить",
  "auth.code.resend": "Отправить код повторно",
  "auth.code.resent": "Новый код отправлен",

  "auth.busy": "Подождите…",

  "auth.account.menu": "Аккаунт",
  "auth.account.signedInAs": "Вы вошли как",
  "auth.account.profiles": "Профили разработчика",
  "auth.account.signOut": "Выйти из аккаунта",
  "auth.account.about": "О программе",
  "auth.account.expiresIn": "Сессия завершится через {{days}} дн.",
  "auth.account.expiresToday": "Сессия завершится сегодня",

  "auth.about.title": "О программе",
  "auth.about.description": "1CCoder — инструмент для разработки и автоматизации задач в 1С с помощью AI-агента",
  "auth.about.version": "Версия {{version}}",
  "auth.about.close": "Закрыть",

  "auth.error.emailRequired": "Введите адрес электронной почты",
  "auth.error.emailInvalid": "Это не похоже на адрес электронной почты",
  "auth.error.codeRequired": "Введите код из письма",
  "auth.error.codeFormat": "Код состоит из шести цифр",
  "auth.error.network": "Не удаётся связаться с сервером. Проверьте подключение к интернету.",
  "auth.error.alreadyRegistered": "Эта почта уже зарегистрирована. Войдите в аккаунт.",
  "auth.error.noAccount": "Аккаунт с такой почтой не найден. Создайте новый.",
  "auth.error.incorrectCode": "Неверный код. Попробуйте ещё раз.",
  "auth.error.expiredCode": "Срок действия кода истёк. Запросите новый.",
  "auth.error.tooManyAttempts": "Слишком много неверных попыток. Запросите новый код.",
  "auth.error.invalidToken": "Этот код больше не действителен. Начните заново.",
  "auth.error.rateLimited": "Слишком много попыток. Повторите позже.",
  "auth.error.server": "На сервере возникла проблема. Повторите попытку позже.",
  "auth.error.unknown": "Что-то пошло не так. Попробуйте ещё раз.",
  "auth.error.blocked": "Доступ к 1CCoder для этой учётной записи приостановлен. Если это ошибка, напишите в {{support}}.",
}

/**
 * Russian is the product default (see Phase 1); any locale other than an
 * explicit "en" falls back to Russian rather than to English, because a
 * 1CCoder user who has picked, say, German is still far better served by the
 * language this product is actually written in.
 */
export function authDict(locale: string | undefined): Record<AuthStringKey, string> {
  return locale === "en" ? { ...en } : ru
}

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  )
}

export function createAuthTranslator(locale: string | undefined) {
  const dict = authDict(locale)
  return (key: AuthStringKey, params?: Record<string, string | number>) => interpolate(dict[key], params)
}
