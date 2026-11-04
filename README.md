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
unit tests: 3 of 12 files
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
| Static, side-effect and dynamic imports, `export … from`, `require()` | Edges to every file the specifier can load: each extension that exists, each `exports` condition. A missing `x.js` (`.jsx`, `.mjs`, `.cjs`) is its TypeScript source, as TypeScript reads it: `x.ts`, `x.tsx` or `x.d.ts`, through any path, alias or `exports` target. A value import that finds only `x.d.ts` is unknown: what runs isn't in the graph |
| `vi.mock()`, `vi.importActual()` and the rest of the family | Edges |
| `import.meta.glob()` | Every matching file, now and later |
| JSDoc `@type {import("x")}` and `@import` | Edges (TypeScript reads them) |
| `%sveltekit.assets%/x` in a SvelteKit `app.html` | An edge to `static/x` in the project, the nearest directory with a `svelte.config.*` or a `package.json`. `%sveltekit.head%`, `%sveltekit.body%` and the rest aren't references |
| `page.goto("/x.html")` in a suite with `urls` | An edge to the page |
| `compilerOptions.paths` and `baseUrl` of the nearest `tsconfig.json`, with its relative `extends` | Edges to every target that exists, tried after `alias` and before `package.json` `exports`. A `tsconfig.json` that doesn't parse maps nothing, and `check` lists it |
| `#name` subpath imports, through the `imports` of the importing file's own `package.json` | Edges to every condition's target that exists; an unmatched `#name` is unknown |
| Named imports from a module made only of re-exports | An edge to the one file that exports each name, when the package declares `sideEffects` |
| A file's own package and its ancestors' `package.json` dependencies, and builtins | `pkg:` nodes |
| Anything else | Unknown: the file depends on every change |

A root `bun.lock`, `package-lock.json` or `pnpm-lock.yaml` isn't a source file: a change to one seeds the packages it changed (see [Lockfiles](#lockfiles)).

Nor is a `tsconfig.json` (or a file one `extends`) or a `package.json` under `roots`: their options, `paths`, `type` or `exports` change how the files under them resolve or run, which no import says. A change to one seeds the files it governs, those it's the nearest of its kind to. A change the parsed file doesn't show (formatting, comments), or to a `package.json`'s metadata alone (`version`, `description`, `repository` and the like), seeds nothing, and a dependency change is the lockfile's.

