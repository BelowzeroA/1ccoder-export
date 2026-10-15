// src/main/v8pack/cli.ts
import { readFile as readFile2 } from "node:fs/promises";

// src/main/v8pack/container.ts
import { deflateRawSync, inflateRawSync } from "node:zlib";
var V8_MAGIC = 2147483647;
var DEFAULT_PAGE_SIZE = 512;
var BOM_UTF8 = Buffer.from([239, 187, 191]);
function deflate(data) {
  return deflateRawSync(data);
}
function inflate(data) {
  return inflateRawSync(data);
}
function blockHeader(dataSize, storedSize) {
  const hex = (value) => value.toString(16).padStart(8, "0");
  return Buffer.from(`\r
${hex(dataSize)} ${hex(storedSize)} 7fffffff \r
`, "ascii");
}
function attributeBlock(name, created = 0n, modified = created) {
  const stamps = Buffer.alloc(16);
  stamps.writeBigUInt64LE(created, 0);
  stamps.writeBigUInt64LE(modified, 8);
  return Buffer.concat([stamps, Buffer.alloc(4), Buffer.from(name, "utf16le"), Buffer.alloc(4)]);
}
function storedSize(length, pageSize) {
  return length >= pageSize ? length : pageSize;
}
var NO_NEXT = 2147483647;
var HEADER_LENGTH = 31;
function parseChunkHeader(data, at) {
  if (at + HEADER_LENGTH > data.length)
    return null;
  if (data[at] !== 13 || data[at + 1] !== 10)
    return null;
  const crlf = data.indexOf(`\r
`, at + 2, "ascii");
  if (crlf === -1)
    return null;
  const parts = data.toString("ascii", at + 2, crlf).trim().split(/\s+/);
  const dataSize = Number.parseInt(parts[0] ?? "", 16);
  const storedSize2 = Number.parseInt(parts[1] ?? "", 16);
  const next = Number.parseInt(parts[2] ?? "", 16);
  if (!Number.isFinite(dataSize) || !Number.isFinite(storedSize2) || !Number.isFinite(next))
    return null;
  return { dataSize, storedSize: storedSize2, next, dataOffset: crlf + 2 };
}
function readBlock(data, at) {
  const first = parseChunkHeader(data, at);
  if (!first)
    return null;
  const total = first.dataSize;
  const chunks = [];
  const continuations = [];
  let gathered = 0;
  let chunk = first;
  const visited = new Set;
  while (chunk && gathered < total) {
    const take = Math.min(chunk.storedSize, total - gathered);
    chunks.push(data.subarray(chunk.dataOffset, chunk.dataOffset + take));
    gathered += take;
    if (gathered >= total || chunk.next === NO_NEXT)
      break;
    if (visited.has(chunk.next))
      break;
    visited.add(chunk.next);
    continuations.push(chunk.next);
    chunk = parseChunkHeader(data, chunk.next);
  }
  return {
    block: { headerStart: at, data: Buffer.concat(chunks) },
    nextScanPos: first.dataOffset + first.storedSize,
    continuations
  };
}
function scanBlocks(data) {
  const blocks = [];
  const continuationOffsets = new Set;
  let pos = 16;
  while (pos < data.length) {
    const read = readBlock(data, pos);
    if (!read)
      break;
    for (const offset of read.continuations)
      continuationOffsets.add(offset);
    if (!continuationOffsets.has(read.block.headerStart))
      blocks.push(read.block);
    if (read.nextScanPos <= pos)
      break;
    pos = read.nextScanPos;
  }
  return blocks;
}
function readName(attr) {
  return attr.subarray(20).toString("utf16le").replace(/\0+$/, "");
}

