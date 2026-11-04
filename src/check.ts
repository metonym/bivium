import { statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Computed } from "./compute.ts";
import type { ResolvedConfig } from "./config.ts";
import { fanIn } from "./fanin.ts";
import { globToRegExp } from "./glob.ts";
import { walksByTypes } from "./graph.ts";
import {
  annotationLine,
  causesOf,
  fileOf,
  sourceOf,
  specifierLine,
} from "./locate.ts";
import { orphanOf } from "./plan.ts";
import { aliasPath } from "./resolve.ts";
import { type Extraction, finish } from "./scan.ts";
import { sorted } from "./sorted.ts";
import { type SpelledPath, undeclaredPaths } from "./spelled.ts";
import { QUERY, RELATIVE, UNDECLARED_READS } from "./syntax.ts";
import { plural } from "./text.ts";

interface Unknown {
  node: string;
  causes: { cause: string; at?: string; fix: string }[];
  // The tests that depend on the node, each of which runs on any change. A
  // node no test reaches widens nothing: plans only ever run tests.
  tests: string[];
  // Why `knownUnknowns` allows it, when it does.
  known?: string;
}

type GlobKind = "depends-on" | "reads" | "lists" | "glob" | "edges" | "setup";

interface Declared {
  kind: GlobKind;
  glob: string;
  pattern: RegExp;
}

interface DeadGlob {
  node: string;
  kind: GlobKind;
  // As the source spells it; an `import.meta.glob` pattern is relative to
  // the node.
  glob: string;
  problem: "matches nothing" | "matches only ignored files" | "partly ignored";
  matches: number;
  // The matches a change to which selects nothing: how many, and the first.
  ignored: number;
  examples: string[];
  at?: string;
  fix: string;
}

export interface Report {
  // Nodes whose dependencies the graph can't read: each runs on any change.
  unknown: Unknown[];
  // Files the lexer couldn't read, which the regex extractor read instead.
  fallbacks: { file: string; reason: string }[];
  // `tsconfig.json` files, or files they extend, that don't parse: their
  // `paths` are ignored, so what they map is unresolved.
  unparsedTsconfigs: { file: string; reason: string }[];
  // Globs that miss changes they name, less those `deadGlobs` allows.
  deadGlobs: DeadGlob[];
  // `deadGlobs` entries that match no dead glob.
  staleDeadGlobs: { file: string; glob: string; reason: string; fix: string }[];
  // With `knownUnknowns` in the config: the unknown nodes some test reaches
  // that it doesn't list, and its entries for nodes that aren't unknown.
  unlistedUnknowns: string[];
  staleKnownUnknowns: { file: string; reason: string; fix: string }[];
  // Files under a suite's `root` that no test of it reaches and that the
  // config doesn't exempt: a change to one runs the whole suite.
  unreached: { suite: string; file: string; fix: string }[];
  // Repository paths a file spells in its code that a change to wouldn't
  // select it: an input nothing declares.
  undeclaredPaths: SpelledPath[];
}

const EXAMPLES = 3;
const TAGS: Record<GlobKind, string> = {
  "depends-on": "@depends-on",
  reads: "@reads",
  lists: "@lists",
  glob: "import.meta.glob",
  edges: "edges",
  setup: "setup",
};

const QUOTED = /"([^"]+)"/;

