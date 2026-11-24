# CLI

The `bivium` command picks the tests a change needs, runs them,
and explains each choice.

```sh
bivium plan origin/main               # which tests this branch needs
bivium run --suite unit               # run the unit suite's selection
bivium why tests/Button.test.ts       # how a change reaches this test
```

It has five commands:

| Command | What it answers |
| --- | --- |
| [`plan`](#plan) | which tests of each suite a change can reach |
| [`run`](#run) | whether one suite's selected tests pass, in its runner |
| [`why`](#why) | how a change reaches one test, edge by edge |
| [`check`](#check) | what makes plans wider than they need to be |
| [`graph`](#graph) | which files reach the most tests |

## plan

`plan` prints the tests each suite needs for the changes since a base.

```sh
bivium plan [base] [--json] [--github]
```

`base` defaults to the config's `base`,
else the upstream default branch.
The first line says what it planned against: the base, its merge base,
how many files changed, and the config file.
Then each suite gets one line:

| Selection | Means |
| --- | --- |
| `none` | no test of the suite reaches a change |
| `3 of 12 files` | these tests reach a change; the files follow, one per line |
| `all 12 files (each reaches a change)` | every test reaches a change |
| `all (full run)` | a cause runs the suite in full; a `Full run:` line above names it |

Options:

- `--json` prints the plan as data, with the fields below.
- `--github` also writes each suite's selection to `$GITHUB_OUTPUT` as
  `<output>=all`, `none`, or the files separated by spaces.
  `<output>` is the suite's `output`, `<name>-tests` by default.

| Field | Holds |
| --- | --- |
| `base`, `mergeBase` | the base ref, and the merge base the working tree is compared with |
| `config` | the config file |
| `changed` | the files changed since the merge base |
| `suites` | each suite's selection: `{ mode: "all" }`, `{ mode: "none" }`, or `{ mode: "some", files }` |
| `totals` | how many test files each suite has |
| `reasons` | why a suite runs in full, as sentences |
| `causes` | the same reasons as data, each a `FullRunCause`: `{ kind, suites, file?, package?, narrower?, message }` |
| `packages` | a line per package a lockfile or `package.json` change changed: `bun.lock: svelte 5.1.0 → 5.2.0` |
| `narrowed` | what each [narrower](api.md#narrowers) returned |

```sh
bivium plan origin/main --json
```

## run

`run` runs a suite's `run` command on the tests `plan` selects for it.

```sh
bivium run [base] [--suite <name>]
```

- `--suite <name>` picks the suite.
  Default: the first one in the config.

It prints the plan first, as `plan` does.
The selected files go where the command says `{files}`, or at its end.
When every test is selected, no files are passed,
so the runner runs them all.
When none is, `run` skips the command and exits 0.
Otherwise it exits with the command's status.

```sh
bivium run --suite e2e
```

## why

`why` shows the shortest chain of edges from a changed file to a test.
An edge is one link the graph follows,
such as an import or a `page.goto()`.

```sh
bivium why <test> [file] [--base <ref>] [--format <f>] [--all] [--json]
```

Each edge in the chain names what spells it and the line it's on.
A last line counts the other changes that reach the test.
Options:

- `file` starts the chain at this file instead of a changed one.
- `--base <ref>` sets the base to diff against.
- `--format <f>` picks the layout, from the table below.
- `--all` shows every change's chain, not only the shortest.
- `--json` prints the chain as data, as `--format json` does.

| Format | Shows |
| --- | --- |
| `tree` | the default: the chain drawn from the test down to the change |
| `chain` | the chain read from the change to the test |
| `source` | each hop's line of source |
| `json` | the chain as data |

A test that isn't selected gets a line saying so.
Given a `file`, `why` also counts the tests that file's chains reach,
and names one.

```sh
bivium why tests/Button.test.ts src/Button.svelte --format chain
```

[Reading `why`](#reading-why) has real output of each format.

## check

`check` lists what makes plans wider than they need to be,
each with where it is and how to fix it.

```sh
bivium check [--base <ref>] [--max-unknown <n>] [--json]
```

A node is a file, a barrel name, or a package in the graph.
A node has unknown dependencies (an unknown) when bivium can't read all
it depends on, such as an import it can't resolve or a read from disk.
Every test that reaches one runs on every change.
A changed file under a suite's `root` that no test reaches runs the
whole suite: the orphan rule.

`check` leads with counts by cause, then lists:

- every unknown, with where and how to fix each cause;
- unknowns no test depends on, apart and not counted toward
  `--max-unknown`: plans only run tests, so these widen nothing;
- files under a suite's `root` that no test reaches,
  each with a fix
  (see [A change no test reaches](tuning.md#a-change-no-test-reaches));
- `tsconfig.json` files that don't parse;
- [dead globs](tuning.md#dead-globs);
- repository paths a test spells that nothing declares.

`check` exits 1 on any of these:

- more than `n` unknowns reach a test, with `--max-unknown <n>`;
- with `knownUnknowns` set, an unknown a test reaches that it doesn't
  list, or an entry whose dependencies are all known;
- a dead glob `deadGlobs` doesn't allow,
  or a `deadGlobs` entry that matches none;
- a repository path a test spells that nothing declares.

Options:

- `--max-unknown <n>` fails when more than `n` unknowns reach a test.
- `--base <ref>` sets the base.
  Default: `HEAD`.
- `--json` prints the report as data.
  `ok` matches the exit status, and `summary` holds the counts the text
  leads with.

```sh
bivium check --max-unknown 0
```

## graph

`graph` shows, for each file, how many of a suite's tests a change to it
selects: its fan-in.

```sh
bivium graph [--suite <name>] [--top <n>] [--json]
```

For each suite it lists the `n` files that reach the most tests,
and how all files spread from reaching none to reaching every test.
Tests that run on any change are left out and counted apart.
A few hub files that reach most tests are what make plans wide.
Options:

- `--suite <name>` shows only this suite.
  Default: every suite.
- `--top <n>` sets how many files to list per suite.
  Default: 10.
- `--json` prints each suite's `total` and `everyChange` tests,
  and every node with its `imports` and `importers` (its file edges),
  its `fanIn` per suite, and whether it's `unknown`.

```sh
bivium graph --suite e2e --top 5
```

## Options for every command

These work with every command, before or after it:

- `--config <file>`: the config file.
  Default: `bivium.config.{ts,mts,mjs,js,json}`.
- `--cwd <dir>`: the repository.
  Default: the current directory.
- `--no-cache`: read every file, and skip the extraction cache.
- `--help` or `-h`: print usage.
- `--version` or `-v`: print the version.

An option takes its value as `--flag value` or `--flag=value`.
A switch such as `--json` also takes `=true` or `=false`.
A path can be repo-relative, relative to the current directory
(`./tests/a.test.ts`), or absolute.

An unknown command, option, suite, test, or `--format` is an error.
The message names what's close, when something
is: `unknown option --jsno (did you mean --json?)`.

## Exit status

The exit status says how a command ended:

| Status | Means |
| --- | --- |
| 0 | done |
| 1 | `check` found problems |
| 2 | a usage, configuration, or git error |

`run` exits with its command's status.

## JSON and errors

Every JSON output carries `schemaVersion`, which is `1`.
Dropping or retyping a field bumps it; adding a field doesn't.

With `--json`, an error goes to stdout as JSON too,
so a pipeline that parses stdout gets an object either way:

```json
{ "schemaVersion": 1, "error": { "kind": "git", "code": "BV_GIT_NO_BASE", "message": "bivium: no commit nosuchref here to diff against: fetch it." } }
```

`kind` says what to do about it:

| `kind` | Means |
| --- | --- |
| `usage` | bivium was called wrong |
| `config` | the config can't be read or is invalid; the message names the file and lists every unknown key at once |
| `git` | the base or its history is missing, or git refused, in its own words |
| `other` | a failure bivium didn't name |

`code` names the failure, such as `BV_UNKNOWN_OPTION`
or `BV_CONFIG_INVALID`.
A code never changes meaning.
The `BiviumErrorCode` type lists them all, each with what it means.
From the library, `plan()` throws a `BiviumError` with the same `code`
and `kind`.

## From an agent

Each command has a JSON form that answers one question:

- `bivium plan --json` gives the selection per suite and why:
  `causes` (typed) for each full run, `totals` for the scale,
  and `changed`, `base`, and `mergeBase`.
- `bivium why <test> --format json` gives the chain from a change to
  a test.
  Each link has a `kind`, such as `import` or `goto`, and an `at`,
  as `file:line`.
- `bivium check --json` gives `ok` and a `summary` of what widens plans,
  then each node with a `fix`.

Read the exit status first: 0 done, 1 `check` found problems,
2 an error.
On 2, the JSON has `error.kind` and `error.code`.

## Reading `why`

`why` names each edge by what spells it:

| Edge | Spelled by |
| --- | --- |
| `import` | any other import: static, dynamic, `require()` or `vi.mock()` |
| `type` | an `import type`, `export type … from`, a JSDoc type, or an edge to or from a declaration file |
| `setup` | a suite's setup file |
| `goto` | a page `page.goto()` opens |
| `html` | a module an HTML page loads: `script[src]`, `link[href]`, `iframe[src]` or an inline script's import |
| `name`, `export` | a named import bound to a barrel name, and the file that exports it |
| `glob` | `import.meta.glob` |
| `depends-on`, `reads`, `lists` | the annotations |
| `edges` | the config's `edges` |

A barrel is a module made only of re-exports, such as `src/index.js`.
A named import from one depends on a barrel name,
such as `src/index.js#AccordionItem`,
and through it on that name's file alone,
so a change to another export doesn't select it.

The same test in each format:

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

A test that depends on every change reaches an unknown.
For one, `chain` says why, where, and how to fix it, as `check` does:

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
- [Not supported](how-it-works.md#not-supported): what bivium leaves to
  other tools
