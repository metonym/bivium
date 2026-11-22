# How it works

bivium builds a static, file-level dependency graph
and walks it backwards from the files a change touches to the tests that
reach them; what it can't read counts as depending on everything.

## What it reads

A one-pass lexer reads JavaScript and TypeScript
(`.js`, `.ts`, `.jsx`, `.tsx`, and their `m`/`c` variants),
the scripts and markup expressions of `.svelte`, the scripts of `.vue`,
`.astro` and `.html`, and the `script[src]`,
`link[href]` and `iframe[src]` of `.html`.
Only code counts: an import spelled in a string
or a comment adds no edge.

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

A root `bun.lock`, `package-lock.json` or `pnpm-lock.yaml` isn't a
source file: a change to one seeds the packages it changed
(see [Lockfiles](#lockfiles)).

Nor is a `tsconfig.json` (or a file one `extends`)
or a `package.json` under `roots`: their options, `paths`,
`type` or `exports` change how the files under them resolve or run,
which no import says.
A change to one seeds the files it governs,
those it's the nearest of its kind to.
A change the parsed file doesn't show, such as formatting or comments,
seeds nothing; so does one to a `package.json`'s metadata alone
(`version`, `description`, `repository` and the like),
and a dependency change is the lockfile's.

A file it can't lex cleanly is read by a regex extractor instead,
which over-approximates.
CSS isn't scanned: generated stylesheets reach their inputs through
`edges`, and a [narrower](api.md#narrowers) can do better.

## Lockfiles

A dependency bump changes a lockfile, which no file imports.
When a root `bun.lock`, `package-lock.json` (v2 or v3),
or `pnpm-lock.yaml` v6 or v9 changes,
bivium diffs it against the merge base and seeds the walk with the
`pkg:` nodes of the packages whose entries changed,
and of every package that depends on one,
so a `svelte` bump selects what imports `svelte`,
or a package built on it.
A `package.json` whose only change is to dependencies the lockfile
records the same way counts as those packages changing.

A changed package can also be used in ways the graph can't see:
a CLI a test spawns, a runner, a type package.
So when a change reaches a package that a `package.json` declares,
or that some file imports, and that no test imports, everything runs,
with the reason
(`bun.lock: playwright 1.63.0 → 1.64.0, and no test imports it`),
unless the package is `inert`.
bivium itself always is: a bump changes which tests later plans pick,
not what a test does.
With `loadedByName` set, only a package with a `bin` in the lockfile,
or one it lists, counts as used that way:
a bump that reaches a library only a CMS config imports selects nothing.
Everything also runs for a lockfile bivium can't parse,
one whose settings other than its packages changed
(`overrides`, patches, pnpm's `settings`, `catalogs`, or the version of
pnpm itself), and a `package.json` change the lockfile doesn't record.
Other lockfiles (`yarn.lock`, `bun.lockb`) are files like any other:
outside the roots, a change to one runs everything.

```console
$ bunx bivium plan
bun.lock: @biomejs/biome 2.5.14 → 2.6.3, inert
bun.lock: svelte 5.57.1 → 5.57.2
unit tests: 4 of 12 files
…
```

## Compared with

Where bivium sits among the tools that select or skip tests:

| | Selects | Misses |
|:---|:---|:---|
| `vitest --changed`, `jest --changedSince` | Tests whose module graph reaches a changed file, from the runner's own resolver | Disk reads, fixtures, pages a test visits, config and setup wiring |
| Playwright `--only-changed` | Test files whose imports changed | The pages a test opens and what they load |
| Nx, Turborepo | Whole projects whose inputs changed | Nothing within a project's declared inputs, at project granularity |
| Bazel | Targets whose declared inputs changed | Nothing, if every input is declared |
| bivium | Test files, across runners and file types, from one graph | Nothing it can see; what it can't, it runs |

## Related

- [Tuning a plan](tuning.md): the orphan rule and `check`
- [Config](config.md): telling it what it can't see
