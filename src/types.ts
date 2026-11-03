// The public types, in one module that imports nothing, so the build can
// emit them as one declaration file.

/** One glob, or several. */
export type Globs = string | readonly string[];

/** A test suite: its files, how to run them, and how they're wired. */
export interface SuiteConfig {
  /** The suite's test files. */
  tests: Globs;
  /** The command `bivium run` runs. `{files}` is replaced by the selected files, or nothing for all of them; without it, they're appended. */
  run?: string;
  /**
   * Where the orphan rule applies: a changed file under one of these paths
   * that no test of the suite reaches is wired some other way (a setup
   * file, a runner config), so the whole suite runs. Also where `goto()`
   * calls are read. Paths, not globs. Default: the whole repository.
   */
  root?: string | readonly string[];
  /**
   * URL pattern → the page a `page.goto()` of it opens: `{ "/*":
   * "e2e/fixtures/*" }`. A list names the page first, then what else it
   * loads that no import says, such as a router's layouts; the page must
   * exist, and the rest are edges where they do.
   */
  urls?: Readonly<Record<string, string | readonly string[]>>;
  /** Pages only a `goto()` opens. A changed file that only such pages load, and that no test opens, is wired to no test. */
  pages?: Globs;
  /** Files whose change runs the whole suite: a second harness, a runner config. */
  wiring?: Globs;
  /**
   * Files the runner loads before every test (Vitest and Jest `setupFiles`,
   * Mocha `--require`, Playwright `globalSetup`): every test of the suite
   * depends on them, and on what they import.
   */
  setup?: Globs;
  /** Files under `root` the runner never reads, such as type-check inputs: exempt from the orphan rule. */
  nonInputs?: Globs;
  /**
   * Whether the suite's tests can observe types. `false` for a suite that
   * runs code (Vitest, Jest, Playwright, `bun test`): a change that reaches
   * its tests only through type-only edges (`import type`, `export type …
   * from`, JSDoc types, declaration files) selects none of them. For the
   * orphan rule only a declaration file counts as reached that way: list a
   * types-only module under `root` in `nonInputs`. Default:
   * `true`, for a type-checking suite (`tsc`, `vitest --typecheck`).
   */
  types?: boolean;
  /** The step output `bivium plan --github` writes the selection to. Default: `<name>-tests`. */
  output?: string;
}

