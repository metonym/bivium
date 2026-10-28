import { posix } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { affectedBy, type Graph } from "./graph.ts";
import { byCodeUnit, sorted } from "./sorted.ts";

// What a change to a lockfile, or to a `package.json`'s dependencies, did to
// the installed packages, so a dependency bump seeds the `pkg:` nodes of
// what it changed instead of running everything.

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

// Each dependency field a workspace declares: name → spec.
type Specs = Map<string, Map<string, string>>;

interface Installed {
  // Each copy's entry, as text: a change to any field of one (version,
  // integrity, dependencies) is a change to the package.
  entries: string[];
  versions: string[];
  // The packages its copies depend on, by name.
  dependencies: Set<string>;
}

interface Lockfile {
  // By the name a package is installed (and imported) as.
  packages: Map<string, Installed>;
  // Workspace directory (`.` for the root) → what it declares.
  workspaces: Map<string, Specs>;
  // Every other top-level field, as text: overrides, patches, trusted
  // dependencies and the format's version change what's installed in ways
  // the entries don't show.
  rest: string;
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

// A string, or a comma before a closing bracket, which JSON doesn't allow.
const STRING_OR_TRAILING_COMMA = /"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g;

// JSON with trailing commas, as Bun writes `bun.lock`.
function parseLenient(text: string): unknown {
  return JSON.parse(
    text.replace(
      STRING_OR_TRAILING_COMMA,
      (match, close: string | undefined) => close ?? match,
    ),
  );
}

// The dependency fields of a `package.json`-shaped record, or `undefined`
// when one isn't a map of strings.
function specsOf(value: Record<string, unknown>): Specs | undefined {
  const specs: Specs = new Map();
  for (const field of DEP_FIELDS) {
    const deps = value[field];
    if (deps === undefined) continue;
    if (!isStringRecord(deps)) return undefined;
    specs.set(field, new Map(Object.entries(deps)));
  }
  return specs;
}

function restOf(value: Record<string, unknown>, skip: readonly string[]) {
  return JSON.stringify(
    Object.entries(value).filter(([key]) => !skip.includes(key)),
  );
}

function install(
  packages: Map<string, Installed>,
  name: string,
  entry: unknown,
  version: string,
  info: Record<string, unknown> | undefined,
) {
  const installed = packages.get(name) ?? {
    entries: [],
    versions: [],
    dependencies: new Set<string>(),
  };
  installed.entries.push(JSON.stringify(entry));
  if (!installed.versions.includes(version)) installed.versions.push(version);
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const deps = info?.[field];
    if (isRecord(deps)) {
      for (const dep of Object.keys(deps)) installed.dependencies.add(dep);
    }
  }
  packages.set(name, installed);
}

// The last package name in a `bun.lock` key: `@scope/a/b` is `b` installed
// under `@scope/a`.
function installedName(key: string): string {
  const parts = key.split("/");
  const last = parts.length - 1;
  return last > 0 && parts[last - 1].startsWith("@")
    ? `${parts[last - 1]}/${parts[last]}`
    : parts[last];
}

// `bun.lock`: `packages` maps an install path to `["name@version", …]`,
// with the dependencies in the entry's one object.
function parseBunLock(text: string): Lockfile | undefined {
  const value = parseLenient(text);
  if (!isRecord(value)) return undefined;
  const { packages, workspaces } = value;
  if (!isRecord(packages) || !isRecord(workspaces)) return undefined;
  const lockfile: Lockfile = {
    packages: new Map(),
    workspaces: new Map(),
    rest: restOf(value, ["packages", "workspaces"]),
  };
  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return;
    const ident = entry[0];
    const at = ident.indexOf("@", 1);
    const version = at === -1 ? "" : ident.slice(at + 1);
    install(
      lockfile.packages,
      installedName(key),
      entry,
      version,
      entry.find(isRecord),
    );
  }
  for (const [dir, workspace] of Object.entries(workspaces)) {
    const specs = isRecord(workspace) ? specsOf(workspace) : undefined;
    if (!specs) return undefined;
    lockfile.workspaces.set(dir === "" ? "." : dir, specs);
  }
  return lockfile;
}

