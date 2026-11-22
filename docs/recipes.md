# Recipes

Settings for common test runners and repository shapes,
each a starting point to adjust.

**Vitest or Jest.**
Name the setup files the runner loads,
mirror `resolve.alias` (a Vite key like `"@/"` works as written),
give snapshots to their tests, and, for a suite that runs code,
skip type-only edges:

```ts
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
```

tsconfig `paths` (what `vite-tsconfig-paths` reads) are read without an
`alias`.
An extensionless `vi.mock("@/x")` resolves as an import does.
A test environment the runner loads by name (`jsdom`, `happy-dom`) goes
in `loadedByName` if you set it.

**pnpm workspaces.**
Workspace packages resolve through their `package.json` `exports`,
and a `.js` specifier into one (`@acme/ui/Button.js`) reaches its `.ts`
source.
A `pnpm-lock.yaml` change selects through the packages it changed.
Set `roots` to the packages and apps whose changes the suites need to
see, and a suite per test runner.

**Playwright.**
Map `page.goto()` URLs to the pages they open with `urls`,
list pages only a `goto()` opens in `pages`,
and name `playwright.config.ts` in `wiring`:

```ts
e2e: {
  tests: "e2e/**/*.spec.ts",
  root: "e2e",
  urls: { "/*": "e2e/fixtures/*.html" },
  wiring: ["playwright.config.ts"],
},
```

**Generated code.**
A content or type generator that writes into a gitignored directory
(`.velite`, `.contentlayer/generated`) is an `edges` entry from what it
writes to what it reads:
`{ ".velite/*": ["content/**", "velite.config.ts"] }`.
An import of `#velite` or `../.velite` then reaches the content,
and not every change.

## Related

- [Config](config.md): every key
- [Tuning a plan](tuning.md): when a plan still runs too much
