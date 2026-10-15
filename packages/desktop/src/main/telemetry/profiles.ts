// The profile snapshot telemetry uploads: an allowlist of fields.
//
// An allowlist and not a denylist, so a field added to DeveloperProfile later
// is not uploaded by accident -- it has to be named here first. The password
// is never in a DeveloperProfile to begin with (it lives encrypted in the store
// and is read only by ProfileStore.password), and accountEmail is the
// account's own folder on the server already.

import type { DeveloperProfile } from "../profiles/profile"

export function sanitizeProfile(profile: DeveloperProfile) {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    platformPath: profile.platformPath,
    filePath: profile.filePath,
    serverCluster: profile.serverCluster,
    serverDatabase: profile.serverDatabase,
    workingDirectory: profile.workingDirectory,
    userName: profile.userName,
    hasPassword: profile.hasPassword,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    lastVerifiedAt: profile.lastVerifiedAt,
    configuration: profile.configuration,
    allowWriteWithoutConfirmation: profile.allowWriteWithoutConfirmation,
  }
}
