# Recipes

A recipe is a bivium config for a common test runner
or repository shape: a starting point to adjust.

## Vitest or Jest

```ts
// bivium.config.ts
import { defineConfig } from "bivium";

export default defineConfig({
  suites: {
    unit: {
      tests: "src/**/*.test.{ts,tsx}",
      run: "vitest run {files}",
      root: "src",
      setup: ["src/setupTests.ts"], // vitest.config.ts `setupFiles`
      wiring: ["vitest.config.ts"],
      types: false,
      nonInputs: ["src/**/types.ts"], // types only: nothing loads them at runtime
    },
  },
  alias: { "@/": "src/" },
  reads: { "src/**/*.test.{ts,tsx}": "src/$1__snapshots__/$2.test.$3.snap" },
});
```

Each key tells bivium how the runner loads files,
which the imports alone don't show:

- `root`: the directory the orphan rule covers.
  Under it, a changed file no test reaches is wired some other way,
  so the whole suite runs.
- `setup`: the setup files the runner loads before every test.
  bivium doesn't read the runner's config, so name them here.
- `wiring`: the runner's config; a change to it runs the whole suite.
- `types: false`: the suite runs code,
  so a change that reaches its tests only through types selects none.
- `nonInputs`: modules that hold only types,
  which nothing loads at runtime.
- `alias`: the same prefixes as Vite's `resolve.alias`;
  a Vite key such as `"@/"` works as written.
- `reads`: each test's snapshot, so a snapshot change selects its test.
  `$1`, `$2` and `$3` are what `**/`, `*` and `{ts,tsx}` matched:
  `src/a/Button.test.tsx` reads
  `src/a/__snapshots__/Button.test.tsx.snap`.

For Jest, set `run` to your Jest command
and `setup` to Jest's `setupFiles`.
bivium reads tsconfig `paths` itself, as `vite-tsconfig-paths` does,
so they need no `alias`.
An extensionless `vi.mock("@/x")` resolves as an import does.
A test environment the runner loads by name,
such as `jsdom` or `happy-dom`, goes in `loadedByName` if you set it.
That key lists the packages a test loads other than by an import.

## pnpm workspaces

```ts
// bivium.config.ts
import { defineConfig } from "bivium";

export default defineConfig({
  suites: {
    unit: { tests: "packages/*/src/**/*.test.ts", run: "vitest run {files}" },
    e2e: { tests: "apps/web/e2e/**/*.spec.ts", run: "playwright test {files}" },
  },
  roots: ["packages", "apps"],
});
```

Give each test runner a suite of its own.
Set `roots` to the packages and apps whose changes the suites need to
see; a changed file outside them that isn't ignored runs everything.

Workspace packages resolve through their `package.json` `exports`.
A `.js` specifier into one (`@acme/ui/Button.js`) reaches its
`.ts` source.
A `pnpm-lock.yaml` change selects through the packages it changed
(see [Lockfiles](how-it-works.md#lockfiles)).

## Playwright

```ts
// bivium.config.ts
import { defineConfig } from "bivium";

export default defineConfig({
  suites: {
    e2e: {
      tests: "e2e/**/*.spec.ts",
      root: "e2e",
      urls: { "/*": "e2e/fixtures/*.html" },
      wiring: ["playwright.config.ts"],
    },
  },
});
```

A test reaches a page through the URL it opens, not an import:

- `urls`: maps each `page.goto()` URL to the page it opens.
  Each `*` in the value is what the key's `*` matched,
  so `page.goto("/accordion")` opens `e2e/fixtures/accordion.html`.
- `wiring`: `playwright.config.ts`; a change to it runs the whole suite.

List the pages only a `goto()` opens in the suite's `pages`.

## Generated code

```ts
// bivium.config.ts
import { defineConfig } from "bivium";

export default defineConfig({
  suites: {
    unit: { tests: "src/**/*.test.ts", run: "vitest run {files}" },
  },
  edges: { ".velite/*": ["content/**", "velite.config.ts"] },
});
```

A content or type generator writes into a gitignored directory,
such as `.velite` or `.contentlayer/generated`.
Without an entry, an import of a file there is unknown:
it counts as depending on every change.
An `edges` entry goes from what the generator writes to what it reads.
An import of `#velite` or `../.velite` then reaches the content
and the generator's config, and not every change.

## Related

- [Config](config.md): every key
- [Tuning a plan](tuning.md): when a plan still runs too much
- [Not supported](how-it-works.md#not-supported): what bivium leaves to
  other tools
