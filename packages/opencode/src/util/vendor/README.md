# Vendored `mupdf-wasm.wasm`

Copied verbatim from `mupdf@1.28.1`, `dist/mupdf-wasm.wasm`.

## Why a copy exists

The sidecar ships as a Bun single-file executable. mupdf resolves its WASM at runtime with
`new URL("mupdf-wasm.wasm", import.meta.url)` and reads it from disk, which inside a compiled
binary resolves to `B:/~BUN/root/mupdf-wasm.wasm` -- a path that does not exist. The packaged app
then fails at the first PDF with `ENOENT`, while dev, tests and typecheck all pass.

Importing the bytes with `with { type: "file" }` embeds them in the executable. It has to be this
copy rather than `mupdf/dist/mupdf-wasm.wasm`, because the package's `exports` map exposes only
`"."` and the bundler refuses the subpath.

## Keeping it honest

`test/pdf-raster.test.ts` compares this file against the installed package's copy and fails if they
differ, so bumping `mupdf` without refreshing this file is caught by the test run rather than by a
user opening a scan. To refresh:

    cp node_modules/.bun/mupdf@<version>/node_modules/mupdf/dist/mupdf-wasm.wasm \
       packages/opencode/src/util/vendor/mupdf-wasm.wasm
