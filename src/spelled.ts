import { posix } from "node:path";
import type { Computed } from "./compute.ts";
import { inRoot, type ResolvedConfig } from "./config.ts";
import { fanIn } from "./fanin.ts";
import { reaches } from "./graph.ts";
import { sourceOf, specifierLine } from "./locate.ts";
import { formatOf, SCANNED, stringsOf } from "./scan.ts";
import { sorted } from "./sorted.ts";

// Paths a file spells in its code that a change to wouldn't select it: a
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

// The files `check` reads for paths: each suite's tests, and what they reach
// under its roots, such as a helper that names the fixtures. A file with
// unknown dependencies runs on any change already.
function spellers(config: ResolvedConfig, { graph }: Computed): string[] {
  const found = new Set<string>();
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
        found.add(node);
      }
    }
  }
  return sorted(found);
}

/** The paths files spell that a change to wouldn't select them. */
export async function undeclaredPaths(
  root: string,
  config: ResolvedConfig,
  computed: Computed,
): Promise<SpelledPath[]> {
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
  const found: SpelledPath[] = [];
  const nodes = spellers(config, computed);
  const sources = await Promise.all(nodes.map((node) => sourceOf(root, node)));
  for (const [i, node] of nodes.entries()) {
    const source = sources[i];
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
        if (reaches(graph, targets, (n) => n === node)) continue;
        const line = specifierLine(source, text);
        const entry: SpelledPath = {
          file: node,
          path,
          dir,
          fix: fixFor(node, path, dir),
        };
        if (line !== undefined) entry.at = `${node}:${line}`;
        found.push(entry);
      }
    }
  }
  return found;
}
