import { describe, expect, test } from "bun:test"

import { parkScript, parseParked } from "./window-park"

describe("parking the toolkit's window", () => {
  test("restores without activating and moves past the virtual screen, keeping the size", () => {
    const script = parkScript([777])
    expect(script).toContain("$Pids = '777'")
    expect(script).toContain("ShowWindow($h, 4)")
    expect(script).toContain("$screen.Right + 50")
    expect(script).toContain("0x15")
  })

  // Started with the hide flag, the platform keeps the frame hidden whenever
  // its saved placement is not maximized; hidden, the screenshot breaks.
  test("a hidden frame is shown, and only after it is off-screen", () => {
    const script = parkScript([777])
    expect(script).toContain("if (-not [OneCPark]::IsWindowVisible($h)) { [void][OneCPark]::ShowWindow($h, 4) }")
    expect(script.indexOf("SetWindowPos($h")).toBeLessThan(script.indexOf("IsWindowVisible($h)) { [void]"))
  })

  test("only the main frame: owned windows and untitled ones are skipped", () => {
    const script = parkScript([777])
    expect(script).toContain('StartsWith("V8Window")')
    expect(script).toContain("GetWindow($h, 4) -ne [IntPtr]::Zero) { continue }")
    expect(script).toContain("if (-not $title) { continue }")
  })

  test("reads one window, several, or none", () => {
    expect(parseParked('{"pid":1,"title":"Организация"}')).toEqual(["Организация"])
    expect(parseParked('[{"pid":1,"title":"A"},{"pid":2,"title":"B"}]')).toEqual(["A", "B"])
    expect(parseParked("[]")).toEqual([])
    expect(parseParked("")).toEqual([])
  })
})
