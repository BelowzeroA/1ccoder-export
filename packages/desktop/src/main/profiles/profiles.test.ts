import { describe, expect, test } from "bun:test"

import { classifyBinDir, compareVersions, parseUninstallDump } from "./discovery"
import {
  decodeConfigText,
  iniValues,
  parseCommonInfoBases,
  parseConnectionString,
  parseInfobaseList,
  parseIni,
  parseInstalledLocations,
} from "./v8i"

function utf8WithBom(text: string): Uint8Array {
  const body = new TextEncoder().encode(text)
  const out = new Uint8Array(body.length + 3)
  out.set([0xef, 0xbb, 0xbf])
  out.set(body, 3)
  return out
}

function utf16le(text: string, bom = true): Uint8Array {
  const units = bom ? `\ufeff${text}` : text
  const out = new Uint8Array(units.length * 2)
  for (let i = 0; i < units.length; i++) {
    const code = units.charCodeAt(i)
    out[i * 2] = code & 0xff
    out[i * 2 + 1] = code >> 8
  }
  return out
}

describe("decodeConfigText", () => {
  // Both encodings live in the same directory on a real machine: ibases.v8i is
  // UTF-8 with a BOM, 1CEStart.cfg beside it is UTF-16LE.
  test("reads UTF-8 with a BOM without leaving the BOM in the text", () => {
    expect(decodeConfigText(utf8WithBom("[Тест]\r\nConnect=File=\"D:\\x\";\r\n"))).toBe(
      '[Тест]\r\nConnect=File="D:\\x";\r\n',
    )
  })

  test("reads UTF-16LE with a BOM", () => {
    expect(decodeConfigText(utf16le("InstalledLocation=D:\\Programs\\1cv8\r\n"))).toBe(
      "InstalledLocation=D:\\Programs\\1cv8\r\n",
    )
  })

  test("falls back to UTF-16LE for a BOM-less file full of NULs", () => {
    expect(decodeConfigText(utf16le("InstalledLocation=D:\\Programs\\1cv8", false))).toBe(
      "InstalledLocation=D:\\Programs\\1cv8",
    )
  })

  test("reads plain UTF-8", () => {
    expect(decodeConfigText(new TextEncoder().encode("[A]\nConnect=x"))).toBe("[A]\nConnect=x")
  })
})

describe("parseIni", () => {
  test("keeps repeated keys, which 1CEStart.cfg relies on", () => {
    const file = parseIni("InstalledLocation=C:\\a\r\nInstalledLocation=D:\\b\r\n")
    expect(iniValues(file.globals, "InstalledLocation")).toEqual(["C:\\a", "D:\\b"])
  })

  test("separates entries before the first section from sections", () => {
    const file = parseIni("Top=1\n[S]\nInner=2\n")
    expect(file.globals).toEqual([["Top", "1"]])
    expect(file.sections).toHaveLength(1)
    expect(file.sections[0]!.name).toBe("S")
    expect(file.sections[0]!.entries).toEqual([["Inner", "2"]])
  })

  test("survives a BOM that outlived decoding, so the first section still parses", () => {
    expect(parseIni("\ufeff[First]\nConnect=x").sections[0]!.name).toBe("First")
  })

  test("drops lines it cannot make sense of rather than failing the file", () => {
    const file = parseIni("[S]\ngarbage\n=novalue\nGood=1\n")
    expect(file.sections[0]!.entries).toEqual([["Good", "1"]])
  })
})

describe("parseConnectionString", () => {
  test("reads a file connection", () => {
    const parts = parseConnectionString('File="D:\\Work\\1C\\Base";')
    expect(parts.get("file")).toBe("D:\\Work\\1C\\Base")
  })

  test("reads a server connection", () => {
    const parts = parseConnectionString('Srvr="app-1c:1541";Ref="trade";')
    expect(parts.get("srvr")).toBe("app-1c:1541")
    expect(parts.get("ref")).toBe("trade")
  })

  test("unescapes a doubled quote inside a value", () => {
    expect(parseConnectionString('File="D:\\a""b";').get("file")).toBe('D:\\a"b')
  })

  test("accepts unquoted values and mixed casing", () => {
    const parts = parseConnectionString("SRVR=host;ref=base")
    expect(parts.get("srvr")).toBe("host")
    expect(parts.get("ref")).toBe("base")
  })

  test("skips a malformed part instead of losing the rest", () => {
    const parts = parseConnectionString('junk;Ref="base";')
    expect(parts.get("ref")).toBe("base")
  })
})

