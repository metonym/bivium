# Config

The config names your test suites and tells bivium the dependencies it
can't read from your imports.

```ts
// bivium.config.ts
import { defineConfig } from "bivium";

export default defineConfig({
  suites: {
    unit: {
      tests: "tests/**/*.test.ts",
      run: "vitest run {files}",
      root: "tests", // a changed file here that no test reaches runs the suite
      setup: ["tests/setup.ts"], // the runner loads it before every test
      types: false, // Vitest runs code, so type-only imports select nothing
    },
  },
  roots: ["src", "tests"], // a changed file outside them runs everything
  ignore: ["docs/**"], // no test can observe these
});
```

## The config file

bivium reads the first of `bivium.config.ts`, `.mts`, `.mjs`,
`.js` and `.json` it finds in the repository root.
`--config <file>` names another file.
A `.ts` config needs Bun or Node ≥ 22.18.
`defineConfig` returns the config unchanged, with its types checked.

Every glob key takes one glob or a list of globs.
An unknown key is an error: a misspelled key would otherwise select
fewer tests without saying so.

## Suites

Each entry under `suites` is one suite:
a set of test files and the command that runs them.
`plan` reports a selection per suite, and `run --suite <name>` runs one.

| Key | Sets | Default |
|:---|:---|:---|
| `tests` | The suite's test files | required |
| `run` | The command `bivium run` runs | none; `bivium run` needs one |
| `runAll` | The command for a full run, when every test is selected | `run`, with `root` for `{files}` |
| `root` | Where the orphan rule applies | the whole repository |
| `urls` | URL pattern → the page a `page.goto()` opens | none |
| `pages` | Pages only a `goto()` opens | none |
| `setup` | Files the runner loads before every test | none |
| `wiring` | Files whose change runs the whole suite: another harness, a runner config | none |
| `nonInputs` | Files under `root` the runner never reads, such as type-check inputs | none |
| `types` | Whether the suite's tests can observe types | `true` |
| `output` | The step output `plan --github` writes | `<name>-tests` |

### `run`

`bivium run` puts the selected files where `{files}` is:
`vitest run {files}` runs `vitest run tests/a.test.ts tests/b.test.ts`.
When the whole suite is selected, `{files}` becomes the suite's `root`,
`vitest run tests`, since a bare `vitest run` or `bun test` would run
every suite's tests; without a `root`, it becomes nothing.
Without `{files}`, the files go at the end of the command.
When the runner needs another command for a full run,
set `runAll`: `runAll: "playwright test --project=e2e"`.

### `root` and the orphan rule

The orphan rule runs a whole suite when a file under its `root` changes
and no test of the suite reaches it.
bivium takes such a file to be wired some other way,
such as a setup file or a runner config.
`root` is also where bivium reads `page.goto()` calls.