/** A `bivium.config.ts`. `Suite` is the union of the suite names. */
export interface Config<Suite extends string = string> {
  suites: Readonly<Record<Suite, SuiteConfig>>;
  /** Plugins that narrow what a change to some files selects. */
  narrowers?: readonly Narrower<NoInfer<Suite>>[];
  /** Paths (directories or files, not globs) the graph reads. A changed file outside them that isn't ignored runs everything. Default: the whole repository. */
  roots?: string | readonly string[];
  /**
   * Files no test can observe except through an edge (docs, stories). A
   * change to one selects only the tests that reach it: it never runs a
   * suite by the orphan rule, and doesn't select the tests whose
   * dependencies are unknown.
   */
  ignore?: Globs;
  /** Specifier prefix → path, as the bundler aliases it: `{ "my-package": "src" }`. Tried before `package.json` `exports`. */
  alias?: Readonly<Record<string, string>>;
  /**
   * Generated file glob → its inputs, which it depends on transitively, as
   * with `@depends-on`: `{ "dist/*.css": ["styles/**"] }`. In an input,
   * `$1`, `$2`… stand for what the key's wildcards (`*`, `**`, `?`, `{…}`,
   * numbered from the left) matched: `{ "dist/*.css": "styles/$1.scss" }`.
   */
  edges?: Readonly<Record<string, Globs>>;
  /**
   * File glob → the files it reads as text, as with `@reads`: only a direct
   * change to one of them counts, not a change to what it imports, and
   * their unknown dependencies don't spread to it. Values take `$1`… as in
   * `edges`: `{ "tests/*.test.ts": "tests/__snapshots__/$1.test.ts.snap" }`.
   */
  reads?: Readonly<Record<string, Globs>>;
  /** The selector's own files, which can't be trusted to select themselves. The config file is always one. */
  self?: Globs;
  /** Files only an import reaches. Deleting one never orphans a suite: an importer left pointing at it doesn't resolve, so it runs anyway. */
  importOnly?: Globs;
  /**
   * Files whose disk reads and non-literal imports reach no file of the
   * repository: a library's `fs` calls on the paths its caller passes, a
   * test that reads only the temporary files it writes. Those add no
   * unknown; an `@depends-on` or `@reads` still declares what one does read.
   */
  hermetic?: Globs;
  /** Modules that may bind named imports as barrels. Default: every module made only of re-exports. */
  barrels?: Globs;
  /** Packages to treat as external though no `package.json` declares them: ones a dependency installs. Any other undeclared bare specifier is unknown. */
  external?: readonly string[];
  /**
   * Packages no test uses except by importing them: linters, formatters,
   * type packages and other tools CI runs on its own (`@biomejs/biome`,
   * `knip`, `@types/*`). Globs over package names. A lockfile change selects
   * the importers of each package it changes, and of each package that
   * depends on one; a changed package that reaches a declared or imported
   * package no test imports runs everything, unless that package is here.
   * With `loadedByName` set, only packages with a `bin` need listing.
   */
  inert?: Globs;
  /**
   * Packages a test may load other than by an import bivium sees: a test
   * environment, a plugin a config names by string (`jsdom`, `happy-dom`,
   * `ts-jest`). Globs over package names. Setting it, even to `[]`, says
   * every other package without an executable is loaded only by imports, so a lockfile
   * change that reaches one no test imports selects nothing beyond its
   * importers. A package with a `bin` in the lockfile is always taken to
   * be one a test may run. Default: unset, and any package may be.
   */
  loadedByName?: Globs;
  /** Suffixes tried after a specifier, in order. */
  extensions?: readonly string[];
  /**
   * Globs `bivium check` allows to be dead: an `@depends-on`, `@reads`,
   * `@lists` or `import.meta.glob` pattern in `file`, or an `edges` or
   * `reads` key or value or a suite's `setup` when `file` is the config's, as written there, that matches no
   * file or matches files a change to which selects nothing (ignored, and
   * not in the graph). Each needs a reason, and an entry that matches no
   * dead glob fails the check, so the list stays current.
   */
  deadGlobs?: readonly { file: string; glob: string; reason: string }[];
  /**
   * Nodes `bivium check` allows to have unknown dependencies, each with a
   * reason. With this set, even to `[]`, `check` fails on an unknown node some test
   * reaches that isn't listed, and on a listed node that's no longer
   * unknown, so a new unknown can't hide behind one that went away.
   */
  knownUnknowns?: readonly { file: string; reason: string }[];
  /** The default base ref. */
  base?: string;
  /** The extraction cache's directory, or `false` for none. Default: `node_modules/.cache/bivium`, or `.bivium/cache` without `node_modules`. */
  cache?: boolean | string;
}

/** A suite's selected tests. */
export type Selection =
  | { mode: "all" }
  | { mode: "none" }
  | { mode: "some"; files: string[] };

/** Why some suites run in full, for a program to act on. */
export interface FullRunCause<Suite extends string = string> {
  /**
   * `self`: the selector's own file changed. `wiring`: a suite's `wiring`
   * file. `outside`: a file outside the roots. `lockfile`: a lockfile
   * added, deleted, unreadable, or with changed settings. `package`: a
   * changed package no test imports.
   * `orphan`: a file under a suite's `root` no test of it reaches.
   * `narrower`: a narrower that couldn't decide.
   */
  kind:
    | "self"
    | "wiring"
    | "outside"
    | "lockfile"
    | "package"
    | "orphan"
    | "narrower";
  /** The suites it runs in full. */
  suites: Suite[];
  /** The changed file, when one is the cause. */
  file?: string;
  /** For `package`: the package no test imports. */
  package?: string;
  /** For `narrower`: its name. */
  narrower?: string;
  /** The sentence `reasons` has for it. */
  message: string;
}

