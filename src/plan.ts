import {
  inRoot,
  type ResolvedConfig,
  type ResolvedNarrower,
  type ResolvedSuite,
} from "./config.ts";
import {
  affectedBy,
  DECLARATION,
  type Graph,
  reaches,
  walksByTypes,
} from "./graph.ts";
import { type PackageDiff, packageSeeds } from "./lockfile.ts";
import type { FullRunCause, NarrowResult, Selection } from "./types.ts";

export interface Plan {
  suites: Record<string, Selection>;
  // Why a suite falls back to a full run, as sentences and as data.
  reasons: string[];
  causes: FullRunCause[];
  totals: Record<string, number>;
  full: string[];
  // What a lockfile or `package.json` change seeded or left out, a line per
  // changed package.
  packages: string[];
  // What the walk started from, and each narrowed suite's narrowers: enough
  // to walk again and explain a selection.
  seeds: string[];
  quiet: string[];
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
  // Why suites run in full.
  causes: FullRunCause[];
}

export function classify(
  graph: Graph,
  changed: string[],
  config: ResolvedConfig,
  packages?: PackageDiff,
): Changes {
  const causes: FullRunCause[] = [];
  const all = config.suites.map((suite) => suite.name);
  const runAll = (cause: Omit<FullRunCause, "suites">) =>
    causes.push({ ...cause, suites: all });
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
      runAll({
        kind: "self",
        file,
        message: `${file}: test selector changed`,
      });
      continue;
    }
    for (const suite of wired) {
      causes.push({
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
        runAll({ kind: "lockfile", file, message: `${file}: ${reason}` });
      }
    } else if (read || config.roots.some((root) => inRoot(file, root))) {
      (ignored ? quiet : relevant).push(file);
    } else {
      runAll({
        kind: "outside",
        file,
        message: `${file}: outside the dependency graph`,
      });
    }
  }
  return { relevant, quiet, packageFiles, causes };
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

// Whether the orphan rule runs `suite` for a change to `file`, which isn't
// ignored: a changed config or helper file under its `root` that no test
// imports is wired in some other way (an undeclared setup file,
// webServer, …). `typed` when only type-only edges reach a test of a suite
// that runs code. `check` asks the same of every file under a root.
export function orphanOf(
  graph: Graph,
  config: ResolvedConfig,
  suite: ResolvedSuite,
  file: string,
): { typed: boolean } | undefined {
  if (!suite.roots.some((root) => inRoot(file, root))) return undefined;
  // The walk stops at the first test or page it reaches. A page is opened
  // by a test's goto(), which the graph reads, so a page no test reaches,
  // and the files only such pages load, are wired to no test at all. A
  // suite that runs code is reached only at runtime: a file a test just
  // type-imports may still be one the runner loads. A declaration file
  // never is.
  const wired = (path: string) => suite.isTest(path) || suite.isPage(path);
  if (
    reaches(graph, [file], wired, {
      includeUnknown: false,
      types: suite.types || DECLARATION.test(file),
    })
  ) {
    return undefined;
  }
  const deleted = !graph.has(file);
  if (deleted && suite.isTest(file)) return undefined;
  // An importer left pointing at a deleted import-only file can't resolve
  // it, so it runs as unknown anyway.
  if (deleted && config.isImportOnly(file)) return undefined;
  if (suite.isNonInput(file)) return undefined;
  const typed =
    !suite.types &&
    reaches(graph, [file], suite.isTest, { includeUnknown: false });
  return { typed };
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
  const { relevant, quiet, packageFiles, causes } = classify(
    graph,
    changed,
    config,
    packages,
  );
  const bumped =
    packages && packageFiles.length > 0
      ? packageSeeds(graph, config, packages, packageFiles)
      : { seeds: new Map<string, string>(), notes: [], reasons: [] };
  const all = config.suites.map((suite) => suite.name);
  for (const unused of bumped.reasons) {
    causes.push({ kind: "package", suites: all, ...unused });
  }
  const seeds = [
    ...relevant,
    ...barrelNames,
    ...packageFiles,
    ...bumped.seeds.keys(),
  ];
  const affected = walksByTypes(graph, seeds, { quiet, layout });
  const nodes = [...graph.keys()];
  const tests = new Map(
    config.suites.map((suite) => [suite.name, nodes.filter(suite.isTest)]),
  );

  for (const suite of config.suites) {
    for (const file of relevant) {
      const orphan = orphanOf(graph, config, suite, file);
      if (!orphan) continue;
      const { typed } = orphan;
      causes.push({
        kind: "orphan",
        suites: [suite.name],
        file,
        message: `${file}: no ${suite.name} test imports it${typed ? " (only type imports reach it: list it in the suite's `nonInputs` if nothing loads it at runtime)" : ""}`,
      });
    }
  }

  const narrowings = new Map<string, Narrowing[]>();
  for (const { narrower, result } of narrowed) {
    const matched = relevant.filter(narrower.match);
    if (matched.length === 0) continue;
    if ("all" in result) {
      causes.push({
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

  const full = new Set(causes.flatMap((cause) => cause.suites));
  const suites: Record<string, Selection> = {};
  for (const suite of config.suites) {
    if (full.has(suite.name)) {
      suites[suite.name] = { mode: "all" };
      continue;
    }
    const coarse = affected(suite.types);
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
    reasons: causes.map((cause) => cause.message),
    causes,
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
