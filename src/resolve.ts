import { builtinModules } from "node:module";
import { posix } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { QUERY } from "./syntax.ts";

export interface PackageJson {
  name?: string;
  exports?: unknown;
  main?: string;
  sideEffects?: boolean | string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

// The fields the resolver reads, each kept only when it has the type the
// resolver expects: a malformed field reads as absent.
export function toPackageJson(value: unknown): PackageJson {
  if (!isRecord(value)) return {};
  const json: PackageJson = {};
  if (typeof value.name === "string") json.name = value.name;
  if (value.exports !== undefined) json.exports = value.exports;
  if (typeof value.main === "string") json.main = value.main;
  const { sideEffects } = value;
  if (
    typeof sideEffects === "boolean" ||
    (Array.isArray(sideEffects) &&
      sideEffects.every((glob) => typeof glob === "string"))
  ) {
    json.sideEffects = sideEffects;
  }
  for (const field of DEP_FIELDS) {
    const deps = value[field];
    if (isStringRecord(deps)) json[field] = deps;
  }
  return json;
}

// Package directory (`.` for the root) → its `package.json`.
export type Packages = Map<string, PackageJson>;

// Files a specifier can load (a union: every condition, every extension that
// exists), an external `pkg:<name>` node, or `undefined` when it can't be
// resolved at all.
type Resolution = { files: string[] } | { pkg: string } | undefined;

export type Resolver = (from: string, specifier: string) => Resolution;

const BUILTINS = new Set(builtinModules);
const RUNTIME_BUILTIN = /^(?:node:|bun(?:$|:))/;
const JS_EXTENSION = /\.([cm]?)js(x?)$/;
const NODE_PREFIX = /^node:/;
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// `pkg:` node name for a builtin, or `undefined` if it isn't one.
function builtin(specifier: string): string | undefined {
  if (RUNTIME_BUILTIN.test(specifier)) {
    const name = specifier.replace(NODE_PREFIX, "");
    return specifier.startsWith("bun")
      ? specifier
      : `node:${name.split("/")[0]}`;
  }
  const name = specifier.split("/")[0];
  return BUILTINS.has(specifier) || BUILTINS.has(name)
    ? `node:${name}`
    : undefined;
}

// Every string target in an `exports` value: the union of all conditions.
function targets(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) targets(item, out);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) targets(item, out);
  }
  return out;
}

// `exports` keyed by subpath: a bare target or a conditions object is `.`.
function subpathMap(exports: unknown): Record<string, unknown> | undefined {
  if (typeof exports === "string" || Array.isArray(exports)) {
    return { ".": exports };
  }
  if (!isRecord(exports)) return undefined;
  const bySubpath = Object.keys(exports).some((key) => key.startsWith("."));
  return bySubpath ? exports : { ".": exports };
}

// The targets `exports` maps `subpath` (`.` or `./x`) to, with Node's key
// matching: an exact key, else the `*` pattern with the longest prefix.
export function exportTargets(
  exports: unknown,
  subpath: string,
): string[] | undefined {
  const map = subpathMap(exports);
  if (!map) return undefined;
  if (subpath in map && !subpath.includes("*")) return targets(map[subpath]);
  let best: { key: string; match: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.length >= key.length - 1 &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (!best ||
        prefix.length > best.key.indexOf("*") ||
        (prefix.length === best.key.indexOf("*") &&
          key.length > best.key.length))
    ) {
      best = {
        key,
        match: subpath.slice(prefix.length, subpath.length - suffix.length),
      };
    }
  }
  if (!best) return undefined;
  const { match } = best;
  return targets(map[best.key]).map((target) => target.replaceAll("*", match));
}

// Package directories from the deepest, for owner lookups.
function byDepth(packages: Packages): [string, PackageJson][] {
  return [...packages].sort(([a], [b]) => b.length - a.length);
}

// The package that owns `file`: the nearest `package.json` above it.
export function owner(
  packages: Packages,
  file: string,
): [string, PackageJson] | undefined {
  return byDepth(packages).find(
    ([dir]) => dir === "." || file.startsWith(`${dir}/`),
  );
}

// `rest` is the specifier after an alias key and its `/`.
function aliased(target: string, rest: string): string {
  if (target === ".") return rest || ".";
  return rest ? `${target}/${rest}` : target;
}

