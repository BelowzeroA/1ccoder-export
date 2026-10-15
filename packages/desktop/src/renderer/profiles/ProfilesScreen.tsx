// The developer profiles screen.
//
// Opened from the account menu, mounted in index.tsx's serverScoped slot next
// to the other 1CCoder controls. Two modes: a list of the signed-in account's
// profiles, and a form for creating or editing one.
//
// Two rules from dev_plan.md Phase 6 shape the behaviour here:
//
//   Discovery is a convenience, never a gate. Every field it fills in stays
//   editable, and a machine where nothing is found must still let a profile be
//   typed in by hand -- so the discovery panel is an optional shortcut sitting
//   beside a form that is always fully usable.
//
//   A profile that fails verification is not saved. Saving therefore runs the
//   check first and only writes when nothing blocking failed. An INCONCLUSIVE
//   result is not a failure: it saves, and says why it could not be sure.

import { createEffect, createSignal, For, on, onMount, Show, type JSX } from "solid-js"

import {
  discover,
  draftFromInfobase,
  formatTimestamp,
  listProfiles,
  missingFields,
  removeProfile,
  saveProfile,
  verifyProfile,
  type CheckResult,
  type DeveloperProfile,
  type DiscoveryResult,
  type ProfileDraft,
  type VerificationResult,
} from "./client"
import { checkCodeKey, createProfilesTranslator, type ProfilesStringKey } from "./i18n"
import { profilesIntent, profilesOpen, setProfilesOpen } from "./open-state"
import { dialogStart, pickDirectory, pickFile } from "./pickers"
import { bumpProfilesRevision } from "./revision"

const panelClass = "rounded-md border border-border-base bg-surface-base p-3 flex flex-col gap-2"
const fieldClass =
  "w-full rounded-md border border-border-base bg-surface-base px-2.5 py-1.5 text-text-base outline-none focus:border-border-focus disabled:opacity-60"
const primaryClass = "rounded-md bg-background-stronger px-3 py-1.5 text-text-strong font-medium disabled:opacity-60"
const secondaryClass = "rounded-md border border-border-base px-3 py-1.5 text-text-base disabled:opacity-60"
const ghostClass = "rounded-md px-2 py-1 text-text-weak hover:bg-surface-base-hover disabled:opacity-60"

const emptyDraft = (): ProfileDraft => ({
  name: "",
  platformPath: "",
  kind: "file",
  filePath: "",
  workingDirectory: "",
  userName: "",
  password: "",
  // On by default for a new profile (debrief18): asking on every write cost the user
  // more than it protected; each write is still logged. Existing profiles keep theirs.
  allowWriteWithoutConfirmation: true,
})

/**
 * A path field with the native dialog beside it. The text input stays editable
 * -- a path that discovery cannot find, or one on a share, must still be
 * typeable -- but the dialog is the way that produces a canonical path.
 */
function PathField(props: {
  label: JSX.Element
  value: string
  invalid: boolean
  requiredLabel: string
  browseLabel: string
  placeholder?: string
  onInput: (value: string) => void
  onBrowse: () => void
}) {
  return (
    <div class="flex flex-col gap-1">
      <span class="text-text-weak">{props.label}</span>
      <div class="flex gap-2">
        <input
          type="text"
          class={`${fieldClass} min-w-0 flex-1`}
          classList={{ "border-border-strong": props.invalid }}
          placeholder={props.placeholder}
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
        <button type="button" class={secondaryClass} onClick={props.onBrowse}>
          {props.browseLabel}
        </button>
      </div>
      <Show when={props.invalid}>
        <span class="text-icon-critical-base">{props.requiredLabel}</span>
      </Show>
    </div>
  )
}

