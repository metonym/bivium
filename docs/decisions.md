# Decisions

Choices made while building Phase 1 where the plan
(carbon-components-svelte `.context/test-graph-package/plan.md`) was silent,
or turned out wrong in practice.

## 1. A suite's orphan-rule root defaults to the whole repo

Carbon's orphan rule runs a suite in full when a changed file under the
suite's directory (`tests/`, `e2e/`) reaches none of its tests: such a file is
wired some other way (`setupFiles`, `webServer`). bivium keeps the rule, with
the directory as `suites.<name>.root`.

Defaulting `root` to the tests glob's directory would be precise, but a change
to `vitest.config.ts` or `package.json` would then reach no test and select
nothing. So the default is the whole repo: with no config beyond `tests`, any
change no test reaches runs the suite. That is sound and coarse; setting
`root` (and `roots`) buys precision.

## 2. `roots` stays a config key

Plan §3.3 wanted the graph to be every tracked file, with no hand-listed
roots. Carbon's plans depend on its roots, though: a changed file outside them
(`package.json`, `bun.lock`, `.github/workflows/checks.yml`) runs everything,
and that is how it notices wiring it can't see. Without `roots`, those files
are graph leaves, and only the orphan rule (decision 1) catches them. So
`roots` defaults to the whole repo and carbon lists its eight.

## 3. A specifier depends on every file it could load

Carbon's resolver takes the first suffix that exists. bivium takes all of
them: `./uid` means `uid.js` and `uid.d.ts` when both exist, and an `exports`
entry means every condition's target (`types` and `import`). A runner loads
one of them, but which depends on the runner (Vitest the `.js`, svelte-check
the `.d.ts`), and the selection has to cover every runner that reads the
file.

`exports` targets are exact paths: no extension probing, as in Node. A
missing target is skipped as long as one exists (an unbuilt `.svelte.d.ts`);
when none does, the specifier is unknown.

On carbon this adds about 45 edges to sibling `.d.ts` files and `css/css.d.ts`,
and changed no replayed plan.

## 4. Aliases first, then the package's own `exports`

Carbon's resolver tries `src/<subpath>` (Vite's alias), then `<subpath>` as
the exports map spells it. bivium does the same, generically: configured
aliases (longest key first), then the repo's own package by name through its
`exports`. When an alias resolves, `exports` isn't consulted. This matches
carbon on every replayed commit. A union of the two would be more cautious,
but no case needed it.

## 5. Undeclared packages are unknown; `external` lists phantom deps

Plan §3.2: a bare specifier is a `pkg:` node when a `package.json` declares
it, else unknown. Carbon instead accepted any package its lockfiles install.
Four of carbon's imports name packages only a dependency installs
(`playwright`, `axe-core`, `dom-accessibility-api`, `@carbon/colors`); as
unknowns they would run three more unit tests on every change.

A phantom dependency is a real hazard (an upgrade elsewhere moves it), but
today a lockfile change already runs everything, so it costs nothing to accept
them. bivium reads the declaring `package.json` files (the file's package and
its ancestors) and an `external` config list. Reading lockfiles is Phase 6.

Decision 42 reads them.

## 6. Every re-export-only module is a barrel

As planned (§4.3). Named imports bind to `barrel#Name` when the owning
package's `sideEffects` is `false` or a list; a re-exported module the list
marks as effectful stays behind every name. Without `sideEffects`, the whole
barrel. A name whose target doesn't resolve is unknown, so its importers
still run.

This is the one generalization that changes carbon plans: `src/*/index.js`
and `src/index.d.ts` are barrels too. In the replay, PR 4083 changed
`src/Grid/index.js` (adding the CssGrid exports), and
`src/FullPageError/FullPageError.svelte` imports `{ Column, Grid }` from it.
Carbon ran its two tests (FullPageError and aria-forwarding); bivium sees that
neither name moved. Sound under the same `sideEffects` contract carbon relies
on for `src/index.js`.

`barrels` (globs) limits which modules may bind names.
`eval/carbon/strict.config.ts` sets it to the package entry and reproduces
carbon's plans exactly.

Only changed barrels are diffed against the merge base (an unchanged one has
the same names), and names compare by resolved target files.

## 7. The deleted-file exemption is `importOnly`

Phase 0 suggested exempting every deleted file from the orphan rule. Carbon
master (b65b46a6c) exempts only deleted `.svelte` files: only an import
reaches one, and an importer left pointing at it can't resolve it, so it runs
anyway. A deleted setup file that a runner config names is still observable,
so bivium keeps master's rule, as `importOnly` globs.

## 8. Wiring reasons are generic

A change under carbon's `tests-svelte{3,4}/` gave "Svelte 3/4 harness
changed". bivium says "wires the unit suite" for any `wiring` glob. The replay
maps the old text to the new.

## 9. The narrower is a planner option, not config

Plan §4.5b sketches narrowers as config plugins. Phase 1 only needs the hook,
so `planTests` takes a `narrowed` option shaped like carbon's `styles`:
changed files that match stop walking through `opaque` (generated) nodes, and
the narrower's seeds replace them, or its `reason` runs those suites in full.
The CSS narrower stays in carbon until a plugin interface exists.

Superseded by decision 30: narrowers are config plugins now.

## 10. File order is sorted