/** How to make one of `check`'s unknown causes known. */
export function fixFor(cause: string) {
  if (cause.startsWith("unresolved ")) {
    const specifier = QUOTED.exec(cause)?.[1] ?? "";
    if (specifier.startsWith("./%sveltekit.assets%/")) {
      return "no file in the SvelteKit project's `static/` (a custom `kit.files.assets` isn't read): fix the path, or add an `edges` entry for it";
    }
    if (RELATIVE.test(specifier)) {
      return "no file at that path: fix the import, or add an `edges` entry if a build generates it";
    }
    if (specifier.startsWith("#")) {
      return "map it in the `imports` of the file's package.json, or with `alias`";
    }
    return "declare the package in a package.json, list it in `external` if a dependency installs it, or map it with `alias` or tsconfig `paths`";
  }
  if (cause.startsWith("only declarations for ")) {
    return "only a declaration file is there, so what runs isn't in the graph: if a build writes it, name it in `edges` with its inputs, or import it with `import type` if only its types are used";
  }
  if (cause === "non-literal dynamic import") {
    return "spell the path as a string literal, load the files with `import.meta.glob` and literal patterns, or list the file in `hermetic` if it only imports paths its caller passes";
  }
  if (cause === "non-literal glob import") {
    return "pass `import.meta.glob` literal patterns";
  }
  if (cause === UNDECLARED_READS) {
    return "name what it reads: `// @depends-on <glob>`, or `// @reads <glob>` for files read as text, or an `edges` or `reads` entry for the file in the config; list the file in `hermetic` if it reads no file of the repository";
  }
  if (cause.startsWith("non-literal goto(")) {
    return "pass `goto()` a literal URL, or a template whose path before `?` or `#` is literal; or name the pages it can open with `// @depends-on <glob>`";
  }
  if (cause.startsWith("missing fixture ")) {
    return "no page at that URL: fix the URL, or the suite's `urls`";
  }
  if (cause.startsWith("goto(")) {
    return "map the URL to a file with the suite's `urls`";
  }
  return "see the cause";
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

// The name a path's file has before its first dot: `u.d.ts` and `u.js`
// are both `u`.
function stemOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.indexOf(".", slash + 2);
  return dot === -1 ? path : path.slice(0, dot);
}

// A hint for an unresolved specifier that names the file that's there: a
// sibling with another extension, a file outside the roots, or one git
// doesn't list. For relative specifiers and aliases, which map to a path.
function nearMisses(
  root: string,
  config: ResolvedConfig,
  { graph, listed }: Computed,
) {
  let stems: Map<string, string[]> | undefined;
  const listedSet = new Set(listed);
  const siblings = (path: string) => {
    if (!stems) {
      stems = new Map();
      for (const file of listed) {
        const stem = stemOf(file);
        const list = stems.get(stem);
        list ? list.push(file) : stems.set(stem, [file]);
      }
    }
    return stems.get(stemOf(path)) ?? [];
  };
  const candidates = (base: string) => [
    base,
    ...config.extensions.map((ext) => base + ext),
    ...config.extensions.map((ext) => `${base}/index${ext}`),
  ];
  return (node: string, cause: string): string | undefined => {
    if (!cause.startsWith("unresolved ")) return undefined;
    const specifier = (QUOTED.exec(cause)?.[1] ?? "").replace(QUERY, "");
    const base = RELATIVE.test(specifier)
      ? posix.join(posix.dirname(fileOf(node)), specifier)
      : config.alias
          .map((alias) => aliasPath(alias, specifier))
          .find((path) => path !== undefined);
    if (base === undefined || base.startsWith("../")) return undefined;
    const tried = candidates(base);
    const outside = tried.find(
      (path) => listedSet.has(path) && !graph.has(path),
    );
    if (outside !== undefined) {
      return `${outside} exists, but outside \`roots\`: add it to \`roots\``;
    }
    const unlisted = tried.find((path) => isFile(join(root, path)));
    if (unlisted !== undefined && !listedSet.has(unlisted)) {
      return `${unlisted} exists, but git doesn't list it (ignored?): if a build writes it, name it in \`edges\` with its inputs`;
    }
    const sibling = siblings(base).find((file) => graph.has(file));
    if (sibling !== undefined) {
      return `${sibling} exists: import it by that name, or add its extension to \`extensions\``;
    }
    return undefined;
  };
}

function declaredGlobs(node: string, extraction: Extraction): Declared[] {
  const relative = finish(node, extraction).globs;
  return [
    ...extraction.dependsOn.map(
      (glob): Declared => ({
        kind: "depends-on",
        glob,
        pattern: globToRegExp(glob),
      }),
    ),
    ...extraction.reads.map(
      (glob): Declared => ({
        kind: "reads",
        glob,
        pattern: globToRegExp(glob),
      }),
    ),
    ...extraction.lists.map(
      (glob): Declared => ({
        kind: "lists",
        glob,
        pattern: globToRegExp(glob),
      }),
    ),
    ...extraction.globs.map(
      (glob, i): Declared => ({
        kind: "glob",
        glob,
        pattern: globToRegExp(relative[i]),
      }),
    ),
  ];
}