A file it can't lex cleanly is read by a regex extractor instead, which over-approximates. CSS isn't scanned: generated stylesheets reach their inputs through `edges`, and a [narrower](#narrowers) can do better.

## Config

`bivium.config.ts` (or `.mts`, `.mjs`, `.js`, `.json`) in the repository root, or `--config <file>`. A `.ts` config needs Bun or Node ≥ 22.18. Every glob key takes one glob or a list. An unknown key is an error, since a misspelled one would quietly select less.

| Key | Meaning |
|:---|:---|
| `suites.<name>.tests` | The suite's test files |
| `suites.<name>.run` | The command `bivium run` runs. `{files}` is replaced by the selection (nothing for `all`); without it, the files are appended |
| `suites.<name>.root` | Where the orphan rule applies: a changed file here that no test of the suite reaches is wired some other way (a setup file, a runner config), so the whole suite runs. Paths, not globs (`e2e`, not `e2e/**`): a glob is an error. Default: the whole repository |
| `suites.<name>.urls` | URL pattern → file pattern, for `page.goto()` calls under `root`. A list names the page first, then what else it loads that no import says, such as a router's layouts: `{ "/*": ["app/(site)/*/page.tsx", "app/(site)/layout.tsx", "app/layout.tsx"] }`. The page must exist; the rest are edges where they do |
| `suites.<name>.pages` | Pages only a `goto()` opens; files only they load are wired to no test |
| `suites.<name>.setup` | Files the runner loads before every test (Vitest and Jest `setupFiles`, Mocha `--require`, Playwright `globalSetup`): every test of the suite depends on them and what they import. bivium doesn't read the runner's config, so name them here |
| `suites.<name>.wiring` | Files whose change runs the whole suite: another harness, a runner config |
| `suites.<name>.nonInputs` | Files under `root` the runner never reads, such as type-check inputs |
| `suites.<name>.types` | `false` when the suite runs code and can't observe types (Vitest, Jest, Playwright, `bun test`): a change that reaches its tests only through `import type`, `export type … from`, JSDoc types or a declaration file selects none of them. For the orphan rule a type-only reach counts only for a declaration file, since the runner may load any other file by name: list a types-only module under `root` in `nonInputs`. Default: `true`, which a type-checking suite (`tsc`, `vitest --typecheck`) needs. An inline `import { type A }` is always an edge: under `verbatimModuleSyntax` it still loads the module |
| `suites.<name>.output` | The step output `plan --github` writes. Default: `<name>-tests` |
| `roots` | Paths (not globs) the graph reads. A changed file outside them that isn't ignored runs everything. Default: the whole repository |
| `ignore` | Files no test can observe except through an edge (docs, stories). A change to one selects only the tests that reach it, never runs a suite by the orphan rule, and doesn't select the tests whose dependencies are unknown |
| `alias` | Specifier prefix → path, as the bundler aliases it. Tried before tsconfig `paths` and `package.json` `exports`. A key ending in `/` is the prefix, as Vite reads it: `{ "@/": "src/" }` maps `@/x` to `src/x` |
| `edges` | Generated file glob → its inputs, which it depends on transitively, as with `@depends-on`: `{ "dist/*.css": "styles/**" }`. A key may name files git doesn't list, such as a gitignored generator output (`{ ".velite/*": "content/**" }`): an import that resolves under it, by extension or as an index, lands on that file instead of being unresolved. In a value, `$1`, `$2`… are what the key's wildcards matched, counted from the left: `{ "examples/*/package.json": "examples/$1/**" }` |
| `reads` | File glob → the files it reads as text, as with `@reads`: only a direct change to one counts, so their imports and unknowns don't spread to it. An `edges` or `reads` key that names one file (no wildcard) declares what it reads, as its own `@depends-on` or `@reads` would, so its disk reads aren't unknown. Values take `$1`… as in `edges`: `{ "tests/*.test.ts": "tests/__snapshots__/$1.test.ts.snap" }` |
| `self` | The selector's own files: a change to one runs everything. The config file is always one |
| `importOnly` | Files only an import reaches: deleting one never orphans a suite |
| `hermetic` | Files whose disk reads and non-literal imports reach no file of the repository: a library's `fs` calls on its caller's paths, a test that reads only the temporary files it writes. They add no unknown |
| `barrels` | Modules that may bind named imports. Default: every module made only of re-exports |
| `external` | Packages a dependency installs that your code imports without declaring |
| `inert` | Packages no test uses except by importing them: linters, formatters, type packages (`["@biomejs/biome", "knip", "@types/*"]`). A [lockfile change](#lockfiles) that only they reach selects nothing. With `loadedByName` set, only packages with a `bin` need listing |
| `loadedByName` | Packages a test may load other than by an import: a test environment or a plugin a config names by string (`["jsdom", "ts-jest"]`). Setting it, even to `[]`, says every other package without a `bin` is loaded only by imports, so a [lockfile change](#lockfiles) that reaches one no test imports selects only its importers. A package with a `bin` always counts as one a test may run |
| `extensions` | Suffixes tried after a specifier |
| `deadGlobs` | Dead globs `check` allows, each `{ file, glob, reason }`, the glob as `file` spells it |
| `knownUnknowns` | Nodes `check` allows to have unknown dependencies, each `{ file, reason }`. With it set, even to `[]` (which is `--max-unknown 0`), `check` fails on an unknown node some test reaches that it doesn't list, and on an entry that's no longer unknown, so a new unknown can't replace one that went away |
| `narrowers` | See [Narrowers](#narrowers) |
| `base` | The default base ref. Otherwise the upstream default branch (`origin/HEAD`, then `origin/main`, `origin/master`, `main`, `master`) |
| `cache` | The cache's directory, or `false`. Default: `node_modules/.cache/bivium`, or `.bivium/cache` |

## A change no test reaches

A changed file under a suite's `root` that no test of the suite reaches is wired some other way (a runner config, a setup file), so the whole suite runs: the orphan rule. With the default `root`, the whole repository, any file bivium can't trace to a test runs the suite, which is sound and coarse. Set `root` on every suite to the directories its tests and sources live in, and say what the rest is:

| You changed… | and want… | Use |
|:---|:---|:---|
| a file no test can observe: docs, stories, a changelog | nothing to run, unless some test imports it | `ignore` |
| a file under the suite's `root` only another tool reads: type-check inputs | nothing to run for this suite | the suite's `nonInputs` |
| a runner config or a second harness | the whole suite | the suite's `wiring` |
| a setup file the runner loads before every test, or what it imports | every test of the suite | the suite's `setup` |
| the selector's config, or its own code | everything | `self` (the config file always is) |
| a declaration file, in a suite that runs code | nothing | the suite's `types: false` |
| a types-only module only `import type` reaches, in a suite that runs code | nothing | the suite's `types: false`, and the module in its `nonInputs` |
| a file a test lists but doesn't read (a route, a story) | the test, when one is added or deleted | `// @lists <glob>` in the test |
| a file a build turns into what tests load | the tests that load the output | `edges` from the output to its inputs |

A file outside `roots` that isn't ignored runs everything: it's the backstop for wiring the graph can't see, such as a CI workflow.

`bivium check` lists every file under a suite's `root` that no test reaches and the config doesn't exempt, with a fix for each by what it looks like: a test's snapshot, a runner's config, or anything else. It's the list to work through when adopting bivium, and a new entry is a gap someone just added.

## Recipes

**Vitest or Jest.** Name the setup files the runner loads, mirror `resolve.alias` (a Vite key like `"@/"` works as written), give snapshots to their tests, and, for a suite that runs code, skip type-only edges:

```ts
suites: {
  unit: {
    tests: "src/**/*.test.{ts,tsx}",
    run: "vitest run {files}",
    root: "src",
    setup: ["src/setupTests.ts"], // vitest.config.ts `setupFiles`
    wiring: ["vitest.config.ts"],
    types: false,
    nonInputs: ["src/**/types.ts"], // types only: nothing loads them at runtime
  },
},
alias: { "@/": "src/" },
reads: { "src/**/*.test.{ts,tsx}": "src/$1__snapshots__/$2.test.$3.snap" },
```

tsconfig `paths` (what `vite-tsconfig-paths` reads) are read without an `alias`. An extensionless `vi.mock("@/x")` resolves as an import does. A test environment the runner loads by name (`jsdom`, `happy-dom`) goes in `loadedByName` if you set it.

**pnpm workspaces.** Workspace packages resolve through their `package.json` `exports`, and a `.js` specifier into one (`@acme/ui/Button.js`) reaches its `.ts` source. A `pnpm-lock.yaml` change selects through the packages it changed. Set `roots` to the packages and apps whose changes the suites should see, and a suite per test runner.

**Playwright.** Map `page.goto()` URLs to the pages they open with `urls`, list pages only a `goto()` opens in `pages`, and name `playwright.config.ts` in `wiring`:

```ts
e2e: {
  tests: "e2e/**/*.spec.ts",
  root: "e2e",
  urls: { "/*": "e2e/fixtures/*.html" },
  wiring: ["playwright.config.ts"],
},
```

**Generated code.** A content or type generator that writes into a gitignored directory (`.velite`, `.contentlayer/generated`) is an `edges` entry from what it writes to what it reads: `{ ".velite/*": ["content/**", "velite.config.ts"] }`. An import of `#velite` or `../.velite` then reaches the content, and not every change.

## Lockfiles

A dependency bump changes a lockfile, which no file imports. When a root `bun.lock`, `package-lock.json` (v2 or v3) or `pnpm-lock.yaml` (v6 or v9) changes, bivium diffs it against the merge base and seeds the walk with the `pkg:` nodes of the packages whose entries changed, and of every package that depends on one, so a `svelte` bump selects what imports `svelte`, or a package built on it. A `package.json` whose only change is to dependencies the lockfile records the same way counts as those packages changing.

A changed package can also be used in ways the graph can't see: a CLI a test spawns, a runner, a type package. So when a change reaches a package that a `package.json` declares, or that some file imports, and that no test imports, everything runs, with the reason (`bun.lock: playwright 1.63.0 → 1.64.0, and no test imports it`), unless the package is `inert`. With `loadedByName` set, only a package with a `bin` in the lockfile, or one it lists, counts as used that way: a bump that reaches a library only a CMS config imports selects nothing. Everything also runs for a lockfile bivium can't parse, one whose settings other than its packages changed (`overrides`, patches, pnpm's `settings`, `catalogs`, or the version of pnpm itself), and a `package.json` change the lockfile doesn't record. Other lockfiles (`yarn.lock`, `bun.lockb`) are files like any other: outside the roots, a change to one runs everything.

```console
$ bunx bivium plan
bun.lock: @biomejs/biome 2.5.14 → 2.6.3, inert
bun.lock: svelte 5.57.1 → 5.57.2
unit tests: 4 of 12 files
…
```

## Annotations

| Comment | Meaning |
|:---|:---|
| `// @depends-on <glob> [glob…]` | Inputs that aren't imports: files a script reads, a tool it spawns, the pages a `goto()` the graph can't read opens (a loop over a list of URLs). Transitive. A file that reads the disk without one (or `@reads`, or `@lists`), or calls `goto()` with a URL it can't read, is unknown, unless it's `hermetic` |
| `// @reads <glob> [glob…]` | Files read as text. Only a direct change to one counts, not a change to what it imports. The config's `reads` says the same for files that can't hold a comment |
| `// @lists <glob> [glob…]` | Files whose names it lists, not their contents: a convention test that checks every route has a handler. Only adding, deleting or renaming one counts; an edit doesn't select it, and doesn't run its suite by the orphan rule either |
| `// @glob-registry` | This file's `import.meta.glob` is a lookup table and adds no edges: whatever loads an entry names it itself |

## CLI

| Command | Does |
|:---|:---|
| `bivium plan [base] [--json] [--github]` | Prints what it planned against (the base, its merge base, how many files changed, the config file), then each suite's selection (`none`, the files out of how many, `all` files when each reaches a change, or `all (full run)`) and why a suite runs in full. `--json` adds the base, merge base, config file, changed files, narrower results, changed packages, each suite's test count (`totals`), and the reasons as data (`causes`, each a `FullRunCause`: `{ kind, suites, file?, package?, narrower?, message }`). `--github` also writes each suite's selection to `$GITHUB_OUTPUT` |
| `bivium run [base] [--suite <name>]` | Runs the suite's `run` command with its selection (default: the first suite), or skips it when nothing is affected |
| `bivium why <test> [file] [--format tree\|chain\|source\|json] [--all]` | The shortest chain of edges from a changed file, or from `file`, to the test, with what spells each edge and the line it's on, and how many other changes reach the test. `--format tree` (the default) draws it from the test; `chain` reads from the change to the test; `source` prints each hop's line of source; `json` (or `--json`) prints the chain as data. `--all` shows every change's chain. For a test that isn't selected, it says what the file's chains reach instead |
| `bivium check [--max-unknown <n>] [--json]` | Counts what it found by cause first, then lists every node with unknown dependencies, with where and how to fix each cause, and fails when more than `n` of them reach a test, or on one `knownUnknowns` doesn't list. A node no test depends on is listed apart and not counted: plans only run tests, so it widens nothing. Also lists the files under a suite's `root` that no test reaches, each with a fix (a change to one runs the whole suite; see [A change no test reaches](#a-change-no-test-reaches)), `tsconfig.json` files that don't parse, and [dead globs](#dead-globs), and fails on one `deadGlobs` doesn't allow or on an entry that matches none. `--json` prints the report as data, with `ok` (what the exit status says) and `summary` (the counts the text leads with) |
| `bivium graph [--suite <name>] [--top <n>] [--json]` | How many of each suite's tests a change to each file selects through the graph (leaving out the tests that run on any change, which it counts apart): the `n` files that reach the most, and how files spread from none to every test. A few hub files that reach most tests are what make plans wide. `--json` prints each suite's `total` and `everyChange` tests, and every node with its `imports` and `importers` (file edges), `fanIn` per suite and whether it's `unknown` |

`--config`, `--cwd` and `--no-cache` work with every command, before or after it, and `why` and `check` take `--base <ref>`. An option takes its value as `--flag value` or `--flag=value`, and a switch such as `--json` also takes `=true` or `=false`. A path may be repo-relative, relative to the current directory (`./tests/a.test.ts`) or absolute. `--help` (or `-h`) prints usage. An unknown command, option, suite, test or `--format` is an error, which names what's close when something is (`unknown option --jsno (did you mean --json?)`). Exit status: 0 when done, 1 when `check` finds problems, 2 for a usage, configuration or git error; `run` exits with its command's status.

Every JSON output carries `schemaVersion` (now `1`), which a change that drops or retypes a field bumps; new fields don't. With `--json`, an error is also printed to stdout as JSON, so a pipeline that parses stdout gets an object either way:

```json
{ "schemaVersion": 1, "error": { "kind": "git", "message": "bivium: no commit nosuchref here to diff against: fetch it." } }
```

`kind` is `usage` (bivium was called wrong), `config` (the config can't be read or is invalid; the message names the file and lists every unknown key at once), `git` (the base or its history is missing, or git refused, in its own words) or `other`.

### From an agent

- `bivium plan --json` gives the selection per suite and why: `causes` (typed) for each full run, `totals` for the scale, `changed`, `base` and `mergeBase`.
- `bivium why <test> --format json` gives the chain from a change to a test, each link's `kind` (`import`, `type`, `goto`, `edges`…) and `at` (`file:line`).
- `bivium check --json` gives `ok` and a `summary` of what widens plans, then each node with a `fix`.
- Read the exit status first: 0 done, 1 `check` found problems, 2 an error, with `error.kind` in the JSON.

`why` names each edge by what spells it: `import`, `type` (an `import type`, `export type … from`, JSDoc type, or an edge to or from a declaration file), `setup` (a suite's setup file), `goto` (a page `page.goto()` opens), `html` (a module an HTML page loads: `script[src]`, `link[href]`, `iframe[src]` or an inline script's import), `name` (a named import bound to a barrel name) and `export` (the file that exports it), `glob` (`import.meta.glob`), `depends-on`, `edges` (the config's), `reads` and `lists`.

```console
$ bunx bivium why e2e/accordion.test.ts
e2e/accordion.test.ts
└─ goto    e2e/fixtures/accordion.html             e2e/accordion.test.ts:13
   └─ html    e2e/fixtures/accordion.ts            e2e/fixtures/accordion.html:10
      └─ import  e2e/fixtures/Fixture.svelte       e2e/fixtures/accordion.ts:1
         └─ name    src/index.js#AccordionItem     e2e/fixtures/Fixture.svelte:2
            └─ export  src/AccordionItem.svelte    src/index.js:2
               ● changed
+ 1 more change reaches this test: css/_accordion.scss (--all shows each chain)

$ bunx bivium why e2e/accordion.test.ts --format chain
src/AccordionItem.svelte changed
  exported as AccordionItem  src/index.js:2
  imported by                e2e/fixtures/Fixture.svelte:2
  imported by                e2e/fixtures/accordion.ts:1
  loaded by page             e2e/fixtures/accordion.html:10
  opened by                  e2e/accordion.test.ts:13  ← selected
+ 1 more change reaches this test: css/_accordion.scss (--all shows each chain)

$ bunx bivium why e2e/accordion.test.ts --format source
selected: e2e/accordion.test.ts ← src/AccordionItem.svelte (5 hops)

  --> e2e/accordion.test.ts:13  goto
13 | await page.goto("/accordion.html");
  --> e2e/fixtures/accordion.html:10  html
10 | <script type="module" src="./accordion.ts"></script>
  --> e2e/fixtures/accordion.ts:1  import
 1 | import Fixture from "./Fixture.svelte";
  --> e2e/fixtures/Fixture.svelte:2  name
 2 | import { Accordion, AccordionItem } from "carbon-components-svelte";
  --> src/index.js:2  export
 2 | export { default as AccordionItem } from "./AccordionItem.svelte";
  ● src/AccordionItem.svelte: changed
+ 1 more change reaches this test: css/_accordion.scss (--all shows each chain)
```

For a test that depends on every change, `chain` says why, where, and how to fix it, as `check` does:

```console
$ bunx bivium why tests/e2e.test.ts --format chain
tests/e2e.test.ts runs on every change
  because scripts/launcher.js:10  unresolved "./cli-entry.js"
    fix: no file at that path: fix the import, or add an `edges` entry if a build generates it
  reached via scripts/launcher.js
    depended on by  scripts/build.ts:1
    depended on by  tests/e2e.test.ts:2  ← selected
```

## Dead globs

A typo'd `@depends-on`, or one pointing only at files the planner skips, looks fine and never selects its file. `check` evaluates every `@depends-on`, `@reads`, `@lists` and `import.meta.glob` pattern, every `edges` and `reads` value, and every suite's `setup`, against every file git lists (tracked and untracked, inside the roots or not) and reports one that:

| Problem | Means |
|:---|:---|
| matches nothing | No file matches: a typo or a stale path |
| matches only ignored files, partly ignored | Some matches are ignored and not in the graph, so a change to one selects nothing |

A config value with captures is dead only when it matches nothing for every file its key matches, and a key that matches no file the graph reads is reported too, under the config's file. An ignored file the graph reads still seeds a walk, and a change outside the roots runs everything, so neither is dead. A glob that's dead on purpose goes in `deadGlobs` with a reason:

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
          # History back to the merge base; see "The checkout" below.
          fetch-depth: 0
          filter: blob:none
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

### The checkout

A plan compares the branch with its merge base: the commit where it forked from the base branch. So the job needs the history back to that commit, not just the commit under test. `actions/checkout` fetches one commit by default (`fetch-depth: 1`), with no base branch, and the plan stops with what's missing:

```
bivium: origin/main and HEAD share no commit here, so there's no merge base to diff against. The clone is shallow: fetch the history (actions/checkout: `fetch-depth: 0`).
```

`fetch-depth: 0` fetches every commit. Only a job that plans needs it; one that runs every test anyway, such as a push to the default branch, can keep the default: `fetch-depth: ${{ github.event_name == 'pull_request' && '0' || '1' }}`.

The history git fetches is three kinds of object: commits, trees (each directory's file names, each with the ID of its content) and blobs (the contents). A plan needs the commits, to find the merge base, and the trees, to list what changed. Of the blobs it needs the working tree's, which the checkout has, and the merge base's version of a few changed files only: a lockfile, a `package.json`, a `tsconfig.json`, a barrel, and what a narrower reads. So pick the clone by how big the history is:

| History | Checkout | What a plan pays |
| :--- | :--- | :--- |
| Small: a full clone takes a second or two | `fetch-depth: 0` | Nothing more: every old version is already on disk |
| Large: years of commits, big files | `fetch-depth: 0` and `filter: blob:none` | A fetch from the remote for the old versions it reads, when a change needs any: about a second, sometimes several |

`filter: blob:none` makes a partial clone: every commit and tree, and only the blobs the checkout needs. Git fetches any other blob when something reads it, and fetches for reads made at once run in parallel. Without the filter, a large history's old contents are most of the download; with it, a small repository pays a round trip to the remote for contents it could have had for free.

### The cache

The cache holds what bivium extracted from each file, keyed by git blob, so a warm plan reads only the files a branch changed. Key it on the merge base: a pull request can restore caches from the default branch, whose run at that commit is the one to hit. Without `node_modules`, the cache lives in `.bivium/cache`; it writes a `.gitignore` so it never shows up as a change.

### What a plan costs

Measured on an Apple M-series laptop under load (median of five, wall time):

| Repository | Files | Bun, no cache | Bun, warm | Node 24, no cache | Node 24, warm | Cache |
|:---|---:|---:|---:|---:|---:|---:|
| carbon-components-svelte | 4,680 | 0.15 s | 0.09 s | 0.27 s | 0.13 s | 452 KB |
| generated TypeScript, 23 MB | 7,000 | 0.14 s | 0.08 s | 0.30 s | 0.12 s | 896 KB |

So the cache is optional at this size, `bunx --bun` is worth it, and planning inside a test job (no extra job, no install) costs well under a second. A cold plan of the generated repository peaks at 88 MB of RSS on Bun and 124 MB on Node.

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

`plan(options?)` takes `cwd`, `base`, `config` (default: the config file in `cwd`) and `cache`, and returns each suite's selection, its test count, the reasons as sentences and as data, the packages a lockfile change seeded or found inert, the base, merge base and changed files, and what each narrower returned. Given a config, the suite names carry through to the result's type. The package exports only `plan`, `defineConfig` and their types.

## Compared with

| | Selects | Misses |
|:---|:---|:---|
| `vitest --changed`, `jest --changedSince` | Tests whose module graph reaches a changed file, from the runner's own resolver | Disk reads, fixtures, pages a test visits, config and setup wiring |
| Playwright `--only-changed` | Test files whose imports changed | The pages a test opens and what they load |
| Nx, Turborepo | Whole projects whose inputs changed | Nothing within a project's declared inputs, at project granularity |
| Bazel | Targets whose declared inputs changed | Nothing, if every input is declared |
| bivium | Test files, across runners and file types, from one graph | Nothing it can see; what it can't, it runs |
