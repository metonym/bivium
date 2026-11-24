# Tuning a plan

Tuning a plan is telling bivium how your files are wired,
so a change runs only the tests it can reach.
When a plan runs more than that, bivium can name the cause,
and `bivium check` lists each cause with its fix.

With a suite's default `root`, an edit to `README.md`
or `vitest.config.ts` runs the whole suite:

```console
$ bunx bivium plan
Full run: README.md: no unit test imports it
Full run: vitest.config.ts: no unit test imports it
unit tests: all (full run)
```

`bivium check` lists those files before they change, each with a fix:

```console
$ bunx bivium check
Summary:
  2 files under a suite's root that no test reaches

Files under a suite's root that no test reaches: a change to one runs the whole suite:
  unit (2)
    README.md
      fix: if a test reads or runs it, say so with `reads` or `@depends-on` in that test or what loads it; if none can observe it, list it in the suite's `nonInputs`, or delete it if it's dead
    vitest.config.ts
      fix: if the runner loads it, name it in the suite's `wiring` (or `setup`, if it runs before every test), which makes the full run deliberate

0 nodes with unknown dependencies reach a test: each such test runs on any change.
```

## A change no test reaches

To stop a change to a file no test reaches from running a whole suite,
set the suite's `root` and say what the other files are.

The orphan rule is why it runs.
It applies to a changed file under a suite's `root` that no test of the
suite reaches.
bivium takes such a file to be wired some other way,
such as a runner config or a setup file, so the whole suite runs.
The default `root` is the whole repository,
so any file bivium can't trace to a test runs the suite.
That misses no test, and it runs the suite for a README edit.

Set `root` on every suite to the directories its tests
and sources live in:

```ts
// bivium.config.ts
import { defineConfig } from "bivium";

export default defineConfig({
  suites: {
    unit: {
      tests: "tests/**/*.test.ts",
      run: "vitest run {files}",
      root: "tests",
      wiring: ["vitest.config.ts"],
    },
  },
  roots: ["src", "tests"],
  ignore: ["README.md"],
});
```

Then say what each remaining file is:

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

`roots` is the backstop.
A file outside `roots` that isn't ignored runs everything,
for wiring the graph can't see, such as a CI workflow.

### What `check` lists

`bivium check` lists every file under a suite's `root` that no test
reaches and the config doesn't exempt.
Each gets a fix chosen by what the file looks like: a test's snapshot,
a runner's config, or anything else.
Work through the list when adopting bivium.
After that, an entry that appears is a gap someone added.

### Paths a test spells

A test can depend on a file without bivium seeing it.
A file that reads the disk itself is unknown:
bivium counts it as depending on every change.
But a test that hands a path to the code under test reads nothing the
graph can see, as in `typecheck({ workspace: "tests/fixtures" })`.
Neither does a `hermetic` file that reads the path.

So `check` reads the string literals in each test,
and in the files the tests reach under a suite's `root`,
for repository paths.
A string with a slash is tried relative to the repository root,
as `join(root, "tests/fixtures")` spells one, and relative to the file.
A bare name is tried relative to the file,
as `new URL("fixtures", import.meta.url)` spells one.

`check` fails on a path whose change wouldn't select the tests that
reach the file.
The report names the `reads`, `edges` or annotation that declares it.
A path whose change runs the suite anyway doesn't fail:
one that `wiring` or `self` names, or one the orphan rule covers.
For that last kind, the unreached file's fix names where it's spelled.

`check` skips three kinds of string:

- strings inside brackets, as data: `["src/a.ts", …]`, `map["key"]`;
- the directories the file itself is in;
- paths outside the graph.

A path a test only names, such as an expected output,
takes `// @lists <path>`.

## Dead globs

A dead glob is a pattern that looks fine and never selects its file,
such as a typo'd `@depends-on`, or one that points only at files
bivium skips.
`check` looks for them.
It tests these patterns against every file git lists,
tracked or untracked, inside the roots or not:

- every `@depends-on`, `@reads`, `@lists`
  and `import.meta.glob` pattern;
- every `edges` and `reads` value;
- every suite's `setup`.

It reports a pattern with one of these problems:

| Problem | Means |
|:---|:---|
| matches nothing | No file matches: a typo or a stale path |
| matches only ignored files | Every match is ignored and outside the graph, so a change to one selects nothing |
| partly ignored | Some matches are ignored and outside the graph, and a change to those selects nothing |

```console
$ bunx bivium check
Summary:
  2 dead globs

Dead globs: a change to what they match, or to some of it, selects nothing:
  tests/a.test.ts
    ✗ depends-on docs/**: matches only ignored files (1: docs/a.md)    tests/a.test.ts:1
      fix: point it at files the selector reads, or allowlist it in `deadGlobs` with a reason
    ✗ reads src/tokns.css: matches nothing    tests/a.test.ts:2
      fix: fix the path
…
```

A config value with captures (`$1`) is dead only when it matches nothing
for every file its key matches.
A key that matches no file the graph reads is reported too,
under the config's file.

Two cases aren't dead.
An ignored file the graph reads still starts a walk to the tests that
reach it.
A change outside the roots runs everything.

A glob that's dead on purpose goes in `deadGlobs` with a reason:

```ts
deadGlobs: [
  {
    file: "tests/css/tokens.test.ts",
    glob: "docs/src/**",
    reason: "docs-only changes skip CI",
  },
],
```

## Related

- [Config](config.md): every key named here
- [CLI](cli.md): `check`, `why` and `graph`
- [Recipes](recipes.md): settings for common runners
- [Not supported](how-it-works.md#not-supported): what bivium leaves to
  other tools
