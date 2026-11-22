# How it works

bivium builds a static, file-level dependency graph: which file imports,
loads, or reads which.
It walks that graph backwards, from the files a change touches to the
tests that reach them.
It fails closed: a file it can't read is unknown,
and an unknown counts as depending on every change.

`why` prints one such walk, from the test down to the changed file:

```console
$ bunx bivium why e2e/accordion.test.ts
e2e/accordion.test.ts
└─ goto    e2e/fixtures/accordion.html             e2e/accordion.test.ts:13
   └─ html    e2e/fixtures/accordion.ts            e2e/fixtures/accordion.html:10
      └─ import  e2e/fixtures/Fixture.svelte       e2e/fixtures/accordion.ts:1
         └─ name    src/index.js#AccordionItem     e2e/fixtures/Fixture.svelte:2
            └─ export  src/AccordionItem.svelte    src/index.js:2
               ● changed
```

## What it reads

A one-pass lexer reads the code in these files:

- JavaScript and TypeScript: `.js`, `.ts`, `.jsx`, `.tsx`,
  and their `m` and `c` variants;
- `.svelte`: the scripts and the markup expressions;
- `.vue` and `.astro`: the scripts;
- `.html`: the scripts, and the `script[src]`,
  `link[href]` and `iframe[src]`.

Only code counts: an import spelled in a string
or a comment adds no edge.
Each reference it follows becomes edges to files, a `pkg:`
node for a package, or an unknown:

| It follows | As |
|:---|:---|
| Static, side-effect and dynamic imports, `export … from`, `require()` | Edges to every file the specifier can load: each extension that exists, each `exports` condition |
| A missing `x.js` or `x.jsx` | Its TypeScript source, as TypeScript reads it: `x.ts`, `x.tsx` or `x.d.ts`, through any path, alias or `exports` target |
| A missing `x.mjs` or `x.cjs` | `x.mts` or `x.d.mts`; `x.cts` or `x.d.cts` |
| A value import that finds only a declaration file (`x.d.ts`) | Unknown: what runs isn't in the graph |
| `vi.mock()`, `vi.importActual()` and the rest of the family | Edges |
| `import.meta.glob()` | Edges to every matching file, including one a change adds |
| JSDoc `@type {import("x")}` and `@import` | Edges, since TypeScript reads them |
| `%sveltekit.assets%/x` in a SvelteKit `app.html` | An edge to `static/x` in the project: the nearest directory with a `svelte.config.*` or a `package.json`. `%sveltekit.head%`, `%sveltekit.body%` and the rest aren't references |
| `page.goto("/x.html")` in a suite with `urls` | An edge to the page |
| `compilerOptions.paths` of the nearest `tsconfig.json`, with its relative `extends` | Edges to every target that exists, tried after `alias` and before the `exports` of a package in the repository. A `tsconfig.json` that doesn't parse maps nothing, and `check` lists it |
| `compilerOptions.baseUrl` of that `tsconfig.json` | An edge to the file under it, tried after the `exports` of a package in the repository |
| `#name` subpath imports, through the `imports` of the importing file's own `package.json` | Edges to every condition's target that exists; an unmatched `#name` is unknown |
| Named imports from a barrel: a module made only of re-exports | An edge to the one file that exports each name, when the package's `sideEffects` is `false` or a list without the barrel |
| A package in the dependencies of the file's own `package.json` or an ancestor's, a package in `external`, and a builtin | A `pkg:` node |
| Anything else | Unknown: the file depends on every change |

Some files change how others resolve or run, and no import says so.
bivium seeds the walk from them instead:
seeds are the nodes a walk starts from.

A root lockfile (`bun.lock`, `package-lock.json`, `pnpm-lock.yaml`)
isn't a source file.
A change to one seeds the packages it changed
(see [Lockfiles](#lockfiles)).

Nor is a `tsconfig.json`, a file one `extends`,
or a `package.json` under `roots` (the paths the graph reads).
Their options, `paths`, `type` or `exports` change how the files under
them resolve or run.
A change to one seeds the files it governs:
those it's the nearest of its kind to.

Three kinds of change to these files seed nothing:

- a change the parsed file doesn't show, such as formatting or comments;
- a change to a `package.json`'s metadata alone:
  `version`, `description`, `repository` and the like;
- a change to a `package.json`'s dependencies,
  which goes through the lockfile instead.

A file the lexer can't read cleanly goes to a regex extractor instead.
The regex over-approximates: it errs toward extra edges,
and an extra edge only selects more tests.

CSS isn't scanned.
A generated stylesheet reaches its inputs through `edges`,
and a [narrower](api.md#narrowers) can do better.

## Lockfiles

A dependency bump changes a lockfile, and no file imports a lockfile,
so bivium reads it:

```console
$ bunx bivium plan
bun.lock: @biomejs/biome 2.5.14 → 2.6.3, inert
bun.lock: svelte 5.57.1 → 5.57.2
unit tests: 4 of 12 files
…
```

bivium reads these lockfiles at the repository root:

- `bun.lock`;
- `package-lock.json`, v2 or v3;
- `pnpm-lock.yaml`, v6 or v9.

When one changes, bivium diffs it against the merge base.
It seeds the walk with the `pkg:` nodes of the packages whose entries
changed, and of every package that depends on one.
So a `svelte` bump selects what imports `svelte`,
or a package built on it.
A `package.json` whose only change is to its dependencies,
when the lockfile records them the same way,
counts as those packages changing.

A changed package can also be used in ways the graph can't see:
a CLI a test spawns, a runner, a type package.
So when a change reaches a package that a `package.json` declares
or some file imports, and no test imports it, everything runs.
The plan names the reason
(`bun.lock: playwright 1.63.0 → 1.64.0, and no test imports it`).
A package in `inert` is the exception:
`inert` lists packages no test uses except by importing them,
such as linters and formatters.
bivium itself is always inert: a bump changes which tests later plans
pick, not what a test does.

`loadedByName` lists the packages a test loads other than by an import,
such as a test environment.
With it set, only a package with a `bin` in the lockfile,
or one it lists, counts as used that way.
A bump that reaches a library only a CMS config imports
then selects nothing.

Everything also runs for:

- a lockfile bivium can't parse;
- a lockfile whose settings other than its packages changed:
  `overrides`, patches, pnpm's `settings`, `catalogs`,
  or the version of pnpm itself;
- a `package.json` change the lockfile doesn't record.

Other lockfiles (`yarn.lock`, `bun.lockb`, `npm-shrinkwrap.json`) are
files like any other.
Outside the roots, a change to one runs everything.

## Compared with

Tools that select or skip tests differ in what they select
and what they miss:

| | Selects | Misses |
|:---|:---|:---|
| `vitest --changed`, `jest --changedSince` | Tests whose module graph reaches a changed file, from the runner's own resolver | Disk reads, fixtures, pages a test visits, config and setup wiring |
| Playwright `--only-changed` | Test files whose imports changed | The pages a test opens, and what they load |
| Nx, Turborepo | Whole projects whose inputs changed | Nothing within a project's declared inputs, but it selects whole projects |
| Bazel | Targets whose declared inputs changed | Nothing, when every input is declared |
| bivium | Test files, across runners and file types, from one graph | Nothing it can see; what it can't see, it runs |

## Related

- [Tuning a plan](tuning.md): a change no test reaches, and `check`
- [Config](config.md): telling bivium what it can't see
- [CI](ci.md): the checkout and cache a plan needs
