import { type Barrel, parseBarrel } from "./barrel.ts";
import { inRoot, type ResolvedConfig, type ResolvedSuite } from "./config.ts";
import { globToRegExp, matcher } from "./glob.ts";
import {
  createResolver,
  owner,
  type PackageJson,
  type Packages,
} from "./resolve.ts";
import {
  type Extraction,
  extract,
  finish,
  formatOf,
  gotoUrl,
  SCANNED,
} from "./scan.ts";
import { QUERY, type Scan } from "./syntax.ts";
import type { TsConfigs } from "./tsconfig.ts";

// Static file-level dependency graph. A node is a repo-relative file, a
// barrel name (`src/index.js#Button`), or an external package (`pkg:svelte`,
// `pkg:node:fs`). The graph must never miss an edge, so a file whose
// dependencies it can't read lists why in `unknown`, and counts as depending
// on every change.
export interface FileDeps {
  // Nodes this one imports.
  files: Set<string>;
  // Globs of files this one depends on, transitively.
  patterns: RegExp[];
  // Globs of files read as text; only a direct change to one counts.
  reads: RegExp[];
  // Why this file's dependencies can't be known; non-empty = everything.
  unknown: string[];
  // For a barrel whose names bind precisely: name → files it exports.
  barrel?: Map<string, string[]>;
  // For `why` alone, which names each edge: the `files` only a `goto()`
  // opens, and the `patterns` an `@depends-on` or the config's `edges`
  // spells (the rest are `import.meta.glob`s). The walk ignores them.
  pages?: Set<string>;
  patternKinds?: Map<RegExp, "depends-on" | "edges">;
}

export type Graph = Map<string, FileDeps>;

interface BuildOptions {
  config: ResolvedConfig;
  // `package.json` files by directory, the root's at `.`.
  packages: Packages;
  // `tsconfig.json` paths by directory.
  tsconfigs?: TsConfigs | undefined;
}

const leaf = (): FileDeps => ({
  files: new Set(),
  patterns: [],
  reads: [],
  unknown: [],
});

const LEADING_DOT_SLASH = /^\.\//;

function addPattern(
  deps: FileDeps,
  pattern: RegExp,
  kind: "glob" | "depends-on" | "edges",
) {
  deps.patterns.push(pattern);
  if (kind === "glob") return;
  deps.patternKinds ??= new Map();
  deps.patternKinds.set(pattern, kind);
}

// The causes a `hermetic` file vouches for: what it reads or imports this way
// is never a file of the repository.
const HERMETIC_CAUSES = new Set([
  "reads the disk without @depends-on",
  "non-literal dynamic import",
]);

// Webpack's `sideEffects` globs: one without a `/` matches at any depth;
// one with a `/` is relative to the package's directory.
function sideEffectful(
  owning: [string, PackageJson] | undefined,
): (path: string) => boolean {
  const sideEffects = owning?.[1].sideEffects;
  if (sideEffects === false) return () => false;
  if (!Array.isArray(sideEffects)) return () => true;
  const dir = owning?.[0] ?? ".";
  return matcher(
    sideEffects.map((glob) => {
      if (!glob.includes("/")) return `**/${glob}`;
      const path = glob.replace(LEADING_DOT_SLASH, "");
      return dir === "." ? path : `${dir}/${path}`;
    }),
  );
}

function gotoSuite(
  config: ResolvedConfig,
  path: string,
): ResolvedSuite | undefined {
  return config.suites.find(
    (suite) =>
      suite.urls.length > 0 && suite.roots.some((root) => inRoot(path, root)),
  );
}

