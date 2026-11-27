import { statSync } from "node:fs";
import { join, posix } from "node:path";

import type { Computed } from "./compute.ts";
import type { ResolvedConfig } from "./config.ts";
import { fanIn } from "./fanin.ts";
import { globToRegExp } from "./glob.ts";
import { walksByTypes } from "./graph.ts";
import { duration, wrapped } from "./human.ts";
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
import { type SpelledPath, spelledPaths } from "./spelled.ts";
import { QUERY, RELATIVE, UNDECLARED_READS } from "./syntax.ts";
import {
  branch,
  closingLine,
  failLine,
  MEASURE,
  NOTE_INDENT,
  type Paint,
  plural,
  SEPARATOR,
  textWidth,
  truncatePath,
  truncateWords,
} from "./terminal.ts";

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
  // select the tests that reach it: an input nothing declares. One the
  // orphan rule covers, which runs the suite in full, is left to
  // `unreached`'s fix.
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

export function fixFor(cause: string): string {
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

// Cut at the first dot, so `u.d.ts` and `u.js` share a stem and count
// as siblings.
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
    ...extraction.dependsOn.map((glob): Declared => ({
      kind: "depends-on",
      glob,
      pattern: globToRegExp(glob),
    })),
    ...extraction.reads.map((glob): Declared => ({
      kind: "reads",
      glob,
      pattern: globToRegExp(glob),
    })),
    ...extraction.lists.map((glob): Declared => ({
      kind: "lists",
      glob,
      pattern: globToRegExp(glob),
    })),
    ...extraction.globs.map((glob, i): Declared => {
      // invariant: `finish` maps each glob to one path, in order, so
      // `relative[i]` is this glob's.
      const path = relative[i];
      if (path === undefined) {
        throw new Error(`bivium: check: no resolved path for glob ${glob}.`);
      }
      return { kind: "glob", glob, pattern: globToRegExp(path) };
    }),
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
// "not a node" (`classify`), so a skipped file is an ignored one outside
// the graph. A match outside the roots that isn't ignored runs everything,
// which selects the node too.
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

// A key no node matches is dead, since it applies to nothing. A value is
// dead as an annotation's glob is, over what it matches for every node its
// key matches: a snapshot glob that most tests' captures miss is alive
// while some test's hits.
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
    // Keyed by source, so an expansion many nodes share is matched once.
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

// `step` hears each phase start, with the share of the work done, so a
// progress line can show it: a large repository takes seconds.
export async function check(
  root: string,
  config: ResolvedConfig,
  computed: Computed,
  step: (what: string, done: number) => void = () => {},
): Promise<Report> {
  step("finding what the graph can't read", 0.05);
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
  step("finding dead globs", 0.1);
  const dead = await findDeadGlobs(root, config, computed);
  // The longest phase by far, since it reads every string in every file
  // a test reaches.
  const spelling = "finding paths nothing declares";
  const spelled = await spelledPaths(root, config, computed, (ratio) =>
    step(spelling, 0.15 + 0.8 * ratio),
  );
  step("finding files no test reaches", 0.95);
  const unreached = unreachedFiles(config, computed, [
    ...spelled.undeclared,
    ...spelled.orphaned,
  ]);
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
    undeclaredPaths: spelled.undeclared,
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

function widening(report: Report): Unknown[] {
  return report.unknown.filter((node) => node.tests.length > 0);
}

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

// Largest first, then by name, so the order is stable.
function byCount(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)),
  );
}

// `--json` prints this as `summary`, so dropping or retyping a field
// bumps `SCHEMA_VERSION`.
interface Summary {
  // Nodes with unknown dependencies that some test reaches, the tests they
  // make run on any change, and how many nodes each cause accounts for.
  unknown: number;
  testsOnAnyChange: number;
  unknownByCause: Record<string, number>;
  // Unknown nodes no test reaches, which widen nothing.
  unknownNoTestReaches: number;
  fallbacks: number;
  fallbackReasons: Record<string, number>;
  unparsedTsconfigs: number;
  deadGlobs: number;
  staleDeadGlobs: number;
  unlistedUnknowns: number;
  staleKnownUnknowns: number;
  undeclaredPaths: number;
  unreached: number;
}