const NODE_MODULES = "node_modules/";

// `package-lock.json` v2 and v3: `packages` maps an install path to its
// entry, and a workspace's directory (`""` for the root) to its manifest.
// v1 has no `packages`.
function parsePackageLock(text: string): Lockfile | undefined {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !isRecord(value.packages)) return undefined;
  const { lockfileVersion } = value;
  if (lockfileVersion !== 2 && lockfileVersion !== 3) return undefined;
  const lockfile: Lockfile = {
    packages: new Map(),
    workspaces: new Map(),
    // v2's `dependencies` mirrors `packages` for npm 6; `name` and
    // `version` are the root's own.
    rest: restOf(value, ["packages", "dependencies", "name", "version"]),
  };
  for (const [key, entry] of Object.entries(value.packages)) {
    if (!isRecord(entry)) return undefined;
    const at = key.lastIndexOf(NODE_MODULES);
    if (at !== -1 && (at === 0 || key[at - 1] === "/")) {
      const version = typeof entry.version === "string" ? entry.version : "";
      const name = key.slice(at + NODE_MODULES.length);
      install(lockfile.packages, name, entry, version, entry);
      continue;
    }
    const specs = specsOf(entry);
    if (!specs) return undefined;
    lockfile.workspaces.set(key === "" ? "." : key, specs);
  }
  return lockfile;
}

// The root lockfiles bivium reads, by name.
const FORMATS = new Map<string, (text: string) => Lockfile | undefined>([
  ["bun.lock", parseBunLock],
  ["package-lock.json", parsePackageLock],
]);

// Root lockfiles it can't read. With one in the repository, a
// `package.json` change can't be checked against what's installed.
const UNREAD = [
  "bun.lockb",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

function parse(file: string, text: string | undefined) {
  const format = FORMATS.get(file);
  if (text === undefined || !format) return;
  try {
    return format(text);
  } catch {
    return;
  }
}

interface PackageChange {
  name: string;
  // `bun.lock: svelte 5.1.0 → 5.2.0`.
  detail: string;
  // The changed file it comes from.
  file: string;
}

export interface PackageDiff {
  // The changed lockfiles and `package.json` files the diff accounts for,
  // each with why it can't (it runs everything) or `undefined`.
  files: Map<string, string | undefined>;
  changes: PackageChange[];
  // Package name → the packages that depend on it, in either revision.
  dependents: Map<string, Set<string>>;
  // Names a workspace declares, in either revision.
  declared: Set<string>;
}

function describe(name: string, before?: string, after?: string): string {
  if (before === undefined) return `${name} ${after} added`;
  if (after === undefined) return `${name} ${before} removed`;
  return before === after
    ? `${name} ${after}, entry changed`
    : `${name} ${before} → ${after}`;
}

function versions(installed: Installed | undefined) {
  return installed && sorted(installed.versions).join(", ");
}

// Names whose specs differ between two declarations, with the spec each
// side gives the first field that differs.
function specChanges(before: Specs | undefined, after: Specs | undefined) {
  const changed = new Map<string, [string | undefined, string | undefined]>();
  for (const field of DEP_FIELDS) {
    const a = before?.get(field);
    const b = after?.get(field);
    for (const name of new Set([...(a?.keys() ?? []), ...(b?.keys() ?? [])])) {
      if (a?.get(name) !== b?.get(name) && !changed.has(name)) {
        changed.set(name, [a?.get(name), b?.get(name)]);
      }
    }
  }
  return changed;
}

function lockfileChanges(file: string, base: Lockfile, head: Lockfile) {
  const changes: PackageChange[] = [];
  const names = new Set([...base.packages.keys(), ...head.packages.keys()]);
  for (const name of names) {
    const before = base.packages.get(name);
    const after = head.packages.get(name);
    const same =
      before !== undefined &&
      after !== undefined &&
      sorted(before.entries).join("\n") === sorted(after.entries).join("\n");
    if (same) continue;
    changes.push({
      name,
      detail: `${file}: ${describe(name, versions(before), versions(after))}`,
      file,
    });
  }
  const resolved = new Set(changes.map((change) => change.name));
  const dirs = new Set([...base.workspaces.keys(), ...head.workspaces.keys()]);
  for (const dir of dirs) {
    const declared = specChanges(
      base.workspaces.get(dir),
      head.workspaces.get(dir),
    );
    for (const [name, [before, after]] of declared) {
      if (resolved.has(name)) continue;
      resolved.add(name);
      changes.push({
        name,
        detail: `${file}: ${describe(`${name} range`, before, after)}`,
        file,
      });
    }
  }
  return changes;
}

const MANIFEST = /(?:^|\/)package\.json$/;

function parseManifest(text: string | undefined) {
  if (text === undefined) return;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return;
  }
}