class NotAContainerError extends Error {
  constructor() {
    super("Not a v8 container");
    this.name = "NotAContainerError";
  }
}
function assertContainer(data) {
  if (data.length < 16 || data.readUInt32LE(0) !== V8_MAGIC)
    throw new NotAContainerError;
}
function readContainerRaw(data) {
  assertContainer(data);
  const pageSize = data.readUInt32LE(4);
  const blocks = scanBlocks(data);
  if (blocks.length === 0)
    throw new NotAContainerError;
  const entries = [];
  const attrStartToIndex = new Map;
  for (let i = 1;i + 1 < blocks.length; i += 2) {
    const attrBlock = blocks[i];
    const stored = blocks[i + 1].data;
    let content;
    let isDeflated;
    try {
      content = inflate(stored);
      isDeflated = true;
    } catch {
      content = stored;
      isDeflated = false;
    }
    attrStartToIndex.set(attrBlock.headerStart, entries.length);
    entries.push({
      name: readName(attrBlock.data),
      created: attrBlock.data.length >= 8 ? attrBlock.data.readBigUInt64LE(0) : 0n,
      modified: attrBlock.data.length >= 16 ? attrBlock.data.readBigUInt64LE(8) : 0n,
      attr: attrBlock.data,
      deflate: isDeflated,
      stored,
      content
    });
  }
  const toc = blocks[0].data;
  const tocOrder = [];
  for (let i = 0;i + 12 <= toc.length; i += 12) {
    const index = attrStartToIndex.get(toc.readUInt32LE(i));
    if (index !== undefined)
      tocOrder.push(index);
  }
  return { pageSize, entries, tocOrder };
}
function assembleContainerRaw(pageSize, entries, tocOrder) {
  const count = entries.length;
  const attrs = entries.map((entry) => entry.attr);
  const tocDataSize = count * 12;
  const tocStoredSize = Math.max(tocDataSize, pageSize);
  const tocHeader = blockHeader(tocDataSize, tocStoredSize);
  const spans = [];
  let pos = 16 + tocHeader.length + tocStoredSize;
  for (let i = 0;i < count; i++) {
    const attrLength = attrs[i].length;
    const attrHeader = blockHeader(attrLength, attrLength);
    const payloadLength = entries[i].payload.length;
    const contentHeader = blockHeader(payloadLength, storedSize(payloadLength, pageSize));
    spans.push([pos, pos + attrHeader.length + attrLength]);
    pos += attrHeader.length + attrLength + contentHeader.length + storedSize(payloadLength, pageSize);
  }
  const parts = [];
  const header = Buffer.alloc(16);
  header.writeUInt32LE(V8_MAGIC, 0);
  header.writeUInt32LE(pageSize, 4);
  header.writeUInt32LE(count, 8);
  header.writeUInt32LE(0, 12);
  parts.push(header, tocHeader);
  const toc = Buffer.alloc(tocStoredSize);
  let offset = 0;
  for (const index of tocOrder) {
    const span = spans[index];
    if (!span)
      continue;
    toc.writeUInt32LE(span[0], offset);
    toc.writeUInt32LE(span[1], offset + 4);
    toc.writeUInt32LE(V8_MAGIC, offset + 8);
    offset += 12;
  }
  parts.push(toc);
  for (let i = 0;i < count; i++) {
    const attr = attrs[i];
    parts.push(blockHeader(attr.length, attr.length), attr);
    const payload = entries[i].payload;
    const padded = storedSize(payload.length, pageSize);
    parts.push(blockHeader(payload.length, padded), payload);
    if (padded > payload.length)
      parts.push(Buffer.alloc(padded - payload.length));
  }
  return Buffer.concat(parts);
}
function readContainer(data) {
  return readContainerRaw(data).entries.map((entry) => ({ name: entry.name, content: entry.content }));
}
function writeContainer(files, options = {}) {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const compress = options.compress ?? true;
  const timestamp = options.timestamp ?? 0n;
  const entries = files.map((file) => ({
    attr: attributeBlock(file.name, timestamp),
    payload: compress ? deflate(file.content) : file.content
  }));
  return assembleContainerRaw(pageSize, entries, entries.map((_, index) => index));
}
function makeModuleContainer(bsl) {
  const info = Buffer.concat([BOM_UTF8, Buffer.from('{3,1,0,"",0}', "ascii")]);
  const text = bsl.subarray(0, 3).equals(BOM_UTF8) ? bsl : Buffer.concat([BOM_UTF8, bsl]);
  return writeContainer([
    { name: "info", content: info },
    { name: "text", content: text }
  ], { compress: false });
}
function extractModuleText(data) {
  try {
    const text = readContainer(data).find((entry) => entry.name === "text");
    return text ? text.content : null;
  } catch {
    return null;
  }
}

