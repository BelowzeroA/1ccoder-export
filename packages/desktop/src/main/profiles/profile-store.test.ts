import { describe, expect, test } from "bun:test"

import { connectionString, normalizeDraft, validateDraft, type ProfileDraft } from "./profile"
import { ProfileStore, type SecretBox, type StoreDeps, type StoredProfile } from "./profile-store"
import { classifyDesignerRun, designerArgs, splitCluster } from "./verify"

function fakeDeps(options: { encryption?: boolean; seed?: StoredProfile[] } = {}) {
  let rows: StoredProfile[] = options.seed ?? []
  let clock = 1_000
  let ids = 0

  const secrets: SecretBox = {
    available: () => options.encryption !== false,
    // Reversible stand-in for DPAPI: the point under test is that the store
    // writes ciphertext and never the plaintext, not how strong it is.
    encrypt: (plain) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
    decrypt: (cipher) =>
      cipher.startsWith("enc:") ? Buffer.from(cipher.slice(4), "base64").toString("utf8") : null,
  }

  const deps: StoreDeps = {
    read: () => rows.map((row) => ({ ...row })),
    write: (next) => {
      rows = next.map((row) => ({ ...row }))
    },
    secrets,
    now: () => clock++,
    newId: () => `id-${++ids}`,
  }

  return { deps, rows: () => rows, store: new ProfileStore(deps) }
}

const fileDraft: ProfileDraft = {
  name: "Бухгалтерия",
  platformPath: "D:\\Programs\\1cv8\\8.3.27.2342\\bin\\1cv8.exe",
  kind: "file",
  filePath: "D:\\Bases\\Acc",
  workingDirectory: "D:\\Work\\Acc",
  userName: "Администратор",
  password: "секрет",
}

describe("validateDraft", () => {
  test("accepts a complete file profile", () => {
    expect(validateDraft(fileDraft)).toEqual([])
  })

  test("requires the file path for a file infobase", () => {
    expect(validateDraft({ ...fileDraft, filePath: "  " })).toEqual([{ field: "filePath", code: "required" }])
  })

  test("requires a working directory", () => {
    expect(validateDraft({ ...fileDraft, workingDirectory: "   " })).toEqual([
      { field: "workingDirectory", code: "required" },
    ])
  })

  test("requires cluster and database for a server infobase", () => {
    const problems = validateDraft({ ...fileDraft, kind: "server", filePath: undefined })
    expect(problems.map((p) => p.field).sort()).toEqual(["serverCluster", "serverDatabase"])
  })

  test("accepts a blank password, because an infobase may have no users", () => {
    expect(validateDraft({ ...fileDraft, password: "" })).toEqual([])
  })
})

describe("normalizeDraft", () => {
  test("drops fields the chosen kind does not use", () => {
    const normalized = normalizeDraft({ ...fileDraft, kind: "server", serverCluster: "srv", serverDatabase: "db" })
    expect(normalized.filePath).toBeUndefined()
    expect(normalized.serverCluster).toBe("srv")
  })

  test("trims fields but never the password", () => {
    const normalized = normalizeDraft({ ...fileDraft, name: "  Учёт  ", password: " padded " })
    expect(normalized.name).toBe("Учёт")
    expect(normalized.password).toBe(" padded ")
  })
})

describe("connectionString", () => {
  test("builds a file connection", () => {
    expect(connectionString({ kind: "file", filePath: "D:\\Bases\\Acc" })).toBe('File="D:\\Bases\\Acc";')
  })

  test("builds a server connection", () => {
    expect(connectionString({ kind: "server", serverCluster: "app-1c", serverDatabase: "trade" })).toBe(
      'Srvr="app-1c";Ref="trade";',
    )
  })

  test("doubles an inner quote so the platform reads the value we meant", () => {
    expect(connectionString({ kind: "file", filePath: 'D:\\a"b' })).toBe('File="D:\\a""b";')
  })
})