/**
 * Diffs the changed root lockfiles and `package.json` dependency fields
 * between the merge base (`base`) and the working tree (`head`), or returns
 * `undefined` when no such file changed.
 */
export async function readPackageDiff(
  changed: readonly string[],
  listed: readonly string[],
  base: (path: string) => Promise<string | undefined>,
  head: (path: string) => Promise<string | undefined>,
): Promise<PackageDiff | undefined> {
  const lockfiles = changed.filter((file) => FORMATS.has(file));
  const manifests = changed.filter((file) => MANIFEST.test(file));
  if (lockfiles.length === 0 && manifests.length === 0) return undefined;
  const read = (path: string) => Promise.all([base(path), head(path)]);
  const known = [...FORMATS.keys()];
  // An unchanged lockfile is the same in both trees.
  const [lockTexts, manifestTexts] = await Promise.all([
    Promise.all(
      known.map((file) =>
        lockfiles.includes(file)
          ? read(file)
          : head(file).then((text) => [text, text] as const),
      ),
    ),
    Promise.all(manifests.map(read)),
  ]);
  const diff: PackageDiff = {
    files: new Map(),
    changes: [],
    dependents: new Map(),
    declared: new Set(),
  };
  // The lockfiles the working tree has, parsed (`undefined` if they don't
  // parse), to check a `package.json` against.
  const present = new Map<string, Lockfile | undefined>();
  for (const [i, file] of known.entries()) {
    const [baseText, headText] = lockTexts[i];
    const after = parse(file, headText);
    if (headText !== undefined) present.set(file, after);
    const before = parse(file, baseText);
    for (const lockfile of [before, after]) {
      if (!lockfile) continue;
      for (const [name, installed] of lockfile.packages) {
        for (const dependency of installed.dependencies) {
          const set = diff.dependents.get(dependency) ?? new Set<string>();
          set.add(name);
          diff.dependents.set(dependency, set);
        }
      }
      for (const specs of lockfile.workspaces.values()) {
        for (const deps of specs.values()) {
          for (const name of deps.keys()) diff.declared.add(name);
        }
      }
    }
    if (!lockfiles.includes(file)) continue;
    if (baseText === undefined || headText === undefined) {
      diff.files.set(file, baseText === undefined ? "added" : "deleted");
    } else if (!(before && after)) {
      diff.files.set(file, "can't parse it");
    } else if (before.rest === after.rest) {
      diff.files.set(file, undefined);
      diff.changes.push(...lockfileChanges(file, before, after));
    } else {
      diff.files.set(file, "a setting other than the packages changed");
    }
  }

  // A `package.json` that changed only its dependencies, as every lockfile
  // the working tree has records them, changed only what those lockfiles
  // say. Any other change to one is classified as before.
  const unread = UNREAD.some((file) => listed.includes(file));
  for (const [i, file] of manifests.entries()) {
    const [before, after] = manifestTexts[i].map(parseManifest);
    if (!(before && after) || unread || present.size === 0) continue;
    const others = (record: Record<string, unknown>) =>
      restOf(record, DEP_FIELDS);
    const specsBefore = specsOf(before);
    const specsAfter = specsOf(after);
    if (others(before) !== others(after) || !specsBefore || !specsAfter) {
      continue;
    }
    const dir = posix.dirname(file);
    const declared = specChanges(specsBefore, specsAfter);
    const recorded = [...present.values()].every((lockfile) => {
      const specs = lockfile?.workspaces.get(dir);
      if (!specs) return false;
      return [...declared.keys()].every((name) =>
        DEP_FIELDS.every(
          (field) =>
            specs.get(field)?.get(name) === specsAfter.get(field)?.get(name),
        ),
      );
    });
    if (!recorded) continue;
    diff.files.set(file, undefined);
    for (const [name, [from, to]] of declared) {
      diff.declared.add(name);
      diff.changes.push({
        name,
        detail: `${file}: ${describe(`${name} range`, from, to)}`,
        file,
      });
    }
  }
  return diff;
}