`git ls-files -co` lists untracked files out of order, so the graph's file
list is sorted. Tracked files come out sorted anyway, so this changes no
replayed plan.

## 11. The package ships TypeScript source

`bin` and `exports` point at `src/*.ts`, which Bun runs and Node ≥ 22.18
type-strips. Node doesn't strip types under `node_modules`, so publishing
needs a build to `.js` first (packaging, not Phase 1).

Superseded by decision 28: the package ships `dist/`.

# Phase 2: the scanner

## 12. Only code counts, plus annotations and JSDoc types

The lexer (`src/lex.ts`) reads specifiers only from code. An import spelled
in a string or a comment adds no edge, and neither does a mention of
`fs` or `Bun.file`, which would otherwise make the file "read the disk".

Comments still carry two things:

- **Annotations** (`@depends-on`, `@reads`, `@glob-registry`), read with the
  regex extractor's own patterns on the comment's text, so the rule is
  unchanged: on a line that starts with the comment, or with `*` inside a
  block comment.
- **JSDoc types** in `/** */` comments: `import("x")` inside a tag's type
  (`@type {import("x").T}`, `@param {…}`), and `@import … from "x"` tags.
  TypeScript reads both in JavaScript files, and svelte-check in Svelte
  ones, so they are real type dependencies. `import()` in prose or in an
  `@example` is not: the type must be inside the `{…}` that follows a tag.
  A JSDoc type import of `fs` isn't a disk read.

## 13. Keyword handlers look ahead, never consume

