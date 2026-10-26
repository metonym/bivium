# bivium

> Run only the tests a change can affect, and never miss one.

bivium builds a static, file-level dependency graph of a repository and walks it backwards from the files a change touches to the tests that reach them. It fails closed: anything it can't read (a non-literal `import()`, an unresolved specifier, a disk read with no declared inputs) counts as depending on everything, and a change it can't place runs the whole suite, with a reason. It picks the tests; your runner runs them.

It has no dependencies and needs no install of the repository it plans: it reads the git index and the working tree, never `node_modules`. CI can plan in a job that skips the install, and skip the test jobs whose selection is `none`. It runs on Node ≥ 22 and Bun. It was extracted from [carbon-components-svelte](https://github.com/carbon-design-system/carbon-components-svelte)'s `test:changed`.

```sh
bun add -d bivium
```

```ts
// bivium.config.ts
import { defineConfig } from "bivium";

export default defineConfig({
  suites: {
    unit: { tests: "tests/**/*.test.ts", run: "vitest run {files}", root: "tests" },
    e2e: {
      tests: "e2e/**/*.test.ts",
      run: "playwright test {files}",
      root: "e2e",
      urls: { "/*": "e2e/fixtures/*" }, // page.goto("/x.html") → e2e/fixtures/x.html
    },
  },
  roots: ["src", "tests", "e2e"], // a changed file outside them runs everything
  ignore: ["**/*.md", "docs/**"],
});
```

```console
$ bunx bivium plan
unit tests: 3 files
  tests/Button.test.ts
  tests/Modal.test.ts
  tests/css/unknown.test.ts
e2e tests: none
$ bunx bivium run --suite unit     # vitest run tests/Button.test.ts …
```

## What it reads

A one-pass lexer reads JavaScript and TypeScript (`.js`, `.ts`, `.jsx`, `.tsx`, and their `m`/`c` variants), the scripts and markup expressions of `.svelte`, the scripts of `.vue`, `.astro` and `.html`, and the `script[src]`, `link[href]` and `iframe[src]` of `.html`. Only code counts: an import spelled in a string or a comment adds no edge.

| It follows | As |
|:---|:---|
| Static, side-effect and dynamic imports, `export … from`, `require()` | Edges to every file the specifier can load: each extension that exists, each `exports` condition |
| `vi.mock()`, `vi.importActual()` and the rest of the family | Edges |
| `import.meta.glob()` | Every matching file, now and later |
| JSDoc `@type {import("x")}` and `@import` | Edges (TypeScript reads them) |
| `page.goto("/x.html")` in a suite with `urls` | An edge to the page |
| Named imports from a module made only of re-exports | An edge to the one file that exports each name, when the package declares `sideEffects` |
| A file's own package and its ancestors' `package.json` dependencies, and builtins | `pkg:` nodes |
| Anything else | Unknown: the file depends on every change |

A file it can't lex cleanly is read by a regex extractor instead, which over-approximates. CSS isn't scanned: generated stylesheets reach their inputs through `edges`, and a [narrower](#narrowers) can do better.

## Config

`bivium.config.ts` (or `.mts`, `.mjs`, `.js`, `.json`) in the repository root, or `--config <file>`. A `.ts` config needs Bun or Node ≥ 22.18. Every glob key takes one glob or a list. An unknown key is an error, since a misspelled one would quietly select less.

| Key | Meaning |
|:---|:---|
| `suites.<name>.tests` | The suite's test files |
| `suites.<name>.run` | The command `bivium run` runs. `{files}` is replaced by the selection (nothing for `all`); without it, the files are appended |
| `suites.<name>.root` | Where the orphan rule applies: a changed file here that no test of the suite reaches is wired some other way (a setup file, a runner config), so the whole suite runs. Default: the whole repository |
| `suites.<name>.urls` | URL pattern → file pattern, for `page.goto()` calls under `root` |
| `suites.<name>.pages` | Pages only a `goto()` opens; files only they load are wired to no test |
| `suites.<name>.wiring` | Files whose change runs the whole suite: another harness, a runner config |
| `suites.<name>.nonInputs` | Files under `root` the runner never reads, such as type-check inputs |
| `suites.<name>.output` | The step output `plan --github` writes. Default: `<name>-tests` |
| `roots` | Paths the graph reads. A changed file outside them that isn't ignored runs everything. Default: the whole repository |
| `ignore` | Files no test can observe. A file some test reaches still counts |
| `alias` | Specifier prefix → path, as the bundler aliases it. Tried before `package.json` `exports` |
| `edges` | Generated file glob → its inputs: `{ "dist/*.css": "styles/**" }` |
| `self` | The selector's own files: a change to one runs everything. The config file is always one |
| `importOnly` | Files only an import reaches: deleting one never orphans a suite |
| `barrels` | Modules that may bind named imports. Default: every module made only of re-exports |
| `external` | Packages a dependency installs that your code imports without declaring |
| `extensions` | Suffixes tried after a specifier |
| `deadGlobs` | Dead globs `check` allows, each `{ file, glob, reason }`, the glob as `file` spells it |
| `narrowers` | See [Narrowers](#narrowers) |
| `base` | The default base ref. Otherwise the upstream default branch (`origin/HEAD`, then `origin/main`, `origin/master`, `main`, `master`) |
| `cache` | The cache's directory, or `false`. Default: `node_modules/.cache/bivium`, or `.bivium/cache` |

## Annotations

| Comment | Meaning |
|:---|:---|
| `// @depends-on <glob> [glob…]` | Inputs that aren't imports: files a script reads, a tool it spawns. Transitive. A file that reads the disk without one is unknown |
| `// @reads <glob> [glob…]` | Files read as text. Only a direct change to one counts, not a change to what it imports |
| `// @glob-registry` | This file's `import.meta.glob` is a lookup table and adds no edges: whatever loads an entry names it itself |

## CLI

| Command | Does |
|:---|:---|
| `bivium plan [base] [--json] [--github]` | Prints each suite's selection: `all`, `none` or the files, and why a suite runs in full. `--json` adds the base, merge base, changed files and narrower results. `--github` also writes each suite's selection to `$GITHUB_OUTPUT` |
| `bivium run [base] [--suite <name>]` | Runs the suite's `run` command with its selection (default: the first suite), or skips it when nothing is affected |
| `bivium why <test> [file]` | The shortest chain of edges from a changed file, or from `file`, to the test, with the line that spells each edge |
| `bivium check [--max-unknown <n>]` | Lists every node with unknown dependencies, with where and how to fix each cause, and fails when more than `n` of them reach a test. A node no test depends on is listed apart and not counted: plans only run tests, so it widens nothing. Also lists [dead globs](#dead-globs), and fails on one `deadGlobs` doesn't allow or on an entry that matches none |

`--config`, `--cwd` and `--no-cache` work with every command, and `why` and `check` take `--base <ref>`. An unknown option is an error.

```console
$ bunx bivium why tests/Modal.test.ts
tests/Modal.test.ts
└─ import  src/Modal/Modal.svelte    tests/Modal.test.ts:3
   └─ import  src/Button/Button.svelte    src/Modal/Modal.svelte:12
      ● changed
```

## Dead globs

A typo'd `@depends-on`, or one pointing only at files the planner skips, looks fine and never selects its file. `check` evaluates every `@depends-on`, `@reads` and `import.meta.glob` pattern against every file git lists (tracked and untracked, inside the roots or not) and reports one that:

| Problem | Means |
|:---|:---|
| matches nothing | No file matches: a typo or a stale path |
| matches only ignored files, partly ignored | Some matches are ignored and not in the graph, so a change to one selects nothing |

An ignored file the graph reads still seeds a walk, and a change outside the roots runs everything, so neither is dead. A glob that's dead on purpose goes in `deadGlobs` with a reason:

```ts
deadGlobs: [
  { file: "tests/css/tokens.test.ts", glob: "docs/src/**", reason: "docs-only changes skip CI" },
],
```

## CI

Plan in a job of its own, before any install, and feed each suite's job its selection:

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      unit: ${{ steps.plan.outputs.unit-tests }}
      e2e: ${{ steps.plan.outputs.e2e-tests }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - id: merge-base
        run: echo "sha=$(git merge-base origin/main HEAD)" >> "$GITHUB_OUTPUT"
      - uses: actions/cache@v6
        with:
          path: .bivium/cache
          key: bivium-${{ steps.merge-base.outputs.sha }}
          restore-keys: bivium-
      - id: plan
        # --bun: run on Bun, which loads a TypeScript config whatever Node
        # the runner has.
        run: bunx --bun bivium plan origin/main --github
  unit:
    needs: plan
    if: needs.plan.outputs.unit != 'none'
    steps:
      # …install, then run all tests or the selected files:
      - run: bunx vitest run ${{ needs.plan.outputs.unit != 'all' && needs.plan.outputs.unit || '' }}
```

The cache holds what bivium extracted from each file, keyed by git blob, so a warm plan reads only the files a branch changed. Key it on the merge base: a pull request can restore caches from the default branch, whose run at that commit is the one to hit. Without `node_modules`, the cache lives in `.bivium/cache`; it writes a `.gitignore` so it never shows up as a change.

## Narrowers

Some changes reach every test through a generated file: every page loads the compiled stylesheet, so any style edit selects every e2e test. A narrower replaces such a change's coarse seeds with finer ones from a semantic diff, such as the sources that render a changed CSS rule.

```ts
narrowers: [
  {
    name: "css",
    match: "styles/**", // the changed files it narrows
    opaque: "dist/*.css", // the generated nodes its seeds stand in for
    suites: ["e2e"],
    async narrow({ base, head, changed, graph }) {
      const rules = diffRules(await compile(base.commit), await compile(head.commit));
      if (!rules) return { all: "a rule that requires no class changed" };
      return { seeds: sourcesSpelling(rules), note: `${rules.length} rules changed` };
    },
  },
],
```

The matched files still seed the walk, but it stops at the `opaque` nodes, and the seeds stand in for them. A narrower can only narrow: its suites' selection is cut to what the walk without it selects. One that returns `{ all: reason }`, throws, or returns anything else runs its suites in full with the reason. `narrow()` gets the repository `root`, the merge base and the working tree as `base` and `head` (each with `commit` and `read(path)`), the matched `changed` files, and a read-only `graph` (`nodes()`, `importers(node)`, `dependents(nodes)`, `tests(suite)`). [`eval/carbon/css-narrower.ts`](eval/carbon/css-narrower.ts) is carbon-components-svelte's, over crassus.

## From code

```ts
import { defineConfig, plan } from "bivium";

const config = defineConfig({ suites: { unit: { tests: "tests/**/*.test.ts" } } });
const result = await plan({ config, base: "origin/main" });
result.suites.unit; // { mode: "some", files: [...] }; result.suites.e2e is a type error
```

`plan(options?)` takes `cwd`, `base`, `config` (default: the config file in `cwd`) and `cache`, and returns each suite's selection, the reasons, the base, merge base and changed files, and what each narrower returned. Given a config, the suite names carry through to the result's type. The package exports only `plan`, `defineConfig` and their types.

## Compared with

| | Selects | Misses |
|:---|:---|:---|
| `vitest --changed`, `jest --changedSince` | Tests whose module graph reaches a changed file, from the runner's own resolver | Disk reads, fixtures, pages a test visits, config and setup wiring |
| Playwright `--only-changed` | Test files whose imports changed | The pages a test opens and what they load |
| Nx, Turborepo | Whole projects whose inputs changed | Nothing within a project's declared inputs, at project granularity |
| Bazel | Targets whose declared inputs changed | Nothing, if every input is declared |
| bivium | Test files, across runners and file types, from one graph | Nothing it can see; what it can't, it runs |