function problemOf(
  matches: number,
  ignored: number,
): DeadGlob["problem"] | undefined {
  if (matches === 0) return "matches nothing";
  if (ignored === 0) return undefined;
  return ignored === matches ? "matches only ignored files" : "partly ignored";
}

type Found = Omit<DeadGlob, "at">;

// A glob is dead when a change it names can't select its node: it matches
// no file, or a file the planner skips. `ignore` means "not a seed", never
// "not a node" (`classify`), so a skipped file is an ignored one outside the
// graph. A match outside the roots that isn't ignored runs everything, which
// selects the node too.
function deadOf(
  node: string,
  kind: GlobKind,
  glob: string,
  patterns: RegExp[],
  listed: string[],
  skipped: (file: string) => boolean,
): Found | undefined {
  const matches = listed.filter((file) => patterns.some((re) => re.test(file)));
  const ignored = sorted(matches.filter(skipped));
  const problem = problemOf(matches.length, ignored.length);
  if (problem === undefined) return undefined;
  return {
    node,
    kind,
    glob,
    problem,
    matches: matches.length,
    ignored: ignored.length,
    examples: ignored.slice(0, EXAMPLES),
    fix:
      problem === "matches nothing"
        ? "fix the path"
        : "point it at files the selector reads, or allowlist it in `deadGlobs` with a reason",
  };
}

// The config's `edges` and `reads`, under the config's file. A key no node
// matches applies to nothing. A value is dead as an annotation's glob is,
// over what it matches for every node its key matches: a snapshot glob that
// most tests' captures miss is alive while some test's hits.
function configDeadGlobs(
  config: ResolvedConfig,
  { graph, listed }: Computed,
  skipped: (file: string) => boolean,
): Found[] {
  const file = config.file ?? "the config";
  const found: Found[] = [];
  const entries = [
    ...config.generated.map((map) => ["edges", map] as const),
    ...config.reads.map((map) => ["reads", map] as const),
  ];
  for (const [kind, map] of entries) {
    // Each value's patterns, once per distinct expansion.
    const patterns = map.values.map(() => new Map<string, RegExp>());
    let matched = false;
    for (const node of graph.keys()) {
      const targets = map.targets(node);
      if (!targets) continue;
      matched = true;
      for (const [i, re] of targets.entries()) patterns[i]?.set(re.source, re);
    }
    if (!matched) {
      found.push({
        node: file,
        kind,
        glob: map.key,
        problem: "matches nothing",
        matches: 0,
        ignored: 0,
        examples: [],
        fix: "fix the path: no file the graph reads matches it",
      });
      continue;
    }
    for (const [i, glob] of map.values.entries()) {
      const expanded = [...(patterns[i]?.values() ?? [])];
      const dead = deadOf(file, kind, glob, expanded, listed, skipped);
      if (dead) found.push(dead);
    }
  }
  for (const suite of config.suites) {
    for (const glob of suite.setup) {
      const pattern = globToRegExp(glob);
      const dead = deadOf(file, "setup", glob, [pattern], listed, skipped);
      if (dead) found.push(dead);
    }
  }
  return found;
}

async function findDeadGlobs(
  root: string,
  config: ResolvedConfig,
  computed: Computed,
): Promise<DeadGlob[]> {
  const { graph, extractions, listed } = computed;
  const skipped = (file: string) => config.isIgnored(file) && !graph.has(file);
  const found: Found[] = [];
  for (const node of graph.keys()) {
    const extraction = extractions.get(node);
    if (!extraction) continue;
    for (const { kind, glob, pattern } of declaredGlobs(node, extraction)) {
      const dead = deadOf(node, kind, glob, [pattern], listed, skipped);
      if (dead) found.push(dead);
    }
  }
  const configured = configDeadGlobs(config, computed, skipped);
  const nodes = [
    ...new Set([
      ...found.map(({ node }) => node),
      ...configured.map(({ node }) => node),
    ]),
  ];
  const texts = await Promise.all(nodes.map((node) => sourceOf(root, node)));
  const sources = new Map(
    nodes.map((node, i): [string, string | undefined] => [node, texts[i]]),
  );
  const locate = (
    dead: Found,
    line: (source: string) => number | undefined,
  ) => {
    const source = sources.get(dead.node);
    const at = source === undefined ? undefined : line(source);
    return at === undefined ? dead : { ...dead, at: `${dead.node}:${at}` };
  };
  return [
    ...found.map((dead) =>
      locate(dead, (source) =>
        dead.kind === "glob"
          ? specifierLine(source, dead.glob)
          : annotationLine(source, TAGS[dead.kind], dead.glob),
      ),
    ),
    ...configured.map((dead) =>
      locate(dead, (source) => specifierLine(source, dead.glob)),
    ),
  ];
}