function mapUrl(suite: ResolvedSuite, url: string): string | undefined {
  for (const { key, target } of suite.urls) {
    const star = key.indexOf("*");
    if (star === -1) {
      if (url === key) return target;
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (url.startsWith(prefix) && url.endsWith(suffix)) {
      const match = url.slice(prefix.length, url.length - suffix.length);
      return target.replaceAll("*", match);
    }
  }
  return undefined;
}

// The page a `goto()` argument in `path` opens, when its suite maps the URL.
export function gotoPage(
  config: ResolvedConfig,
  path: string,
  argument: string,
): string | undefined {
  const suite = gotoSuite(config, path);
  const url = gotoUrl(argument);
  return suite === undefined || url === undefined
    ? undefined
    : mapUrl(suite, url.replace(QUERY, ""));
}

// Parses every source file; non-code files become leaves.
export function buildGraph(
  sources: Map<string, string>,
  options: BuildOptions,
): Graph {
  const extractions = new Map<string, Extraction>();
  for (const [path, source] of sources) {
    if (SCANNED.test(path)) {
      extractions.set(path, extract(formatOf(path), source));
    }
  }
  return graphFrom(sources.keys(), extractions, options);
}

// The graph of `files`, from the extractions of the ones the scanner reads
// (`SCANNED`); the rest are leaves, never read. Resolution runs every time:
// it depends on which files exist.
export function graphFrom(
  files: Iterable<string>,
  extractions: Map<string, Extraction>,
  { config, packages, tsconfigs }: BuildOptions,
): Graph {
  const graph: Graph = new Map();
  const paths = [...files];
  const exists = new Set(paths);
  const resolve = createResolver({
    files: exists,
    config,
    packages,
    tsconfigs,
  });
  const scans = new Map<string, Scan>();
  const barrels = new Map<string, Barrel>();
  for (const path of paths) {
    const extraction = extractions.get(path);
    if (!extraction) continue;
    const gotos = gotoSuite(config, path) !== undefined;
    scans.set(path, finish(path, extraction, { gotos }));
    if (extraction.barrel && config.isBarrel(path)) {
      barrels.set(path, extraction.barrel);
    }
  }

  // A named import binds to a barrel name only when the owning package
  // declares `sideEffects`: otherwise importing one name runs every module.
  const named = new Map<string, Map<string, string[]>>();
  const effects = new Map<string, string[]>();
  const nameUnknown = new Map<string, string[]>();
  for (const [path, barrel] of barrels) {
    const effectful = sideEffectful(owner(packages, path));
    if (effectful(path)) continue;
    const resolveTarget = (specifier: string) => {
      const resolved = resolve(path, specifier);
      return resolved && "files" in resolved ? resolved.files : undefined;
    };
    // Re-exported modules with side effects run on any import from it.
    const always: string[] = [];
    for (const specifier of [...barrel.names.values(), ...barrel.stars]) {
      for (const file of resolveTarget(specifier) ?? []) {
        if (effectful(file) && !always.includes(file)) always.push(file);
      }
    }
    const names = new Map<string, string[]>();
    for (const [name, specifier] of barrel.names) {
      const targets = resolveTarget(specifier);
      if (!targets) {
        nameUnknown.set(`${path}#${name}`, [`unresolved "${specifier}"`]);
      }
      names.set(name, targets ?? []);
    }
    named.set(path, names);
    effects.set(path, always);
  }

  const external = new Set<string>();
  for (const path of paths) {
    const found = scans.get(path);
    if (!found) {
      graph.set(path, leaf());
      continue;
    }
    const deps = leaf();
    for (const { specifier, names } of found.imports) {
      const resolved = resolve(path, specifier);
      if (resolved === undefined) {
        // `import` and `vi.mock()` of one specifier are one cause.
        const cause = `unresolved "${specifier}"`;
        if (!deps.unknown.includes(cause)) deps.unknown.push(cause);
      } else if ("pkg" in resolved) {
        deps.files.add(`pkg:${resolved.pkg}`);
        external.add(`pkg:${resolved.pkg}`);
      } else {
        for (const file of resolved.files) {
          const barrel = names && named.get(file);
          if (!barrel || !names) {
            deps.files.add(file);
            continue;
          }
          // Unknown names (types, typos) fall back to the whole barrel.
          for (const name of names) {
            deps.files.add(barrel.has(name) ? `${file}#${name}` : file);
          }
        }
      }
    }
    deps.unknown.push(
      ...(config.isHermetic(path)
        ? found.unknown.filter((cause) => !HERMETIC_CAUSES.has(cause))
        : found.unknown),
    );
    for (const glob of found.globs) {
      addPattern(deps, globToRegExp(glob), "glob");
    }

    const suite = found.gotos.length > 0 ? gotoSuite(config, path) : undefined;
    if (suite) {
      for (const argument of found.gotos) {
        const url = gotoUrl(argument);
        if (url === undefined) {
          deps.unknown.push(`non-literal goto(${argument})`);
        } else if (url !== "about:blank") {
          const page = mapUrl(suite, url.replace(QUERY, ""));
          if (page === undefined) deps.unknown.push(`goto("${url}")`);
          else if (exists.has(page)) {
            if (!deps.files.has(page)) {
              deps.pages ??= new Set();
              deps.pages.add(page);
            }
            deps.files.add(page);
          } else deps.unknown.push(`missing fixture "${url}"`);
        }
      }
    }

    for (const glob of found.dependsOn) {
      addPattern(deps, globToRegExp(glob), "depends-on");
    }
    for (const glob of found.reads) deps.reads.push(globToRegExp(glob));
    const names = named.get(path);
    if (names) deps.barrel = names;
    graph.set(path, deps);
  }

  for (const [path, names] of named) {
    for (const [name, targets] of names) {
      const id = `${path}#${name}`;
      graph.set(id, {
        ...leaf(),
        files: new Set([...targets, ...(effects.get(path) ?? [])]),
        unknown: nameUnknown.get(id) ?? [],
      });
    }
  }
  for (const id of external) graph.set(id, leaf());
  // Generated files depend on their inputs, whether they're tracked or
  // only referenced.
  for (const deps of [...graph.values()]) {
    for (const file of deps.files) {
      if (!graph.has(file) && isGenerated(config, file))
        graph.set(file, leaf());
    }
  }
  for (const [path, deps] of graph) {
    for (const edge of config.generated) {
      const inputs = edge.targets(path);
      if (!inputs) continue;
      for (const input of inputs) addPattern(deps, input, "edges");
    }
    for (const read of config.reads) {
      const globs = read.targets(path);
      if (globs) deps.reads.push(...globs);
    }
  }
  return graph;
}

function isGenerated(config: ResolvedConfig, path: string) {
  return config.generated.some(({ pattern }) => pattern.test(path));
}

export function changedBarrelNames(
  before: Map<string, string[]>,
  after: Map<string, string[]>,
): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  const key = (files?: string[]) => files?.join("\0");
  return [...names].filter(
    (name) => key(before.get(name)) !== key(after.get(name)),
  );
}