describe("ProfileStore", () => {
  // debrief15.md: the standing permission to write without an ask.
  test("writing without confirmation is off unless ticked, and unticking turns it off", () => {
    const { store } = fakeDeps()
    const plain = store.save("user@example.com", fileDraft)
    if (!plain.ok) throw new Error("save failed")
    expect(plain.profile.allowWriteWithoutConfirmation).toBeUndefined()
    const on = store.save("user@example.com", { ...fileDraft, id: plain.profile.id, allowWriteWithoutConfirmation: true })
    if (!on.ok) throw new Error("save failed")
    expect(store.get(on.profile.id)?.allowWriteWithoutConfirmation).toBe(true)
    store.save("user@example.com", { ...fileDraft, id: plain.profile.id, allowWriteWithoutConfirmation: false })
    expect(store.get(plain.profile.id)?.allowWriteWithoutConfirmation).toBeUndefined()
  })

  test("stores the password as ciphertext and never in the clear", () => {
    const { store, rows } = fakeDeps()
    store.save("user@example.com", fileDraft)
    const raw = JSON.stringify(rows())
    expect(raw).not.toContain("секрет")
    expect(rows()[0]!.passwordCipher).toBeTruthy()
  })

  test("never hands the secret out with the profile", () => {
    const { store } = fakeDeps()
    const saved = store.save("user@example.com", fileDraft)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.profile.hasPassword).toBe(true)
    expect(JSON.stringify(saved.profile)).not.toContain("секрет")
  })

  test("returns the password only through the explicit accessor", () => {
    const { store } = fakeDeps()
    const saved = store.save("user@example.com", fileDraft)
    if (!saved.ok) throw new Error("save failed")
    expect(store.password(saved.profile.id)).toBe("секрет")
  })

  test("refuses to persist the password when encryption is unavailable, and says so", () => {
    const { store, rows } = fakeDeps({ encryption: false })
    const saved = store.save("user@example.com", fileDraft)
    if (!saved.ok) throw new Error("save failed")
    expect(saved.passwordNotStored).toBe(true)
    expect(saved.profile.hasPassword).toBe(false)
    expect(JSON.stringify(rows())).not.toContain("секрет")
  })

  test("an undefined password on update leaves the stored one alone", () => {
    const { store } = fakeDeps()
    const first = store.save("user@example.com", fileDraft)
    if (!first.ok) throw new Error("save failed")
    store.save("user@example.com", { ...fileDraft, id: first.profile.id, name: "Переименовано", password: undefined })
    expect(store.password(first.profile.id)).toBe("секрет")
    expect(store.get(first.profile.id)?.name).toBe("Переименовано")
  })

  test("an empty password on update clears it", () => {
    const { store } = fakeDeps()
    const first = store.save("user@example.com", fileDraft)
    if (!first.ok) throw new Error("save failed")
    store.save("user@example.com", { ...fileDraft, id: first.profile.id, password: "" })
    expect(store.password(first.profile.id)).toBeNull()
    expect(store.get(first.profile.id)?.hasPassword).toBe(false)
  })

  test("lists only the signed-in account's profiles", () => {
    const { store } = fakeDeps()
    store.save("a@example.com", fileDraft)
    store.save("b@example.com", { ...fileDraft, name: "Чужой" })
    expect(store.list("A@Example.com").map((p) => p.name)).toEqual(["Бухгалтерия"])
  })

  test("rejects an incomplete draft without writing anything", () => {
    const { store, rows } = fakeDeps()
    const result = store.save("user@example.com", { ...fileDraft, filePath: "" })
    expect(result.ok).toBe(false)
    expect(rows()).toHaveLength(0)
  })

  test("an unreadable ciphertext yields no password rather than throwing", () => {
    const { store, deps } = fakeDeps()
    const saved = store.save("user@example.com", fileDraft)
    if (!saved.ok) throw new Error("save failed")
    deps.write(deps.read().map((row) => ({ ...row, passwordCipher: "from-another-machine" })))
    expect(store.password(saved.profile.id)).toBeNull()
  })

  test("remove reports whether it removed anything", () => {
    const { store } = fakeDeps()
    const saved = store.save("user@example.com", fileDraft)
    if (!saved.ok) throw new Error("save failed")
    expect(store.remove(saved.profile.id)).toBe(true)
    expect(store.remove(saved.profile.id)).toBe(false)
  })
})

describe("designerArgs", () => {
  const input = {
    platformPath: "D:\\bin\\1cv8.exe",
    kind: "file" as const,
    filePath: "D:\\Bases\\Acc",
    userName: "Администратор",
    password: "секрет",
  }

  test("always carries a command, because a bare DESIGNER opens a window that never closes", () => {
    expect(designerArgs(input, "C:\\out.log")).toContain("/CheckConfig")
  })

  test("quotes the value, not the whole argument", () => {
    const args = designerArgs(input, "C:\\out.log")
    expect(args).toContain('/F"D:\\Bases\\Acc"')
    expect(args).toContain('/Out"C:\\out.log"')
  })

  test("builds the server target as cluster\\database", () => {
    const args = designerArgs(
      { ...input, kind: "server", filePath: undefined, serverCluster: "app-1c", serverDatabase: "trade" },
      "C:\\out.log",
    )
    expect(args).toContain('/S"app-1c\\trade"')
  })
})

describe("classifyDesignerRun", () => {
  test("exit 0 is the only thing that means success", () => {
    expect(classifyDesignerRun({ exitCode: 0, timedOut: false }, "Ошибок не обнаружено")).toEqual({ kind: "ok" })
  })

  test("recognises the platform's own rejection of the credentials", () => {
    expect(classifyDesignerRun({ exitCode: 1, timedOut: false }, "Пользователь ИБ не идентифицирован")).toEqual({
      kind: "bad-credentials",
    })
  })

  test("recognises a missing infobase", () => {
    expect(classifyDesignerRun({ exitCode: 1, timedOut: false }, "Информационная база не обнаружена!")).toEqual({
      kind: "infobase-missing",
    })
  })

  // A locked base, a licence problem, or a platform installed in a language we
  // have no markers for. Telling the user their password is wrong on this
  // evidence would be a lie.
  test("an unrecognised failure is inconclusive, not a credential failure", () => {
    expect(classifyDesignerRun({ exitCode: 1, timedOut: false }, "Что-то совершенно другое")).toEqual({
      kind: "inconclusive",
      reason: "unrecognised",
    })
  })

  test("a timeout is inconclusive", () => {
    expect(classifyDesignerRun({ exitCode: null, timedOut: true }, "")).toEqual({
      kind: "inconclusive",
      reason: "timeout",
    })
  })

  test("a failure to launch is inconclusive", () => {
    expect(classifyDesignerRun({ exitCode: null, timedOut: false, spawnError: "ENOENT" }, "")).toEqual({
      kind: "inconclusive",
      reason: "spawn-failed",
    })
  })
})

describe("splitCluster", () => {
  test("defaults to the agent port", () => {
    expect(splitCluster("app-1c")).toEqual({ host: "app-1c", port: 1541 })
  })

  test("reads an explicit port", () => {
    expect(splitCluster("app-1c:1741")).toEqual({ host: "app-1c", port: 1741 })
  })

  test("falls back to the default when the port makes no sense", () => {
    expect(splitCluster("app-1c:nonsense")).toEqual({ host: "app-1c", port: 1541 })
  })
})
