import { posix } from "node:path";
import { isRecord } from "./resolve.ts";
import { sorted } from "./sorted.ts";

// What the resolver uses of a `tsconfig.json`, with its relative `extends`
// applied: `paths` keys → targets, and `baseUrl`, both repo-relative.
export interface TsPaths {
  paths: Record<string, string[]>;
  baseUrl?: string;
}

// The directory of each `tsconfig.json` → its `TsPaths`. A file applies to
// the files under its directory that no deeper `tsconfig.json` claims.
export type TsConfigs = Map<string, TsPaths>;

interface Read {
  extends: string[];
  // Repo-relative, from the file that sets it.
  baseUrl?: string;
  // With the directory of the file that sets them, which targets are
  // relative to when no `baseUrl` is set.
  paths?: { map: Record<string, string[]>; dir: string };
}

type Parsed = { read: Read } | { error: string };

// tsconfig.json is JSON with comments and trailing commas. Strings are
// matched first, so a `//` or `,}` inside one is kept.
const COMMENT = /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const TRAILING_COMMA = /("(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/g;
const BOM = /^﻿/;
const RELATIVE = /^\.\.?(?:\/|$)/;

export function parseJsonc(text: string): unknown {
  return JSON.parse(
    text
      .replace(BOM, "")
      .replace(COMMENT, (_, string?: string) => string ?? " ")
      .replace(TRAILING_COMMA, (_, string?: string) => string ?? ""),
  );
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function parse(file: string, text: string): Parsed {
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!isRecord(value)) return { error: "not an object" };
  const dir = posix.dirname(file);
  const { extends: extended } = value;
  const read: Read = {
    extends: typeof extended === "string" ? [extended] : [],
  };
  if (isStrings(extended)) read.extends = extended;
  const options = value.compilerOptions;
  if (isRecord(options)) {
    if (typeof options.baseUrl === "string") {
      read.baseUrl = posix.join(dir, options.baseUrl);
    }
    if (isRecord(options.paths)) {
      const map: Record<string, string[]> = {};
      for (const [key, targets] of Object.entries(options.paths)) {
        if (isStrings(targets)) map[key] = targets;
      }
      read.paths = { map, dir };
    }
  }
  return { read };
}

// The repo-relative file a relative `extends` names, before TypeScript's
// `.json` fallback. A package, an absolute path or one outside the
// repository can't be read: `undefined`.
function extendsPath(file: string, target: string): string | undefined {
  if (!RELATIVE.test(target)) return undefined;
  const path = posix.join(posix.dirname(file), target);
  return path.startsWith("../") || path === ".." ? undefined : path;
}

interface ReadTsconfigs {
  tsconfigs: TsConfigs;
  // Files that don't parse, whose configs then have no `paths`.
  unparsed: { file: string; reason: string }[];
}

// Reads `files` (each a `tsconfig.json`) and the files their relative
// `extends` name, through `read`, which gives `undefined` for a file it
// can't read. An `extends` it can't read (a package in `node_modules`, a
// file git doesn't list) is skipped. A config any of whose files doesn't
// parse has no `paths`, so what they would map stays unresolved.
export async function readTsconfigs(
  files: string[],
  read: (file: string, extended: boolean) => Promise<string | undefined>,
): Promise<ReadTsconfigs> {
  // `undefined` for a file `read` couldn't read.
  const parsed = new Map<string, Parsed | undefined>();
  // A file is read once. Whoever started its read waits for it, so a
  // cycle of `extends` ends.
  const load = async (file: string, extended: boolean): Promise<void> => {
    if (parsed.has(file)) return;
    parsed.set(file, undefined);
    const text = await read(file, extended);
    if (text === undefined) {
      // TypeScript tries `<extends>.json` when `<extends>` is missing.
      if (!file.endsWith(".json")) await load(`${file}.json`, true);
      return;
    }
    const result = parse(file, text);
    parsed.set(file, result);
    if (!("read" in result)) return;
    await Promise.all(
      result.read.extends.map((target) => {
        const path = extendsPath(file, target);
        return path === undefined ? undefined : load(path, true);
      }),
    );
  };
  await Promise.all(files.map((file) => load(file, false)));

  const found = (path: string) => {
    const at = parsed.get(path);
    if (at !== undefined || path.endsWith(".json")) return at;
    return parsed.get(`${path}.json`);
  };
  // The options `file` ends up with, each from the nearest file that sets
  // it; `undefined` when a file in the chain doesn't parse, or extends
  // itself.
  const effective = (file: string, seen: Set<string>): Read | undefined => {
    const at = found(file);
    if (at === undefined) return { extends: [] };
    if (!("read" in at) || seen.has(file)) return undefined;
    const chain = new Set([...seen, file]);
    const merged: Read = { extends: [] };
    // A later `extends` entry overrides an earlier one; the file, all.
    for (const target of at.read.extends) {
      const path = extendsPath(file, target);
      if (path === undefined) continue;
      const base = effective(path, chain);
      if (base === undefined) return undefined;
      if (base.baseUrl !== undefined) merged.baseUrl = base.baseUrl;
      if (base.paths !== undefined) merged.paths = base.paths;
    }
    if (at.read.baseUrl !== undefined) merged.baseUrl = at.read.baseUrl;
    if (at.read.paths !== undefined) merged.paths = at.read.paths;
    return merged;
  };

  const tsconfigs: TsConfigs = new Map();
  for (const file of files) {
    if (parsed.get(file) === undefined) continue;
    const options = effective(file, new Set());
    const resolved: TsPaths = { paths: {} };
    if (options?.baseUrl !== undefined) resolved.baseUrl = options.baseUrl;
    const { paths } = options ?? {};
    if (paths) {
      const base = options?.baseUrl ?? paths.dir;
      for (const [key, targets] of Object.entries(paths.map)) {
        resolved.paths[key] = targets.map((target) => posix.join(base, target));
      }
    }
    tsconfigs.set(posix.dirname(file), resolved);
  }
  const unparsed: ReadTsconfigs["unparsed"] = [];
  for (const file of sorted(parsed.keys())) {
    const at = parsed.get(file);
    if (at && "error" in at) unparsed.push({ file, reason: at.error });
  }
  return { tsconfigs, unparsed };
}