const CONFIG_FILE =
  /(?:^|[./_-])(?:config|setup|teardown|harness)(?:[./_-]|$)|^tsconfig[^/]*\.json$|^\.[^/]*rc(?:\.[^/]+)?$/;

// How to stop a change to `file`, which no test reaches, from running the
// whole suite, by what it looks like: a test's own file (a snapshot named
// after it), a runner's config or harness, or anything else.
function unreachedFix(
  file: string,
  tests: readonly string[],
  spelled: readonly SpelledPath[],
): string {
  const named = spelled.find(
    ({ path }) => file === path || file.startsWith(`${path}/`),
  );
  if (named !== undefined) {
    return `${named.at ?? named.file} names ${named.path}: ${named.fix}`;
  }
  const name = posix.basename(file);
  const owner = tests.find((test) =>
    name.startsWith(`${posix.basename(test)}.`),
  );
  if (owner !== undefined) {
    return `if ${owner} reads it, add \`reads: { "${owner}": "${file}" }\` (or \`// @reads ${file}\` in the test)`;
  }
  if (CONFIG_FILE.test(name)) {
    return "if the runner loads it, name it in the suite's `wiring` (or `setup`, if it runs before every test), which makes the full run deliberate";
  }
  return "if a test reads or runs it, say so with `reads` or `@depends-on` in that test or what loads it; if none can observe it, list it in the suite's `nonInputs`, or delete it if it's dead";
}

// The files a change to which the orphan rule would run a suite for. Each
// suite's forward walk from its tests rules out what any test reaches, so
// only the rest pay for a walk of their own.
function unreachedFiles(
  config: ResolvedConfig,
  { graph }: Computed,
  spelled: readonly SpelledPath[],
): Report["unreached"] {
  const found: Report["unreached"] = [];
  const files = [...graph.keys()].filter(
    (node) => !node.startsWith("pkg:") && !node.includes("#"),
  );
  for (const suite of config.suites) {
    const reached = fanIn(graph, suite);
    const tests = files.filter(suite.isTest);
    for (const file of files) {
      if ((reached.get(file) ?? 0) > 0) continue;
      // Exempt, or run in full by a rule the config chose.
      if (config.isIgnored(file) || config.isSelf(file)) continue;
      if (suite.isWiring(file)) continue;
      if (!orphanOf(graph, config, suite, file)) continue;
      found.push({
        suite: suite.name,
        file,
        fix: unreachedFix(file, tests, spelled),
      });
    }
  }
  return found;
}

