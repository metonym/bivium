import { posix } from "node:path";
import type { Computed } from "./compute.ts";
import { inRoot, type ResolvedConfig, type ResolvedSuite } from "./config.ts";
import { fanIn } from "./fanin.ts";
import { affectedBy } from "./graph.ts";
import { sourceOf, specifierLine } from "./locate.ts";
import { orphanOf } from "./plan.ts";
import { formatOf, SCANNED, stringsOf } from "./scan.ts";
import { sorted } from "./sorted.ts";

// Paths a file spells in its code that a change to wouldn't select the
// tests that reach it, or run its suite as wiring or by the orphan rule: a
// test that hands `"tests/fixtures"` to the code under test, or that reads
// it while `hermetic` vouches for its reads. Nothing in the graph says the
// file depends on them, so `check` asks for a declaration.

export interface SpelledPath {
  file: string;
  // Repository-relative: a file, or a directory of files the graph reads.
  path: string;
  dir: boolean;
  at?: string;
  fix: string;
}

// A relative path, maybe with SvelteKit's `[param]` and `(group)`: no
// spaces, globs, schemes or escapes.
const PATH_LIKE = /^[\w@.+~()[\]-]+(?:\/[\w@.+~()[\]-]+)*$/;
const LETTER = /[a-z]/i;
const LEADING_SLASHES = /^\/+/;
const TRAILING_SLASHES = /\/+$/;
const DOT_RELATIVE = /^\.\.?\//;

// The repository paths `text` may name from `file`. A path with a slash may
// be relative to the root, as `join(root, "tests/fixtures")` spells it, or
// to the file; a bare name only to the file, as `join(import.meta.dir,
// "fixtures")` spells it. A leading slash is a template's static part after
// `${root}`, or a URL: only a path with a further slash counts.
function candidates(file: string, text: string): string[] {
  let path = text.replace(TRAILING_SLASHES, "");
  const rooted = path.startsWith("/");
  if (rooted) path = path.replace(LEADING_SLASHES, "");
  if (!PATH_LIKE.test(path) || !LETTER.test(path)) return [];
  const dir = posix.dirname(file);
  let found: string[];
  if (rooted) found = path.includes("/") ? [posix.normalize(path)] : [];
  else if (DOT_RELATIVE.test(path)) found = [posix.join(dir, path)];
  else if (path.includes("/")) {
    found = [posix.normalize(path), posix.join(dir, path)];
  } else found = [posix.join(dir, path)];
  return found.filter((p) => p !== "." && !p.startsWith("../"));
}

function fixFor(file: string, path: string, dir: boolean): string {
  if (dir) {
    return `if it reads them, add \`reads: { "${file}": "${path}/**" }\` (or \`// @reads ${path}/**\`), \`@depends-on\` if it runs them, \`@lists\` if it only names them`;
  }
  if (SCANNED.test(path)) {
    return `if it runs it, add \`edges: { "${file}": "${path}" }\` (or \`// @depends-on ${path}\`), \`@reads\` if it reads it as text, \`@lists\` if it only names it`;
  }
  return `if it reads it, add \`reads: { "${file}": "${path}" }\` (or \`// @reads ${path}\`), \`@lists\` if it only names it`;
}

// The files `check` reads for paths, with the suites whose tests reach
// them: each suite's tests, and what they reach under its roots, such as a
// helper that names the fixtures. A file with unknown dependencies runs on
// any change already.
function spellers(
  config: ResolvedConfig,
  { graph }: Computed,
): Map<string, ResolvedSuite[]> {
  const found = new Map<string, ResolvedSuite[]>();
  for (const suite of config.suites) {
    const reached = fanIn(graph, suite);
    for (const [node, deps] of graph) {
      if (deps.unknown.length > 0 || !SCANNED.test(node)) continue;
      if (node.startsWith("pkg:") || node.includes("#")) continue;
      if (
        suite.isTest(node) ||
        ((reached.get(node) ?? 0) > 0 &&
          suite.roots.some((root) => inRoot(node, root)))
      ) {
        const suites = found.get(node);
        suites ? suites.push(suite) : found.set(node, [suite]);
      }
    }
  }
  return new Map(
    sorted(found.keys()).map((node) => [node, found.get(node) ?? []]),
  );
}

// How a change to one of `targets` runs `suites` without an edge to the
// file: as the selector's own file or a suite's wiring, it runs them all,
// and by the orphan rule, the suite whose root it's under.
function runsAnyway(
  config: ResolvedConfig,
  { graph }: Computed,
  suites: readonly ResolvedSuite[],
  targets: readonly string[],
): "wiring" | "orphan" | undefined {
  if (
    targets.some(
      (file) =>
        config.isSelf(file) || suites.some((suite) => suite.isWiring(file)),
    )
  ) {
    return "wiring";
  }
  const orphan = targets.some(
    (file) =>
      !config.isIgnored(file) &&
      suites.some((suite) => orphanOf(graph, config, suite, file)),
  );
  return orphan ? "orphan" : undefined;
}

export interface Spelled {
  // A change there selects nothing through the file: `check` fails.
  undeclared: SpelledPath[];
  // A change there runs the file's suite by the orphan rule: in full, but
  // sound. Each names where an unreached file is spelled.
  orphaned: SpelledPath[];
}

/** The paths files spell that no edge from them declares. */
export async function spelledPaths(
  root: string,
  config: ResolvedConfig,
  computed: Computed,
): Promise<Spelled> {
  const { graph } = computed;
  // Each file of the graph, and each directory by the files under it.
  const files = new Set<string>();
  const dirs = new Map<string, string[]>();
  for (const node of graph.keys()) {
    if (node.startsWith("pkg:") || node.includes("#")) continue;
    files.add(node);
    for (let dir = posix.dirname(node); dir !== "."; ) {
      const list = dirs.get(dir);
      list ? list.push(node) : dirs.set(dir, [node]);
      dir = posix.dirname(dir);
    }
  }
  const found: Spelled = { undeclared: [], orphaned: [] };
  const spelling = spellers(config, computed);
  const nodes = [...spelling.keys()];
  const sources = await Promise.all(nodes.map((node) => sourceOf(root, node)));
  for (const [i, node] of nodes.entries()) {
    const source = sources[i];
    const suites = spelling.get(node) ?? [];
    // The tests a change to the file selects: what a path it spells must
    // select too. For a test, itself; for a helper, the tests it reaches.
    const through = [
      ...affectedBy(graph, [node], { includeUnknown: false }),
    ].filter((path) => suites.some((suite) => suite.isTest(path)));
    if (source === undefined) continue;
    const seen = new Set<string>();
    for (const text of stringsOf(formatOf(node), source) ?? []) {
      for (const path of candidates(node, text)) {
        if (seen.has(path) || path === node) continue;
        seen.add(path);
        const dir = !files.has(path);
        // The directory a file is in is where it starts from, not an input.
        if (dir && node.startsWith(`${path}/`)) continue;
        const targets = dir ? dirs.get(path) : [path];
        if (!targets) continue;
        const selected = affectedBy(graph, targets);
        if (through.every((test) => selected.has(test))) continue;
        const anyway = runsAnyway(config, computed, suites, targets);
        if (anyway === "wiring") continue;
        const line = specifierLine(source, text);
        const entry: SpelledPath = {
          file: node,
          path,
          dir,
          fix: fixFor(node, path, dir),
        };
        if (line !== undefined) entry.at = `${node}:${line}`;
        found[anyway === "orphan" ? "orphaned" : "undeclared"].push(entry);
      }
    }
  }
  return found;
}
