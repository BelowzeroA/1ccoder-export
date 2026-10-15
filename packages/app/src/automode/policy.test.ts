import { describe, expect, it } from "bun:test"

import { alwaysAskReason, commandSegments, isAlwaysAsk, tokenize } from "./policy"

const bash = (command: string) => alwaysAskReason({ permission: "bash", patterns: [command] })

describe("commandSegments", () => {
  it("splits on every command separator", () => {
    expect(commandSegments("git status && npm test")).toEqual(["git status", "npm test"])
    expect(commandSegments("a; b | c || d & e")).toEqual(["a", "b", "c", "d", "e"])
    expect(commandSegments("a\nb\r\nc")).toEqual(["a", "b", "c"])
  })

  it("does not split on separators inside quotes", () => {
    expect(commandSegments(`echo "a && b"`)).toEqual([`echo "a && b"`])
    expect(commandSegments(`grep ';' file`)).toEqual([`grep ';' file`])
  })

  it("joins a backslash line continuation into one command", () => {
    expect(commandSegments("rm \\\n-rf build")).toEqual(["rm -rf build"])
  })
})

describe("tokenize", () => {
  it("keeps quoted arguments whole and drops the quotes", () => {
    expect(tokenize(`git commit -m "two words"`)).toEqual(["git", "commit", "-m", "two words"])
  })

  it("preserves an empty quoted argument", () => {
    expect(tokenize(`test -z ""`)).toEqual(["test", "-z", ""])
  })
})

describe("destructive shell commands", () => {
  it("stops for recursive and forced deletes", () => {
    expect(bash("rm -rf build")).toBe("destructive_shell")
    expect(bash("rm -r node_modules")).toBe("destructive_shell")
    expect(bash("rm -f package-lock.json")).toBe("destructive_shell")
    expect(bash("rm --recursive dist")).toBe("destructive_shell")
    expect(bash("/bin/rm -rf /tmp/x")).toBe("destructive_shell")
  })

  it("lets an ordinary single-file delete through", () => {
    expect(bash("rm obsolete.ts")).toBeUndefined()
    expect(bash("rm -v note.txt")).toBeUndefined()
  })

  it("stops for the Windows and PowerShell equivalents", () => {
    expect(bash("Remove-Item -Recurse -Force .\\build")).toBe("destructive_shell")
    expect(bash("rmdir /s /q build")).toBe("destructive_shell")
    expect(bash("del /s *.tmp")).toBe("destructive_shell")
    expect(bash("del *.log")).toBe("destructive_shell")
    expect(bash("C:\\Windows\\System32\\format.exe D:")).toBe("destructive_shell")
  })

  it("stops for disk-level and machine-level operations", () => {
    expect(bash("mkfs.ext4 /dev/sdb1")).toBe("destructive_shell")
    expect(bash("dd if=/dev/zero of=/dev/sdb")).toBe("destructive_shell")
    expect(bash("diskpart")).toBe("destructive_shell")
    expect(bash("shutdown /r /t 0")).toBe("destructive_shell")
  })

  it("classifies git clean as a mass delete rather than a history rewrite", () => {
    expect(bash("git clean -fdx")).toBe("destructive_shell")
    expect(bash("git clean -n")).toBeUndefined()
  })

  it("sees past sudo, env assignments and a wrapping shell", () => {
    expect(bash("sudo rm -rf /var/tmp/cache")).toBe("destructive_shell")
    expect(bash("FOO=1 rm -rf build")).toBe("destructive_shell")
    expect(bash(`bash -c "rm -rf build"`)).toBe("destructive_shell")
    expect(bash(`powershell -Command "Remove-Item -Recurse C:\\tmp"`)).toBe("destructive_shell")
  })

  it("classifies a compound command on its dangerous half", () => {
    expect(bash("npm run build && rm -rf dist")).toBe("destructive_shell")
    expect(bash("cd app; git push")).toBe("git_history")
  })

  it("does not classify a delete that only appears inside a quoted string", () => {
    expect(bash(`echo "rm -rf build"`)).toBeUndefined()
    expect(bash(`grep -n "git push" README.md`)).toBeUndefined()
  })
})

describe("git operations that reach other people", () => {
  it("stops for every push", () => {
    expect(bash("git push")).toBe("git_history")
    expect(bash("git push --force")).toBe("git_history")
    expect(bash("git push --force-with-lease origin main")).toBe("git_history")
    expect(bash("git -C ../other push")).toBe("git_history")
  })

  it("stops for history rewrites", () => {
    expect(bash("git reset --hard HEAD~3")).toBe("git_history")
    expect(bash("git rebase main")).toBe("git_history")
    expect(bash("git filter-branch --tree-filter true HEAD")).toBe("git_history")
  })

  it("lets ordinary git work through", () => {
    expect(bash("git status")).toBeUndefined()
    expect(bash("git add -A")).toBeUndefined()
    expect(bash("git commit -m 'wip'")).toBeUndefined()
    expect(bash("git reset --soft HEAD~1")).toBeUndefined()
    expect(bash("git fetch origin")).toBeUndefined()
    expect(bash("git log --oneline")).toBeUndefined()
  })
})

describe("infobase writes", () => {
  it("stops for any non-read infobase action", () => {
    expect(alwaysAskReason({ permission: "infobase_write" })).toBe("infobase_write")
    expect(alwaysAskReason({ permission: "infobase_delete" })).toBe("infobase_write")
    // Fails safe: an operation Phase 7 has not defined yet still asks.
    expect(alwaysAskReason({ permission: "infobase_unknown_future_op" })).toBe("infobase_write")
  })

  it("lets infobase reads through", () => {
    expect(alwaysAskReason({ permission: "infobase_read" })).toBeUndefined()
    expect(alwaysAskReason({ permission: "infobase_list" })).toBeUndefined()
  })
})

describe("everything else runs unprompted", () => {
  it("allows the routine agentic tools, including the directory prompt", () => {
    for (const action of ["read", "edit", "glob", "grep", "list", "task", "external_directory", "webfetch", "skill"]) {
      expect(isAlwaysAsk({ permission: action, patterns: ["/anywhere"] })).toBe(false)
    }
  })

  it("treats a request with no action as answerable, so mode queries are unaffected", () => {
    expect(isAlwaysAsk({})).toBe(false)
  })

  it("allows ordinary build and test commands", () => {
    for (const command of ["bun test", "npm run build", "ls -la", "cat file.ts", "mkdir -p dist", "cp a b"]) {
      expect(bash(command)).toBeUndefined()
    }
  })
})