// Every node with unknown dependencies, with where and how to fix each
// cause, and every dead glob `deadGlobs` doesn't allow.
export async function check(
  root: string,
  config: ResolvedConfig,
  computed: Computed,
): Promise<Report> {
  const nodes = [...computed.graph]
    .filter(([, deps]) => deps.unknown.length > 0)
    .map(([node]) => node);
  // A suite that can't observe types reaches its tests without the
  // type-only edges, as `plan` walks for it.
  const testsOf = (node: string) => {
    const reach = walksByTypes(computed.graph, [node], {
      includeUnknown: false,
      readers: false,
    });
    const found = new Set<string>();
    for (const suite of config.suites) {
      for (const test of reach(suite.types)) {
        if (suite.isTest(test)) found.add(test);
      }
    }
    return sorted(found);
  };
  const nearMiss = nearMisses(root, config, computed);
  const known = new Map(
    (config.knownUnknowns ?? []).map((entry) => [entry.file, entry.reason]),
  );
  const unknown = await Promise.all(
    nodes.map(async (node): Promise<Unknown> => {
      const causes = (await causesOf(root, computed, node)).map(
        ({ cause, at }) => {
          const fix = nearMiss(node, cause) ?? fixFor(cause);
          return at === undefined ? { cause, fix } : { cause, at, fix };
        },
      );
      const reason = known.get(node);
      const entry: Unknown = { node, causes, tests: testsOf(node) };
      if (reason !== undefined) entry.known = reason;
      return entry;
    }),
  );
  const fallbacks = [...computed.fallbacks].map(([file, reason]) => ({
    file,
    reason,
  }));
  const dead = await findDeadGlobs(root, config, computed);
  const spelled = await undeclaredPaths(root, config, computed);
  const unreached = unreachedFiles(config, computed, spelled);
  const allows = (entry: { file: string; glob: string }, found: DeadGlob) =>
    entry.file === found.node && entry.glob === found.glob;
  return {
    unknown,
    fallbacks,
    unparsedTsconfigs: computed.unparsedTsconfigs,
    deadGlobs: dead.filter(
      (found) => !config.deadGlobs.some((entry) => allows(entry, found)),
    ),
    unlistedUnknowns: config.knownUnknowns
      ? unknown
          .filter(
            (entry) => entry.tests.length > 0 && entry.known === undefined,
          )
          .map((entry) => entry.node)
      : [],
    staleKnownUnknowns: (config.knownUnknowns ?? [])
      .filter((entry) => !nodes.includes(entry.file))
      .map((entry) => ({
        ...entry,
        fix: "remove the entry: its dependencies are known now",
      })),
    unreached,
    undeclaredPaths: spelled,
    staleDeadGlobs: config.deadGlobs
      .filter((entry) => !dead.some((found) => allows(entry, found)))
      .map((entry) => ({
        ...entry,
        fix: "remove the entry: its glob is no longer dead",
      })),
  };
}

function summary({ problem, matches, ignored, examples }: DeadGlob) {
  if (problem === "matches nothing") return problem;
  const shown = [...examples, ...(ignored > examples.length ? ["…"] : [])];
  const count =
    problem === "partly ignored" ? `${ignored} of ${matches}` : `${ignored}`;
  return `${problem} (${count}: ${shown.join(", ")})`;
}

// The unknown nodes some test depends on: the ones `--max-unknown` counts.
function widening(report: Report): Unknown[] {
  return report.unknown.filter((node) => node.tests.length > 0);
}

/** Whether `check` fails: past `--max-unknown`, or on a list it keeps. */
export function failed(report: Report, max: number | undefined): boolean {
  return (
    (max !== undefined && widening(report).length > max) ||
    report.unlistedUnknowns.length > 0 ||
    report.staleKnownUnknowns.length > 0 ||
    report.deadGlobs.length > 0 ||
    report.staleDeadGlobs.length > 0 ||
    report.undeclaredPaths.length > 0
  );
}

function pushUnknown(lines: string[], { node, causes, tests, known }: Unknown) {
  lines.push(known === undefined ? node : `${node}    (known: ${known})`);
  for (const { cause, at, fix } of causes) {
    lines.push(`  ✗ ${cause}${at ? `    ${at}` : ""}`, `    fix: ${fix}`);
  }
  if (tests.length > 0) {
    const more = tests.length > 3 ? `, and ${tests.length - 3} more` : "";
    lines.push(`  runs on any change: ${tests.slice(0, 3).join(", ")}${more}`);
  }
}

// What a cause is, without what it names: the line `check` counts it on.
function categoryOf(cause: string): string {
  if (cause.startsWith("unresolved ")) {
    const specifier = QUOTED.exec(cause)?.[1] ?? "";
    if (RELATIVE.test(specifier)) return "unresolved relative import";
    if (specifier.startsWith("#")) return "unresolved # import";
    return "unresolved bare import (a package, alias or path)";
  }
  if (cause.startsWith("only declarations for ")) {
    return "a .js import with only its declarations there";
  }
  if (cause.startsWith("non-literal goto(")) return "non-literal goto()";
  if (cause.startsWith("goto(")) return "goto() URL no `urls` pattern maps";
  if (cause.startsWith("missing fixture ")) return "goto() of a missing page";
  return cause;
}

const POSITION = /(?: in <>)? at \d+.*$/;
const BLANK_LINES = /\n{3,}/g;

