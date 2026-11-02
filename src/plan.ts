import {
  inRoot,
  type ResolvedConfig,
  type ResolvedNarrower,
  type ResolvedSuite,
} from "./config.ts";
import { affectedBy, type Graph } from "./graph.ts";
import { type PackageDiff, packageSeeds } from "./lockfile.ts";
import type { FullRunCause, NarrowResult, Selection } from "./types.ts";

export interface Plan {
  suites: Record<string, Selection>;
  // Why a suite falls back to a full run, as sentences and as data.
  reasons: string[];
  causes: FullRunCause[];
  // Each suite's test count.
  totals: Record<string, number>;
  full: string[];
  // What a lockfile or `package.json` change seeded or left out, a line per
  // changed package.
  packages: string[];
  // What the walk started from, and each narrowed suite's narrowers: enough
  // to walk again and explain a selection.
  seeds: string[];
  // Changed ignored files the graph has: they seed the walk, but no unknown
  // node depends on them.
  quiet: string[];
  // The changed paths added or deleted, which seed `@lists`.
  layout: ReadonlySet<string>;
  // `pkg:` seed → the package change it stands for.
  packageCauses: Map<string, string>;
  narrowings: Map<string, Narrowing[]>;
}

export interface Narrowed {
  narrower: ResolvedNarrower;
  result: NarrowResult;
}