// Names of the barrel at `path` as they were in `source` (its base
// version), resolved against the head graph. `undefined` when it wasn't a
// barrel, so every head name counts as changed.
export function baseBarrelNames(
  path: string,
  source: string | undefined,
  { config, packages, tsconfigs }: BuildOptions,
  graph: Graph,
): Map<string, string[]> | undefined {
  const barrel = source === undefined ? undefined : parseBarrel(path, source);
  if (!barrel) return undefined;
  const resolve = createResolver({
    files: new Set(graph.keys()),
    config,
    packages,
    tsconfigs,
  });
  const names = new Map<string, string[]>();
  for (const [name, specifier] of barrel.names) {
    const resolved = resolve(path, specifier);
    names.set(name, resolved && "files" in resolved ? resolved.files : []);
  }
  return names;
}

// The nodes that declare one pattern (an `import.meta.glob`, `@depends-on`,
// `edges` input or text read), each with what spells it for that node.
interface PatternGroup {
  re: RegExp;
  nodes: string[];
  kinds: Via["kind"][];
}

// Patterns by source, each tested once per path however many nodes declare
// it: an `edges` key that matches every test gives every test the same
// input. A pattern without a wildcard is a lookup.
interface Patterns {
  literal: Map<string, PatternGroup[]>;
  wild: PatternGroup[];
}

interface ReverseIndex {
  dependents: Map<string, string[]>;
  globbers: Patterns;
  readers: Patterns;
  unknown: string[];
}

const indexes = new WeakMap<Graph, ReverseIndex>();

const REGEX_SYNTAX = "[](){}|*+?.^$";

// The one path a compiled glob matches, or `undefined` if it has a
// wildcard.
function literalOf(re: RegExp): string | undefined {
  const { source } = re;
  if (!source.startsWith("^") || !source.endsWith("$")) return undefined;
  let path = "";
  for (let i = 1; i < source.length - 1; i++) {
    const char = source[i];
    if (char === "\\") path += source[++i];
    else if (REGEX_SYNTAX.includes(char)) return undefined;
    else path += char;
  }
  return path;
}

function patterns(): Patterns & {
  add: (re: RegExp, node: string, kind: Via["kind"]) => void;
} {
  const literal = new Map<string, PatternGroup[]>();
  const wild: PatternGroup[] = [];
  const bySource = new Map<string, PatternGroup>();
  return {
    literal,
    wild,
    add: (re, node, kind) => {
      let group = bySource.get(re.source);
      if (!group) {
        group = { re, nodes: [], kinds: [] };
        bySource.set(re.source, group);
        const path = literalOf(re);
        if (path === undefined) wild.push(group);
        else {
          const list = literal.get(path);
          list ? list.push(group) : literal.set(path, [group]);
        }
      }
      // A node that declares a pattern twice keeps the first kind.
      if (group.nodes.at(-1) === node) return;
      group.nodes.push(node);
      group.kinds.push(kind);
    },
  };
}

function reverseIndex(graph: Graph): ReverseIndex {
  const cached = indexes.get(graph);
  if (cached) return cached;
  const dependents = new Map<string, string[]>();
  const globbers = patterns();
  const readers = patterns();
  const unknown: string[] = [];
  for (const [path, deps] of graph) {
    for (const file of deps.files) {
      const list = dependents.get(file);
      list ? list.push(path) : dependents.set(file, [path]);
    }
    for (const re of deps.patterns) {
      globbers.add(re, path, deps.patternKinds?.get(re) ?? "glob");
    }
    for (const re of deps.reads) readers.add(re, path, "reads");
    if (deps.unknown.length > 0) unknown.push(path);
  }
  const index: ReverseIndex = {
    dependents,
    globbers: { literal: globbers.literal, wild: globbers.wild },
    readers: { literal: readers.literal, wild: readers.wild },
    unknown,
  };
  indexes.set(graph, index);
  return index;
}