At `import`, `export`, `require`, `vi`, `.goto`, and `Bun`, the lexer reads
ahead to record what follows, then resumes right after the keyword. Every
character is still lexed once as code, so the bracket stack and the
previous-token state that decides regex vs division never depend on whether
a lookahead understood the statement. A lookahead that fails (`import x =
require("y")` isn't a declaration) just records nothing, and the code that
follows is read normally.

`/` after `)` is a regex only when the `(` followed `if`, `for`, `while` or
`with`; after `}` only when the `{` opened a block (it followed `)`, `=>`,
`;`, `{`, `}`, the start, or `else`/`try`/`finally`/`do`); after a word only
for the keywords es-module-lexer lists (plus `default`). A TypeScript `!`
after a value is a non-null assertion, so `a! / b` divides.

## 14. A file that doesn't lex cleanly falls back to the regex, whole

The lexer throws on an unterminated string, template, comment, regex, JSX
element, `<script>` or HTML comment, and on an unbalanced `(`, `[`, `{` or
`${`. The whole file is then read by the regex extractor
(`src/scan-regex.ts`, kept unchanged), and `Scan.fallback` says why. A
newline inside a string or regex is an error, so a misread regex can't
silently swallow the rest of a line.

The regex extractor over-approximates (it reads everything, strings and
comments included), so a file the lexer can't read never loses an edge. Any
other exception in the lexer (a bug, or a stack overflow on absurd JSX
nesting) falls back the same way rather than failing the plan. On carbon no
file falls back; on the differential corpus none does either.

## 15. Host formats lex only their code

- `.svelte`: each `<script>` block (and a `generics="…"` attribute), and
  every `{…}` markup expression, where an `import()` can appear. Markup
  text, HTML comments and `<style>` are skipped. This matches what the
  regex read there, minus text: the regex also read `import x from "y"`
  typed in markup or in a commented-out script.
- `.html`: inline `<script>` blocks, and `script[src]`, `link[href]`,
  `iframe[src]` (now also unquoted, which the regex missed). A ref inside an
  HTML comment or a script's string no longer counts. Inline event handler
  attributes (`onclick="import('./x')"`) aren't read; the regex would have.
- `.vue`: `<script>` blocks (and `<script src>`); template expressions can't
  import.
- `.astro`: the `---` frontmatter and `<script>` blocks. Markup
  expressions aren't lexed.

`.vue`, `.astro`, `.jsx` and `.tsx` were leaves before (the resolver could
reach them, but nothing read their imports), so scanning them only adds
edges. JSX is lexed in JavaScript files and `.tsx`, where `<T,>` and `<T
extends U>` are type parameters.

## 16. CSS isn't scanned

Plan §3.1 has CSS read `@import`, `@use`, `@forward` and `url()`. The planner
draws no CSS edges today: CSS files are leaves, generated CSS reaches its
inputs through `edges`, and carbon's CSS narrower runs outside the graph. So
the scanner leaves CSS out until a phase needs those edges.

## 17. What reads differently from the regex

Precision (fewer edges or unknowns, all sound):

- Imports, globs, `goto()`s, disk reads and annotations inside strings and
  comments.
- A class method or declaration named `import`/`require`
  (`import(node) { … }`, `require(id: string)`) isn't a non-literal import.
- `import.meta.glob` with a no-substitution template literal is readable,
  and so is `import(/* webpackChunkName: "x" */ "./x")`.
- A `goto()` argument is the whole first argument, so
  `` goto(`/x.html?v=${f(a, b)}`) `` maps to its page.

Soundness (edges or unknowns the regex silently missed):

- `import("./a" + b)` (a literal followed by more) and `vi.mock(variable)`
  are non-literal imports; a glob array with a non-literal entry is a
  non-literal glob.
- `vi.importActual<T>("x")` with type arguments, `import.meta.globEager`,
  `import { "a-b" as c } from`, specifiers containing `$`, JSDoc `@import`,
  and unquoted HTML refs.

## 18. Differences from TypeScript, by design

`eval/corpus.ts` compares the lexer's specifiers with TypeScript's parser.
TypeScript has no notion of `goto()`, annotations, HTML refs or Svelte
markup, so those aren't compared; it does see `vi.mock` once the walker
looks for it, and it agrees. Triple-slash references (`/// <reference
types="…" />`, `path="…"`) are TypeScript inputs but not module edges, and
the regex never read them either; they stay out until a type-check suite
needs them.

# Phase 4: speed

## 19. The cache stores extractions, keyed by blob OID and format

Plan §5.2 lever 2. The unit cached is a file's extraction: its raw
specifiers, annotations, globs as written, every `goto()` argument, and its
re-exports when it's a barrel, before resolution. `extract(format, source)`
computes it; `finish(path, extraction)` adds what depends on the path
(globs made root-relative, `goto()`s kept only for a suite with `urls`), and
`graphFrom` applies `barrels`. So an extraction depends on the content and
the format (`svelte`, `vue`, `astro`, `html`, `ts`, `tsx`, `js`, all from
the extension) and nothing else, and the key is `format:oid`. Identical
files share an entry, a rename still hits, and every config shares one
cache: no config key reaches the scanner, so a config change can't make an
entry stale. If one ever does, it goes into the header.

Resolution is never cached. It depends on which other files exist, and
after the resolver change below it takes 8–11 ms on carbon.

## 20. Which files git vouches for

`git ls-files -s` lists each index entry's blob OID without hashing. An
entry's OID is the working-tree content only when the file is in neither
diff against the merge base: not the working-tree diff (which bivium runs
anyway for `changed`) and not the index diff (`diff --cached
--merge-base`, the one extra git call). Without the second, a change staged
and then reverted on disk would pass the staged blob off as the file. It
runs without the cache too: there a staged new file deleted from disk
would otherwise look present. The
entry must also be stage 0, a regular file (not a symlink or submodule),
and tagged `H` by `-v` (not skip-worktree or assume-unchanged, whose
working tree git doesn't track).

Every other scanned file is read and extracted fresh, and only files with a
vouched OID are written to the cache: bivium never hashes, so a dirty file
has no key. A branch's own changes are therefore always read; on carbon a
typical PR reads 2–40 files and takes the other ~3,300 from the cache.

`tests/cache.test.ts` checks this in a temp repo: an uncommitted edit, the
same edit committed, a new base, a staged blob the working tree reverted,
and a poisoned entry (proving hits are used). Removing either diff from the
check fails it.

## 21. Format: one JSON file with a string table

Measured on carbon's 3,320 extractions (median of 25, load 8–17):

| Format | Size | Load, Bun | Load, Node 24 | Write, Bun |
| --- | --- | --- | --- | --- |
| JSON objects | 1,038 KB | 3.1–5.4 ms | 12–14 ms | 1.9–3.1 ms |
| JSON positional arrays | 676 KB | 3.6–6.4 ms | 8–14 ms | 1.5–2.9 ms |
| Tab/`\x1f` line format | 585 KB | 4.6–8.6 ms | 9.3–9.6 ms | 4.5–7.0 ms |
| `v8.serialize` | 978 KB | 3.6–6.2 ms | 18–19 ms | 14–28 ms |
| JSON + string table | 439 KB | 5.0 ms | 10 ms | 5.3 ms |

No format wins load time by more than noise, and the line format's
escaping is the most code. The string table is less than half the size
of anything else (specifiers repeat across files, and CI uploads the
file), so that is the format: `[header, strings, rows]`, a row being
`[key, imports, globs, gotos, dependsOn, reads, unknown, fallback,
barrel]` of string ids, with `0` for empty. Rows decode only when a file
asks for them, and a row that doesn't decode is a miss.

## 22. Location, writes, size and invalidation

- `node_modules/.cache/bivium/extractions.json` (the convention Babel,
  ESLint and Vite use), or `.bivium/cache/` without `node_modules`; a
  `cache` config key (a path, or `false`) and `--no-cache` override it. The
  directory gets a `*` `.gitignore`, so the cache is never an untracked
  change, which would run everything.
- A run writes only when it extracted a file with a vouched OID that the
  cache lacked. A warm run with a small diff writes nothing.
- It keeps every entry the run used, then unused ones, most recently
  written first, up to half as many again. Switching branches still mostly
  hits, and the file stays within 1.5 × the repo's scanned files.
- Written to `extractions.json.<pid>.<time>.tmp` and renamed, so a crash
  leaves the old file or the new one. Any failure to load (missing,
  truncated, not JSON, counts that don't match the header) is an empty
  cache; any failure to save is ignored.
- The header carries the bivium version and `SCANNER_VERSION`. A test
  hashes the scanner's sources (`barrel`, `host`, `lex`, `scan-regex`,
  `scan`) and fails until `SCANNER_VERSION` is bumped and the hash updated,
  so a scanner change can't silently reuse old extractions.

## 23. Leaves are never read

Plan lever 1. Only scanned files and nested `package.json` files are read.
A leaf git vouches for exists (it's in neither diff, so the working tree
has it). Any other leaf (changed, untracked, a symlink) is `stat`ed, and
dropped if it's missing or not a file, as a failed read dropped it before.
Carbon reads 3,320 of its 3,580 graph files cold, 9.5 of 11.1 MB.

## 24. One `ls-files` call

`ls-files -s -v -o --exclude-standard` lists the index and the untracked
files of the whole repo in one walk; tracked files are filtered to the
roots in code. Before, `ls-files -co -- <roots>` and `ls-files --others`
each walked the working tree, and the untracked walk is the slowest git
call (27–49 ms of a 36–49 ms git stage under load 8). Git is now most of a
warm plan. `core.untrackedCache` doesn't help: `ls-files` doesn't use it
(git 2.50, on a carbon clone: 31 ms with it and 31 without, where `git
status` drops to 24), and with a warm fsmonitor as well it took 39–41 ms
against 32–35.

## 25. The resolver looks probe bases up

A probe of `./x` tried `x`, `x` plus each of 12 extensions, and
`x/index` plus each: 25 fresh strings hashed per specifier, a quarter of
graph-build time. The resolver indexes its files once by every `file minus
an extension`, so a probe is two map lookups, with results in the same
order. Resolutions are cached per directory, then per (interned)
specifier. `graphFrom` on carbon: 19.1 → 8.1 ms. `createResolver` takes
`files` instead of an `exists` callback.

## 26. Nothing else to make lazy

Plan lever 6. Planning (reverse index, BFS, orphan rule, test filters) is
2–3 ms on carbon, and the reverse index was already built on the first
query. A reverse walk needs every file's forward edges, so resolution
can't be skipped for files a change doesn't reach without a way to rule
files out unresolved; that is the grep strategy (Phase 7).

## 27. Soundness on carbon

- `eval/carbon/cache-equal.ts`: on three bases (2, 63 and 309 changed
  files), the graphs from Phase 2's path (every file read), no cache, an
  empty cache and a warm one are identical node by node (edges, patterns,
  reads, unknowns, barrel names), and so are their plans.
- `eval/carbon/replay.ts --subset --cache <dir> --baseline <checkout>`:
  the 40 most recent PR groups and 20 older ones, evenly spaced, each
  planned with no cache, with the cache earlier groups left, and with a
  full one; the three graphs and plans are identical, and identical to
  Phase 2's (a9cea33). Against the recorded Phase 0 plans, 20 match and
  40 differ only by `tests/scripts/test-graph.test.ts` leaving the
  selection: the Phase 2 lexer no longer counts the `"Bun."` in a string
  in `scripts/lib/test-graph.ts` as a disk read (decision 17).

# Packaging and DX (bivium)

## 28. The package ships a build

`scripts/build.ts` bundles `src/index.ts` and `src/cli.ts` into `dist/` as
ESM for Node, with a shared chunk, whitespace and syntax minified but
names kept (a stack trace in a CI log stays readable). Only `version` is
inlined from `package.json`, through a build plugin; a plain JSON import
inlined the whole manifest. `dist/package.json` is the manifest with
`./dist/` dropped from its paths and the dev-only fields removed, and npm
publishes `dist/`, as sveast does. `engines` says Node ≥ 22; a
`bivium.config.ts` needs 22.18 for type stripping, which the README says.

## 29. The public API is defineConfig, plan, and their types

`src/index.ts` re-exported every module, so any internal refactor was a
breaking change. It now exports `defineConfig`, `plan` and the types a
consumer writes against. Those types live in `src/types.ts`, which imports
nothing, so the build emits `index.d.ts` as that module's declarations
plus the exported functions' and checks it has no import: a consumer sees
the public API and none of the internals.

`plan()` has two signatures. Given a config, its suite names flow into
the result (`result.suites.unit` is typed, `result.suites.nope` is an
error, which `scripts/test-package.ts` checks); without one, it loads the
config file and the names are strings. Internally, suites are named by
strings: the generic parameter lives at the boundary, so nothing inside
needs a cast to build a `Record<Suite, Selection>`.

## 30. Narrowers are config plugins, and can only narrow

Plan §4.5b, now that a second narrower is plausible and carbon's CSS diff
should live in carbon's config rather than its script:

```ts
narrowers: [{ name, match, opaque, suites?, narrow(context) }]
```

`narrow()` runs when a changed file the graph places matches, with the
root, the merge base and the working tree (`commit`, `read()`), the
matched files and a read-only graph (`nodes`, `importers`, `dependents`,
`tests`). It returns `{ seeds, note? }` or `{ all: reason }`.

- As in decision 9, the matched files still seed the walk but stop at the
  `opaque` nodes, which the seeds stand in for; other seeds walk as usual.
- The narrowed selection is intersected with the coarse one, so a narrower
  can only remove tests. A bad seed costs precision, never a missed test.
  On carbon the coarse e2e walk of a `css/` change is every test, so the
  intersection changes nothing there.
- A narrower that throws, or returns anything but the two shapes, counts
  as `{ all }` with the reason. Results are checked at run time: a config
  file is untyped code.
- A narrower runs only for suites the caller will use. `run --suite unit`
  doesn't run carbon's CSS narrower, which narrows only e2e, and e2e keeps
  the coarse walk. Carbon's script instead reports e2e as `all` ("not
  compiled when only unit tests run"); neither is used by a unit run, so
  this is an intended difference, not a regression.

`eval/carbon/css-narrower.ts` is carbon's `styleSeeds` on this API, with
the same reasons. `eval/carbon/bivium.config.ts` doesn't use it, so the
golden replay still compares against carbon without an install, as Phase
0 did; `narrowed.config.ts` adds it.

## 31. The CLI matches carbon's script, and rejects what it doesn't know

- `plan --json` puts the suites under `suites`, next to `reasons`, the
  base, merge base, changed files and narrower results, so a suite can be
  named anything (the `reasons` restriction is gone).
- `plan --github` writes `<name>-tests` for every suite (carbon's
  `unit-tests`, `e2e-tests`), or a suite's `output`.
- An unknown option, or an extra positional argument, is an error. A
  misspelled `--github` used to be ignored, leaving CI with no outputs.

## 32. Configs are checked, and unknown keys are errors

A config file is untyped, and a misspelled key (`ignored`, a suite's
`roots`) would quietly select less. `checkConfig` checks every key's type
and rejects unknown ones, for files and for configs passed to `plan()`.
Every glob key takes one glob or a list.

## 33. `sideEffects` paths are relative to their package

An entry with a `/` was matched against repo-relative paths after
dropping `./`, so `./effects.js` matched nothing and a nested package's
entries matched only root files: an effectful module counted as free of
side effects, the unsound direction. A path entry is now relative to the
package that declares it, and a bare name matches at any depth, as
webpack reads them. Carbon's `css/*.css` is unaffected.

## 34. why and check find lines by searching

The scanner keeps no offsets: the cache would have to store them for
every file, for output only `why` and `check` need. Both re-read the few
files they report and search for the specifier, annotation or call. A
miss drops the line number, never the edge. `affectedBy` now walks
breadth-first and can record how it reached each node, so `why`'s chain
is a shortest one through the same walk the plan ran, narrowers included.


## 35. check fails on dead globs

Fail-closed covers what the graph can't read, not a glob it reads but that
can never fire: a typo'd `@depends-on`, a stale path, or one over files the
planner skips. Carbon had a repo test for this; `check` replaces it.

- Every `@depends-on`, `@reads` and `import.meta.glob` pattern a node
  declares is evaluated against every path the one `ls-files` call lists
  (decision 24), tracked and untracked, inside the roots or not. Config
  `edges` inputs are left out: the config owns them.
- A glob is dead when it matches nothing, or when any match is a file
  `classify` drops before seeding: ignored and not a graph node. A match
  that is a node counts even under an ignored path (`ignore` means "not a
  seed"), and one outside the roots that isn't ignored runs everything.
  Carbon's test flagged a glob only when every match was ignored; one
  partly over ignored files still misses a change to those, so it's
  reported too, with the count and a few of them.
- The graph keeps only RegExps. The extractions already hold each glob as
  written, so `Computed` keeps the extraction map and the listing, and
  `check` recompiles the patterns the way `graphFrom` does. The graph, the
  plan and the cache format are unchanged. Lines are found by searching
  the source, as in decision 34.
- `deadGlobs` allows a glob, by `file` and the glob as written, with a
  required reason. An entry that matches no dead glob fails the check, as
  the old test's exact `toEqual` did, so the list can't go stale.

On carbon, two of the old test's five entries remain:
`tests/css/v11-tokens.test.ts`'s `docs/src/**` (795 of its 844 matches are
ignored docs files) and `docs/svelte.config.ts`. The DatePicker examples
are under a root, so they're nodes, and `bun.lock` is outside the roots and
not ignored, so a change to it runs everything.

## 36. `hermetic` vouches for reads outside the repository

A library that works on its user's files, such as a documentation
generator, imports `fs` in most of its modules and `import()`s a config
file by path, but reads none of its own repository's files that way: its
tests pass it fixtures or temporary directories. Each such module was
unknown, so every test that reaches it ran on every change. On sveld, 51
unknown nodes reached a test, and the e2e harness, which reaches all of
`src/`, could never be skipped.

`hermetic` (globs) lists the files whose disk reads and non-literal
imports reach no file of the repository. For them, `graphFrom` drops
"reads the disk without @depends-on" and "non-literal dynamic import";
every other cause (an unresolved specifier, a non-literal glob or `goto()`)
stays, and so does what an `@depends-on` or `@reads` declares. A file that
does read repository files names them with an annotation, hermetic or not.

It's config, not an annotation, so one glob covers a library's `src/**`,
and it's applied in `graphFrom`, not `extract`, so cached extractions
don't depend on the config. It's a promise the graph can't check: a
hermetic file that reads a repository file without declaring it is missed.
The fix hints in `check` name it as the alternative to an annotation.

## 37. check reaches tests the way plan does

`check` lists the tests each unknown node makes run on any change by
walking from the node as if it had changed. That also seeded the files
that read it as text, but an unknown node isn't a change: `plan` adds it
to every walk after the readers are seeded, so its readers only run when
it changes. sveld's tests read fixtures with `@reads`, and the fixtures
import files that don't exist on purpose: `check` counted 60 of them as
reaching a test that no plan ever widened. The walk takes `readers: false`
there.

## 38. `edges` and `reads` refer back to the matched path

`edges` mapped a glob to fixed inputs, so a dependency per match needed an
entry per match, and there was no config form of `@reads`. Two cases from
carbon-preprocess-svelte: its e2e suite builds each `examples/*` project,
so `examples/<name>/package.json` depends on `examples/<name>/**`; and a
bun snapshot `tests/__snapshots__/X.test.ts.snap` belongs to
`tests/X.test.ts`, but no test reached it, so the orphan rule ran the whole
unit suite (8 of 150 PRs, for one golden snapshot).

- **Captures.** In a value, `$1`, `$2`… are what the key's wildcards
  matched: each `*`, `**`, `?` and `{…}`, numbered from the left by where
  it starts, as regex groups are. `**/` captures its trailing slash, so
  `src/**/*.ts` → `tests/$1$2.test.ts` puts a file at any depth back in
  place. A capture is substituted as text, never as a glob, so a file
  named `a,b.test.ts` doesn't turn into an alternation. `*` can't stand
  for the capture, as it does in `urls`, because values are globs with
  their own `*`; `{name}` would collide with `{a,b}`. A `$` followed by
  digits in a value is always a capture.
- **Bad references are config errors.** `checkConfig` rejects `$0` and a
  number past the key's wildcards, naming the entry and the value. A
  capture inside an alternative the match didn't take has no text; it
  matches anything, so it can only widen.
- **`reads` is a new key, not an option on `edges`.** It's `@reads` in the
  config: file glob → globs of files it reads as text, seeded only by a
  direct change, through the same `deps.reads` and the same readers loop.
  A snapshot change now seeds its test, which also takes it off the orphan
  rule (`reach` seeds readers). A deleted test's stale snapshot reaches no
  test, so it still runs the suite. `edges` stays transitive: a generated
  file is built from its inputs and what they import.
- **Per-example tests read, they don't import.** With `edges`, an
  example's unknown node (a page loading a bundle only its build writes)
  sits under its test's glob, so the test ran on every change. With
  `reads` the unknown stays the example's own: unknown nodes join a walk
  after readers are seeded (decision 37), and a change to the example's
  files still seeds the test. `reads` is a promise, like `@reads`: a
  change to what the read files import, such as the library an example
  builds against, doesn't count, so a suite that needs that keeps `edges`
  or adds the library to its value.
- Both apply at the end of `graphFrom`, as `edges` did, so extractions and
  the cache are unchanged. `why` labels the edges `edges in the config`
  and `reads in the config`, checking that the entry matches both ends
  rather than just the node.
- `check` now covers the config (decision 35 left `edges` out). A key that
  matches no graph node applies to nothing. A value is evaluated over the
  union of its expansions for every node the key matches: a snapshot glob
  most tests have no file for is alive while one has. Both are reported
  under the config's file, and `deadGlobs` allows them by that file and
  the glob as written.

## 39. Subpath imports resolve through the owning `package.json`

A `#name` specifier is the importing file's own package's business: Node
reads the `imports` of the nearest `package.json` above the file, and no
other. bivium does the same with the package that owns the file (the one
`sideEffects` and declared dependencies already use), and matches keys as
`exports` does: an exact key, else the `*` pattern with the longest
prefix. Every condition's target counts, as in decision 3. A `./` target is
an exact path in the package, skipped when missing as long as another
exists; a package target (`"#dep": { "node": "dep-native" }`) resolves as
the bare specifier would, and one that can't makes the whole specifier
unknown, since that condition's file is then unknown. Files beat a `pkg:`
node when a key has both: a `pkg:` node is a leaf no change reaches.

`alias` is still tried first, so a config can map a `#` prefix itself. A
`#name` no key matches, or whose targets are all missing or `null`, is
unresolved: unknown, as Node would fail to load it.

## 40. tsconfig `paths` after `alias`, before `exports`

A repository whose tests import its package by name through
`compilerOptions.paths` (`"carbon-preprocess-svelte/*": ["./src/*"]`) had
to repeat the mapping as `alias`. bivium now reads `paths` and `baseUrl`
from every `tsconfig.json` git lists at the root or under the roots, and a
file uses the nearest one above it, as TypeScript and
`vite-tsconfig-paths` pick a project for a file.

- Order: relative, `alias`, `paths`, `#` imports (decision 39), the repo's
  own packages by name, a file under `baseUrl`, builtins, declared
  packages. `alias` is the config, so it wins. `paths` comes before
  `exports` because that's the case it exists for: `exports` names a
  build output (`dist/`) the tests never load from source. As with an
  alias, a key that matches but whose targets don't exist falls through.
  `baseUrl` lookups come after the repo's packages, which a bundler
  resolves without reading `tsconfig.json`, and before `pkg:` nodes: an
  edge to a file is the cautious choice when TypeScript would load one.
- Keys match as TypeScript matches them (exact, else the longest
  prefix). TypeScript loads the first target that exists; bivium takes
  every one that exists, as decision 3 does for conditions.
- Targets are relative to `baseUrl` when one is set anywhere in the
  chain, else to the file that sets `paths`. A file's own options
  override what it extends, and a later `extends` entry an earlier one.
- `extends` is followed when it's a relative path (with TypeScript's
  `.json` fallback) to a file git lists. A package (`@tsconfig/svelte`)
  lives in `node_modules`, and an ignored file (SvelteKit's generated
  `.svelte-kit/tsconfig.json`) changes without the diff seeing it, so
  both are skipped: what only they would map stays unresolved, which is
  unknown.
- The files are JSON with comments and trailing commas, parsed without a
  dependency. One that doesn't parse, or a chain with such a file in it,
  maps nothing: `paths` from a parent would be a guess, and an unmapped
  specifier is unknown. `check` lists them, without failing.
- tsconfig files are read on every run, like `package.json`, and never
  cached, so an edit takes effect on the next plan. A change to one is a
  leaf the graph places nowhere, like a `package.json`: outside the roots
  it runs everything, under a suite's `root` the orphan rule runs the
  suite. An edge from each file that resolved through `paths` would look
  more precise, but it would stop the orphan rule from firing, and the
  files whose resolution an edit moved away from `paths` would have no
  such edge.

TypeScript's `include` and `files` aren't read, nor `references` to other
configs: the nearest file is an approximation, and when it's wrong the
specifier is unresolved rather than mapped elsewhere, unless that
config's own `paths` happen to match it.

## 41. `%sveltekit.assets%` is the project's `static/`

SvelteKit's `app.html` links its icon as
`href="%sveltekit.assets%/favicon.png"`, which the scanner reads, like any
relative `href`, as `./%sveltekit.assets%/favicon.png`: unresolved, so the
file depended on every change. SvelteKit replaces the placeholder with the
assets directory, `static/` in the project unless `kit.files.assets` says
otherwise. The resolver maps the prefix to `static/` in the nearest
directory above the file with a `svelte.config.*` or a `package.json`, and
a missing file stays unresolved.

The mapping is in the resolver, not the scanner, so extractions (and the
cache) are unchanged. The other placeholders (`%sveltekit.head%`,
`%sveltekit.body%`, `%sveltekit.nonce%`) sit in text or in attributes the
scanner doesn't read, so they never were references; a test pins that.
A custom `kit.files.assets` isn't read: its files are unresolved unless
`static/` has the same name, which `check`'s hint for the cause points
out. An `%sveltekit.env.PUBLIC_X%` in a `src` or `href` stays unresolved.

## 42. A lockfile change seeds the packages it changed

A changed `bun.lock` was outside the roots in most configs, so it ran
everything: on sveld 31 of the last 150 merged PRs and on
carbon-preprocess-svelte 49, nearly all dev-dependency bumps. Decision 5
deferred reading lockfiles; this reads them.

When a root `bun.lock` or `package-lock.json` (v2 or v3) changed,
`readPackageDiff` (`src/lockfile.ts`) reads it at the merge base and in
the working tree, and lists the packages whose entries differ: a version,
an integrity, a resolution or a dependency, compared by the whole entry,
and the dependency ranges a workspace declares. `planTests` then:

- Seeds `pkg:<name>` for the changed package and for every package that
  depends on it, transitively, through the lockfiles' dependency lists in
  either revision (`dependencies`, `optionalDependencies`,
  `peerDependencies`), that some file imports. Packages are matched by
  the name they're installed as, so two versions of one name merge, which
  only adds seeds.
- Seeds the lockfile itself, so a file that `@reads` or `@depends-on` it,
  and every file with unknown dependencies, still runs. It isn't subject
  to the orphan rule: the packages it changed are how it's wired.
- Runs everything when a package the change reaches is used some way the
  graph can't see. That's each package in the change's dependents closure
  that a workspace declares, that nothing depends on, or that some file
  imports, and that reaches no test through an import (a CLI a script
  spawns, a runner, a type package, a dependency only a runner config
  imports). The reason names it: `bun.lock: rolldown 1.2.13 → 1.2.15 (and
  16 more packages rolldown depends on), and no test imports it`.
- `inert` (globs over package names) lists the packages no test uses
  except by importing them: linters, formatters, type packages, tools CI
  runs on its own. Such a package counts as covered, so a change only
  they reach selects nothing beyond the files that import them (and the
  unknown files, as any change does). It's a promise the graph can't
  check, like `hermetic`, and it's config, not a guess: bivium has no
  list of "dev tools", since a `devDependency` such as `svelte-check` or
  `playwright` is exactly what an e2e harness runs.

A changed `package.json` (the root's or a workspace's) whose only change
is to its dependency fields, and whose changed names every lockfile the
working tree has records the same way for its directory, is handled the
same way: the names whose ranges changed count as changed packages, and
it seeds itself without the orphan rule. Any other `package.json` change
is classified as before.

Fail-closed rules:

- A lockfile that can't be parsed, that was added or deleted, or whose
  settings other than its packages and workspaces changed (`overrides`,
  `patchedDependencies`, `trustedDependencies`, the format version) runs
  everything, with the reason.
- A `package.json` dependency change that the lockfiles don't record (no
  lockfile, a stale one, or one in a format bivium doesn't read in the
  repository) isn't explained, so it's classified as before: outside the
  roots, it runs everything.