export interface PlanOptions {
  // Barrel-name nodes (`src/index.js#Button`) whose target moved.
  barrelNames?: string[];
  // The changed paths added or deleted: only they select an `@lists`.
  layout?: ReadonlySet<string>;
  narrowed?: Narrowed[];
  // What the changed lockfiles and `package.json` files changed.
  packages?: PackageDiff;
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

interface Changes {
  // Changed files the graph places: the walk's seeds.
  relevant: string[];
  // Changed ignored files the graph has. No test can observe one except
  // through an edge to it, so they seed the walk without selecting the
  // tests that depend on every change, and the orphan rule skips them.
  quiet: string[];
  // Changed lockfiles and `package.json` files whose package diff stands in
  // for them. Each seeds the walk, for the files that read it, but isn't
  // subject to the orphan rule: the packages it changed are how it's wired.
  packageFiles: string[];
  runs: FullRuns;
}

// Why suites run in full, and which.
interface FullRuns {
  reasons: string[];
  causes: FullRunCause[];
  full: Set<string>;
  // Every suite, unless `suites` names some.
  add(cause: Omit<FullRunCause, "suites"> & { suites?: string[] }): void;
}

function fullRuns(config: ResolvedConfig): FullRuns {
  const reasons: string[] = [];
  const causes: FullRunCause[] = [];
  const full = new Set<string>();
  const all = config.suites.map((suite) => suite.name);
  return {
    reasons,
    causes,
    full,
    add(cause) {
      const suites = cause.suites ?? all;
      causes.push({ ...cause, suites });
      reasons.push(cause.message);
      for (const name of suites) full.add(name);
    },
  };
}

export function classify(
  graph: Graph,
  changed: string[],
  config: ResolvedConfig,
  packages?: PackageDiff,
): Changes {
  const runs = fullRuns(config);
  const relevant: string[] = [];
  const quiet: string[] = [];
  const packageFiles: string[] = [];
  for (const file of changed) {
    // `ignore` means "no test observes it", never "not a node": a file some
    // test reaches still selects that test.
    const read = graph.has(file);
    const ignored = config.isIgnored(file);
    if (!read && ignored) continue;
    const wired = config.suites.filter((suite) => suite.isWiring(file));
    const diffed = packages?.files.has(file) ?? false;
    if (config.isSelf(file)) {
      runs.add({
        kind: "self",
        file,
        message: `${file}: test selector changed`,
      });
      continue;
    }
    for (const suite of wired) {
      runs.add({
        kind: "wiring",
        suites: [suite.name],
        file,
        message: `${file}: wires the ${suite.name} suite`,
      });
    }
    // A wired lockfile still changes packages the other suites import.
    if (wired.length > 0 && !diffed) continue;
    if (diffed) {
      const reason = packages?.files.get(file);
      if (reason === undefined) {
        packageFiles.push(file);
      } else {
        runs.add({ kind: "lockfile", file, message: `${file}: ${reason}` });
      }
    } else if (read || config.roots.some((root) => inRoot(file, root))) {
      (ignored ? quiet : relevant).push(file);
    } else {
      runs.add({
        kind: "outside",
        file,
        message: `${file}: outside the dependency graph`,
      });
    }
  }
  return { relevant, quiet, packageFiles, runs };
}

// What a suite's narrowers select: the walk from the matched files stops at
// their opaque nodes, which their seeds stand in for, and the other seeds
// walk as usual. Cut to the coarse walk, so a narrower can only narrow.
function narrowedWalk(
  graph: Graph,
  seeds: string[],
  {
    quiet,
    layout,
    types,
  }: { quiet: string[]; layout: ReadonlySet<string>; types: boolean },
  coarse: Set<string>,
  narrowings: Narrowing[],
): Set<string> {
  const matched = new Set(narrowings.flatMap((narrowing) => narrowing.matched));
  const fine = affectedBy(
    graph,
    seeds.filter((seed) => !matched.has(seed)),
    { quiet, layout, types },
  );
  for (const narrowing of narrowings) {
    const walk = affectedBy(graph, [...narrowing.matched, ...narrowing.seeds], {
      opaque: narrowing.narrower.opaque,
      layout,
      types,
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
  {
    barrelNames = [],
    layout = new Set<string>(),
    narrowed = [],
    packages,
  }: PlanOptions = {},
): Plan {
  const { relevant, quiet, packageFiles, runs } = classify(
    graph,
    changed,
    config,
    packages,
  );
  const bumped =
    packages && packageFiles.length > 0
      ? packageSeeds(graph, config, packages, packageFiles)
      : { seeds: new Map<string, string>(), notes: [], reasons: [] };
  const { add, full } = runs;
  for (const unused of bumped.reasons) add({ kind: "package", ...unused });
  const seeds = [
    ...relevant,
    ...barrelNames,
    ...packageFiles,
    ...bumped.seeds.keys(),
  ];
  const affected = affectedBy(graph, seeds, { quiet, layout });
  // A suite that can't observe types walks without the type-only edges.
  let runtime: Set<string> | undefined;
  const affectedFor = (suite: ResolvedSuite) => {
    if (suite.types) return affected;
    runtime ??= affectedBy(graph, seeds, { quiet, layout, types: false });
    return runtime;
  };
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
      add({
        kind: "orphan",
        suites: [suite.name],
        file,
        message: `${file}: no ${suite.name} test imports it`,
      });
    }
  }

  const narrowings = new Map<string, Narrowing[]>();
  for (const { narrower, result } of narrowed) {
    const matched = relevant.filter(narrower.match);
    if (matched.length === 0) continue;
    if ("all" in result) {
      add({
        kind: "narrower",
        suites: narrower.suites,
        narrower: narrower.name,
        message: `${narrower.name}: ${result.all}`,
      });
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
    if (full.has(suite.name)) {
      suites[suite.name] = { mode: "all" };
      continue;
    }
    const coarse = affectedFor(suite);
    const narrowing = narrowings.get(suite.name);
    suites[suite.name] = select(
      narrowing
        ? narrowedWalk(
            graph,
            seeds,
            { quiet, layout, types: suite.types },
            coarse,
            narrowing,
          )
        : coarse,
      tests.get(suite.name) ?? [],
    );
  }
  return {
    suites,
    reasons: runs.reasons,
    causes: runs.causes,
    totals: Object.fromEntries(
      config.suites.map((suite) => [
        suite.name,
        tests.get(suite.name)?.length ?? 0,
      ]),
    ),
    full: [...full],
    packages: bumped.notes,
    seeds,
    quiet,
    layout,
    packageCauses: bumped.seeds,
    narrowings,
  };
}
