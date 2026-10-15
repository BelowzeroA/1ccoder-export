import { glob, globSync, type GlobOptions } from "glob"
import { minimatch } from "minimatch"

export namespace Glob {
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
  }

  /**
   * node-glob takes its `cwd` as a glob-flavoured path, so a Windows path with
   * backslashes silently matches nothing -- no error, no warning, an empty
   * array. Every caller that builds a root with `path.join` therefore has to
   * remember to convert it, and one that forgets loses a whole scan: that is
   * how the bundled skills directory stopped being discovered on Windows.
   *
   * Converted here rather than at each call site, and only on Windows, because
   * a backslash is a legal character in a POSIX filename and rewriting it there
   * would break a directory that legitimately contains one.
   */
  function toGlobCwd(cwd: string | undefined): string | undefined {
    if (!cwd || process.platform !== "win32") return cwd
    return cwd.replace(/\\/g, "/")
  }

  function toGlobOptions(options: Options): GlobOptions {
    return {
      cwd: toGlobCwd(options.cwd),
      absolute: options.absolute,
      dot: options.dot,
      follow: options.symlink ?? false,
      nodir: options.include !== "all",
    }
  }

  export async function scan(pattern: string, options: Options = {}): Promise<string[]> {
    return glob(pattern, toGlobOptions(options)) as Promise<string[]>
  }

  export function scanSync(pattern: string, options: Options = {}): string[] {
    return globSync(pattern, toGlobOptions(options)) as string[]
  }

  export function match(pattern: string, filepath: string): boolean {
    return minimatch(filepath, pattern, { dot: true })
  }
}
