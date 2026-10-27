import type { Computed } from "./compute.ts";
import type { ResolvedConfig } from "./config.ts";
import { globToRegExp } from "./glob.ts";
import { affectedBy } from "./graph.ts";
import { annotationLine, causesOf, sourceOf, specifierLine } from "./locate.ts";
import { type Extraction, finish } from "./scan.ts";
import { sorted } from "./sorted.ts";

interface Unknown {
  node: string;
  causes: { cause: string; at?: string; fix: string }[];
  // The tests that depend on the node, each of which runs on any change. A
  // node no test reaches widens nothing: plans only ever run tests.
  tests: string[];
}

type GlobKind = "depends-on" | "reads" | "glob" | "edges";

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
}

const EXAMPLES = 3;
const TAGS: Record<GlobKind, string> = {
  "depends-on": "@depends-on",
  reads: "@reads",
  glob: "import.meta.glob",
  edges: "edges",
};

const QUOTED = /"([^"]+)"/;

/** How to make one of `check`'s unknown causes known. */
export function fixFor(cause: string) {
  if (cause.startsWith("unresolved ")) {
    const specifier = QUOTED.exec(cause)?.[1] ?? "";
    if (specifier.startsWith("./%sveltekit.assets%/")) {
      return "no file in the SvelteKit project's `static/` (a custom `kit.files.assets` isn't read): fix the path, or add an `edges` entry for it";
    }
    if (specifier.startsWith(".")) {
      return "no file at that path: fix the import, or add an `edges` entry if a build generates it";
    }
    if (specifier.startsWith("#")) {
      return "map it in the `imports` of the file's package.json, or with `alias`";
    }
    return "declare the package in a package.json, list it in `external` if a dependency installs it, or map it with `alias` or tsconfig `paths`";
  }
  if (cause === "non-literal dynamic import") {
    return "spell the path as a string literal, load the files with `import.meta.glob` and literal patterns, or list the file in `hermetic` if it only imports paths its caller passes";
  }
  if (cause === "non-literal glob import") {
    return "pass `import.meta.glob` literal patterns";
  }
  if (cause === "reads the disk without @depends-on") {
    return "name what it reads: `// @depends-on <glob>`, or `// @reads <glob>` for files read as text; list the file in `hermetic` if it reads no file of the repository";
  }
  if (cause.startsWith("non-literal goto(")) {
    return "pass `goto()` a literal URL, or a template whose path before `?` or `#` is literal";
  }
  if (cause.startsWith("missing fixture ")) {
    return "no page at that URL: fix the URL, or the suite's `urls`";
  }
  if (cause.startsWith("goto(")) {
    return "map the URL to a file with the suite's `urls`";
  }
  return "see the cause";
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
  const isTest = (node: string) =>
    config.suites.some((suite) => suite.isTest(node));
  const unknown = await Promise.all(
    nodes.map(
      async (node): Promise<Unknown> => ({
        node,
        causes: (await causesOf(root, computed, node)).map(({ cause, at }) =>
          at === undefined
            ? { cause, fix: fixFor(cause) }
            : { cause, at, fix: fixFor(cause) },
        ),
        tests: sorted(
          [
            ...affectedBy(computed.graph, [node], {
              includeUnknown: false,
              readers: false,
            }),
          ].filter(isTest),
        ),
      }),
    ),
  );
  const fallbacks = [...computed.fallbacks].map(([file, reason]) => ({
    file,
    reason,
  }));
  const dead = await findDeadGlobs(root, config, computed);
  const allows = (entry: { file: string; glob: string }, found: DeadGlob) =>
    entry.file === found.node && entry.glob === found.glob;
  return {
    unknown,
    fallbacks,
    unparsedTsconfigs: computed.unparsedTsconfigs,
    deadGlobs: dead.filter(
      (found) => !config.deadGlobs.some((entry) => allows(entry, found)),
    ),
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
export function widening(report: Report): Unknown[] {
  return report.unknown.filter((node) => node.tests.length > 0);
}

function pushUnknown(lines: string[], { node, causes, tests }: Unknown) {
  lines.push(node);
  for (const { cause, at, fix } of causes) {
    lines.push(`  ✗ ${cause}${at ? `    ${at}` : ""}`, `    fix: ${fix}`);
  }
  if (tests.length > 0) {
    const more = tests.length > 3 ? `, and ${tests.length - 3} more` : "";
    lines.push(`  runs on any change: ${tests.slice(0, 3).join(", ")}${more}`);
  }
}

export function formatReport(report: Report, max: number | undefined): string {
  const lines: string[] = [];
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
  const count = widen.length;
  const limit = max === undefined ? "" : ` (at most ${max})`;
  lines.push(
    "",
    `${count} ${count === 1 ? "node" : "nodes"} with unknown dependencies ${count === 1 ? "reaches" : "reach"} a test${limit}: each such test runs on any change.`,
  );
  if (idle.length > 0) {
    lines.push(`${idle.length} more no test reaches.`);
  }
  const dead = report.deadGlobs.length;
  const stale = report.staleDeadGlobs.length;
  if (dead > 0) {
    lines.push(
      `${dead} dead ${dead === 1 ? "glob" : "globs"} not in \`deadGlobs\`.`,
    );
  }
  if (stale > 0) {
    lines.push(
      `${stale} stale \`deadGlobs\` ${stale === 1 ? "entry" : "entries"}.`,
    );
  }
  return lines.join("\n").trimStart();
}
