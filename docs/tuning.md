# Tuning a plan

A plan that runs more than a change needs has a cause bivium can name;
`bivium check` lists each one with its fix.

## A change no test reaches

A changed file under a suite's `root` that no test of the suite reaches
is wired some other way (a runner config, a setup file),
so the whole suite runs: the orphan rule.
With the default `root`, the whole repository,
any file bivium can't trace to a test runs the suite,
which is sound and coarse.
Set `root` on every suite to the directories its tests
and sources live in, and say what the rest is:

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

A file outside `roots` that isn't ignored runs everything:
it's the backstop for wiring the graph can't see, such as a CI workflow.

`bivium check` lists every file under a suite's `root` that no test
reaches and the config doesn't exempt,
with a fix for each by what it looks like: a test's snapshot,
a runner's config, or anything else.
It's the list to work through when adopting bivium,
and a new entry is a gap someone added.

A file's own disk reads make it unknown,
but a test that hands a path to the code under test
(`typecheck({ workspace: "tests/fixtures" })`),
or a `hermetic` one that reads it, reads nothing the graph can see.
So `check` also reads the string literals in each test,
and in what the tests reach under a suite's `root`,
for repository paths: relative to the root when they have a slash
(`join(root, "tests/fixtures")`), and relative to the file
(`new URL("fixtures", import.meta.url)`).
It fails on one a change to which wouldn't select the tests that reach
the file, with the `reads`, `edges` or annotation that declares it.
A path whose change runs the suite anyway, as `wiring`,
`self` or by the orphan rule, doesn't fail,
and an unreached file's fix names where it's spelled.
Strings inside brackets are skipped as data
(`["src/a.ts", …]`, `map["key"]`), as are the directories a file is in
and paths outside the graph.
A path a test only names, such as an expected output,
takes `// @lists <path>`.

## Dead globs

A typo'd `@depends-on`, or one pointing only at files the planner skips,
looks fine and never selects its file.
`check` evaluates every `@depends-on`, `@reads`,
`@lists` and `import.meta.glob` pattern,
every `edges` and `reads` value, and every suite's `setup`,
against every file git lists
(tracked and untracked, inside the roots or not) and reports one that:

| Problem | Means |
|:---|:---|
| matches nothing | No file matches: a typo or a stale path |
| matches only ignored files, partly ignored | Some matches are ignored and not in the graph, so a change to one selects nothing |

A config value with captures is dead only when it matches nothing for
every file its key matches, and a key that matches no file the graph
reads is reported too, under the config's file.
An ignored file the graph reads still seeds a walk,
and a change outside the roots runs everything, so neither is dead.
A glob that's dead on purpose goes in `deadGlobs` with a reason:

```ts
deadGlobs: [
  { file: "tests/css/tokens.test.ts", glob: "docs/src/**", reason: "docs-only changes skip CI" },
],
```

## Related

- [Config](config.md): every key named here
- [CLI](cli.md): `check`, `why` and `graph`
- [Recipes](recipes.md): settings for common runners
