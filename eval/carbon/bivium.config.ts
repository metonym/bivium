import { defineConfig } from "../../src/index.ts";

/**
 * carbon-components-svelte's `test:changed` (scripts/test-changed.ts and
 * scripts/lib/test-graph.ts at b65b46a6c) as a bivium config. Each key notes
 * the constant it replaces. It plans as carbon's script does without an
 * install: `narrowed.config.ts` adds the CSS narrowing (`styleSeeds`).
 */
export default defineConfig({
  base: "origin/master",
  suites: {
    // UNIT_TEST, SUITE_ROOTS.unit, TYPE_CHECK_ONLY, COMPAT_HARNESS
    unit: {
      tests: "tests/**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}",
      run: "bunx vitest run {files}",
      root: "tests",
      // Read only by `test:types` (svelte-check), which runs whenever the
      // unit suite's job does. `tests/tsconfig.json` isn't one: Vite reads
      // it to transform the tests.
      nonInputs: ["**/*.test-d.ts", "**/tsconfig.compat-check.json"],
      // The Svelte 3/4 harnesses run the same unit tests.
      wiring: ["tests-svelte{3,4}/**"],
    },
    // E2E_TEST, SUITE_ROOTS.e2e, FIXTURE_PAGE, the `e2e/fixtures` goto mapping
    e2e: {
      tests: "e2e/**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}",
      // Chromium only, as CI runs it.
      run: "bunx playwright test --project=chromium {files}",
      root: "e2e",
      urls: { "/*": "e2e/fixtures/*" },
      pages: "e2e/fixtures/**/*.html",
    },
  },
  // GRAPH_ROOTS (test-changed.ts; test-graph.ts's copy is a subset plus
  // ignored docs paths). The framed DatePicker pages are examples an e2e test
  // renders from `src`.
  roots: [
    "src",
    "tests",
    "e2e",
    "css",
    "scripts",
    "docs/src/pages/framed/DatePicker",
    "crassus.config.ts",
    "docs/src/token-reference.ts",
  ],
  // IGNORED
  ignore: [
    "**/*.md",
    "docs/**",
    "examples/**",
    "bench/**",
    "thumbnails/**",
    "ostia.config.ts",
    "biome.json",
    "carbon.yml",
    "telemetry.yml",
    "LICENSE",
    ".gitignore",
    ".github/FUNDING.yml",
    // Workflows that run no tests and config only they read. checks.yml is
    // left out: a change to it has to run the suites it runs.
    ".github/labeler.yml",
    ".github/workflows/{deploy-docs,docs-examples,perf,pr-labels,release}.yml",
  ],
  // PACKAGE_SUBPATH: Vite aliases the package name to `src/`. Type tests
  // resolve it through `package.json` exports, which bivium reads itself.
  alias: { "carbon-components-svelte": "src" },
  // The lockfile-wide `installedPackages()`: packages a dependency installs
  // that carbon imports without declaring them.
  external: [
    "playwright",
    "axe-core",
    "dom-accessibility-api",
    "@carbon/colors",
  ],
  // BUILT_CSS, BUILT_CSS_DEPS
  edges: { "css/*.css": ["css/**", "scripts/build-css.ts"] },
  // SELECTOR
  self: [
    "scripts/test-changed.ts",
    "scripts/lib/test-graph.ts",
    "scripts/lib/css-delta.ts",
  ],
  // The orphan rule's deleted `.svelte` exemption.
  importOnly: ["**/*.svelte"],
});