export function ProfilesScreen(props: { locale: string | undefined; accountEmail: string }) {
  const t = createProfilesTranslator(props.locale)

  const [profiles, setProfiles] = createSignal<DeveloperProfile[]>([])
  const [discovery, setDiscovery] = createSignal<DiscoveryResult | null>(null)
  const [scanning, setScanning] = createSignal(false)

  const [mode, setMode] = createSignal<"list" | "form">("list")
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal<ProfileDraft>(emptyDraft())
  const [missing, setMissing] = createSignal<string[]>([])
  const [confirmingDelete, setConfirmingDelete] = createSignal<string | null>(null)
  /**
   * Whether this screen was opened *for* the form rather than navigated into
   * from the list.
   *
   * Someone who asked for "новый профиль" from the home pane asked for one
   * thing; once it is saved that thing is done, and dropping them on the
   * profile catalogue is an answer to a question they did not ask. Someone who
   * opened the catalogue and then chose to add a profile is managing profiles,
   * and the list is exactly where they belong afterwards.
   */
  const [openedForForm, setOpenedForForm] = createSignal(false)

  const [busy, setBusy] = createSignal(false)
  const [checks, setChecks] = createSignal<VerificationResult | null>(null)
  /**
   * The draft the current `checks()` were produced against. Verification
   * launches the 1C platform for up to 90 seconds, so saving must reuse a
   * result the user already has rather than run it a second time and risk
   * contradicting the verdict they are looking at.
   */
  const [checkedSignature, setCheckedSignature] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<ProfilesStringKey | null>(null)

  /**
   * Identifies what verification actually tested. `name` is deliberately left
   * out: renaming a profile changes nothing about whether its platform,
   * infobase, workspace and credentials work.
   */
  function draftSignature(value: ProfileDraft): string {
    return JSON.stringify([
      value.id ?? "",
      value.platformPath,
      value.kind,
      value.filePath ?? "",
      value.serverCluster ?? "",
      value.serverDatabase ?? "",
      value.workingDirectory,
      value.userName,
      value.password ?? null,
    ])
  }

  const patch = (partial: Partial<ProfileDraft>) => setDraft((current) => ({ ...current, ...partial }))

  async function refreshProfiles() {
    setProfiles(await listProfiles(props.accountEmail))
    // Every mutation on this screen ends here, so this is the one place that
    // knows the list moved. The session selector under the composer reads the
    // same profiles and has no other way to hear about a new one.
    bumpProfilesRevision()
  }

  async function rescan() {
    setScanning(true)
    try {
      setDiscovery(await discover())
    } finally {
      setScanning(false)
    }
  }

  onMount(() => {
    void refreshProfiles()
    void rescan()
  })

  // What the screen shows when something asks for it. The screen is mounted for
  // the app's whole life and merely hides itself, so without this an "edit this
  // profile" request from the home list would land the user on the list to find
  // it again. Deferred: the initial intent is the list, which is where the
  // screen already starts.
  createEffect(
    on(
      profilesIntent,
      (intent) => {
        // startCreate and startEdit clear the flag, so it is set after them.
        if (intent.kind === "create") {
          startCreate()
          setOpenedForForm(true)
          return
        }
        if (intent.kind === "list") return backToList()
        const profile = profiles().find((item) => item.id === intent.id)
        if (!profile) return backToList()
        startEdit(profile)
        setOpenedForForm(true)
      },
      { defer: true },
    ),
  )

  /** The newest platform found, used as the default for a new profile. */
  const defaultPlatform = () => discovery()?.platforms[0]?.thickClient ?? ""

  function startCreate() {
    setOpenedForForm(false)
    setEditingId(null)
    setDraft({ ...emptyDraft(), platformPath: defaultPlatform() })
    setMissing([])
    setChecks(null)
    setCheckedSignature(null)
    setNotice(null)
    setMode("form")
  }

  function startEdit(profile: DeveloperProfile) {
    setOpenedForForm(false)
    setEditingId(profile.id)
    setDraft({
      id: profile.id,
      name: profile.name,
      platformPath: profile.platformPath,
      kind: profile.kind,
      filePath: profile.filePath ?? "",
      serverCluster: profile.serverCluster ?? "",
      serverDatabase: profile.serverDatabase ?? "",
      workingDirectory: profile.workingDirectory,
      userName: profile.userName,
      // undefined means "leave the stored password alone"; the field starts
      // blank and only becomes a change once the user types in it.
      password: undefined,
      allowWriteWithoutConfirmation: profile.allowWriteWithoutConfirmation === true,
    })
    setMissing([])
    setChecks(null)
    setCheckedSignature(null)
    setNotice(null)
    setMode("form")
  }

  /** Leaving the form: back to the list, or out of the screen entirely. */
  function leaveForm() {
    const close = openedForForm()
    backToList()
    if (close) setProfilesOpen(false)
  }

  function backToList() {
    setOpenedForForm(false)
    setMode("list")
    setChecks(null)
    setCheckedSignature(null)
    setNotice(null)
    setMissing([])
  }

  /** Runs verification alone, without saving. */
  async function runCheck() {
    const gaps = missingFields(draft())
    setMissing(gaps)
    if (gaps.length) return

    setBusy(true)
    setNotice(null)
    try {
      setChecks(await verifyProfile(draft(), editingId() ?? undefined))
      setCheckedSignature(draftSignature(draft()))
    } catch {
      setNotice("profiles.error.unknown")
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    const gaps = missingFields(draft())
    setMissing(gaps)
    if (gaps.length) return

    setBusy(true)
    setNotice(null)
    try {
      // Reuse the verification the user already ran against this exact draft.
      // Running it again means a second launch of the platform, which can
      // legitimately reach a different verdict -- a large infobase that another
      // client has open times out -- and then contradicts the check the user
      // just watched pass.
      const signature = draftSignature(draft())
      const cached = checks()
      const verification =
        cached && checkedSignature() === signature ? cached : await verifyProfile(draft(), editingId() ?? undefined)
      setChecks(verification)
      setCheckedSignature(signature)
      if (!verification.ok) {
        setNotice("profiles.verify.blocked")
        return
      }

      const result = await saveProfile(props.accountEmail, draft())
      if (!result.ok) {
        // The store re-validates; anything it rejects that the client check
        // passed is a bug on our side, so show the fields rather than a
        // generic error.
        setMissing(result.problems.map((problem) => problem.field))
        return
      }

      await refreshProfiles()
      // Only a real failure counts as a warning worth holding the form for. An
      // inconclusive check means verification learned nothing -- verify.ts says
      // so explicitly and does not block on it -- and treating it as a warning
      // stranded the user on the form with no way to tell the profile had in
      // fact saved. The list is where a saved profile becomes visible, so a
      // save that was not refused goes back to it.
      const warned = verification.checks.some((check) => check.status === "fail")
      setNotice(
        result.passwordNotStored
          ? "profiles.verify.passwordNotStored"
          : warned
            ? "profiles.verify.warned"
            : "profiles.verify.saved",
      )
      // A warning or an unstored password has to be read, so the form stays put
      // and says so; anything else is finished.
      if (!warned && !result.passwordNotStored) leaveForm()
    } catch {
      setNotice("profiles.error.unknown")
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete(id: string) {
    setBusy(true)
    try {
      await removeProfile(id)
      await refreshProfiles()
    } finally {
      setConfirmingDelete(null)
      setBusy(false)
    }
  }

  const fieldError = (field: string) => missing().includes(field)

  return (
    <Show when={profilesOpen()}>
      <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 text-xs">
        <div class="w-full max-w-3xl max-h-[85vh] overflow-auto rounded-lg border border-border-base bg-background-base p-4 flex flex-col gap-3">
          <div class="flex items-start justify-between gap-3">
            <div class="flex flex-col gap-0.5">
              <h2 class="text-base font-semibold text-text-strong">{t("profiles.title")}</h2>
              <p class="text-text-weak">{t("profiles.subtitle")}</p>
            </div>
            <button type="button" class={ghostClass} onClick={() => setProfilesOpen(false)}>
              {t("profiles.close")}
            </button>
          </div>

          <Show when={mode() === "list"} fallback={renderForm()}>
            {renderList()}
          </Show>
        </div>
      </div>
    </Show>
  )

  function renderList() {
    return (
      <div class="flex flex-col gap-3">
        <div class="flex justify-end">
          <button type="button" class={primaryClass} onClick={startCreate}>
            {t("profiles.action.create")}
          </button>
        </div>

        <Show
          when={profiles().length > 0}
          fallback={
            <div class={panelClass}>
              <span class="text-text-base">{t("profiles.list.empty")}</span>
              <span class="text-text-weak">{t("profiles.list.emptyHint")}</span>
            </div>
          }
        >
          <div class="flex flex-col gap-2">
            <For each={profiles()}>
              {(profile) => (
                <div class={panelClass}>
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex flex-col gap-0.5 min-w-0">
                      <span class="text-text-strong font-medium">{profile.name}</span>
                      <span class="text-text-weak break-all">
                        {profile.kind === "file"
                          ? profile.filePath
                          : `${profile.serverCluster}\\${profile.serverDatabase}`}
                      </span>
                      <span class="text-text-faint break-all">{profile.workingDirectory}</span>
                      <span class="text-text-faint">
                        {profile.userName} ·{" "}
                        {profile.hasPassword ? t("profiles.list.hasPassword") : t("profiles.list.noPassword")} ·{" "}
                        {profile.lastVerifiedAt
                          ? t("profiles.list.verifiedAt", {
                              when: formatTimestamp(profile.lastVerifiedAt, props.locale),
                            })
                          : t("profiles.list.neverVerified")}
                      </span>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                      <button type="button" class={ghostClass} onClick={() => startEdit(profile)}>
                        {t("profiles.action.edit")}
                      </button>
                      <button type="button" class={ghostClass} onClick={() => setConfirmingDelete(profile.id)}>
                        {t("profiles.action.delete")}
                      </button>
                    </div>
                  </div>

                  <Show when={confirmingDelete() === profile.id}>
                    <div class="flex items-center justify-between gap-2 rounded-md border border-border-base px-2 py-1.5">
                      <span class="text-text-base">{t("profiles.action.deleteConfirm")}</span>
                      <div class="flex gap-1">
                        <button
                          type="button"
                          class={secondaryClass}
                          disabled={busy()}
                          onClick={() => void confirmDelete(profile.id)}
                        >
                          {t("profiles.action.deleteYes")}
                        </button>
                        <button type="button" class={ghostClass} onClick={() => setConfirmingDelete(null)}>
                          {t("profiles.action.cancel")}
                        </button>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        {renderDiscovery()}
      </div>
    )
  }

  function renderDiscovery() {
    return (
      <div class={panelClass}>
        <div class="flex items-center justify-between gap-2">
          <span class="text-text-strong font-medium">{t("profiles.discovery.title")}</span>
          <button type="button" class={ghostClass} disabled={scanning()} onClick={() => void rescan()}>
            {scanning() ? t("profiles.discovery.scanning") : t("profiles.action.rescan")}
          </button>
        </div>

        <Show when={discovery()} fallback={<span class="text-text-weak">{t("profiles.discovery.scanning")}</span>}>
          {(result) => (
            <>
              <Show
                when={result().platforms.length > 0}
                fallback={
                  <div class="flex flex-col">
                    <span class="text-text-base">{t("profiles.discovery.none")}</span>
                    <span class="text-text-weak">{t("profiles.discovery.noneHint")}</span>
                  </div>
                }
              >
                <div class="flex flex-col gap-0.5">
                  <For each={result().platforms}>
                    {(platform) => (
                      <span class="text-text-weak break-all">
                        {platform.version}
                        {platform.edition === "training" ? ` (${t("profiles.discovery.training")})` : ""} —{" "}
                        {platform.thickClient}
                      </span>
                    )}
                  </For>
                </div>
              </Show>

              <span class="text-text-faint">
                {t("profiles.discovery.infobases")}: {result().infobases.length}
                <Show when={result().skippedInfobases.length > 0}>
                  {" · "}
                  {t("profiles.discovery.skipped", { count: result().skippedInfobases.length })}
                </Show>
              </span>
            </>
          )}
        </Show>
      </div>
    )
  }

  function renderForm() {
    return (
      <div class="flex flex-col gap-3">
        <span class="text-text-strong font-medium">
          {editingId() ? t("profiles.form.editTitle") : t("profiles.form.newTitle")}
        </span>

        {/* The shortcut, offered only when creating: picking a base 1C already
            knows about fills in everything except the credentials. */}
        <Show when={!editingId() && (discovery()?.infobases.length ?? 0) > 0}>
          <div class={panelClass}>
            <span class="text-text-weak">{t("profiles.discovery.infobases")}</span>
            <div class="flex flex-wrap gap-1">
              <For each={discovery()!.infobases}>
                {(infobase) => (
                  <button
                    type="button"
                    class="rounded-md border border-border-base px-2 py-1 text-text-base hover:bg-surface-base-hover"
                    onClick={() => {
                      setDraft(
                        draftFromInfobase(
                          infobase,
                          draft().platformPath || defaultPlatform(),
                          discovery()?.workspaceRoot ?? "",
                        ),
                      )
                      setMissing([])
                      setChecks(null)
                      setCheckedSignature(null)
                    }}
                  >
                    {infobase.name}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <label class="flex flex-col gap-1">
          <span class="text-text-weak">{t("profiles.field.name")}</span>
          <input
            type="text"
            class={fieldClass}
            classList={{ "border-border-strong": fieldError("name") }}
            value={draft().name}
            onInput={(event) => patch({ name: event.currentTarget.value })}
          />
          <Show when={fieldError("name")}>
            <span class="text-icon-critical-base">{t("profiles.field.required")}</span>
          </Show>
        </label>

        <div class="flex flex-col gap-1">
          <span class="text-text-weak">{t("profiles.field.platform")}</span>
          <Show when={(discovery()?.platforms.length ?? 0) > 0}>
            <select
              class={fieldClass}
              value={draft().platformPath}
              onChange={(event) => patch({ platformPath: event.currentTarget.value })}
            >
              <option value="">{t("profiles.field.platformPick")}</option>
              <For each={discovery()!.platforms}>
                {(platform) => (
                  <option value={platform.thickClient ?? ""}>
                    {platform.version}
                    {platform.edition === "training" ? ` (${t("profiles.discovery.training")})` : ""}
                  </option>
                )}
              </For>
            </select>
          </Show>
          {/* Always present, never only the dropdown: a platform installed
              somewhere discovery does not look must still be usable. */}
          <div class="flex gap-2">
            <input
              type="text"
              class={`${fieldClass} min-w-0 flex-1`}
              classList={{ "border-border-strong": fieldError("platformPath") }}
              placeholder={t("profiles.field.platformManual")}
              value={draft().platformPath}
              onInput={(event) => patch({ platformPath: event.currentTarget.value })}
            />
            <button
              type="button"
              class={secondaryClass}
              onClick={() =>
                void pickFile({
                  title: t("profiles.picker.platform"),
                  defaultPath: dialogStart(draft().platformPath, "file"),
                  extensions: ["exe"],
                })
                  .then((path) => path && patch({ platformPath: path }))
                  .catch(() => setNotice("profiles.error.unknown"))
              }
            >
              {t("profiles.action.browse")}
            </button>
          </div>
          <Show when={fieldError("platformPath")}>
            <span class="text-icon-critical-base">{t("profiles.field.required")}</span>
          </Show>
        </div>

        <div class="flex flex-col gap-1">
          <span class="text-text-weak">{t("profiles.field.kind")}</span>
          <div class="flex gap-2">
            <label class="flex items-center gap-1">
              <input
                type="radio"
                name="1ccoder-profile-kind"
                checked={draft().kind === "file"}
                onChange={() => patch({ kind: "file" })}
              />
              <span>{t("profiles.field.kindFile")}</span>
            </label>
            <label class="flex items-center gap-1">
              <input
                type="radio"
                name="1ccoder-profile-kind"
                checked={draft().kind === "server"}
                onChange={() => patch({ kind: "server" })}
              />
              <span>{t("profiles.field.kindServer")}</span>
            </label>
          </div>
        </div>

        <Show
          when={draft().kind === "file"}
          fallback={
            <>
              <label class="flex flex-col gap-1">
                <span class="text-text-weak">{t("profiles.field.serverCluster")}</span>
                <input
                  type="text"
                  class={fieldClass}
                  classList={{ "border-border-strong": fieldError("serverCluster") }}
                  value={draft().serverCluster ?? ""}
                  onInput={(event) => patch({ serverCluster: event.currentTarget.value })}
                />
                <Show when={fieldError("serverCluster")}>
                  <span class="text-icon-critical-base">{t("profiles.field.required")}</span>
                </Show>
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-text-weak">{t("profiles.field.serverDatabase")}</span>
                <input
                  type="text"
                  class={fieldClass}
                  classList={{ "border-border-strong": fieldError("serverDatabase") }}
                  value={draft().serverDatabase ?? ""}
                  onInput={(event) => patch({ serverDatabase: event.currentTarget.value })}
                />
                <Show when={fieldError("serverDatabase")}>
                  <span class="text-icon-critical-base">{t("profiles.field.required")}</span>
                </Show>
              </label>
            </>
          }
        >
          <PathField
            label={t("profiles.field.filePath")}
            value={draft().filePath ?? ""}
            invalid={fieldError("filePath")}
            requiredLabel={t("profiles.field.required")}
            browseLabel={t("profiles.action.browse")}
            onInput={(value) => patch({ filePath: value })}
            onBrowse={() =>
              void pickDirectory({
                title: t("profiles.picker.infobase"),
                defaultPath: dialogStart(draft().filePath, "directory"),
              })
                .then((path) => path && patch({ filePath: path }))
                .catch(() => setNotice("profiles.error.unknown"))
            }
          />
        </Show>

        <PathField
          label={
            <>
              {t("profiles.field.workingDirectory")}{" "}
              <span class="text-text-faint">({t("profiles.field.workingDirectoryHint")})</span>
            </>
          }
          value={draft().workingDirectory}
          invalid={fieldError("workingDirectory")}
          requiredLabel={t("profiles.field.required")}
          browseLabel={t("profiles.action.browse")}
          onInput={(value) => patch({ workingDirectory: value })}
          onBrowse={() =>
            void pickDirectory({
              title: t("profiles.picker.workingDirectory"),
              defaultPath: dialogStart(draft().workingDirectory, "directory"),
            })
              .then((path) => path && patch({ workingDirectory: path }))
              .catch(() => setNotice("profiles.error.unknown"))
          }
        />

        <label class="flex flex-col gap-1">
          <span class="text-text-weak">{t("profiles.field.userName")}</span>
          <input
            type="text"
            class={fieldClass}
            classList={{ "border-border-strong": fieldError("userName") }}
            value={draft().userName}
            onInput={(event) => patch({ userName: event.currentTarget.value })}
          />
          <Show when={fieldError("userName")}>
            <span class="text-icon-critical-base">{t("profiles.field.required")}</span>
          </Show>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-text-weak">
            {t("profiles.field.password")}{" "}
            <span class="text-text-faint">
              ({editingId() ? t("profiles.field.passwordKeep") : t("profiles.field.passwordOptional")})
            </span>
          </span>
          <input
            type="password"
            class={fieldClass}
            value={draft().password ?? ""}
            onInput={(event) => patch({ password: event.currentTarget.value })}
          />
        </label>

        <label class="flex items-start gap-2">
          <input
            type="checkbox"
            class="mt-0.5"
            checked={draft().allowWriteWithoutConfirmation === true}
            onChange={(event) => patch({ allowWriteWithoutConfirmation: event.currentTarget.checked })}
          />
          <span class="flex flex-col">
            <span class="text-text-base">{t("profiles.field.allowWrite")}</span>
            <span class="text-text-faint">{t("profiles.field.allowWriteHint")}</span>
          </span>
        </label>

        {renderChecks()}

        <Show when={notice()}>{(key) => <span class="text-text-base">{t(key())}</span>}</Show>

        <div class="flex items-center justify-end gap-2">
          <button type="button" class={ghostClass} disabled={busy()} onClick={leaveForm}>
            {t("profiles.action.cancel")}
          </button>
          <button type="button" class={secondaryClass} disabled={busy()} onClick={() => void runCheck()}>
            {busy() ? t("profiles.verify.running") : t("profiles.action.verify")}
          </button>
          <button type="button" class={primaryClass} disabled={busy()} onClick={() => void save()}>
            {busy() ? t("profiles.verify.running") : t("profiles.action.save")}
          </button>
        </div>
      </div>
    )
  }

  function renderChecks() {
    return (
      <Show when={checks()}>
        {(result) => (
          <div class={panelClass}>
            <span class="text-text-strong font-medium">{t("profiles.verify.title")}</span>
            <For each={result().checks}>{(check) => renderCheck(check)}</For>
          </div>
        )}
      </Show>
    )
  }

  function renderCheck(check: CheckResult) {
    const statusKey =
      check.status === "pass"
        ? "profiles.status.pass"
        : check.status === "fail"
          ? "profiles.status.fail"
          : "profiles.status.inconclusive"
    const tone =
      check.status === "pass"
        ? "text-text-base"
        : check.status === "fail"
          ? "text-icon-critical-base"
          : "text-text-weak"
    const messageKey = checkCodeKey(check.code)

    return (
      <div class="flex flex-col gap-0.5">
        <span class={tone}>
          {t(`profiles.check.${check.id}` as ProfilesStringKey)}: {t(statusKey)}
        </span>
        {/* An unknown code falls through to the raw code rather than to a
            reassuring message we made up. */}
        <span class="text-text-weak">{messageKey ? t(messageKey) : check.code}</span>
        <Show when={check.detail}>
          <span class="text-text-faint break-all whitespace-pre-wrap">{check.detail}</span>
        </Show>
      </div>
    )
  }
}