// src/main/v8pack/tree.ts
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// src/main/infobase/form-bindings.ts
var KNOWN_EVENTS = {
  ПриСозданииНаСервере: { event: "OnCreateAtServer", directive: "&НаСервере", parameters: 2 },
  ПриЧтенииНаСервере: { event: "OnReadAtServer", directive: "&НаСервере", parameters: 1 },
  ПослеЗаписиНаСервере: { event: "AfterWriteAtServer", directive: "&НаСервере", parameters: 2 },
  ПриОткрытии: { event: "OnOpen", directive: "&НаКлиенте", parameters: 1 },
  ПередЗакрытием: { event: "BeforeClose", directive: "&НаКлиенте", parameters: 4 },
  ПриЗакрытии: { event: "OnClose", directive: "&НаКлиенте", parameters: 1 },
  ОбработкаОповещения: { event: "NotificationProcessing", directive: "&НаКлиенте", parameters: 3 },
  ПослеЗаписи: { event: "AfterWrite", directive: "&НаКлиенте", parameters: 1 }
};
function parseModuleProcedures(bsl) {
  const found = [];
  let pending = null;
  bsl.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^﻿/, "").trim();
    if (line.startsWith("&")) {
      pending = line.split("(")[0].trim();
      return;
    }
    const declaration = /^(Процедура|Функция|Procedure|Function)\s+([0-9A-Za-zА-Яа-яЁё_]+)\s*\(([^)]*)\)/i.exec(line);
    if (!declaration)
      return;
    found.push({
      name: declaration[2],
      directive: pending,
      line: index + 1,
      isProcedure: /^(?:Процедура|Procedure)$/i.test(declaration[1]),
      parameters: declaration[3].split(",").filter((part) => part.trim().length > 0).length
    });
    pending = null;
  });
  return found;
}

