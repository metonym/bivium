import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { version } from "../package.json" with { type: "json" };
import type { Barrel } from "./barrel.ts";
import type { Extraction, Format } from "./scan.ts";
import type { ImportRef } from "./syntax.ts";

// Extractions (a file's raw specifiers and annotations, before resolution)
// by git blob OID and format. A blob's extraction never changes, so a file
// the index says is unchanged needs no read. Resolution isn't cached: it
// depends on which other files exist.
//
// One JSON file: `[header, strings, rows]`. Every string is an index into
// `strings` (specifiers repeat across files), and a row is decoded only when
// a file asks for it. A file that doesn't parse, or whose header doesn't
// match this bivium, is ignored, never fatal.

// Bump on any change to what `extract` returns for some input (lexer,
// host formats, regex fallback, barrel parsing). `tests/cache.test.ts` fails
// until it's bumped.
export const SCANNER_VERSION = 1;
const MAGIC = "bivium-extractions";
const FILE = "extractions.json";

interface Header {
  magic: string;
  bivium: string;
  scanner: number;
  rows: number;
  strings: number;
}

function isHeader(value: unknown): value is Header {
  return (
    typeof value === "object" &&
    value !== null &&
    "magic" in value &&
    value.magic === MAGIC &&
    "bivium" in value &&
    value.bivium === version &&
    "scanner" in value &&
    value.scanner === SCANNER_VERSION &&
    "rows" in value &&
    typeof value.rows === "number" &&
    "strings" in value &&
    typeof value.strings === "number"
  );
}
// `[key, imports, globs, gotos, dependsOn, reads, unknown, fallback, barrel]`.
type Row = unknown[];

export type CacheOption = boolean | string | undefined;

// Where the cache lives: `cache` when it's a path (relative to `root`),
// else `node_modules/.cache/bivium`, else `.bivium/cache`. `false`: nowhere.
export function cacheDir(root: string, cache: CacheOption): string | undefined {
  if (cache === false) return undefined;
  if (typeof cache === "string") {
    return isAbsolute(cache) ? cache : join(root, cache);
  }
  const modules = join(root, "node_modules");
  return existsSync(modules)
    ? join(modules, ".cache", "bivium")
    : join(root, ".bivium", "cache");
}

export class ExtractionCache {
  // Undecoded rows by key.
  #rows = new Map<string, Row>();
  #strings: unknown[] = [];
  // Entries this run read or wrote, in order.
  #used = new Map<string, Extraction>();
  #dirty = false;
  readonly dir: string | undefined;

  constructor(dir?: string) {
    this.dir = dir;
  }

  // Loads the cache in `dir`; a missing or unreadable one is empty.
  static async open(dir: string | undefined): Promise<ExtractionCache> {
    const cache = new ExtractionCache(dir);
    if (!dir) return cache;
    const text = await readFile(join(dir, FILE), "utf-8").catch(() => "");
    if (text) cache.#load(text);
    return cache;
  }

