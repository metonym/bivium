/**
 * carbon-components-svelte's CSS narrowing (`styleSeeds` in
 * scripts/test-changed.ts, over scripts/lib/css-delta.ts) as a bivium
 * narrower, so carbon can declare it in its own config:
 *
 *   narrowers: [
 *     cssNarrower(async () => ({
 *       ...(await import("./scripts/lib/css-delta")),
 *       compileAt: (await import("crassus/git")).compileAt,
 *     })),
 *   ],
 *
 * A `css/` change compiles the stylesheets e2e tests load at the merge base
 * and in the working tree, diffs their rules, and seeds the walk with the
 * sources that spell each changed rule's rarest required class. The tools
 * load lazily, since crassus needs the install a `css/` change does; when
 * they can't, the e2e suite runs in full, as carbon's script does.
 */
import type { GraphView, Narrower, NarrowResult } from "../../src/types.ts";

interface Compiled {
  sheets: Record<string, { css: string } | undefined>;
}

/** What the narrower needs from crassus and css-delta.ts. */
export interface CssTools {
  compileAt(
    ref: string | undefined,
    options: { cwd: string; entries: string[] },
  ): Promise<Compiled>;
  changedSelectors(
    base: string,
    head: string,
  ): { selectors: string[] } | { reason: string };
  selectorSources(
    sources: Map<string, string>,
    selectors: string[],
  ): { files: string[] } | { reason: string };
}

// Every compiled `css/<entry>.css` is built from the whole `css/` tree.
const BUILT_CSS = /^css\/([^/]+)\.css$/;
// Where the classes a fixture page renders are spelled.
const PAGE_SOURCE = /^(?:src|e2e)\//;

// The compiled stylesheets (`all`) some e2e test loads, through the files
// that import them: only those can change which e2e tests a `css/` change
// selects.
export function stylesheetEntries(graph: GraphView<"unit" | "e2e">): string[] {
  const tests = graph.tests("e2e");
  const entries: string[] = [];
  for (const node of graph.nodes()) {
    const entry = BUILT_CSS.exec(node)?.[1];
    if (entry === undefined) continue;
    const reach = graph.dependents(graph.importers(node));
    if (tests.some((test) => reach.has(test))) entries.push(entry);
  }
  return entries.sort((a, b) => (a < b ? -1 : Number(a > b)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cssNarrower(
  load: (root: string) => Promise<CssTools>,
): Narrower<"unit" | "e2e"> {
  return {
    name: "css/",
    match: "css/**",
    opaque: "css/*.css",
    suites: ["e2e"],
    async narrow({ root, base, head, graph }): Promise<NarrowResult> {
      const entries = stylesheetEntries(graph);
      try {
        const tools = await load(root);
        const [before, after] = await Promise.all([
          tools.compileAt(base.commit, { cwd: root, entries }),
          tools.compileAt(head.commit, { cwd: root, entries }),
        ]);
        const selectors = new Set<string>();
        for (const entry of entries) {
          const was = before.sheets[entry]?.css;
          const now = after.sheets[entry]?.css;
          if (was === undefined || now === undefined) {
            return { all: `${entry}.css: not compiled` };
          }
          const change = tools.changedSelectors(was, now);
          if ("reason" in change)
            return { all: `${entry}.css: ${change.reason}` };
          for (const selector of change.selectors) selectors.add(selector);
        }
        const pages = new Map<string, string>();
        const files = graph
          .nodes()
          .filter((node) => PAGE_SOURCE.test(node) && !node.includes("#"));
        const texts = await Promise.all(files.map((file) => head.read(file)));
        for (const [i, file] of files.entries()) {
          const text = texts[i];
          if (text !== undefined) pages.set(file, text);
        }
        const seeds = tools.selectorSources(pages, [...selectors]);
        if ("reason" in seeds) return { all: seeds.reason };
        return {
          seeds: seeds.files,
          note: `${selectors.size} changed selectors, rendered by ${seeds.files.length} sources`,
        };
      } catch (error) {
        return { all: `couldn't diff the compiled CSS: ${messageOf(error)}` };
      }
    },
  };
}
