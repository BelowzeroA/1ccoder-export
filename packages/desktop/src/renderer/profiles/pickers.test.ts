import { describe, expect, test } from "bun:test"

import { dialogStart } from "./pickers"

describe("dialogStart", () => {
  test("opens a file dialog in the file's own folder", () => {
    expect(dialogStart("D:\\Programs\\1cv8\\8.3.27.2342\\bin\\1cv8.exe", "file")).toBe(
      "D:\\Programs\\1cv8\\8.3.27.2342\\bin",
    )
    expect(dialogStart("/opt/1cv8/bin/1cv8", "file")).toBe("/opt/1cv8/bin")
  })

  test("opens a folder dialog in the folder itself", () => {
    expect(dialogStart("D:\\Work\\Dynamite\\stage", "directory")).toBe("D:\\Work\\Dynamite\\stage")
  })

  test("falls back to the dialog's own default when there is nothing useful", () => {
    expect(dialogStart("", "directory")).toBeUndefined()
    expect(dialogStart("   ", "file")).toBeUndefined()
    expect(dialogStart(undefined, "file")).toBeUndefined()
    // A bare file name names no folder to start in.
    expect(dialogStart("1cv8.exe", "file")).toBeUndefined()
  })
})
