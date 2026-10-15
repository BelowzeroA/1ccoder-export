export { AppBaseProviders, AppInterface } from "./app"
export { useLayout } from "./context/layout"
export { useServerSDK } from "./context/server-sdk"
export { useServerSync } from "./context/server-sync"
export { useServer } from "./context/server"
export { useSettings } from "./context/settings"
// 1CCoder: the AutoMode control injected by the desktop renderer needs the
// per-project permission state (see automode/policy.ts and Phase 5).
export { usePermission } from "./context/permission"
export { alwaysAskReason, type AlwaysAskReason } from "./automode/policy"
// 1CCoder: the new-session screen's target selector is supplied by the desktop
// renderer, which replaces opencode's project picker with a developer-profile
// picker. See components/session-target-slot.tsx.
export {
  setSessionDirectoryResolver,
  setSessionTargetRenderer,
  sessionDirectoryResolver,
  sessionTargetRenderer,
  type SessionDirectoryResolver,
  type SessionTargetRenderer,
  type SessionTargetSlotInput,
} from "./components/session-target-slot"
// 1CCoder: the running session shows its developer profile as read-only text
// beside the model picker. See components/session-profile-note-slot.ts.
export {
  setSessionProfileNoteRenderer,
  sessionProfileNoteRenderer,
  type SessionProfileNoteRenderer,
} from "./components/session-profile-note-slot"
// 1CCoder: the home screen's left pane lists developer profiles instead of
// projects. See pages/home/home-scope-slot.ts.
export {
  homeScope,
  homeScopeName,
  homeScopeSource,
  setHomeScopeSource,
  type HomeScopeItem,
  type HomeScopeSource,
} from "./pages/home/home-scope-slot"
export { useTabs } from "./context/tabs"
// 1CCoder: the desktop fork selects a session's agent from its developer profile.
export { useLocal } from "./context/local"
export { useProviders } from "./hooks/use-providers"
export { ACCEPTED_FILE_EXTENSIONS, ACCEPTED_FILE_TYPES, filePickerFilters } from "./constants/file-picker"
export { useCommand } from "./context/command"
export { loadLocaleDict, normalizeLocale, type Locale, useLanguage } from "./context/language"
export { useWslServers } from "./wsl/context"
export { type DisplayBackend, type FatalRendererErrorLog, type Platform, PlatformProvider } from "./context/platform"
export { type UpdaterPlatform, type UpdaterState } from "./updater"
export {
  type WslDistroProbe,
  type WslInstalledDistro,
  type WslJob,
  type WslOnlineDistro,
  type WslOpencodeCheck,
  type WslRuntimeCheck,
  type WslServerConfig,
  type WslServerItem,
  type WslServerRuntime,
  type WslServersEvent,
  type WslServersPlatform,
  type WslServersState,
} from "./wsl/types"
export { ServerConnection } from "./context/server"
export { createDraftStore, type DraftStore } from "./utils/draft-store"