- `bun.lockb`, `pnpm-lock.yaml`, `yarn.lock` and nested lockfiles are
  read as before: a change to one outside the roots runs everything.
- An ignored lockfile is still skipped (`ignore` says no test observes
  it), and a `self` one still runs everything. A wired one runs its
  suites and still seeds the others.

What it can still miss, by design: a package some test imports is assumed
to reach the other tests only through imports too. One that a suite's
harness also runs as a tool (a dev server a unit helper imports) is caught
only if the tool's own package depends on the change and no test imports
that package, or if the harness's file is unknown. A CLI used without
being declared (a phantom binary) is the hazard decision 5 describes for
phantom imports.

`plan` prints a line per changed package it seeded or found inert
(`bun.lock: svelte 5.1.0 → 5.2.0`, `bun.lock: knip 6.43.0 → 6.44.0,
inert`), `--json` and `plan()` return them as `packages`, and `why` names
the change at the root of a chain that starts at a `pkg:` node.
Extraction is unchanged, so the cache and `SCANNER_VERSION` are too.

On carbon-preprocess-svelte, replaying six dependency-bump commits with
`inert` set to Biome, knip, ostia, bivium and `@types/*`: in the two
Biome bumps the lockfile selects nothing (the plans still run what the
reformatted example and golden files reach), and the sveast bump selects
21 of 31 unit tests and no package test. The other three still run
everything, for rolldown (which `examples/rolldown` imports and no test
reaches), `carbon-components-svelte` (which the tests read as an
installed fixture), or a declared `sveast` nothing imports any more.

