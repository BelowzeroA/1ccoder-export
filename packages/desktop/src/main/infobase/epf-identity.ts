// Is the built .epf the one that was meant to be built?
//
// 2026-09-25, failures_to_tools.md T1 (debrief7.md §8.4, D14). A processing was
// reported finished whose file was byte-identical to the template it had been
// copied from: the loader had written the real build somewhere else, and every
// check that followed exercised the template. The compile check passed (the
// template compiles), the logic check ran an inline copy of the code, and the
// one contradicting value -- the template's own name coming back from the
// platform -- was explained away as a cache effect.
//
// A build that did not change the file has not happened. That is decidable
// offline, from the bytes and from the object module's text, before the
// platform is asked anything.

import { createHash } from "node:crypto"

import { extractModuleText, readContainer } from "../v8pack/container"

export interface EpfFingerprint {
  readonly md5: string
  readonly size: number
  /** The object module's text, when the container has one v8pack can read. */
  readonly module?: string
}

export function fingerprint(bytes: Buffer): EpfFingerprint {
  const md5 = createHash("md5").update(bytes).digest("hex")
  const module = (() => {
    try {
      return readContainer(bytes)
        .map((entry) => extractModuleText(entry.content))
        .find((text): text is Buffer => text !== null)
        ?.toString("utf8")
    } catch {
      return undefined
    }
  })()
  return { md5, size: bytes.length, ...(module !== undefined ? { module } : {}) }
}

export interface IdentityVerdict {
  /** A reference the build is indistinguishable from, or undefined. */
  readonly sameAs?: string
  /** How: every byte, or only the object module. */
  readonly how?: "bytes" | "module"
}

/**
 * Compares a build against references it must NOT equal: the bundled
 * templates, and the file the caller says it started from.
 */
export function compareIdentity(
  build: EpfFingerprint,
  references: readonly { readonly label: string; readonly fingerprint: EpfFingerprint }[],
): IdentityVerdict {
  const bytes = references.find((reference) => reference.fingerprint.md5 === build.md5)
  if (bytes) return { sameAs: bytes.label, how: "bytes" }
  if (build.module === undefined) return {}
  const module = references.find((reference) => reference.fingerprint.module === build.module)
  return module ? { sameAs: module.label, how: "module" } : {}
}

export function describeIdentity(path: string, build: EpfFingerprint, verdict: IdentityVerdict): string {
  const head = `Файл: ${path} — ${build.size} байт, md5 ${build.md5}`
  if (!verdict.sameAs) return `${head}\nОтличается от шаблонов и от исходного файла.`
  return [
    head,
    "",
    verdict.how === "bytes"
      ? `СБОРКИ НЕ БЫЛО: файл побайтно совпадает с «${verdict.sameAs}».`
      : `СБОРКИ НЕ БЫЛО: модуль объекта совпадает с модулем «${verdict.sameAs}» дословно.`,
    "Загрузчик записал результат не в этот файл, либо сборка не запускалась. Проверь путь `epfPath`",
    "у 1c_load_epf_from_files и поищи рядом файл с неожиданным именем (например с добавленным `.epf`).",
    "Проверять компиляцию этого файла бессмысленно — это шаблон.",
  ].join("\n")
}
