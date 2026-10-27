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
   * calls are read. Default: the whole repository.
   */
  root?: Globs;
  /** URL pattern → file pattern for `page.goto()`: `{ "/*": "e2e/fixtures/*" }`. */
  urls?: Readonly<Record<string, string>>;
  /** Pages only a `goto()` opens. A changed file that only such pages load, and that no test opens, is wired to no test. */
  pages?: Globs;
  /** Files whose change runs the whole suite: a second harness, a runner config. */
  wiring?: Globs;
  /** Files under `root` the runner never reads, such as type-check inputs: exempt from the orphan rule. */
  nonInputs?: Globs;
  /** The step output `bivium plan --github` writes the selection to. Default: `<name>-tests`. */
  output?: string;
}

/** A `bivium.config.ts`. `Suite` is the union of the suite names. */
export interface Config<Suite extends string = string> {
  suites: Readonly<Record<Suite, SuiteConfig>>;
  /** Plugins that narrow what a change to some files selects. */
  narrowers?: readonly Narrower<NoInfer<Suite>>[];
  /** Paths (directories or files) the graph reads. A changed file outside them that isn't ignored runs everything. Default: the whole repository. */
  roots?: Globs;
  /** Files no test can observe. A file some test reaches still counts. */
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
   */
  inert?: Globs;
  /** Suffixes tried after a specifier, in order. */
  extensions?: readonly string[];
  /**
   * Globs `bivium check` allows to be dead: an `@depends-on`, `@reads` or
   * `import.meta.glob` pattern in `file`, or an `edges` or `reads` key or
   * value when `file` is the config's, as written there, that matches no
   * file or matches files a change to which selects nothing (ignored, and
   * not in the graph). Each needs a reason, and an entry that matches no
   * dead glob fails the check, so the list stays current.
   */
  deadGlobs?: readonly { file: string; glob: string; reason: string }[];
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