function counted(counts: Map<string, number>): string[] {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .map(([what, count]) => `${count} ${what}`);
}

// Counts by cause first, so a long report is actionable from its head.
function summaryLines(report: Report): string[] {
  const widen = widening(report);
  const lines: string[] = [];
  if (widen.length > 0) {
    const tests = new Set(widen.flatMap((node) => node.tests));
    lines.push(
      `${plural(widen.length, "node")} with unknown dependencies ${widen.length === 1 ? "reaches" : "reach"} ${plural(tests.size, "test")}, which ${tests.size === 1 ? "runs" : "run"} on any change:`,
    );
    const causes = new Map<string, number>();
    for (const node of widen) {
      for (const category of new Set(
        node.causes.map(({ cause }) => categoryOf(cause)),
      )) {
        causes.set(category, (causes.get(category) ?? 0) + 1);
      }
    }
    lines.push(...counted(causes).map((line) => `  ${line}`));
  }
  const idle = report.unknown.length - widen.length;
  if (idle > 0) {
    lines.push(
      `${plural(idle, "more node")} with unknown dependencies no test reaches`,
    );
  }
  if (report.fallbacks.length > 0) {
    const reasons = new Map<string, number>();
    for (const { reason } of report.fallbacks) {
      const what = reason.replace(POSITION, "");
      reasons.set(what, (reasons.get(what) ?? 0) + 1);
    }
    lines.push(
      `${plural(report.fallbacks.length, "file")} read by the regex extractor: ${counted(reasons).join(", ")}`,
    );
  }
  const problems = [
    [
      report.unparsedTsconfigs.length,
      "tsconfig file that doesn't parse",
      "tsconfig files that don't parse",
    ],
    [report.deadGlobs.length, "dead glob", "dead globs"],
    [
      report.staleDeadGlobs.length,
      "stale `deadGlobs` entry",
      "stale `deadGlobs` entries",
    ],
    [
      report.unlistedUnknowns.length,
      "unknown not in `knownUnknowns`",
      "unknowns not in `knownUnknowns`",
    ],
    [
      report.staleKnownUnknowns.length,
      "stale `knownUnknowns` entry",
      "stale `knownUnknowns` entries",
    ],
    [
      report.undeclaredPaths.length,
      "path spelled in code that nothing declares",
      "paths spelled in code that nothing declares",
    ],
    [
      report.unreached.length,
      "file under a suite's root that no test reaches",
      "files under a suite's root that no test reaches",
    ],
  ] as const;
  for (const [count, one, many] of problems) {
    if (count > 0) lines.push(plural(count, one, many));
  }
  return lines.length === 0
    ? []
    : ["Summary:", ...lines.map((line) => `  ${line}`), ""];
}

// Files listed one by one per suite; past that, counted by directory.
const UNREACHED_SHOWN = 10;