export function summarize(report: Report): Summary {
  const widen = widening(report);
  const causes = new Map<string, number>();
  for (const node of widen) {
    for (const category of new Set(
      node.causes.map(({ cause }) => categoryOf(cause)),
    )) {
      causes.set(category, (causes.get(category) ?? 0) + 1);
    }
  }
  const reasons = new Map<string, number>();
  for (const { reason } of report.fallbacks) {
    const what = reason.replace(POSITION, "");
    reasons.set(what, (reasons.get(what) ?? 0) + 1);
  }
  return {
    unknown: widen.length,
    testsOnAnyChange: new Set(widen.flatMap((node) => node.tests)).size,
    unknownByCause: byCount(causes),
    unknownNoTestReaches: report.unknown.length - widen.length,
    fallbacks: report.fallbacks.length,
    fallbackReasons: byCount(reasons),
    unparsedTsconfigs: report.unparsedTsconfigs.length,
    deadGlobs: report.deadGlobs.length,
    staleDeadGlobs: report.staleDeadGlobs.length,
    unlistedUnknowns: report.unlistedUnknowns.length,
    staleKnownUnknowns: report.staleKnownUnknowns.length,
    undeclaredPaths: report.undeclaredPaths.length,
    unreached: report.unreached.length,
  };
}

// A section of the human report says what a cause is, how much of it
// there is, and a few places it's at, so the fix is said only once.
interface Example {
  place: string;
  detail?: string;
  fix?: string;
}

interface Section {
  title: string;
  count: string;
  examples: Example[];
}

interface ReportView {
  paint: Paint;
  // Every example, and each fix whole.
  all: boolean;
  elapsedMs: number;
}

const SHOWN = 3;
const BRANCH_WIDTH = "  ├ ".length;

// The fix most examples share, said once under them, so it isn't one
// sentence repeated. An example with another fix carries it in a note;
// when no two share one, each does.
function sharedFix(examples: readonly Example[]): string | undefined {
  const counts = new Map<string, number>();
  for (const { fix } of examples) {
    if (fix !== undefined) counts.set(fix, (counts.get(fix) ?? 0) + 1);
  }
  const [top] = [...counts].sort(([, a], [, b]) => b - a);
  if (top === undefined) return undefined;
  return top[1] > 1 || examples.length === 1 ? top[0] : undefined;
}

function fixLines(
  { paint, all }: ReportView,
  first: string,
  fix: string,
): { lines: string[]; cut: boolean } {
  const label = `${first}${paint.good("fix")} `;
  if (all) {
    return {
      lines: wrapped(fix, label, " ".repeat(textWidth(label))),
      cut: false,
    };
  }
  const shown = truncateWords(fix, MEASURE - textWidth(label));
  return { lines: [`${label}${shown}`], cut: shown !== fix };
}

function renderSection(
  view: ReportView,
  { title, count, examples }: Section,
): { lines: string[]; cut: boolean } {
  const { paint, all } = view;
  const lines = [`${paint.bold(title)}${paint.dim(`${SEPARATOR}${count}`)}`];
  const shared = sharedFix(examples);
  const shown = all ? examples : examples.slice(0, SHOWN);
  const hidden = examples.length - shown.length;
  let cut = hidden > 0;
  // A detail gets up to 40 columns and a place the rest, never under 30,
  // so a place keeps its file name and a detail its point.
  const detailWidth = Math.min(
    40,
    Math.max(0, ...shown.map(({ detail }) => textWidth(detail ?? ""))),
  );
  const placeMax = Math.max(
    30,
    MEASURE - BRANCH_WIDTH - (detailWidth > 0 ? detailWidth + 2 : 0),
  );
  const places = shown.map(({ place }) => {
    const fitted = all ? place : truncatePath(place, placeMax);
    cut ||= fitted !== place;
    return fitted;
  });
  const placeWidth = Math.max(0, ...places.map(textWidth));
  for (const [i, example] of shown.entries()) {
    const glyph = paint.dim(
      branch(i, hidden > 0 ? shown.length + 1 : shown.length),
    );
    const place = places[i] ?? "";
    let detail = example.detail ?? "";
    if (detail !== "" && !all) {
      const room = MEASURE - BRANCH_WIDTH - placeWidth - 2;
      const fitted = truncateWords(detail, room);
      cut ||= fitted !== detail;
      detail = fitted;
    }
    lines.push(
      detail === ""
        ? `  ${glyph}${place}`
        : `  ${glyph}${place.padEnd(placeWidth)}  ${paint.dim(detail)}`,
    );
    if (example.fix !== undefined && example.fix !== shared) {
      const note = fixLines(view, NOTE_INDENT, example.fix);
      lines.push(...note.lines);
      cut ||= note.cut;
    }
  }
  if (hidden > 0) {
    lines.push(`  ${paint.dim(`└ ${hidden} more`)}`);
  }
  if (shared !== undefined) {
    const line = fixLines(view, "  ", shared);
    lines.push(...line.lines);
    cut ||= line.cut;
  }
  return { lines, cut };
}

const UNRESOLVED = "unresolved ";

