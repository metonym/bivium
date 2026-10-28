import { builtinModules } from "node:module";
import { posix } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { QUERY } from "./syntax.ts";
import type { TsConfigs, TsPaths } from "./tsconfig.ts";

export interface PackageJson {
  name?: string;
  exports?: unknown;
  // Subpath imports: `#name` or `#pattern/*` → targets, as `exports` spells
  // them.
  imports?: Record<string, unknown>;
  main?: string;
  sideEffects?: boolean | string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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
  if (isRecord(value.imports)) json.imports = value.imports;
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

interface Scope {
  owning: [string, PackageJson] | undefined;
  ts: TsPaths | undefined;
  // The package names `owning` can import.
  declared: Set<string>;
  // Bare specifier → its resolution, for every file in the scope.
  resolved: Map<string, Resolution>;
}

interface Directory {
  dir: string;
  // Relative specifier → its resolution, for every file in `dir`.
  relative: Map<string, Resolution>;
  scope: Scope;
}

const BUILTINS = new Set(builtinModules);
const RUNTIME_BUILTIN = /^(?:node:|bun(?:$|:))/;
const JS_EXTENSION = /\.([cm]?)js(x?)$/;
const NODE_PREFIX = /^node:/;
const INVALID_IMPORT_TARGET = /^[./#]/;
// SvelteKit replaces it in `app.html` with the assets directory; the scanner
// reads `href="%sveltekit.assets%/x"` as a relative reference.
const SVELTEKIT_ASSETS = "./%sveltekit.assets%/";
const INDEX = "/index";
const SVELTE_CONFIGS = ["js", "mjs", "cjs", "ts", "mts"].map(
  (ext) => `svelte.config.${ext}`,
);
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

// The targets `map` (`exports` by subpath, or `imports`) gives `subpath`,
// with Node's key matching: an exact key, else the `*` pattern with the
// longest prefix.
function mapTargets(
  map: Record<string, unknown>,
  subpath: string,
): string[] | undefined {
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

// The targets `exports` maps `subpath` (`.` or `./x`) to.
export function exportTargets(
  exports: unknown,
  subpath: string,
): string[] | undefined {
  const map = subpathMap(exports);
  return map && mapTargets(map, subpath);
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
  tsconfigs = new Map(),
}: {
  files: ReadonlySet<string>;
  config: ResolvedConfig;
  packages: Packages;
  tsconfigs?: TsConfigs | undefined;
}): Resolver {
  const generated = (path: string) =>
    config.generated.some(({ pattern }) => pattern.test(path));
  const { extensions } = config;
  const exists = (path: string) => files.has(path);
  // `base` → the files `base + extension`, in extension order: a probe
  // looks its bases up instead of building every candidate name. A file
  // can only end with the extensions whose last `.` segment is as long as
  // its own.
  const suffixed = new Map<string, [number, string][]>();
  // A directory → its `index` files, so a probe needn't build `base/index`.
  const indexes = new Map<string, [number, string][]>();
  const byTail: number[][] = [];
  const undotted: number[] = [];
  for (let i = 0; i < extensions.length; i++) {
    const ext = extensions[i];
    const dot = ext.lastIndexOf(".");
    if (dot === -1) undotted.push(i);
    else {
      const list = byTail[ext.length - dot];
      if (list) list.push(i);
      else byTail[ext.length - dot] = [i];
    }
  }
  const addSuffixed = (i: number, file: string) => {
    const ext = extensions[i];
    if (!file.endsWith(ext)) return;
    const base = file.slice(0, file.length - ext.length);
    const list = suffixed.get(base);
    if (list) list.push([i, file]);
    else {
      const created: [number, string][] = [[i, file]];
      suffixed.set(base, created);
      if (base.endsWith(INDEX)) {
        indexes.set(base.slice(0, -INDEX.length), created);
      }
    }
  };
  for (const file of files) {
    const dot = file.lastIndexOf(".");
    if (dot !== -1) {
      for (const i of byTail[file.length - dot] ?? []) addSuffixed(i, file);
    }
    for (const i of undotted) addSuffixed(i, file);
  }
  for (const list of suffixed.values()) {
    if (list.length > 1) list.sort(([a], [b]) => a - b);
  }
  const deepestFirst = byDepth(packages);
  const local = new Map<string, string>();
  for (const [dir, json] of deepestFirst) {
    if (json.name && !local.has(json.name)) local.set(json.name, dir);
  }
  // Names a package can import: its own dependencies and its ancestors'.
  const declaredIn = (dir: string): Set<string> => {
    const names = new Set<string>();
    for (const [pkgDir, json] of deepestFirst) {
      if (pkgDir !== "." && dir !== pkgDir && !dir.startsWith(`${pkgDir}/`))
        continue;
      for (const field of DEP_FIELDS) {
        for (const name of Object.keys(json[field] ?? {})) names.add(name);
      }
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
    for (const [, file] of indexes.get(base) ?? []) found.push(file);
    return found;
  };

  // A file's scope: the package that owns it and the nearest
  // `tsconfig.json`, all a bare specifier's resolution reads of where it is.
  // Every directory under the same two shares one, with its resolutions.
  const tsDeepestFirst = [...tsconfigs].sort(([a], [b]) => b.length - a.length);
  const scopes = new Map<string, Scope>();
  const scopeOf = (from: string): Scope => {
    const contains = ([dir]: [string, unknown]) =>
      dir === "." || from.startsWith(`${dir}/`);
    const pkg = deepestFirst.findIndex(contains);
    const ts = tsDeepestFirst.findIndex(contains);
    const key = `${pkg} ${ts}`;
    let scope = scopes.get(key);
    if (!scope) {
      const owning = pkg === -1 ? undefined : deepestFirst[pkg];
      scope = {
        owning,
        ts: ts === -1 ? undefined : tsDeepestFirst[ts][1],
        declared: declaredIn(owning?.[0] ?? "."),
        resolved: new Map(),
      };
      scopes.set(key, scope);
    }
    return scope;
  };

  // A SvelteKit project's directory: the nearest one above `dir` with a
  // `svelte.config.*` or a `package.json`.
  const svelteKitRoot = (dir: string): string => {
    for (let at = dir; ; at = posix.dirname(at)) {
      if (at === "." || packages.has(at)) return at;
      if (SVELTE_CONFIGS.some((name) => exists(`${at}/${name}`))) return at;
    }
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

  // `#name` through the owning package's `imports`: every condition's
  // target, like `exports`. A `./` target is an exact path in the package; a
  // package target resolves as a bare specifier would, and one that can't
  // makes the whole specifier unknown.
  const resolveImport = (scope: Scope, bare: string): Resolution => {
    const { owning } = scope;
    const imports = owning?.[1].imports;
    const list = owning && imports && mapTargets(imports, bare);
    if (!list) return;
    const found: string[] = [];
    let pkg: string | undefined;
    for (const target of list) {
      if (target.startsWith("./")) {
        const path = inPackage(owning[0], posix.normalize(target));
        if ((generated(path) || exists(path)) && !found.includes(path)) {
          found.push(path);
        }
        continue;
      }
      // Node rejects any other relative, absolute or `#` target.
      if (INVALID_IMPORT_TARGET.test(target)) continue;
      const specifier = target.replace(QUERY, "");
      const resolved =
        specifier === "" ? undefined : resolveBare(scope, specifier);
      if (resolved === undefined) return;
      if ("pkg" in resolved) pkg ??= resolved.pkg;
      else {
        for (const file of resolved.files) {
          if (!found.includes(file)) found.push(file);
        }
      }
    }
    // A `pkg:` node is a leaf no change reaches: the files are the edges.
    if (found.length > 0) return { files: found };
    return pkg === undefined ? undefined : { pkg };
  };

  const resolveRelative = (fromDir: string, bare: string): Resolution => {
    if (bare.startsWith(SVELTEKIT_ASSETS)) {
      // The default `kit.files.assets`: `static/` in the project.
      const rest = bare.slice(SVELTEKIT_ASSETS.length);
      const found = probe(posix.join(svelteKitRoot(fromDir), "static", rest));
      return found.length > 0 ? { files: found } : undefined;
    }
    const found = probe(posix.join(fromDir, bare));
    return found.length > 0 ? { files: found } : undefined;
  };

  // Any other specifier, the same from every file in `scope`.
  const resolveBare = (scope: Scope, bare: string): Resolution => {
    for (const [key, target] of config.alias) {
      if (bare !== key && !bare.startsWith(`${key}/`)) continue;
      const found = probe(aliased(target, bare.slice(key.length + 1)));
      if (found.length > 0) return { files: found };
    }
    const { ts } = scope;
    const mapped = ts && mapTargets(ts.paths, bare);
    if (mapped) {
      // Every target that exists, where TypeScript takes the first.
      const found = [...new Set(mapped.flatMap(probe))];
      if (found.length > 0) return { files: found };
    }
    if (bare.startsWith("#")) return resolveImport(scope, bare);
    const name = packageName(bare);
    const dir = local.get(name);
    if (dir !== undefined) {
      const subpath = `.${bare.slice(name.length)}`;
      const found = resolveLocal(dir, packages.get(dir) ?? {}, subpath);
      return found.length > 0 ? { files: found } : undefined;
    }
    if (ts?.baseUrl !== undefined) {
      const found = probe(posix.join(ts.baseUrl, bare));
      if (found.length > 0) return { files: found };
    }
    const node = builtin(bare);
    if (node) return { pkg: node };
    if (scope.declared.has(name) || config.external.has(name)) {
      return { pkg: name };
    }
    return;
  };

  // A relative specifier resolves the same from every file in a directory,
  // any other the same from every file in a scope, and a file's imports
  // resolve one after another.
  const dirs = new Map<string, Directory>();
  const directoryOf = (from: string): Directory => {
    const dir = posix.dirname(from);
    let found = dirs.get(dir);
    if (!found) {
      found = { dir, relative: new Map(), scope: scopeOf(from) };
      dirs.set(dir, found);
    }
    return found;
  };
  let lastFrom: string | undefined;
  let last: Directory | undefined;
  return (from, specifier) => {
    if (from !== lastFrom || !last) {
      lastFrom = from;
      last = directoryOf(from);
    }
    const { dir, relative, scope } = last;
    // A subpath import's leading `#` isn't a hash.
    const hash = specifier.startsWith("#") ? "#" : "";
    const isRelative = specifier.startsWith(".");
    const memo = isRelative ? relative : scope.resolved;
    if (memo.has(specifier)) return memo.get(specifier);
    const bare = hash + specifier.slice(hash.length).replace(QUERY, "");
    let resolved: Resolution;
    if (bare !== "" && bare !== "#") {
      resolved = isRelative
        ? resolveRelative(dir, bare)
        : resolveBare(scope, bare);
    }
    memo.set(specifier, resolved);
    return resolved;
  };
}
