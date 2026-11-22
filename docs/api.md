# API

`plan()` returns what `bivium plan --json` prints, typed by your config;
narrowers refine a plan from a semantic diff.

## plan()

```ts
import { defineConfig, plan } from "bivium";

const config = defineConfig({ suites: { unit: { tests: "tests/**/*.test.ts" } } });
const result = await plan({ config, base: "origin/main" });
result.suites.unit; // { mode: "some", files: [...] }; result.suites.e2e is a type error
```

`plan(options?)`
takes `cwd`, `base`, `config` (default: the config file in `cwd`)
and `cache`, and returns each suite's selection, its test count,
the reasons as sentences and as data,
the packages a lockfile change seeded or found inert, the base,
merge base and changed files, and what each narrower returned.
Given a config, the suite names carry through to the result's type.
The package exports only `plan`, `defineConfig` and their types.

## Narrowers

Some changes reach every test through a generated file:
every page loads the compiled stylesheet,
so any style edit selects every e2e test.
A narrower replaces such a change's coarse seeds with finer ones from a
semantic diff, such as the sources that render a changed CSS rule.

```ts
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

The matched files still seed the walk,
but it stops at the `opaque` nodes, and the seeds stand in for them.
A narrower can only narrow: its suites' selection is cut to what the
walk without it selects.
One that returns `{ all: reason }`, throws,
or returns anything else runs its suites in full with the reason.
`narrow()` gets:

- `root`, the repository;
- `base` and `head`, the merge base and the working tree,
  each with `commit` and `read(path)`;
- `changed`, the matched files;
- `graph`, read-only: `nodes()`, `importers(node)`,
  `dependents(nodes)` and `tests(suite)`.

carbon-components-svelte runs one over crassus.

## Related

- [Config](config.md): `defineConfig` and every key
- [CLI](cli.md): the same plan from the command line