// src/main/v8pack/form-module.ts
var BOM = "\uFEFF";
function* quotedStrings(text) {
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      index++;
      continue;
    }
    const start = index;
    let value = "";
    let cursor = index + 1;
    for (;; ) {
      const quote = text.indexOf('"', cursor);
      if (quote === -1)
        return;
      value += text.slice(cursor, quote);
      if (text[quote + 1] === '"') {
        value += '"';
        cursor = quote + 2;
        continue;
      }
      cursor = quote + 1;
      break;
    }
    yield { start, end: cursor, text: value };
    index = cursor;
  }
}
var OPENER = /^\s*(?:&[А-Яа-яA-Za-z]+|Перем\s|Процедура\s|Функция\s|\/\/|#Если|#Область)/u;
var BODY = /(?:^|\n)\s*(?:Процедура\s|Функция\s|&[А-Яа-яA-Za-z]+)/u;
var MIN_LENGTH = 40;
function looksLikeModule(text) {
  return text.length >= MIN_LENGTH && OPENER.test(text) && BODY.test(text);
}
function findFormModule(content) {
  let text;
  try {
    text = content.toString("utf8");
  } catch {
    return null;
  }
  if (!Buffer.from(text, "utf8").equals(content))
    return null;
  let best = null;
  for (const span of quotedStrings(text)) {
    if (!looksLikeModule(span.text))
      continue;
    if (!best || span.text.length > best.text.length)
      best = span;
  }
  return best;
}
function replaceFormModule(content, bsl) {
  const span = findFormModule(content);
  if (!span)
    return null;
  const text = content.toString("utf8");
  const next = bsl.toString("utf8").replace(BOM, "");
  const escaped = next.replace(/"/g, '""');
  return Buffer.from(`${text.slice(0, span.start)}"${escaped}"${text.slice(span.end)}`, "utf8");
}
var EVENT_ENTRY = (name) => new RegExp(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12},"${name}"`, "i");
function unboundEventHandlers(description, bsl) {
  const text = description.toString("utf8");
  return parseModuleProcedures(bsl.toString("utf8")).filter((procedure) => procedure.isProcedure && Object.hasOwn(KNOWN_EVENTS, procedure.name)).map((procedure) => procedure.name).filter((name) => !EVENT_ENTRY(name).test(text));
}

// src/main/v8pack/tree.ts
var MANIFEST_NAME = ".v8pack.json";
var MANIFEST_VERSION = 2;
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
function safeFileName(name, index) {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
  return cleaned.length > 0 ? `${String(index).padStart(3, "0")}_${cleaned}` : `${String(index).padStart(3, "0")}`;
}
async function unpackContainer(containerPath, outDir) {
  const raw = readContainerRaw(await readFile(containerPath));
  await mkdir(join(outDir, "raw"), { recursive: true });
  await mkdir(join(outDir, "files"), { recursive: true });
  await mkdir(join(outDir, "modules"), { recursive: true });
  const entries = [];
  for (const [index, entry] of raw.entries.entries()) {
    const base = safeFileName(entry.name, index);
    await writeFile(join(outDir, "raw", `${String(index).padStart(3, "0")}.bin`), entry.stored);
    await writeFile(join(outDir, "raw", `${String(index).padStart(3, "0")}.attr`), entry.attr);
    const moduleText = extractModuleText(entry.content);
    if (moduleText) {
      const file2 = join("modules", `${base}.bsl`);
      await mkdir(dirname(join(outDir, file2)), { recursive: true });
      await writeFile(join(outDir, file2), moduleText);
      entries.push({
        index,
        name: entry.name,
        file: file2.replace(/\\/g, "/"),
        kind: "module",
        deflate: entry.deflate,
        hash: sha256(moduleText)
      });
      continue;
    }
    const substrate = join("files", base);
    await mkdir(dirname(join(outDir, substrate)), { recursive: true });
    await writeFile(join(outDir, substrate), entry.content);
    const form = findFormModule(entry.content);
    if (!form) {
      entries.push({
        index,
        name: entry.name,
        file: substrate.replace(/\\/g, "/"),
        kind: "raw",
        deflate: entry.deflate,
        hash: sha256(entry.content)
      });
      continue;
    }
    const file = join("modules", `${base}.form.bsl`);
    const bsl = Buffer.from(form.text, "utf8");
    await mkdir(dirname(join(outDir, file)), { recursive: true });
    await writeFile(join(outDir, file), bsl);
    entries.push({
      index,
      name: entry.name,
      file: file.replace(/\\/g, "/"),
      kind: "form",
      substrate: substrate.replace(/\\/g, "/"),
      substrateHash: sha256(entry.content),
      deflate: entry.deflate,
      hash: sha256(bsl)
    });
  }
  const manifest = {
    version: MANIFEST_VERSION,
    pageSize: raw.pageSize,
    tocOrder: [...raw.tocOrder],
    entries
  };
  await writeFile(join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}
`, "utf8");
  return manifest;
}

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}
function rebuild(entry, editable, substrate) {
  let content;
  if (entry.kind === "module") {
    content = makeModuleContainer(editable);
  } else if (entry.kind === "form") {
    if (!substrate)
      throw new ManifestError(`Entry ${entry.name} is a form module with no ${entry.substrate}`);
    const spliced = replaceFormModule(substrate, editable);
    if (!spliced) {
      throw new ManifestError(`Cannot put the module back into ${entry.name}: no module found in ${entry.substrate}. ` + `Undo the edits to that file, or unpack the container again.`);
    }
    content = spliced;
  } else {
    content = editable;
  }
  return entry.deflate ? deflate(content) : content;
}
async function packContainer(sourceDir, outPath) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(sourceDir, MANIFEST_NAME), "utf8"));
  } catch {
    throw new ManifestError(`No ${MANIFEST_NAME} in ${sourceDir}. Unpack the container first.`);
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new ManifestError(`Unsupported manifest version ${manifest.version}`);
  }
  const assembled = [];
  const rebuilt = [];
  const unbound = [];
  for (const entry of manifest.entries) {
    const stem = String(entry.index).padStart(3, "0");
    const attr = await readFile(join(sourceDir, "raw", `${stem}.attr`));
    const editable = await readFile(join(sourceDir, entry.file));
    const substrate = entry.substrate ? await readFile(join(sourceDir, entry.substrate)) : null;
    const untouched = sha256(editable) === entry.hash && (!substrate || sha256(substrate) === entry.substrateHash);
    if (untouched) {
      assembled.push({ attr, payload: await readFile(join(sourceDir, "raw", `${stem}.bin`)) });
      continue;
    }
    rebuilt.push(entry.name);
    assembled.push({ attr, payload: rebuild(entry, editable, substrate) });
    if (entry.kind === "form" && substrate) {
      const handlers = unboundEventHandlers(substrate, editable);
      if (handlers.length > 0)
        unbound.push({ entry: entry.name, handlers });
    }
  }
  const infoAt = manifest.entries.findIndex((entry) => entry.name === "configinfo");
  const info = infoAt >= 0 ? manifest.entries[infoAt] : undefined;
  if (info && rebuilt.length > 0 && info.kind === "raw") {
    const text = (await readFile(join(sourceDir, info.file))).toString("utf8");
    const stored = new Map(manifest.entries.map((entry, at) => [entry.name, assembled[at].payload]).filter(([name]) => rebuilt.includes(name)));
    const refreshed = refreshConfigInfo(text, stored);
    if (refreshed !== text) {
      assembled[infoAt] = { attr: assembled[infoAt].attr, payload: rebuild(info, Buffer.from(refreshed, "utf8"), null) };
      if (!rebuilt.includes(info.name))
        rebuilt.push(info.name);
    }
  }
  const bytes = assembleContainerRaw(manifest.pageSize, assembled, manifest.tocOrder);
  const parent = dirname(outPath);
  if (parent && parent !== "." && parent !== outPath)
    await mkdir(parent, { recursive: true }).catch(() => {
      return;
    });
  await writeFile(outPath, bytes);
  return { bytes: bytes.length, rebuilt, unbound };
}
function refreshConfigInfo(text, stored) {
  return [...stored].reduce((current, [name, payload]) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hash = createHash("sha1").update(payload).digest("base64");
    return current.replace(new RegExp(`("${escaped}",)[A-Za-z0-9+/]{27}=`), `$1${hash}`);
  }, text);
}
async function listEditable(sourceDir) {
  const out = [];
  for (const sub of ["modules", "files"]) {
    try {
      for (const name of await readdir(join(sourceDir, sub)))
        out.push(`${sub}/${name}`);
    } catch {}
  }
  return out.sort();
}