`root` takes paths, not globs: `e2e`, not `e2e/**`.
A glob is an error.
To keep the rule from running a suite for files that aren't test inputs,
see [A change no test reaches](tuning.md#a-change-no-test-reaches).

### `urls` and `pages`

For a browser suite, `urls` turns each `page.goto()` call under `root`
into an edge, a dependency the graph follows, to the page it opens.
A list value names the page first, then what else it loads that no
import says, such as a router's layouts:

```ts
urls: {
  "/*": ["app/(site)/*/page.tsx", "app/(site)/layout.tsx", "app/layout.tsx"],
},
```

The page must exist, or the `goto()` is unknown.
The rest become edges where their files exist.

`pages` lists the pages only a `goto()` opens.
A listed page that no test opens is wired to no test,
and so are the files only such pages load.
A change to one selects nothing, and doesn't run the suite by the
orphan rule.

### `setup` and `wiring`

bivium doesn't read the runner's config,
so name the files the runner loads on its own.
`setup` is for the files it loads before every test:
Vitest and Jest `setupFiles`, Mocha `--require`,
Playwright `globalSetup`.
Every test of the suite depends on them and on what they import.

`wiring` is for files whose change runs the whole suite,
such as a second harness or a runner config.

### `types`

Set `types: false` on a suite that runs code and can't observe types:
Vitest, Jest, Playwright, `bun test`.
A change that reaches its tests only through type-only edges
then selects none of them.
Type-only edges are `import type`, `export type … from`, JSDoc types,
and declaration files.
The default, `true`, is what a type-checking suite needs,
such as `tsc` or `vitest --typecheck`.

An inline `import { type A }` is always an edge:
under `verbatimModuleSyntax`, it still loads the module.

With `types: false`, the orphan rule counts a type-only reach only for a
declaration file, since the runner may load any other file by name.
List a types-only module under `root` in `nonInputs`.

## What the graph reads

The graph is bivium's map of which file depends on which.
These keys set which files it reads and how it resolves imports.

| Key | Sets | Default |
|:---|:---|:---|
| `roots` | Paths the graph reads | the whole repository |
| `alias` | Specifier prefix → path, as the bundler aliases it | none |
| `extensions` | Suffixes tried after a specifier | the list below |
| `barrels` | Modules that may bind named imports | every module made only of re-exports |
| `external` | Packages a dependency installs that your code imports without declaring | none |

`roots` takes paths, directories or files, not globs.
A changed file outside the roots that isn't ignored runs everything.
That is the backstop for wiring the graph can't see,
such as a CI workflow.

`alias` is tried before tsconfig `paths` and `package.json` `exports`.
A key ending in `/` is a prefix, as Vite reads it:
`{ "@/": "src/" }` maps `@/x` to `src/x`.

`extensions` defaults to `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`,
`.mjs`, `.cjs`, `.d.ts`, `.svelte`, `.vue` and `.json`, in that order.
A list you set replaces it.

A barrel is a module made only of re-exports, such as an `index.ts`.
bivium can trace a named import from one to the single file that exports
the name, as [What it reads](how-it-works.md#what-it-reads) describes.
`barrels` limits which modules get that treatment.

`external` is for packages a dependency installs that your code imports
without declaring.
An import of any other package no `package.json` declares is unknown:
bivium counts the importing file as depending on every change.

## Files with a fixed effect

These keys mark files that need a rule of their own.

| Key | Names |
|:---|:---|
| `ignore` | Files no test can observe except through an edge, such as docs and stories |
| `self` | The selector's own files |
| `importOnly` | Files only an import reaches |

A change to an ignored file selects only the tests that reach it.
It never runs a suite by the orphan rule,
and doesn't select the tests whose dependencies are unknown.

A change to a `self` file runs everything,
since the selector can't be trusted to select itself.
The config file is always one.

Deleting an `importOnly` file never runs a suite by the orphan rule.
An importer still pointing at it can't resolve it,
so the importer's tests run anyway.

## Inputs imports don't show

A file is unknown when bivium can't read all of its dependencies,
such as a file that reads the disk.
bivium counts an unknown file as depending on every change,
so the tests that reach it run every time.
These keys declare what such files read,
or vouch that they read nothing in the repository.

| Key | Maps or names |
|:---|:---|
| `edges` | Generated file glob → its inputs |
| `reads` | File glob → the files it reads as text |
| `hermetic` | Files whose disk reads reach no file of the repository |

### `edges`

`edges` maps a generated file to the inputs a build makes it
from: `{ "dist/*.css": "styles/**" }`.
The generated file depends on its inputs transitively,
as with `@depends-on`.

A key may name files git doesn't list,
such as a gitignored generator output: `{ ".velite/*": "content/**" }`.
An import that resolves under the key, by extension or as an index,
then lands on that file instead of being unresolved.

In a value, `$1`, `$2`… stand for what the key's wildcards matched,
counted from the
left: `{ "examples/*/package.json": "examples/$1/**" }`.

### `reads`

`reads` maps a file to the files it reads as text,
as `@reads`
does: `{ "tests/*.test.ts": "tests/__snapshots__/$1.test.ts.snap" }`.
Only a direct change to a read file counts:
its imports and unknowns don't spread to the reader.
Values take `$1`… as in `edges`.

### A key that names one file

An `edges` or `reads` key with no wildcard names one file.
It declares what that file reads, as the file's own `@depends-on`
or `@reads` would, so the file's disk reads aren't unknown.

### `hermetic`

`hermetic` names files whose disk reads and non-literal imports reach no
file of the repository.
Examples are a library's `fs` calls on the paths its caller passes,
and a test that reads only the temporary files it writes.
These files add no unknown.
`check` still flags a repository path one of them spells that nothing
declares (see [Paths a test spells](tuning.md#paths-a-test-spells)).

## Packages and lockfiles

When a lockfile changes, bivium selects the tests that import each
changed package.
A changed package no test imports runs everything,
since a test may use it another way, such as a CLI it spawns.
These keys say which packages need that caution;
[Lockfiles](how-it-works.md#lockfiles) has the full rule.

| Key | Names | Example |
|:---|:---|:---|
| `inert` | Packages no test uses except by importing them | `["@biomejs/biome", "knip", "@types/*"]` |
| `loadedByName` | Packages a test may load other than by an import | `["jsdom", "ts-jest"]` |

`inert` is for linters, formatters and type packages.
A lockfile change that only they reach selects nothing.
With `loadedByName` set, only packages with a `bin` need listing.
bivium itself is always inert.

`loadedByName` is for a test environment,
or a plugin a config names by string.
Setting it, even to `[]`, says every other package without a `bin` is
loaded only by imports.
A lockfile change that reaches one no test imports
then selects only its importers.
A package with a `bin` always counts as one a test may run.

## What `check` allows

These keys list what `bivium check` accepts, each entry with a reason.

| Key | Each entry | Allows |
|:---|:---|:---|
| `deadGlobs` | `{ file, glob, reason }` | A [dead glob](tuning.md#dead-globs): one that matches no file, or only files bivium skips |
| `knownUnknowns` | `{ file, reason }` | A file with unknown dependencies |

In `deadGlobs`, `glob` is the glob as `file` spells it.

With `knownUnknowns` set, `check` fails on an unknown file some test
reaches that the list doesn't name.
Setting it to `[]` does what `--max-unknown 0` does.
`check` also fails on an entry whose dependencies are known,
so an unknown that appears can't take the place of one that went away.

## Plans and the cache

These keys set what a plan compares with, how it narrows,
and where it caches what it reads.

| Key | Sets | Default |
|:---|:---|:---|
| `narrowers` | Plugins that narrow what a change to some files selects | none |
| `base` | The base ref when a command names none | the upstream default branch |
| `cache` | The cache's directory, or `false` for none | `node_modules/.cache/bivium` |

The upstream default branch is `origin/HEAD`,
or else the first of `origin/main`, `origin/master`,
`main` and `master` that exists.
Without `node_modules`, the cache is `.bivium/cache`.
[Narrowers](api.md#narrowers) covers writing one.

## Annotations

An annotation is a comment in a source file that declares a dependency
its imports don't show.

```ts
// tests/tokens.test.ts
// @reads src/tokens.css
import { readFileSync } from "node:fs";

const css = readFileSync("src/tokens.css", "utf-8");
```

| Comment | Declares | A change that counts |
|:---|:---|:---|
| `// @depends-on <glob> [glob…]` | Inputs that aren't imports: files a script reads, a tool it spawns, pages a `goto()` opens | One to an input, or to what it depends on |
| `// @reads <glob> [glob…]` | Files read as text | A direct change to one, not to what it imports |
| `// @lists <glob> [glob…]` | Files whose names it lists, not their contents | Adding, deleting or renaming one |
| `// @glob-registry` | This file's `import.meta.glob` is a lookup table | None: it adds no edges |

A file that reads the disk without `@depends-on`,
`@reads` or `@lists` is unknown, unless it's `hermetic`.
So is a file that calls `goto()` with a URL the graph can't read,
such as one from a loop over a list of URLs.
An `@depends-on` in that file names the pages it opens.
The config's `edges` and `reads` say the same for files that can't hold
a comment.

`@lists` fits a convention test that checks every route has a handler.
An edit to a listed file doesn't select the test,
and doesn't run its suite by the orphan rule either.

`@glob-registry` is for an `import.meta.glob` used as a lookup table:
whatever loads an entry names it itself.

## Related

- [Tuning a plan](tuning.md): which key to reach for
  when a change runs too much
- [Recipes](recipes.md): Vitest, Jest, Playwright, pnpm workspaces,
  generated code
- [How it works](how-it-works.md): what the graph follows
- [Not supported](how-it-works.md#not-supported): what bivium leaves to
  other tools