## 43. why names what spells each edge, and tree stays the default

`why` said `import` for every edge to a file and `glob` for every
pattern, so a chain through a page read as five imports, and a config
`edges` hop looked like an `import.meta.glob`. `Via.kind` now names what
spells the edge: `import`, `goto`, `html` (an HTML page's `script[src]`,
`link[href]`, `iframe[src]` or inline script import), `name` (a named
import bound to a barrel name), `export` (a barrel name to the file that
exports it, or to a re-export with side effects), `glob`
(`import.meta.glob`), `depends-on`, `edges`, `reads` and `unknown`.

Selection doesn't change: every kind is followed the same way, and the
walk computes a kind only when asked for `parents`. `name`, `export` and
`html` follow from the node ids. The rest needed two fields in
`graphFrom`, outside the extraction (so no `SCANNER_VERSION` bump): the
`files` only a `goto()` opens (`pages`), and which `patterns` an
`@depends-on` or the config's `edges` spells (`patternKinds`). A page a
file both imports and opens is an `import`.

Line lookup still searches (34), but now prefers an occurrence in code,
on a line that loads the thing (`goto(`, an import, `src=`), over one in
a comment: on carbon, `e2e/helpers/host.ts:9`, a JSDoc line that names
`host.html`, became the `page.goto()` on line 50. A `goto()` is found by
the argument that maps to the page.