export function importersOf(graph: Graph, node: string): readonly string[] {
  return reverseIndex(graph).dependents.get(node) ?? [];
}

// How the walk reached a node, by what spells the edge: an import, a page a
// `goto()` opens, a module an HTML page loads (`script[src]`, `link[href]`,
// `iframe[src]` or an inline script's import), a barrel name a named import
// binds (`name`) and the file that exports it (`export`), an
// `import.meta.glob`, an `@depends-on`, the config's `edges`, a file it
// reads as text (`@reads` or the config's `reads`), or its unknown
// dependencies, so it depends on any change. Only `why` reads the kind:
// every kind is followed the same way.
export interface Via {
  from: string;
  kind:
    | "import"
    | "goto"
    | "html"
    | "name"
    | "export"
    | "glob"
    | "depends-on"
    | "edges"
    | "reads"
    | "unknown";
}

// What spells the edge from `dependent` to `node`, one of its `files`.
function fileKind(graph: Graph, dependent: string, node: string): Via["kind"] {
  if (dependent.includes("#")) return "export";
  if (graph.get(dependent)?.pages?.has(node)) return "goto";
  if (node.includes("#")) return "name";
  return dependent.endsWith(".html") ? "html" : "import";
}

interface Walk {
  includeUnknown?: boolean;
  // Whether `changed` seeds the files that read them as text. An unknown
  // node isn't a change, so what it puts on every change skips its readers.
  readers?: boolean;
  opaque?: (path: string) => boolean;
  // Filled with how each node other than a seed was first reached. The walk
  // is breadth-first, so following them back is a shortest chain.
  parents?: Map<string, Via>;
}

// Every node that transitively depends on one of `changed` (inclusive).
// Files with unknown dependencies count as depending on any change unless
// `includeUnknown` is false. The walk doesn't enter `opaque` nodes.
export function affectedBy(
  graph: Graph,
  changed: Iterable<string>,
  {
    includeUnknown = true,
    readers: seedReaders = true,
    opaque,
    parents,
  }: Walk = {},
): Set<string> {
  const { dependents, globbers, readers, unknown } = reverseIndex(graph);
  const affected = new Set<string>();
  const queue: string[] = [];
  const visit = (path: string, via?: Via) => {
    if (affected.has(path) || opaque?.(path)) return;
    affected.add(path);
    queue.push(path);
    if (via && parents) parents.set(path, via);
  };
  const visitGroup = (group: PatternGroup, from: string) => {
    const { nodes, kinds } = group;
    for (let i = 0; i < nodes.length; i++) {
      visit(nodes[i], parents && { from, kind: kinds[i] });
    }
  };

  const changedPaths = [...changed];
  for (const path of changedPaths) visit(path);
  // Text reads only see the files themselves, not what they import.
  if (seedReaders) {
    for (const path of changedPaths) {
      for (const group of readers.literal.get(path) ?? []) {
        visitGroup(group, path);
      }
      for (const group of readers.wild) {
        if (group.re.test(path)) visitGroup(group, path);
      }
    }
  }
  const first = queue[0];
  if (includeUnknown && first !== undefined) {
    for (const path of unknown) visit(path, { from: first, kind: "unknown" });
  }
  // Once a group's nodes are visited, a later match adds nothing, so a
  // walk visits each group once and stops testing its pattern.
  const { literal } = globbers;
  let active = globbers.wild;
  let spent: Set<PatternGroup> | undefined;
  const spend = (group: PatternGroup, from: string) => {
    visitGroup(group, from);
    spent ??= new Set();
    spent.add(group);
  };
  for (let at = 0; at < queue.length; at++) {
    const path = queue[at];
    for (const dependent of dependents.get(path) ?? []) {
      visit(
        dependent,
        parents && { from: path, kind: fileKind(graph, dependent, path) },
      );
    }
    const exact = literal.size > 0 ? literal.get(path) : undefined;
    if (exact) {
      for (const group of exact) {
        if (!spent?.has(group)) spend(group, path);
      }
    }
    let matched = false;
    for (const group of active) {
      if (!group.re.test(path)) continue;
      spend(group, path);
      matched = true;
    }
    if (matched) active = active.filter((group) => !spent?.has(group));
  }
  return affected;
}
