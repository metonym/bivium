# Changelog

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