describe("parseInfobaseList", () => {
  // Shaped after the real file: 13 sections, of which one is a tree folder.
  const sample = [
    "[Best]",
    "ID=ea9ca3d5-3eda-40c4-bc0f-9c2b0b8a9a5c",
    "Folder=/",
    "OrderInTree=1280",
    "[Acc best 2]",
    'Connect=File="D:\\Work\\Bases\\BestAcc2";',
    "Folder=/Best",
    "Version=8.3",
    "DefaultApp=ThickClient",
    "[Trade server]",
    'Connect=Srvr="app-1c";Ref="trade";Usr="Админ";',
    "[Published]",
    'Connect=ws="https://example/base";',
  ].join("\r\n")

  test("returns only real infobases", () => {
    const listing = parseInfobaseList(sample)
    expect(listing.infobases.map((ib) => ib.name)).toEqual(["Acc best 2", "Trade server"])
  })

  test("reports a tree folder as skipped rather than dropping it silently", () => {
    const listing = parseInfobaseList(sample)
    expect(listing.skipped).toContainEqual({ name: "Best", reason: "folder" })
  })

  test("reports a web-published base as an unsupported connection", () => {
    const skipped = parseInfobaseList(sample).skipped.find((entry) => entry.name === "Published")
    expect(skipped?.reason).toBe("unsupported-connection")
  })

  test("splits the connection string into profile fields", () => {
    const [file, server] = parseInfobaseList(sample).infobases
    expect(file!.target).toEqual({ kind: "file", filePath: "D:\\Work\\Bases\\BestAcc2" })
    expect(server!.target).toEqual({ kind: "server", serverCluster: "app-1c", serverDatabase: "trade" })
  })

  test("carries over a user name 1C had remembered", () => {
    const server = parseInfobaseList(sample).infobases.find((ib) => ib.name === "Trade server")
    expect(server?.suggestedUser).toBe("Админ")
  })
})

describe("1CEStart.cfg readers", () => {
  test("collects every install root, not just the last", () => {
    const text = [
      "InstalledLocation=C:\\Program Files (x86)\\1cv8",
      "InstalledLocation=D:\\Programs\\1cv8",
      "InstalledLocation=D:\\Programs\\1cv8",
      "InstallComponents=SERVER=0",
    ].join("\r\n")
    expect(parseInstalledLocations(text)).toEqual(["C:\\Program Files (x86)\\1cv8", "D:\\Programs\\1cv8"])
  })

  test("finds a common infobase list when one is named", () => {
    expect(parseCommonInfoBases("CommonInfoBases=D:\\shared\\ibases.v8i")).toEqual(["D:\\shared\\ibases.v8i"])
  })
})

describe("classifyBinDir", () => {
  test("recognises the ordinary thick client", () => {
    expect(classifyBinDir(["1cv8.exe", "1cv8c.exe", "1cv8s.exe"])).toEqual({
      thickClient: "1cv8.exe",
      edition: "standard",
    })
  })

  test("recognises the training edition, whose thick client is named differently", () => {
    expect(classifyBinDir(["1cv8t.exe", "1cv8ct.exe", "1cv8st.exe"])).toEqual({
      thickClient: "1cv8t.exe",
      edition: "training",
    })
  })

  test("rejects a thin-client-only installation", () => {
    expect(classifyBinDir(["1cv8c.exe", "1cv8ct.exe"])).toBeNull()
  })
})

describe("parseUninstallDump", () => {
  const dump = [
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{AAA}",
    "    DisplayName    REG_SZ    1C:Enterprise 8 (x86-64) (8.3.27.2342)",
    "    InstallLocation    REG_SZ    D:\\Programs\\1cv8\\8.3.27.2342\\",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{BBB}",
    "    DisplayName    REG_SZ    Some Other Product",
    "    InstallLocation    REG_SZ    C:\\Other",
    "",
  ].join("\r\n")

  test("keeps 1C products and ignores everything else", () => {
    expect(parseUninstallDump(dump)).toEqual(["D:\\Programs\\1cv8\\8.3.27.2342\\"])
  })

  test("ignores a 1C entry that records no install location", () => {
    const partial = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{CCC}",
      "    DisplayName    REG_SZ    1C:Enterprise 8 (8.3.10.1)",
      "",
    ].join("\r\n")
    expect(parseUninstallDump(partial)).toEqual([])
  })
})

describe("compareVersions", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("8.3.27.2342", "8.3.9.100")).toBeGreaterThan(0)
  })

  test("treats a missing part as zero", () => {
    expect(compareVersions("8.3", "8.3.0.0")).toBe(0)
  })
})
