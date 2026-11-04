# Changelog

## 0.3.3 — 2026-11-03

**Performance**

- 0.3.2 fetched a partial clone's merge-base reads in one batch, to save
  round trips (#55). git already fetches reads made at once in parallel,
  so it saved none, and its check for missing blobs ran first: the batch
  is removed. A file unchanged since the merge base is still read from
  the working tree, and each path once.

**Fixes**

- A plan in a clone without the base branch, or without the history back
  to where the branch forked from it, such as `actions/checkout`'s
  default one-commit fetch, failed with `git diff … failed`. It now says
  which is missing, and that a shallow clone needs `fetch-depth: 0`.

**Docs**

- The README's CI section explains the checkout a plan needs: history
  back to the merge base, and when to add `filter: blob:none` (a large
  history) or leave it off (a small one).

## 0.3.2 — 2026-11-03

**Performance**

- In a partial clone (`filter: blob:none`), the merge-base versions a
  plan reads (a changed lockfile, `package.json` or barrel) are fetched
  in one round trip, where git fetched each on its own: on a CI runner,
  each took seconds. A file unchanged since the merge base is read from
  the working tree, with no git call (#55).

**Fixes**

- A change to a `tsconfig.json` (or a file one `extends`) or a
  `package.json` under `roots` selected no test, though it can change
  how every file under it resolves or runs: a `paths` mapping, `type`,
  `exports`. It now selects the tests of the files it governs, the ones
  it's the nearest of its kind to. A change that leaves the parsed file
  the same, or only changes `package.json` metadata such as `version`,
  still selects nothing (#54).

## 0.3.1 — 2026-11-03

**Features**

- `bivium check` lists the files under a suite's `root` that no test
  reaches and the config doesn't exempt: a change to any of them runs
  the whole suite by the orphan rule. Each comes with a fix by what it
  looks like (`reads` for a test's snapshot, `wiring` for a runner's
  config, `nonInputs` otherwise), and `check --json` has them as
  `unreached`. It's reported, not a failure (#48).
- A `urls` value can be a list: the page first, then what else it loads
  that no import says, such as a router's layouts (`/about` →
  `app/(marketing)/about/page.tsx`, `app/(marketing)/layout.tsx`,
  `app/layout.tsx`). The page must exist; the rest are edges where they
  do (#26).
- A file's `@depends-on`, or an `edges` key that names it, now also
  covers its `goto()` calls whose URL bivium can't read, such as a loop
  over a list of routes: list the pages they open, and the file is no
  longer unknown (#27).

## 0.3.0 — 2026-11-02

**Breaking changes**

- A changed `ignore`d file the graph reads selects only the tests that
  reach it through an edge. It no longer trips the orphan rule (with
  the default `root`, any ignored change ran the whole suite), and no
  longer selects the tests whose dependencies are unknown, so a
  docs-only change selects `none` (#31, #32).
- A suite's `root`, and `roots`, with a wildcard is an error. Both take
  paths, so `root: "components/**"` matched nothing and the orphan rule
  quietly stopped for it (#21).
- A usage or configuration error (no command, an unknown command,
  option or suite) exits 2. It exited 1, as `check` does when it finds
  problems (#40).
- `plan`'s and `check`'s text output changed (see CLI).

**Features**

- `suites.<name>.types: false` says a suite runs code: a change that
  reaches its tests only through `import type`, `export type … from`,
  JSDoc types or declaration files selects none of them. The default
  keeps today's selection, which a type-checking suite needs. `why`
  labels these edges `type` (#38).
- `suites.<name>.setup` names the files a runner loads before every
  test (`setupFiles`, `--require`, `globalSetup`): every test of the
  suite depends on them and on what they import (#35).
- `// @lists <glob>` selects a test when a match is added, deleted or
  renamed, not when one is edited, for a test that lists files without
  reading them (#25).
- An `edges` key can name generated files git doesn't list, such as
  `.velite/*`: an import that resolves under it, with an extension or
  as an index, lands there instead of being unresolved (#20).
- A root `pnpm-lock.yaml` (v6 or v9) is diffed like `bun.lock`. Its
  settings, overrides, catalogs, patches and pnpm's own version still
  run everything, as does one bivium can't read (#34).
- `loadedByName` lists the packages a test may load other than by an
  import (`jsdom`, `ts-jest`). Set, any other package without a `bin`
  is import-only, so a lockfile bump that reaches one no test imports
  selects only its importers (#23).
- `knownUnknowns` lists the unknown nodes `check` allows, each with a
  reason, and `check` fails on one it doesn't list or an entry that's
  no longer unknown (#24).
- `bivium graph` ranks each suite's files by how many tests a change to
  one selects; `--json` exports the graph with each node's fan-in
  (#36).

**CLI**

- Options can come before the command, and `--help` or `-h` anywhere
  prints usage and exits 0.
- `plan` prints each selection's scale (`unit tests: 3 of 822 files`)
  and tells a full run (`all (full run)`) from every test reaching a
  change. `plan --json` and `plan()` add `totals`, and `causes`, each
  reason as data.
- `check` leads with counts by cause, and a fix for an unresolved
  specifier names the file that's there: a sibling with another
  extension, a file outside `roots`, or one git ignores.
- `why --format json` is `why --json` (#40).

**Performance**

- The walk tests each distinct pattern (`edges`, `@depends-on`,
  `import.meta.glob`, `reads`) once per node it visits, however many
  files declare it. With 4,000 tests and
  `{ "tests/*.test.ts": "src/setup.ts" }`, a plan took 0.81 s, and now
  0.08 s (#39).
- A plan that reads files holds only what it extracted from each, not
  the file's text, and reads 64 at a time. A cold plan of 7,000 files
  needs a 20 MB heap on Node instead of over 64 MB, and peaks at 124 MB
  of RSS instead of 285 MB (Bun: 88 MB instead of 115 MB) (#42).
- The orphan rule's walk from each changed file stops at the first test
  or page it reaches, as does the lockfile check for a package a test
  imports: with 350 changes in 5,900 files, the selection step took
  21.7 ms and now 8.1 ms.

**Fixes**

- An `alias` key that ends in `/` (`{ "@/": "src/" }`, as Vite
  configs spell it) matches the specifiers that start with it. It
  matched none (#29).
- A missing `x.js` resolves to `x.tsx` and `x.d.ts` as well as `x.ts`
  (and the `.mjs` and `.cjs` variants), through `exports` and `imports`
  targets too, so `@acme/ui/Button.js` reaches
  `packages/ui/src/Button.ts`. A value import that finds only `x.d.ts`
  is unknown: what runs isn't in the graph (#28).
- A doubled slash in a specifier resolves through `alias` and tsconfig
  `paths` (#33).
- A specifier that starts with a dot but not `./` or `../` (`.velite`)
  is bare, as TypeScript reads it (#20).
- An `edges` or `reads` key that names one file declares what it reads
  from disk, as `@depends-on` and `@reads` do (#22).
- The lexer reads a JSX element with type arguments in `.tsx`
  (`<List<string> />`) instead of falling back to the regex extractor
  (#30).
- A type import from `fs` doesn't count as reading the disk, and
  `check` lists an unresolved specifier once per file.

**Docs**

- The README has one table for what to do with a changed file no test
  reaches, recipes for Vitest and Jest, pnpm workspaces, Playwright
  and generated code, and what a plan costs in CI (#41).

## 0.2.1 — 2026-10-28

**Performance**

- `git merge-base` runs only when something needs the commit:
  `plan()`, `plan --json`, or a narrower whose files changed. Base
  versions of changed files are read by the blob ID the diff names.
  Git's CPU per plan drops 21 to 24% on carbon-components-svelte and
  sveld.
- A bare specifier is resolved once per owning `package.json` and
  nearest `tsconfig.json`, and probing checks only matching extensions:
  13 to 30% fewer instructions building the graph on real
  repositories.
- The lexer's first pass in a fresh process is 23% faster on Bun and
  32% on Node, with identical extractions.

**Fixes**

- Without the cache, a file staged as new and then deleted from disk
  no longer counts as present.

**Docs**

- The CI example clones with `filter: blob:none`: on
  carbon-components-svelte the checkout went from 6.3 s to 3.8 s.

## 0.2.0 — 2026-10-27

**Breaking changes**

- `bivium check` now reports an `edges` or `reads` key that matches no
  node, and a value that matches nothing for any match, so a config
  with a stale `edges` entry fails it. Allow one in `deadGlobs`.
- tsconfig `paths` and `baseUrl` are read, after `alias` and before
  `package.json` `exports`, so a specifier that was unresolved (and
  ran its tests on every change) may now resolve.
- `bivium why --json` reports the finer edge kinds and new fields.

**Features**

- A changed root `bun.lock` or `package-lock.json` seeds the packages
  it changed and their dependents instead of running everything. A
  changed package no test imports still runs everything unless it's
  listed in the new `inert` key.
- `edges` values can use `$1`, `$2`… for what the key's wildcards
  matched, and the new `reads` key is `@reads` in the config, for
  files that can't hold a comment (snapshots, `package.json`).
- `#name` subpath imports resolve through the importing file's own
  `package.json` `imports`.
- `%sveltekit.assets%/x` in an `app.html` maps to the project's
  `static/x`.
- `bivium why` names what spells each edge (`goto`, `html`, `name`,
  `export`, `depends-on`, `edges`, `reads`), aligns its columns, says
  how many other changes reach the test, and takes `--format
  tree|chain|source` and `--all`. A test that isn't selected says
  what the file's chains reach instead.

**Fixes**

- `bivium why` cites the call that spells an edge, not a comment that
  mentions the file.

## 0.1.2 — 2026-10-27

**Features**

- `hermetic` (globs) lists files whose disk reads and non-literal
  imports reach no file of the repository, such as a library's `fs`
  calls on its caller's paths. They no longer count as unknown; an
  unresolved import, a non-literal glob or `goto()`, and any
  `@depends-on` or `@reads` still do.

**Fixes**

- `bivium check` no longer counts a test that only `@reads` an
  unknown node as running on any change, which `plan` never does.

## 0.1.1 — 2026-10-26

**Fixes**

- `bivium --version` (and `-v`) prints the version instead of failing
  as an unknown command.

## 0.1.0 — 2026-10-26

The first release of bivium, the test selector extracted from
carbon-components-svelte's `test:changed`.

**Features**

- `bivium plan` prints each suite's selection (`all`, `none` or the test
  files) and why a suite runs in full; `--json` prints it with the base,
  merge base, changed files and narrower results; `--github` writes each
  suite's selection to `$GITHUB_OUTPUT` as `<name>-tests`, or a suite's
  `output`.
- `bivium run [--suite <name>]` runs a suite's command with its selection.
- `bivium why <test> [file]` prints the shortest chain of edges from a
  changed file, or from `file`, to a test, with the line of each edge.
- `bivium check [--max-unknown <n>]` lists the nodes whose dependencies
  can't be read, with locations, fixes and the tests each one makes run on
  any change, and fails when more than `n` reach a test. Ones no test
  reaches are listed apart: they widen no plan.
- `bivium check` fails on a dead glob: an `@depends-on`, `@reads` or
  `import.meta.glob` pattern that matches no file, or matches files that
  are ignored and outside the graph, so a change to them selects nothing.
  `deadGlobs` in the config allows one with a reason, and an entry that
  matches no dead glob fails the check too.
- `narrowers` in the config replace a change's coarse seeds with finer
  ones from a semantic diff. They can only narrow.
- `plan()` and `defineConfig()` from code; given a config, `plan()` types
  its result by the suite names.
- A one-pass lexer for JavaScript, TypeScript, JSX, Svelte, Vue, Astro and
  HTML, with a regex fallback, and an extraction cache keyed by git blob.

**Requirements**

- Node ≥ 22 (≥ 22.18 for a `bivium.config.ts`), or Bun.
