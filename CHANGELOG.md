# Changelog

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