`--format chain` reads from the change to the test, one verb per hop,
each path once; for a test that depends on every change it gives the
cause, its line and `check`'s fix first. `--format source` prints each
hop's line of source under it. `tree` stays the default: it is what
users and scripts have seen since 0.1, and the other two haven't been
used yet. Making `chain` the default is a later, separate change.

`why` also says how many other changes reach the test (`--all` shows
each one's chain). A walk from many seeds reaches what the walks from
each reach, so it walks from each other seed alone, with the same
narrower walks; on carbon with four changed components that adds well
under a tenth of a second. A test that depends on every change skips
it: every change reaches it. A given file that doesn't reach the test
reports how many tests its chains do reach, leaving out the ones that
run on every change, which any file would select.

## 44. The merge base is found when something asks for it

`diff --merge-base` finds the merge base itself, so the `git merge-base`
process only serves what needs the commit: `plan()` and `plan --json`
report it, and a narrower gets it as `base.commit`. `readRevision` now runs
it on first use, up front for those two callers, and as soon as a changed
file matches a narrower, so the narrower doesn't wait for it after the
graph. A `bivium run`, a text `plan` or `--github` skips it.

A changed barrel's or lockfile's base version doesn't need it either: the
working-tree diff runs with `--raw --no-abbrev`, which names each changed
file's blob at the merge base (all zeros for a file added since), and
`git show <blob>` reads it. A path the diff doesn't name (or names as
conflicted, or as a submodule) is read as `<merge base>:<path>`. Reading
by blob first made the barrel case no slower: with the merge base found
first and then the file, the bench's barrel plan was 28% slower.

Measured with `ostia ab` (load 7), `readRevision` retires 14–16% fewer
instructions and takes 7% less time. On carbon and sveld (load 7, 7 × 20
calls) a call spends 21% and 24% less CPU, git's processes included (126
ms against 160, 93 against 121), and takes 49 ms against 52 and 39
against 42; `bench/phases.ts`'s git phase moved within its noise.

Measured and dropped: the index diff (decision 20) could go too. An
entry unchanged since the merge base on disk (not in the working-tree
diff) and the same on disk as in the index (not in `ls-files -m`) is
unchanged in the index, so `-m` on the listing gives the same vouched-for
set with two git processes instead of three. It cut a carbon call's CPU
by 16% and sveld's by 27%, but `-m` checks each entry serially in the
process that already walks for untracked files, the longest call: on
carbon `readRevision` took 51 ms against 47. Parsing the listing without
a regex saved under a millisecond of its 2–3.
