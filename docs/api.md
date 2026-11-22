# API

`plan()` picks each suite's tests from code,
and returns the plan `bivium plan --json` prints, typed by your config.

```ts
import { defineConfig, plan } from "bivium";

const config = defineConfig({ suites: { unit: { tests: "tests/**/*.test.ts" } } });
const result = await plan({ config, base: "origin/main" });
result.suites.unit; // { mode: "some", files: [...] }; result.suites.e2e is a type error
```

Given a config, the suite names carry through to the result's type,
so a suite the config doesn't have is a type error.
The package exports `plan`, `defineConfig`, `BiviumError`,
and their types.

## plan()

`plan(options?)`
takes four options, all optional:

| Option | Is | Default |
| --- | --- | --- |
| `cwd` | the repository | the current directory |
| `base` | the ref to compare the working tree with | the config's `base`, else the upstream default branch |
| `config` | the config | the `bivium.config.*` file in `cwd` |
| `cache` | the extraction cache's directory, or `false` for none | the config's `cache` |

It returns the fields `bivium plan --json` prints,
except `schemaVersion` and `config`:

| Field | Holds |
| --- | --- |
| `suites` | each suite's selection: `{ mode: "all" }`, `{ mode: "none" }`, or `{ mode: "some", files }` |
| `totals` | how many test files each suite has |
| `reasons` | why a suite runs in full, as sentences |
| `causes` | the same reasons as data, one `FullRunCause` each, in order |
| `packages` | a line per package a lockfile or `package.json` change changed, and that selects through its importers or nothing |
| `base`, `mergeBase` | the base ref, and the merge base the working tree is compared with |
| `changed` | the files changed since the merge base, untracked ones included |
| `narrowed` | what each narrower that ran returned, as `{ name, result }` |

On failure, `plan()` throws a `BiviumError`,
whose `code` and `kind` are the CLI's
(see [JSON and errors](cli.md#json-and-errors)).

## Narrowers

A narrower is a plugin in the config that makes a change to some files
select fewer tests, from a semantic diff.

```ts
// bivium.config.ts, inside defineConfig({ … })
narrowers: [
  {
    name: "css",
    match: "styles/**", // the changed files it narrows
    opaque: "dist/*.css", // the generated nodes its seeds stand in for
    suites: ["e2e"],
    async narrow({ base, head, changed, graph }) {
      const rules = diffRules(await compile(base.commit), await compile(head.commit));
      if (!rules) return { all: "a rule that requires no class changed" };
      return { seeds: sourcesSpelling(rules), note: `${rules.length} rules changed` };
    },
  },
],
```

`compile`, `diffRules`, and `sourcesSpelling` stand for your own code.

Some changes reach every test through a generated file.
Every page loads the compiled stylesheet,
so any style edit selects every e2e test.
bivium plans by a walk: from the changed files (the seeds),
it follows edges back to the tests that reach them.
A narrower replaces a change's coarse seeds with finer ones,
such as the sources that render a changed CSS rule.

The matched files still seed the walk,
but it stops at the `opaque` nodes, and the narrower's seeds stand in
for them.
A narrower can only narrow: its suites' selection is cut to what the
walk without it selects.

| Key | Is |
| --- | --- |
| `name` | names it in reasons and notes: `css: …` |
| `match` | the changed files it narrows |
| `opaque` | the generated nodes its seeds stand in for, such as `dist/*.css` |
| `suites` | the suites it narrows; default: every suite |
| `narrow` | the function that returns the finer seeds |

`narrow()` gets one object:

- `root`, the repository;
- `base` and `head`, the merge base and the working tree,
  each with `commit` and `read(path)`;
- `changed`, the matched files;
- `graph`, read-only: `nodes()`, `importers(node)`, `dependents(nodes)`,
  and `tests(suite)`.

It returns one of two shapes:

| Returns | Then |
| --- | --- |
| `{ seeds, note? }` | the walk uses `seeds`; `bivium plan` prints `note` after the narrower's name |
| `{ all: reason }` | its suites run in full, with `reason` |

A narrower that throws, or returns anything else,
runs its suites in full with the reason too.

carbon-components-svelte runs one over crassus.

## Related

- [Config](config.md): `defineConfig` and every key
- [CLI](cli.md): the same plan from the command line
- [How it works](how-it-works.md): the graph a plan walks
