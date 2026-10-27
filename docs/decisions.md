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
and then reverted on disk would pass the staged blob off as the file. The
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
warm plan; `core.untrackedCache` or an fsmonitor would cut it, but those
are the repository's settings.

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