interface PackageSeeds {
  // `pkg:` node → the change it stands for, for `why`.
  seeds: Map<string, string>;
  // A line per changed package that selects through its importers, or that
  // selects nothing.
  notes: string[];
  // A line per package no test imports that a change reaches: these run
  // everything.
  reasons: string[];
}

/**
 * The `pkg:` nodes the changes of `files` seed. A changed package seeds
 * itself and every package that depends on it, transitively, that some
 * file imports. Each package it reaches that a workspace declares, that
 * nothing depends on, or that some file imports, must reach a test by an
 * import or be `inert`: otherwise a test may use it some way the graph
 * can't see (a CLI, a runner, types), and the change runs everything.
 */
export function packageSeeds(
  graph: Graph,
  config: ResolvedConfig,
  diff: PackageDiff,
  files: readonly string[],
): PackageSeeds {
  const result: PackageSeeds = { seeds: new Map(), notes: [], reasons: [] };
  const reaches = new Map<string, boolean>();
  const reachesTest = (name: string) => {
    let found = reaches.get(name);
    if (found === undefined) {
      const node = `pkg:${name}`;
      const reached = graph.has(node)
        ? affectedBy(graph, [node], { includeUnknown: false })
        : new Set<string>();
      found = [...reached].some((path) =>
        config.suites.some((suite) => suite.isTest(path)),
      );
      reaches.set(name, found);
    }
    return found;
  };
  const changes = diff.changes
    .filter((change) => files.includes(change.file))
    .sort((a, b) => byCodeUnit(a.name, b.name));
  // Each package no test imports → the changes that reach it, its own first.
  const unused = new Map<string, PackageChange[]>();
  const seen = new Set<string>();
  for (const change of changes) {
    const { name, detail } = change;
    if (seen.has(name)) continue;
    seen.add(name);
    const closure = new Set([name]);
    const queue = [name];
    for (let at = 0; at < queue.length; at++) {
      for (const dependent of diff.dependents.get(queue[at]) ?? []) {
        if (closure.has(dependent)) continue;
        closure.add(dependent);
        queue.push(dependent);
      }
    }
    const through: string[] = [];
    let covered = true;
    for (const user of closure) {
      const node = `pkg:${user}`;
      const imported = graph.has(node);
      if (imported) {
        through.push(user);
        if (!result.seeds.has(node)) {
          result.seeds.set(
            node,
            user === name ? detail : `${detail}, which ${user} depends on`,
          );
        }
      }
      const entry =
        imported || diff.declared.has(user) || !diff.dependents.has(user);
      if (entry && !reachesTest(user) && !config.isInert(user)) {
        covered = false;
        const list = unused.get(user) ?? [];
        if (user === name) list.unshift(change);
        else list.push(change);
        unused.set(user, list);
      }
    }
    if (!covered) continue;
    if (through.length === 0) {
      result.notes.push(`${detail}, inert`);
      continue;
    }
    const others = through.filter((user) => user !== name);
    const shown = others.slice(0, 3).join(", ");
    const rest = others.length > 3 ? ` and ${others.length - 3} more` : "";
    result.notes.push(
      others.length === 0 ? detail : `${detail}, through ${shown}${rest}`,
    );
  }
  for (const user of sorted(unused.keys())) {
    const [first, ...more] = unused.get(user) ?? [];
    if (!first) continue;
    const own = first.name === user;
    const also =
      more.length === 0
        ? ""
        : ` (and ${more.length} more ${more.length === 1 ? "package" : "packages"} ${user} depends on)`;
    result.reasons.push(
      own
        ? `${first.detail}${also}, and no test imports it`
        : `${first.detail}, which ${user} depends on${also}, and no test imports ${user}`,
    );
  }
  return result;
}