// src/main/v8pack/cli.ts
var USAGE = `v8pack — 1C:Enterprise container tool (1CCoder)

  unpack <container> <dir>   Unpack .epf/.erf/.cfe into an editable directory
  pack   <dir> <container>   Rebuild a container from an unpacked directory
  list   <dir>               List the editable files in an unpacked directory
  info   <container>         Show what a container holds, without unpacking

Edit the .bsl files under <dir>/modules, then pack. Entries you did not touch
are copied through byte for byte; only what changed is rebuilt.
`;
async function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "unpack": {
      if (args.length < 2)
        return usage();
      const manifest = await unpackContainer(args[0], args[1]);
      const objectModules = manifest.entries.filter((entry) => entry.kind === "module").length;
      const formModules = manifest.entries.filter((entry) => entry.kind === "form").length;
      const counted = [
        `${objectModules} object module(s)`,
        ...formModules > 0 ? [`${formModules} form module(s)`] : []
      ].join(", ");
      console.log(`Unpacked ${manifest.entries.length} entries (${counted}) into ${args[1]}`);
      console.log(`Edit files under ${args[1]}/modules, then: pack ${args[1]} <output>`);
      return 0;
    }
    case "pack": {
      if (args.length < 2)
        return usage();
      const result = await packContainer(args[0], args[1]);
      console.log(`Wrote ${args[1]} (${result.bytes} bytes)`);
      console.log(result.rebuilt.length === 0 ? "Nothing changed: the container is byte-identical to the original." : `Rebuilt ${result.rebuilt.length} entr${result.rebuilt.length === 1 ? "y" : "ies"}: ${result.rebuilt.join(", ")}`);
      for (const form of result.unbound) {
        console.log(`WARNING: ${form.entry}: ${form.handlers.join(", ")} — в модуле есть, но форма это событие не подключает. ` + "Платформа такой обработчик не вызовет: v8pack меняет только текст модуля. " + "Подключить событие можно XML-кругом (1c_dump_epf_to_files → 1c_load_epf_from_files, " + "подключение делается при сборке) или взяв заготовку, где оно уже подключено.");
      }
      return 0;
    }
    case "list": {
      if (args.length < 1)
        return usage();
      for (const file of await listEditable(args[0]))
        console.log(file);
      return 0;
    }
    case "info": {
      if (args.length < 1)
        return usage();
      const raw = readContainerRaw(await readFile2(args[0]));
      console.log(`page size ${raw.pageSize}, ${raw.entries.length} entries`);
      for (const entry of raw.entries) {
        const module = extractModuleText(entry.content) !== null;
        console.log(`  ${entry.name}  ${entry.content.length} B${entry.deflate ? " (deflated)" : ""}${module ? "  [module]" : ""}`);
      }
      return 0;
    }
    default:
      return usage();
  }
}
function usage() {
  console.log(USAGE);
  return 1;
}
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
