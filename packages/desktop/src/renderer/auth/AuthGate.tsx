// The 1CCoder authorization gate.
//
// Rendered instead of <AppInterface> until a credential exists locally, so no
// session UI, project picker or infobase catalog can mount for an unauthorized
// user. Mounted from ../index.tsx alongside the existing ready()/defaultServer
// <Show> gates rather than through a separate router.

import { createSignal, Match, Show, Switch } from "solid-js"

import { SUPPORT_CONTACT } from "../../main/llm/support"
import { AUTH_ERROR_STRINGS, AuthError, confirm, isValidCode, isValidEmail, login, register } from "./client"
import { writeCredential, type StoredCredential } from "./credential"
import { createAuthTranslator, type AuthStringKey } from "./i18n"

type Step = "choose" | "register" | "login" | "code"

export function AuthGate(props: { locale: string | undefined; onAuthenticated: (value: StoredCredential) => void }) {
  const t = createAuthTranslator(props.locale)

  const [step, setStep] = createSignal<Step>("choose")
  const [email, setEmail] = createSignal("")
  const [phone, setPhone] = createSignal("")
  const [code, setCode] = createSignal("")
  const [token, setToken] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [errorKey, setErrorKey] = createSignal<AuthStringKey | null>(null)
  const [noticeKey, setNoticeKey] = createSignal<AuthStringKey | null>(null)

  // Remembers which flow produced the current code, so "resend" re-issues via
  // the same endpoint -- /register would 409 for an account that is already
  // active, and /login would 404 for one that is not yet confirmed.
  const [origin, setOrigin] = createSignal<"register" | "login">("register")

  function fail(error: unknown) {
    setNoticeKey(null)
    if (error instanceof AuthError) {
      setErrorKey(AUTH_ERROR_STRINGS[error.code])
      // An exhausted or dead token cannot be retried; send the user back to the
      // start of the flow instead of leaving them on a code form that can only fail.
      if (error.code === "invalid-token" || error.code === "too-many-attempts") {
        setCode("")
        setToken("")
        setStep(origin())
      }
      return
    }
    setErrorKey("auth.error.unknown")
  }

  function goTo(next: Step) {
    setErrorKey(null)
    setNoticeKey(null)
    setStep(next)
  }

  async function requestCode(mode: "register" | "login") {
    const address = email().trim()
    if (address.length === 0) {
      setErrorKey("auth.error.emailRequired")
      return
    }
    if (!isValidEmail(address)) {
      setErrorKey("auth.error.emailInvalid")
      return
    }

    setErrorKey(null)
    setNoticeKey(null)
    setBusy(true)
    try {
      const response = mode === "register" ? await register(address, phone()) : await login(address)
      setToken(response.token)
      setOrigin(mode)
      setCode("")
      setStep("code")
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function submitCode() {
    const value = code().trim()
    if (value.length === 0) {
      setErrorKey("auth.error.codeRequired")
      return
    }
    if (!isValidCode(value)) {
      setErrorKey("auth.error.codeFormat")
      return
    }

    setErrorKey(null)
    setNoticeKey(null)
    setBusy(true)
    try {
      const response = await confirm(token(), value)
      const stored: StoredCredential = {
        email: response.email,
        credential: response.credential,
        // Server sends epoch seconds; everything client-side works in millis.
        expiresAt: response.expires_at * 1000,
      }
      await writeCredential(stored)
      props.onAuthenticated(stored)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setErrorKey(null)
    setNoticeKey(null)
    setBusy(true)
    try {
      const address = email().trim()
      const response = origin() === "register" ? await register(address, phone()) : await login(address)
      setToken(response.token)
      setCode("")
      setNoticeKey("auth.code.resent")
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  const fieldClass =
    "w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-text-base outline-none focus:border-border-focus disabled:opacity-60"
  const primaryClass =
    "w-full rounded-md bg-background-stronger px-3 py-2 text-text-strong font-medium disabled:opacity-60"
  const secondaryClass = "w-full rounded-md border border-border-base px-3 py-2 text-text-base disabled:opacity-60"

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base text-text-base">
      <div class="w-full max-w-sm flex flex-col gap-4 px-6">
        <div class="flex flex-col gap-1 text-center">
          <h1 class="text-xl font-semibold text-text-strong">{t("auth.welcome.title")}</h1>
          <p class="text-sm text-text-weak">{t("auth.welcome.subtitle")}</p>
        </div>

        <Switch>
          <Match when={step() === "choose"}>
            <div class="flex flex-col gap-2">
              <button type="button" class={primaryClass} onClick={() => goTo("login")}>
                {t("auth.action.login")}
              </button>
              <button type="button" class={secondaryClass} onClick={() => goTo("register")}>
                {t("auth.action.register")}
              </button>
            </div>
          </Match>

          <Match when={step() === "register" || step() === "login"}>
            <form
              class="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void requestCode(step() === "register" ? "register" : "login")
              }}
            >
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-text-weak">{t("auth.field.email")}</span>
                <input
                  type="email"
                  autofocus
                  disabled={busy()}
                  class={fieldClass}
                  placeholder={t("auth.field.emailPlaceholder")}
                  value={email()}
                  onInput={(event) => setEmail(event.currentTarget.value)}
                />
              </label>

              <Show when={step() === "register"}>
                <label class="flex flex-col gap-1 text-sm">
                  <span class="text-text-weak">
                    {t("auth.field.phone")} <span class="text-text-faint">({t("auth.field.phoneOptional")})</span>
                  </span>
                  <input
                    type="tel"
                    disabled={busy()}
                    class={fieldClass}
                    placeholder={t("auth.field.phonePlaceholder")}
                    value={phone()}
                    onInput={(event) => setPhone(event.currentTarget.value)}
                  />
                </label>
              </Show>

              <button type="submit" class={primaryClass} disabled={busy()}>
                {busy() ? t("auth.busy") : t("auth.register.submit")}
              </button>
              <button type="button" class={secondaryClass} disabled={busy()} onClick={() => goTo("choose")}>
                {t("auth.action.back")}
              </button>
            </form>
          </Match>

          <Match when={step() === "code"}>
            <form
              class="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void submitCode()
              }}
            >
              <p class="text-sm text-text-weak">{t("auth.code.sentTo", { email: email().trim() })}</p>
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-text-weak">{t("auth.code.field")}</span>
                <input
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxlength={6}
                  autofocus
                  disabled={busy()}
                  class={`${fieldClass} tracking-[0.4em] text-center`}
                  value={code()}
                  onInput={(event) => setCode(event.currentTarget.value.replace(/\D/g, ""))}
                />
              </label>

              <button type="submit" class={primaryClass} disabled={busy()}>
                {busy() ? t("auth.busy") : t("auth.code.submit")}
              </button>
              <button type="button" class={secondaryClass} disabled={busy()} onClick={() => void resend()}>
                {t("auth.code.resend")}
              </button>
              <button type="button" class={secondaryClass} disabled={busy()} onClick={() => goTo(origin())}>
                {t("auth.action.back")}
              </button>
            </form>
          </Match>
        </Switch>

        <Show when={errorKey()}>
          {(key) => (
            <p role="alert" class="text-sm text-center text-icon-critical-base">
              {t(key(), { support: SUPPORT_CONTACT })}
            </p>
          )}
        </Show>
        <Show when={noticeKey()}>{(key) => <p class="text-sm text-center text-text-weak">{t(key())}</p>}</Show>
      </div>
    </div>
  )
}