export function createResolver({
  files,
  config,
  packages,
}: {
  // The repo-relative files in the graph.
  files: ReadonlySet<string>;
  config: ResolvedConfig;
  packages: Packages;
}): Resolver {
  const generated = (path: string) =>
    config.generated.some(({ pattern }) => pattern.test(path));
  const { extensions } = config;
  const exists = (path: string) => files.has(path);
  // `base` → the files `base + extension`, in extension order: a probe
  // looks its bases up instead of building every candidate name.
  const suffixed = new Map<string, [number, string][]>();
  for (const file of files) {
    for (let i = 0; i < extensions.length; i++) {
      const ext = extensions[i];
      if (!file.endsWith(ext)) continue;
      const base = file.slice(0, file.length - ext.length);
      const list = suffixed.get(base);
      if (list) list.push([i, file]);
      else suffixed.set(base, [[i, file]]);
    }
  }
  for (const list of suffixed.values()) {
    if (list.length > 1) list.sort(([a], [b]) => a - b);
  }
  const deepestFirst = byDepth(packages);
  const local = new Map<string, string>();
  for (const [dir, json] of deepestFirst) {
    if (json.name && !local.has(json.name)) local.set(json.name, dir);
  }
  // Names each package can import: its own dependencies and its ancestors'.
  const declared = new Map<string, Set<string>>();
  const declaredFor = (from: string) => {
    const dir = owner(packages, from)?.[0] ?? ".";
    let names = declared.get(dir);
    if (!names) {
      names = new Set();
      for (const [pkgDir, json] of deepestFirst) {
        if (pkgDir !== "." && dir !== pkgDir && !dir.startsWith(`${pkgDir}/`))
          continue;
        for (const field of DEP_FIELDS) {
          for (const name of Object.keys(json[field] ?? {})) names.add(name);
        }
      }
      declared.set(dir, names);
    }
    return names;
  };

  // Every file `base` can mean: itself, with an extension, or an index.
  const probe = (base: string): string[] => {
    if (generated(base)) return [base];
    const found: string[] = [];
    if (exists(base)) found.push(base);
    for (const [, file] of suffixed.get(base) ?? []) found.push(file);
    // TypeScript's `./x.js` → `./x.ts`.
    const js = found.length === 0 && JS_EXTENSION.exec(base);
    if (js) {
      const ts = `${base.slice(0, js.index)}.${js[1]}ts${js[2]}`;
      if (exists(ts)) found.push(ts);
    }
    for (const [, file] of suffixed.get(`${base}/index`) ?? []) {
      found.push(file);
    }
    return found;
  };

  const inPackage = (dir: string, path: string) =>
    dir === "." ? path : posix.join(dir, path);

  // A specifier naming a package in the repo, through its `exports`.
  const resolveLocal = (dir: string, json: PackageJson, subpath: string) => {
    if (json.exports !== undefined) {
      const list = exportTargets(json.exports, subpath);
      return (list ?? [])
        .map((target) => inPackage(dir, posix.normalize(target)))
        .filter((path) => generated(path) || exists(path));
    }
    if (subpath === ".") {
      return probe(inPackage(dir, posix.normalize(json.main ?? "index")));
    }
    return probe(inPackage(dir, subpath.slice(2)));
  };

  const resolve = (from: string, fromDir: string, specifier: string) => {
    const bare = specifier.replace(QUERY, "");
    if (bare === "") return;
    if (bare.startsWith(".")) {
      const found = probe(posix.join(fromDir, bare));
      return found.length > 0 ? { files: found } : undefined;
    }
    for (const [key, target] of config.alias) {
      if (bare !== key && !bare.startsWith(`${key}/`)) continue;
      const found = probe(aliased(target, bare.slice(key.length + 1)));
      if (found.length > 0) return { files: found };
    }
    const name = packageName(bare);
    const dir = local.get(name);
    if (dir !== undefined) {
      const subpath = `.${bare.slice(name.length)}`;
      const found = resolveLocal(dir, packages.get(dir) ?? {}, subpath);
      return found.length > 0 ? { files: found } : undefined;
    }
    const node = builtin(bare);
    if (node) return { pkg: node };
    if (declaredFor(from).has(name) || config.external.has(name)) {
      return { pkg: name };
    }
    return;
  };

  // A specifier resolves the same from every file in a directory, and a
  // file's imports resolve one after another.
  const cache = new Map<string, Map<string, Resolution>>();
  let lastFrom: string | undefined;
  let lastDir = "";
  let inDir = new Map<string, Resolution>();
  return (from, specifier) => {
    if (from !== lastFrom) {
      lastFrom = from;
      lastDir = posix.dirname(from);
      inDir = cache.get(lastDir) ?? new Map();
      cache.set(lastDir, inDir);
    }
    if (inDir.has(specifier)) return inDir.get(specifier);
    const resolved = resolve(from, lastDir, specifier);
    inDir.set(specifier, resolved);
    return resolved;
  };
}
