import {
  inRoot,
  type ResolvedConfig,
  type ResolvedNarrower,
} from "./config.ts";
import { affectedBy, type Graph } from "./graph.ts";
import type { NarrowResult, Selection } from "./types.ts";

export interface Plan {
  suites: Record<string, Selection>;
  // Why a suite falls back to a full run.
  reasons: string[];
  // The suites forced to run in full, by a reason.
  full: string[];
  // What the walk started from, and each narrowed suite's narrowers: enough
  // to walk again and explain a selection.
  seeds: string[];
  narrowings: Map<string, Narrowing[]>;
}

export interface Narrowed {
  narrower: ResolvedNarrower;
  result: NarrowResult;
}

export interface PlanOptions {
  // Barrel-name nodes (`src/index.js#Button`) whose target moved.
  barrelNames?: string[];
  narrowed?: Narrowed[];
}

// `all`, `none`, or the space-separated files, as CI step outputs.
export function formatSelection(selection: Selection): string {
  return selection.mode === "some" ? selection.files.join(" ") : selection.mode;
}

function select(affected: Set<string>, tests: string[]): Selection {
  const files = tests.filter((file) => affected.has(file));
  if (files.length === 0) return { mode: "none" };
  if (files.length === tests.length) return { mode: "all" };
  return { mode: "some", files };
}

interface Narrowing {
  matched: string[];
  narrower: ResolvedNarrower;
  seeds: readonly string[];
}

export interface Changes {
  // Changed files the graph places: the walk's seeds.
  relevant: string[];
  reasons: string[];
  // Suites that run in full.
  full: Set<string>;
}

export function classify(
  graph: Graph,
  changed: string[],
  config: ResolvedConfig,
): Changes {
  const reasons: string[] = [];
  const full = new Set<string>();
  const runAll = () => {
    for (const suite of config.suites) full.add(suite.name);
  };
  const relevant: string[] = [];
  for (const file of changed) {
    // `ignore` means "not a seed", never "not a node": a file some test
    // reaches still counts.
    const read = graph.has(file);
    if (!read && config.isIgnored(file)) continue;
    const wired = config.suites.filter((suite) => suite.isWiring(file));
    if (config.isSelf(file)) {
      reasons.push(`${file}: test selector changed`);
      runAll();
    } else if (wired.length > 0) {
      for (const suite of wired) {
        reasons.push(`${file}: wires the ${suite.name} suite`);
        full.add(suite.name);
      }
    } else if (read || config.roots.some((root) => inRoot(file, root))) {
      relevant.push(file);
    } else {
      reasons.push(`${file}: outside the dependency graph`);
      runAll();
    }
  }
  return { relevant, reasons, full };
}

// What a suite's narrowers select: the walk from the matched files stops at
// their opaque nodes, which their seeds stand in for, and the other seeds
// walk as usual. Cut to the coarse walk, so a narrower can only narrow.
function narrowedWalk(
  graph: Graph,
  seeds: string[],
  coarse: Set<string>,
  narrowings: Narrowing[],
): Set<string> {
  const matched = new Set(narrowings.flatMap((narrowing) => narrowing.matched));
  const fine = affectedBy(
    graph,
    seeds.filter((seed) => !matched.has(seed)),
  );
  for (const narrowing of narrowings) {
    const walk = affectedBy(graph, [...narrowing.matched, ...narrowing.seeds], {
      opaque: narrowing.narrower.opaque,
    });
    for (const node of walk) fine.add(node);
  }
  return new Set([...fine].filter((node) => coarse.has(node)));
}

// Picks the tests of each suite that `changed` can affect. `graph` is the
// head revision.
export function planTests(
  graph: Graph,
  changed: string[],
  config: ResolvedConfig,
  { barrelNames = [], narrowed = [] }: PlanOptions = {},
): Plan {
  const { relevant, reasons, full } = classify(graph, changed, config);
  const seeds = [...relevant, ...barrelNames];
  const affected = affectedBy(graph, seeds);
  const nodes = [...graph.keys()];
  const tests = new Map(
    config.suites.map((suite) => [suite.name, nodes.filter(suite.isTest)]),
  );

  // A changed setup/config/helper file that no test imports is wired in some
  // other way (setupFiles, webServer, …): run its whole suite.
  for (const suite of config.suites) {
    const suiteTests = tests.get(suite.name) ?? [];
    for (const file of relevant) {
      if (!suite.roots.some((root) => inRoot(file, root))) continue;
      const reach = affectedBy(graph, [file], { includeUnknown: false });
      if (suiteTests.some((test) => reach.has(test))) continue;
      const deleted = !graph.has(file);
      if (deleted && suite.isTest(file)) continue;
      // An importer left pointing at a deleted import-only file can't
      // resolve it, so it runs as unknown anyway.
      if (deleted && config.isImportOnly(file)) continue;
      if (suite.isNonInput(file)) continue;
      // A page is opened by a test's goto(), which the graph reads, so a
      // page no test reaches, and the files only such pages load, are wired
      // to no test at all.
      if ([...reach].some(suite.isPage)) continue;
      reasons.push(`${file}: no ${suite.name} test imports it`);
      full.add(suite.name);
    }
  }

  const narrowings = new Map<string, Narrowing[]>();
  for (const { narrower, result } of narrowed) {
    const matched = relevant.filter(narrower.match);
    if (matched.length === 0) continue;
    if ("all" in result) {
      reasons.push(`${narrower.name}: ${result.all}`);
      for (const name of narrower.suites) full.add(name);
      continue;
    }
    for (const name of narrower.suites) {
      const list = narrowings.get(name) ?? [];
      list.push({ matched, narrower, seeds: result.seeds });
      narrowings.set(name, list);
    }
  }

  const suites: Record<string, Selection> = {};
  for (const suite of config.suites) {
    suites[suite.name] = full.has(suite.name)
      ? { mode: "all" }
      : select(
          narrowings.has(suite.name)
            ? narrowedWalk(
                graph,
                seeds,
                affected,
                narrowings.get(suite.name) ?? [],
              )
            : affected,
          tests.get(suite.name) ?? [],
        );
  }
  return { suites, reasons, full: [...full], seeds, narrowings };
}