  #load(text: string) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return;
      const [header, strings, rows]: unknown[] = parsed;
      if (
        !isHeader(header) ||
        !Array.isArray(strings) ||
        !Array.isArray(rows) ||
        header.strings !== strings.length ||
        header.rows !== rows.length
      ) {
        return;
      }
      this.#strings = strings;
      for (const row of rows) {
        if (Array.isArray(row) && typeof row[0] === "string") {
          this.#rows.set(row[0], row);
        }
      }
    } catch {
      // Corrupt: start empty, and the next save replaces it.
    }
  }

  get size(): number {
    return this.#rows.size;
  }

  get(oid: string, format: Format): Extraction | undefined {
    const key = `${format}:${oid}`;
    const used = this.#used.get(key);
    if (used) return used;
    const row = this.#rows.get(key);
    if (!row) return undefined;
    let extraction: Extraction;
    try {
      extraction = decode(row, this.#strings);
    } catch {
      this.#rows.delete(key);
      return undefined;
    }
    this.#used.set(key, extraction);
    return extraction;
  }

  set(oid: string, format: Format, extraction: Extraction): void {
    const key = `${format}:${oid}`;
    this.#used.set(key, extraction);
    this.#dirty = true;
  }

  // Writes the cache if this run added entries: every entry it used, then
  // unused ones (most recently saved first) up to half as many again, so a
  // branch switch still hits but the file stays bounded. Written to a temp
  // file and renamed, so a crash leaves the old cache or the new one.
  // Errors are swallowed: the cache only saves time.
  async save(): Promise<void> {
    if (!this.dir || !this.#dirty) return;
    const table = new Strings();
    const rows: Row[] = [];
    for (const [key, extraction] of this.#used) {
      rows.push(encode(key, extraction, table));
    }
    let stale = Math.floor(this.#used.size / 2);
    for (const [key, row] of this.#rows) {
      if (stale === 0) break;
      if (this.#used.has(key)) continue;
      try {
        rows.push(encode(key, decode(row, this.#strings), table));
        stale--;
      } catch {
        // A corrupt row is dropped.
      }
    }
    const header: Header = {
      magic: MAGIC,
      bivium: version,
      scanner: SCANNER_VERSION,
      rows: rows.length,
      strings: table.list.length,
    };
    const file = join(this.dir, FILE);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      // Inside a repo, the cache must not show up as an untracked change.
      const ignore = join(this.dir, ".gitignore");
      if (!existsSync(ignore)) await writeFile(ignore, "*\n");
      await writeFile(temp, JSON.stringify([header, table.list, rows]));
      await rename(temp, file);
      this.#dirty = false;
    } catch {
      await unlink(temp).catch(() => undefined);
    }
  }
}

class Strings {
  list: string[] = [];
  #ids = new Map<string, number>();
  id(value: string): number {
    let id = this.#ids.get(value);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(value);
      this.#ids.set(value, id);
    }
    return id;
  }
  ids(values: string[]): number[] | 0 {
    return values.length === 0 ? 0 : values.map((value) => this.id(value));
  }
}

function encode(key: string, e: Extraction, table: Strings): Row {
  const imports = e.imports.map(({ specifier, names }) =>
    names
      ? [table.id(specifier), ...names.map((n) => table.id(n))]
      : table.id(specifier),
  );
  const barrel = e.barrel && [
    [...e.barrel.names].flatMap(([name, from]) => [
      table.id(name),
      table.id(from),
    ]),
    table.ids(e.barrel.stars),
  ];
  return [
    key,
    imports.length === 0 ? 0 : imports,
    table.ids(e.globs),
    table.ids(e.gotos),
    table.ids(e.dependsOn),
    table.ids(e.reads),
    table.ids(e.unknown),
    e.fallback === undefined ? 0 : table.id(e.fallback),
    barrel ?? 0,
  ];
}

// Throws on anything that isn't a row `encode` wrote.
function decode(row: Row, strings: unknown[]): Extraction {
  const str = (id: unknown): string => {
    const value = typeof id === "number" ? strings[id] : undefined;
    if (typeof value !== "string") throw new Error("bad string id");
    return value;
  };
  const list = (ids: unknown): string[] => {
    if (ids === 0) return [];
    if (!Array.isArray(ids)) throw new Error("bad list");
    return ids.map(str);
  };
  const refs = row[1] === 0 ? [] : row[1];
  if (!Array.isArray(refs)) throw new Error("bad imports");
  const imports = refs.map(
    (item): ImportRef =>
      Array.isArray(item)
        ? { specifier: str(item[0]), names: item.slice(1).map(str) }
        : { specifier: str(item) },
  );
  const extraction: Extraction = {
    imports,
    globs: list(row[2]),
    gotos: list(row[3]),
    dependsOn: list(row[4]),
    reads: list(row[5]),
    unknown: list(row[6]),
  };
  if (row[7] !== 0) extraction.fallback = str(row[7]);
  if (row[8] !== 0) {
    if (!Array.isArray(row[8])) throw new Error("bad barrel");
    const [pairs, stars]: unknown[] = row[8];
    if (!Array.isArray(pairs)) throw new Error("bad barrel names");
    const names = new Map<string, string>();
    for (let i = 0; i < pairs.length; i += 2) {
      names.set(str(pairs[i]), str(pairs[i + 1]));
    }
    extraction.barrel = { names, stars: list(stars) } satisfies Barrel;
  }
  return extraction;
}
