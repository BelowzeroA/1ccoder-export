import { describe, expect, test } from "bun:test"

import {
  comConnectionString,
  connectorProgId,
  describeProtection,
  parseProtection,
  protectionCleared,
  protectionScript,
  typeLibScript,
} from "./unsafe-protection"

const PLATFORM_85 = String.raw`C:\Program Files\1cv8\8.5.1.1343\bin\1cv8.exe`

const fileInput = {
  // Plain escaped literals: Bun's String.raw keeps Cyrillic as \u escapes.
  profile: { kind: "file" as const, filePath: 'D:\\1C_DB\\WORK\\ИП "Тест"', userName: "Админ", platformPath: PLATFORM_85 },
  password: "p'w",
}

describe("the connection", () => {
  test("the connector follows the platform's major version", () => {
    expect(connectorProgId(PLATFORM_85)).toBe("V85.COMConnector")
    expect(connectorProgId(String.raw`C:\Program Files\1cv8\8.3.27.2342\bin\1cv8.exe`)).toBe("V83.COMConnector")
  })

  test("values are quoted the way 1C reads them, doubled quotes inside", () => {
    expect(comConnectionString(fileInput)).toBe('File="D:\\1C_DB\\WORK\\ИП ""Тест""";Usr="Админ";Pwd="p\'w"')
    const server = { profile: { ...fileInput.profile, kind: "server" as const, serverCluster: "srv", serverDatabase: "bp" }, password: "" }
    expect(comConnectionString(server)).toBe(`Srvr="srv";Ref="bp";Usr="Админ";Pwd=""`)
  })

  test("the script embeds the connection as a PowerShell literal, single quotes doubled", () => {
    expect(protectionScript(fileInput)).toContain(`'File="D:\\1C_DB\\WORK\\ИП ""Тест""";Usr="Админ";Pwd="p''w"'`)
    expect(protectionScript(fileInput)).toContain("'V85.COMConnector'")
  })

  // Loading the library in the connecting process broke the connection; the
  // registration lives in its own script.
  test("the type library is registered from the profile's own platform, in a separate script", () => {
    expect(typeLibScript(PLATFORM_85)).toContain(String.raw`'C:\Program Files\1cv8\8.5.1.1343\bin\comcntr.dll'`)
    expect(protectionScript(fileInput)).not.toContain("LoadTypeLibEx")
  })
})

describe("the outcome", () => {
  test("is read from the script's last line", () => {
    expect(parseProtection('noise\n{"state":"turned-off","detail":"Админ"}\n')).toEqual({ state: "turned-off", detail: "Админ" })
    expect(parseProtection('{"state":"off","detail":""}')).toEqual({ state: "off" })
  })

  test("anything unexpected is an error, not a pass", () => {
    expect(parseProtection("").state).toBe("error")
    expect(parseProtection('{"state":"maybe"}').state).toBe("error")
  })

  test("only off, turned-off and no-users count as cleared", () => {
    expect(["off", "turned-off", "no-users"].every((state) => protectionCleared({ state: state as "off" }))).toBe(true)
    expect(["no-user", "no-rights", "error"].some((state) => protectionCleared({ state: state as "error" }))).toBe(false)
  })

  test("a cleared flag needs no words; one that is not tells where to untick it", () => {
    expect(describeProtection({ state: "turned-off" }, "Админ")).toBeUndefined()
    const text = describeProtection({ state: "error", detail: "Library not registered" }, "Админ") ?? ""
    expect(text).toContain("«Защита от опасных действий»")
    expect(text).toContain("пользователя «Админ»")
    expect(text).toContain("Library not registered")
  })
})
