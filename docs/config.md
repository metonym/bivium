# Config

bivium reads `bivium.config.ts` from the repository root;
every key, and the comments a file can carry, are below.

`bivium.config.ts` (or `.mts`, `.mjs`, `.js`, `.json`) in the repository
root, or `--config <file>`.
A `.ts` config needs Bun or Node ≥ 22.18.
Every glob key takes one glob or a list.
An unknown key is an error, since a misspelled one would quietly select
less.

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
| `hermetic` | Files whose disk reads and non-literal imports reach no file of the repository: a library's `fs` calls on its caller's paths, a test that reads only the temporary files it writes. They add no unknown, and `check` still flags a repository path one spells that nothing declares |
| `barrels` | Modules that may bind named imports. Default: every module made only of re-exports |
| `external` | Packages a dependency installs that your code imports without declaring |
| `inert` | Packages no test uses except by importing them: linters, formatters, type packages (`["@biomejs/biome", "knip", "@types/*"]`). A [lockfile change](how-it-works.md#lockfiles) that only they reach selects nothing. With `loadedByName` set, only packages with a `bin` need listing. bivium itself always is |
| `loadedByName` | Packages a test may load other than by an import: a test environment or a plugin a config names by string (`["jsdom", "ts-jest"]`). Setting it, even to `[]`, says every other package without a `bin` is loaded only by imports, so a [lockfile change](how-it-works.md#lockfiles) that reaches one no test imports selects only its importers. A package with a `bin` always counts as one a test may run |
| `extensions` | Suffixes tried after a specifier |
| `deadGlobs` | Dead globs `check` allows, each `{ file, glob, reason }`, the glob as `file` spells it |
| `knownUnknowns` | Nodes `check` allows to have unknown dependencies, each `{ file, reason }`. With it set, even to `[]` (which is `--max-unknown 0`), `check` fails on an unknown node some test reaches that it doesn't list, and on an entry that's no longer unknown, so a new unknown can't replace one that went away |
| `narrowers` | See [Narrowers](api.md#narrowers) |
| `base` | The default base ref. Otherwise the upstream default branch (`origin/HEAD`, then `origin/main`, `origin/master`, `main`, `master`) |
| `cache` | The cache's directory, or `false`. Default: `node_modules/.cache/bivium`, or `.bivium/cache` |

## Annotations

| Comment | Meaning |
|:---|:---|
| `// @depends-on <glob> [glob…]` | Inputs that aren't imports: files a script reads, a tool it spawns, the pages a `goto()` the graph can't read opens (a loop over a list of URLs). Transitive. A file that reads the disk without one (or `@reads`, or `@lists`), or calls `goto()` with a URL it can't read, is unknown, unless it's `hermetic` |
| `// @reads <glob> [glob…]` | Files read as text. Only a direct change to one counts, not a change to what it imports. The config's `reads` says the same for files that can't hold a comment |
| `// @lists <glob> [glob…]` | Files whose names it lists, not their contents: a convention test that checks every route has a handler. Only adding, deleting or renaming one counts; an edit doesn't select it, and doesn't run its suite by the orphan rule either |
| `// @glob-registry` | This file's `import.meta.glob` is a lookup table and adds no edges: whatever loads an entry names it itself |

## Related

- [Tuning a plan](tuning.md): which key to reach for
  when a change runs too much
- [Recipes](recipes.md): Vitest, Jest, Playwright, pnpm workspaces,
  generated code
- [How it works](how-it-works.md): what the graph follows
