# CLI

Five commands: `plan` picks the tests, `run` runs them,
`why` explains one, `check` finds what widens plans,
and `graph` shows where they fan out.

| Command | Does |
|:---|:---|
| `bivium plan [base] [--json] [--github]` | Prints what it planned against (the base, its merge base, how many files changed, the config file), then each suite's selection (`none`, the files out of how many, `all` files when each reaches a change, or `all (full run)`) and why a suite runs in full. `--json` adds the base, merge base, config file, changed files, narrower results, changed packages, each suite's test count (`totals`), and the reasons as data (`causes`, each a `FullRunCause`: `{ kind, suites, file?, package?, narrower?, message }`). `--github` also writes each suite's selection to `$GITHUB_OUTPUT` |
| `bivium run [base] [--suite <name>]` | Runs the suite's `run` command with its selection (default: the first suite), or skips it when nothing is affected |
| `bivium why <test> [file] [--format tree\|chain\|source\|json] [--all]` | The shortest chain of edges from a changed file, or from `file`, to the test, with what spells each edge and the line it's on, and how many other changes reach the test. `--format tree` (the default) draws it from the test; `chain` reads from the change to the test; `source` prints each hop's line of source; `json` (or `--json`) prints the chain as data. `--all` shows every change's chain. For a test that isn't selected, it says what the file's chains reach instead |
| `bivium check [--max-unknown <n>] [--json]` | Counts what it found by cause first, then lists every node with unknown dependencies, with where and how to fix each cause, and fails when more than `n` of them reach a test, or on one `knownUnknowns` doesn't list. A node no test depends on is listed apart and not counted: plans only run tests, so it widens nothing. Also lists the files under a suite's `root` that no test reaches, each with a fix (a change to one runs the whole suite; see [A change no test reaches](tuning.md#a-change-no-test-reaches)), `tsconfig.json` files that don't parse, and [dead globs](tuning.md#dead-globs), and fails on one `deadGlobs` doesn't allow or on an entry that matches none. Fails on a repository path a test spells that nothing declares (see [A change no test reaches](tuning.md#a-change-no-test-reaches)). `--json` prints the report as data, with `ok` (what the exit status says) and `summary` (the counts the text leads with) |
| `bivium graph [--suite <name>] [--top <n>] [--json]` | How many of each suite's tests a change to each file selects through the graph (leaving out the tests that run on any change, which it counts apart): the `n` files that reach the most, and how files spread from none to every test. A few hub files that reach most tests are what make plans wide. `--json` prints each suite's `total` and `everyChange` tests, and every node with its `imports` and `importers` (file edges), `fanIn` per suite and whether it's `unknown` |

`--config`, `--cwd` and `--no-cache` work with every command,
before or after it, and `why` and `check` take `--base <ref>`.
An option takes its value as `--flag value` or `--flag=value`,
and a switch such as `--json` also takes `=true` or `=false`.
A path may be repo-relative, relative to the current directory
(`./tests/a.test.ts`) or absolute.
`--help` (or `-h`) prints usage.
An unknown command, option, suite, test or `--format` is an error,
which names what's close when something is
(`unknown option --jsno (did you mean --json?)`).
Exit status: 0 when done, 1 when `check` finds problems, 2 for a usage,
configuration or git error; `run` exits with its command's status.

Every JSON output carries `schemaVersion`, which is `1`;
a change that drops or retypes a field bumps it, and new fields don't.
With `--json`, an error is also printed to stdout as JSON,
so a pipeline that parses stdout gets an object either way:

```json
{ "schemaVersion": 1, "error": { "kind": "git", "code": "BV_GIT_NO_BASE", "message": "bivium: no commit nosuchref here to diff against: fetch it." } }
```

`kind` is `usage` (bivium was called wrong),
`config`
(the config can't be read or is invalid; the message names the file and
lists every unknown key at once), `git`
(the base or its history is missing, or git refused, in its own words)
or `other`.
`code` names the failure, such as `BV_UNKNOWN_OPTION`
or `BV_CONFIG_INVALID`, and never changes meaning:
the `BiviumErrorCode` type lists them all, each with what it means.
From the library, `plan()` throws a `BiviumError` with the same `code`
and `kind`.

## From an agent

- `bivium plan --json` gives the selection per suite and why:
  `causes` (typed) for each full run, `totals` for the scale, `changed`,
  `base` and `mergeBase`.
- `bivium why <test> --format json` gives the chain from a change to a
  test, each link's `kind` (`import`, `type`, `goto`, `edges`…)
  and `at` (`file:line`).
- `bivium check --json` gives `ok` and a `summary` of what widens plans,
  then each node with a `fix`.
- Read the exit status first: 0 done, 1 `check` found problems,
  2 an error, with `error.kind` and `error.code` in the JSON.

## Reading `why`

`why` names each edge by what spells it:
`import`, `type`
(an `import type`, `export type … from`, JSDoc type, or an edge to or
from a declaration file), `setup` (a suite's setup file),
`goto` (a page `page.goto()` opens),
`html`
(a module an HTML page loads: `script[src]`, `link[href]`, `iframe[src]`
or an inline script's import), `name`
(a named import bound to a barrel name)
and `export` (the file that exports it), `glob` (`import.meta.glob`),
`depends-on`, `edges` (the config's), `reads` and `lists`.

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

For a test that depends on every change, `chain` says why, where,
and how to fix it, as `check` does:

```console
$ bunx bivium why tests/e2e.test.ts --format chain
tests/e2e.test.ts runs on every change
  because scripts/launcher.js:10  unresolved "./cli-entry.js"
    fix: no file at that path: fix the import, or add an `edges` entry if a build generates it
  reached via scripts/launcher.js
    depended on by  scripts/build.ts:1
    depended on by  tests/e2e.test.ts:2  ← selected
```

## Related

- [CI](ci.md): planning in GitHub Actions
- [Tuning a plan](tuning.md): fixing what `check` reports
- [API](api.md): the same plan from code