// How many of a cause: imports count in files, since one file can
// have several.
function countOf(hits: number, files: number, noun: string): string {
  return hits === files && noun !== "import"
    ? plural(files, "file")
    : `${plural(hits, noun)} in ${plural(files, "file")}`;
}

// One section per cause, largest first, so the head of a long report is
// what to fix first.
function causeSections(widen: readonly Unknown[]): Section[] {
  const byCategory = new Map<string, { node: string; example: Example }[]>();
  for (const { node, causes, known } of widen) {
    for (const { cause, at, fix } of causes) {
      const category = categoryOf(cause);
      const named = cause.startsWith(UNRESOLVED)
        ? cause.slice(UNRESOLVED.length)
        : cause === category
          ? ""
          : cause;
      const detail = [named, known === undefined ? "" : `known: ${known}`]
        .filter((part) => part !== "")
        .join(SEPARATOR);
      const example: Example = { place: at ?? node, fix };
      if (detail !== "") example.detail = detail;
      const hits = byCategory.get(category) ?? [];
      hits.push({ node, example });
      byCategory.set(category, hits);
    }
  }
  return [...byCategory]
    .map(([category, hits]) => {
      const files = new Set(hits.map(({ node }) => node)).size;
      const noun = category.includes("import") ? "import" : "place";
      return {
        files,
        section: {
          title: category,
          count: countOf(hits.length, files, noun),
          examples: hits.map(({ example }) => example),
        },
      };
    })
    .sort(
      (a, b) =>
        b.files - a.files || (a.section.title < b.section.title ? -1 : 1),
    )
    .map(({ section }) => section);
}

const filesIn = (entries: readonly { file: string }[]) =>
  new Set(entries.map(({ file }) => file)).size;

function otherSections(report: Report): Section[] {
  const sections: Section[] = [];
  const add = (section: Section) => {
    if (section.examples.length > 0) sections.push(section);
  };
  const spelled = report.undeclaredPaths;
  add({
    title: "path spelled in code that nothing declares",
    count: `${plural(spelled.length, "path")} in ${plural(filesIn(spelled), "file")}`,
    examples: spelled.map(({ file, path, dir, at, fix }) => ({
      place: at ?? file,
      detail: dir ? `${path}/` : path,
      fix,
    })),
  });
  const dead = report.deadGlobs;
  add({
    title: "dead glob: a change to what it matches selects nothing",
    count: `${plural(dead.length, "glob")} in ${plural(new Set(dead.map(({ node }) => node)).size, "file")}`,
    examples: dead.map((found) => ({
      place: found.at ?? found.node,
      detail: `${found.kind} ${found.glob}: ${summary(found)}`,
      fix: found.fix,
    })),
  });
  add({
    title: "`deadGlobs` entry that matches no dead glob",
    count: plural(report.staleDeadGlobs.length, "entry", "entries"),
    examples: report.staleDeadGlobs.map(({ file, glob, fix }) => ({
      place: file,
      detail: glob,
      fix,
    })),
  });
  add({
    title: "unknown not in `knownUnknowns`",
    count: plural(report.unlistedUnknowns.length, "file"),
    examples: report.unlistedUnknowns.map((node) => ({
      place: node,
      fix: "make its dependencies known, or list it in `knownUnknowns` with a reason",
    })),
  });
  add({
    title: "`knownUnknowns` entry whose dependencies are known",
    count: plural(report.staleKnownUnknowns.length, "entry", "entries"),
    examples: report.staleKnownUnknowns.map(({ file, reason, fix }) => ({
      place: file,
      detail: reason,
      fix,
    })),
  });
  for (const suite of new Set(report.unreached.map(({ suite }) => suite))) {
    const entries = report.unreached.filter((entry) => entry.suite === suite);
    add({
      title: "no test reaches: a change runs the whole suite",
      count: `${plural(entries.length, "file")} in suite ${suite}`,
      examples: entries.map(({ file, fix }) => ({ place: file, fix })),
    });
  }
  add({
    title: "tsconfig that doesn't parse, whose `paths` are ignored",
    count: plural(report.unparsedTsconfigs.length, "file"),
    examples: report.unparsedTsconfigs.map(({ file, reason }) => ({
      place: file,
      detail: reason,
    })),
  });
  add({
    title: "read by the regex extractor",
    count: `${plural(report.fallbacks.length, "file")} the lexer couldn't read`,
    examples: report.fallbacks.map(({ file, reason }) => ({
      place: file,
      detail: reason,
    })),
  });
  const idle = report.unknown.filter((node) => node.tests.length === 0);
  add({
    title: "unknown, but no test reaches it, so it widens nothing",
    count: plural(idle.length, "file"),
    examples: idle.flatMap(({ node, causes, known }) =>
      causes.map(({ cause, at }) => ({
        place: at ?? node,
        detail:
          known === undefined ? cause : `${cause}${SEPARATOR}known: ${known}`,
      })),
    ),
  });
  return sections;
}