/** Options for {@link plan}. */
export interface PlanOptions<Suite extends string = string> {
  /** The repository. Default: the current directory. */
  cwd?: string;
  /** The ref to compare the working tree with. Default: the config's `base`, else the upstream default branch. */
  base?: string;
  /** The config. Default: the `bivium.config.*` file in `cwd`. */
  config?: Config<Suite>;
  /** Overrides the config's `cache`: a directory, or `false` for none. */
  cache?: boolean | string;
}

/** What {@link plan} selected. */
export interface PlanResult<Suite extends string = string> {
  /** Each suite's tests: `all`, `none`, or the files that can be affected. */
  suites: Record<Suite, Selection>;
  /** Why a suite runs in full. */
  reasons: string[];
  /** The same, as data: one per reason, in order. */
  causes: FullRunCause<Suite>[];
  /** How many test files each suite has. */
  totals: Record<Suite, number>;
  /** A line per package a lockfile or `package.json` change changed, and that selects through its importers or nothing: `bun.lock: svelte 5.1.0 → 5.2.0`. */
  packages: string[];
  /** The base ref. */
  base: string;
  /** The merge base of `base` and `HEAD`, which the working tree is compared with. */
  mergeBase: string;
  /** The files changed since the merge base, untracked ones included. */
  changed: string[];
  /** What each narrower that ran returned. */
  narrowed: { name: string; result: NarrowResult }[];
}

/** A tree a narrower reads files from. */
export interface Tree {
  /** The commit, or `undefined` for the working tree. */
  commit: string | undefined;
  /** A file's text in this tree, or `undefined` if it has none. */
  read(path: string): Promise<string | undefined>;
}

/** The working tree's dependency graph, read-only. */
export interface GraphView<Suite extends string = string> {
  /** Every node: repository files, barrel names (`src/index.js#Button`) and packages (`pkg:svelte`). */
  nodes(): readonly string[];
  /** The nodes that import `node` directly. */
  importers(node: string): readonly string[];
  /** Every node that depends on one of `nodes`, transitively and including them, not counting files whose dependencies are unknown. */
  dependents(nodes: Iterable<string>): ReadonlySet<string>;
  /** A suite's test files. */
  tests(suite: Suite): readonly string[];
}

/** What a narrower is given. */
export interface NarrowContext<Suite extends string = string> {
  /** The repository's root directory. */
  root: string;
  /** The merge base, which the working tree is compared with. */
  base: Tree;
  /** The working tree. */
  head: Tree;
  /** The changed files the narrower matches. */
  changed: readonly string[];
  graph: GraphView<Suite>;
}

/**
 * Finer seeds for the matched files, with an optional line for the CLI to
 * print, or why the narrower can't tell: its suites then run in full.
 */
export type NarrowResult =
  | { seeds: readonly string[]; note?: string }
  | { all: string };

/**
 * Replaces the coarse seeds of some changed files with finer ones from a
 * semantic diff: a stylesheet change seeded with the sources that render a
 * changed rule, instead of every page that loads the stylesheet.
 *
 * The matched files still seed the walk, but it stops at the `opaque`
 * nodes they reach the tests through; the narrower's seeds stand in for
 * those. A narrower can only narrow: its selection is cut to what the
 * coarse walk selects. One that can't decide returns `{ all: reason }`, and
 * one that throws counts as that.
 */
export interface Narrower<Suite extends string = string> {
  /** Names it in reasons: `css/: …`. */
  name: string;
  /** The changed files it narrows. */
  match: Globs;
  /** The generated nodes its seeds stand in for, such as `dist/*.css`. */
  opaque: Globs;
  /** The suites it narrows. Default: every suite. */
  suites?: readonly Suite[];
  narrow(context: NarrowContext<Suite>): NarrowResult | Promise<NarrowResult>;
}
