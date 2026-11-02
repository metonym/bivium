# Changelog

## Unreleased

**Performance**

- The walk tests each distinct `edges`, `@depends-on`, `import.meta.glob`
  and `reads` pattern once per node it visits, however many files
  declare it, and looks a pattern without a wildcard up. An `edges`
  entry that gives every test the same input
  (`{ "tests/*.test.ts": "src/setup.ts" }`) made a plan quadratic in the
  tests: with 4,000 tests a plan took 0.81 s, and now 0.08 s (#39).
- A plan that reads files (no cache, or a cache miss) holds only what
  it extracted from each, not the file's text, and reads 64 files at a
  time. On 7,000 files (23 MB) a cold plan needs a 20 MB heap on Node
  instead of over 64 MB, and peaks at 124 MB of RSS instead of 285 MB
  (Bun: 88 MB instead of 115 MB), and is no slower (#42).

**Breaking changes**

- A changed `ignore`d file the graph reads selects only the tests that
  reach it through an edge. It no longer trips the orphan rule (with
  the default `root`, any ignored change ran the whole suite), and no
  longer selects the tests whose dependencies are unknown, so a
  docs-only change selects `none` (#31, #32).
- A suite's `root`, and `roots`, with a wildcard is an error. Both take
  paths, so `root: "components/**"` matched nothing and the orphan rule
  quietly stopped for it: a change no test reached selected nothing
  instead of the suite (#21).

**Features**

- `suites.<name>.types: false` says a suite runs code and can't observe
  types: a change that reaches its tests only through `import type`,
  `export type … from`, JSDoc types or declaration files selects none
  of them, and still counts as reaching them for the orphan rule. The
  default, `true`, keeps today's selection, which a type-checking suite
  needs. `why` labels these edges `type` (`type-imported by`) whatever
  the setting, and a type import from `fs` no longer counts as reading
  the disk (#38).
- An `edges` key can name generated files git doesn't list: an import
  of `.velite`, `../.contentlayer/generated` or a `paths` alias for
  one resolves to the file the key matches, with an extension or as an
  index, instead of being unresolved, and depends on the key's inputs
  (#20).

**Fixes**

- A specifier that starts with a dot but not `./` or `../`
  (`.velite`) is bare, as TypeScript and Node read it, so tsconfig
  `paths` and `alias` apply to it. An HTML `src=".well-known/x.js"`
  is still relative (#20).
- An `alias` key that ends in `/` (`{ "@/": "src/" }`, as Vite
  configs spell it) matches the specifiers that start with it. It
  matched none, so each was unresolved (#29).
- A missing `x.js` resolves to `x.tsx` and `x.d.ts` as well as
  `x.ts` (`x.cjs` to `x.cts` and `x.d.cts`, `x.mjs` to `x.mts` and
  `x.d.mts`), and the rewrite applies to `exports` and `imports`
  targets too, so `@acme/ui/Button.js` reaches
  `packages/ui/src/Button.ts` through `"./*": "./src/*"` (#28).
- A doubled slash in a specifier resolves through `alias` and tsconfig
  `paths`, as it already did for a relative one (#33).
- A file an `edges` or `reads` key names (without a wildcard) no longer
  counts as reading the disk without saying what, as one with its own
  `@depends-on` or `@reads` doesn't. A key with a wildcard still
  doesn't vouch for each file it matches (#22).
- The lexer reads a JSX element with type arguments in `.tsx`
  (`<List<string> items={[]} />`), which sent the file to the regex
  extractor (#30).
- `check` lists an unresolved specifier once per file, not once per
  import of it (an `import` and a `vi.mock()`).

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