function verdict(paint: Paint, counts: Summary): string {
  const { unknown, testsOnAnyChange: tests } = counts;
  if (unknown === 0) {
    return paint.good("bivium can follow every file a test reaches");
  }
  return `${paint.bad(`${plural(unknown, "file")} bivium can't follow`)} ${unknown === 1 ? "sends" : "send"} ${paint.bold(String(tests))} ${tests === 1 ? "test" : "tests"} to every change`;
}

// The counts the sections below open with, so the head is the whole
// report in one line; split at a separator to stay in the measure.
function context(counts: Summary, max: number | undefined): string[] {
  const parts = [
    max === undefined ? "" : `at most ${max} allowed`,
    counts.undeclaredPaths > 0
      ? plural(counts.undeclaredPaths, "undeclared path")
      : "",
    counts.deadGlobs > 0 ? plural(counts.deadGlobs, "dead glob") : "",
    counts.staleDeadGlobs > 0
      ? plural(
          counts.staleDeadGlobs,
          "stale `deadGlobs` entry",
          "stale `deadGlobs` entries",
        )
      : "",
    counts.unlistedUnknowns > 0
      ? `${counts.unlistedUnknowns} not in \`knownUnknowns\``
      : "",
    counts.staleKnownUnknowns > 0
      ? plural(
          counts.staleKnownUnknowns,
          "stale `knownUnknowns` entry",
          "stale `knownUnknowns` entries",
        )
      : "",
    counts.unreached > 0
      ? `${plural(counts.unreached, "file")} no test reaches`
      : "",
    counts.unparsedTsconfigs > 0
      ? plural(
          counts.unparsedTsconfigs,
          "tsconfig that doesn't parse",
          "tsconfigs that don't parse",
        )
      : "",
    counts.fallbacks > 0
      ? `${plural(counts.fallbacks, "file")} the lexer couldn't read`
      : "",
    counts.unknownNoTestReaches > 0
      ? `${counts.unknownNoTestReaches} more unknown no test reaches`
      : "",
  ].filter((part) => part !== "");
  const lines: string[] = [];
  for (const part of parts) {
    const last = lines.at(-1);
    if (
      last !== undefined &&
      textWidth(last) + SEPARATOR.length + textWidth(part) <= MEASURE
    ) {
      lines[lines.length - 1] = `${last}${SEPARATOR}${part}`;
    } else lines.push(part);
  }
  return lines;
}

// What made the check fail, short so its last line fits: the sections
// above name each in full.
function failures(counts: Summary, max: number | undefined): string[] {
  const parts: [number, string, string][] = [
    [
      max !== undefined && counts.unknown > max ? counts.unknown : 0,
      `unknown, over --max-unknown ${max}`,
      `unknown, over --max-unknown ${max}`,
    ],
    [counts.unlistedUnknowns, "unlisted unknown", "unlisted unknowns"],
    [counts.undeclaredPaths, "undeclared path", "undeclared paths"],
    [counts.deadGlobs, "dead glob", "dead globs"],
    [
      counts.staleKnownUnknowns + counts.staleDeadGlobs,
      "stale entry",
      "stale entries",
    ],
  ];
  return parts.flatMap(([count, one, many]) =>
    count > 0 ? [plural(count, one, many)] : [],
  );
}

// The verdict first, so one line answers; then the counts, a section per
// cause with a few places and its fix, and whether the check passes.
// `--all` shows every place and each fix whole; `--json` has the rest,
// such as the tests each unknown runs.
export function formatReport(
  report: Report,
  max: number | undefined,
  view: ReportView,
): string {
  const { paint } = view;
  const counts = summarize(report);
  const lines = [
    verdict(paint, counts),
    ...context(counts, max).map((line) => paint.dim(line)),
    "",
  ];
  let cut = false;
  for (const section of [
    ...causeSections(widening(report)),
    ...otherSections(report),
  ]) {
    const rendered = renderSection(view, section);
    lines.push(...rendered.lines, "");
    cut ||= rendered.cut;
  }
  const detail = `checked in ${duration(view.elapsedMs)}${cut ? `${SEPARATOR}--all for every file` : ""}`;
  const failed = failures(counts, max);
  lines.push(
    failed.length > 0
      ? failLine(paint, failed.join(SEPARATOR), detail)
      : closingLine(paint, "Check passes", detail),
  );
  return lines.join("\n");
}