function pushUnreached(lines: string[], unreached: Report["unreached"]) {
  if (unreached.length === 0) return;
  lines.push(
    "",
    "Files under a suite's root that no test reaches: a change to one runs the whole suite:",
  );
  for (const suite of new Set(unreached.map((entry) => entry.suite))) {
    const entries = unreached.filter((entry) => entry.suite === suite);
    lines.push(`  ${suite} (${entries.length})`);
    for (const { file, fix } of entries.slice(0, UNREACHED_SHOWN)) {
      lines.push(`    ${file}`, `      fix: ${fix}`);
    }
    const rest = entries.slice(UNREACHED_SHOWN);
    if (rest.length === 0) continue;
    const dirs = new Map<string, number>();
    for (const { file } of rest) {
      const dir = posix.dirname(file);
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
    const counts = [...dirs]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
      .map(([dir, count]) => `${dir}/ (${count})`);
    lines.push(
      `    … ${rest.length} more in ${counts.slice(0, 5).join(", ")}${counts.length > 5 ? ", …" : ""} (--json lists each)`,
    );
  }
}

function pushUndeclared(lines: string[], spelled: Report["undeclaredPaths"]) {
  if (spelled.length === 0) return;
  lines.push(
    "",
    "Paths spelled in code that nothing declares: a change there doesn't select the file:",
  );
  let file: string | undefined;
  for (const { file: node, path, dir, at, fix } of spelled) {
    if (node !== file) lines.push(`  ${node}`);
    file = node;
    lines.push(
      `    ✗ ${dir ? `${path}/` : path}${at ? `    ${at}` : ""}`,
      `      fix: ${fix}`,
    );
  }
}

export function formatReport(report: Report, max: number | undefined): string {
  const lines: string[] = summaryLines(report);
  const widen = widening(report);
  for (const unknown of widen) pushUnknown(lines, unknown);
  const idle = report.unknown.filter((node) => node.tests.length === 0);
  if (idle.length > 0) {
    lines.push(
      "",
      "Unknown, but no test depends on them, so they widen nothing:",
    );
    for (const unknown of idle) pushUnknown(lines, unknown);
  }
  if (report.fallbacks.length > 0) {
    lines.push(
      "",
      "Read by the regex extractor, which the lexer couldn't read:",
    );
    for (const { file, reason } of report.fallbacks) {
      lines.push(`  ${file}: ${reason}`);
    }
  }
  pushUndeclared(lines, report.undeclaredPaths);
  pushUnreached(lines, report.unreached);
  if (report.unparsedTsconfigs.length > 0) {
    lines.push(
      "",
      "tsconfig files that don't parse, whose `paths` are ignored:",
    );
    for (const { file, reason } of report.unparsedTsconfigs) {
      lines.push(`  ${file}: ${reason}`);
    }
  }
  if (report.deadGlobs.length > 0) {
    lines.push(
      "",
      "Dead globs: a change to what they match, or to some of it, selects nothing:",
    );
    let node: string | undefined;
    for (const dead of report.deadGlobs) {
      if (dead.node !== node) lines.push(`  ${dead.node}`);
      node = dead.node;
      lines.push(
        `    ✗ ${dead.kind} ${dead.glob}: ${summary(dead)}${dead.at ? `    ${dead.at}` : ""}`,
        `      fix: ${dead.fix}`,
      );
    }
  }
  if (report.staleDeadGlobs.length > 0) {
    lines.push("", "`deadGlobs` entries that match no dead glob:");
    for (const { file, glob, fix } of report.staleDeadGlobs) {
      lines.push(`  ${file}: ${glob}`, `    fix: ${fix}`);
    }
  }
  if (report.staleKnownUnknowns.length > 0) {
    lines.push("", "`knownUnknowns` entries whose dependencies are known:");
    for (const { file, fix } of report.staleKnownUnknowns) {
      lines.push(`  ${file}`, `    fix: ${fix}`);
    }
  }
  const count = widen.length;
  const limit = max === undefined ? "" : ` (at most ${max})`;
  lines.push(
    "",
    `${count} ${count === 1 ? "node" : "nodes"} with unknown dependencies ${count === 1 ? "reaches" : "reach"} a test${limit}: each such test runs on any change.`,
  );
  const unlisted = report.unlistedUnknowns.length;
  if (unlisted > 0) {
    lines.push(
      `${unlisted} of them not in \`knownUnknowns\`: fix ${unlisted === 1 ? "it" : "them"}, or list ${unlisted === 1 ? "it" : "them"} with a reason.`,
    );
  }
  if (idle.length > 0) {
    lines.push(`${idle.length} more no test reaches.`);
  }
  const staleKnown = report.staleKnownUnknowns.length;
  if (staleKnown > 0) {
    lines.push(
      `${plural(staleKnown, "stale `knownUnknowns` entry", "stale `knownUnknowns` entries")}.`,
    );
  }
  const undeclared = report.undeclaredPaths.length;
  if (undeclared > 0) {
    lines.push(
      `${plural(undeclared, "path", "paths")} spelled in code that nothing declares.`,
    );
  }
  const dead = report.deadGlobs.length;
  const stale = report.staleDeadGlobs.length;
  if (dead > 0) {
    lines.push(`${plural(dead, "dead glob")} not in \`deadGlobs\`.`);
  }
  if (stale > 0) {
    lines.push(
      `${plural(stale, "stale `deadGlobs` entry", "stale `deadGlobs` entries")}.`,
    );
  }
  // Sections each open with a blank line, and the summary ends with one.
  return lines.join("\n").replace(BLANK_LINES, "\n\n").trimStart();
}
