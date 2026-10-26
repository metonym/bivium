import { resolveConfig } from "../src/config.ts";
import { buildGraph, type Graph } from "../src/graph.ts";
import type { PackageJson, Packages } from "../src/resolve.ts";
import { sorted } from "../src/sorted.ts";
import type { Config } from "../src/types.ts";

export const BARREL = "src/index.js";

export const BARREL_SOURCE = `
export { default as Accordion } from "./Accordion/Accordion.svelte";
export { default as Button } from "./Button/Button.svelte";
export {
  default as Modal,
  ModalHeader as Header,
} from "./Modal/Modal.svelte";
`;

/** A small carbon-like repo: Modal composes Button; fixtures pull all.css. */
export const REPO: Record<string, string> = {
  [BARREL]: BARREL_SOURCE,
  "src/Accordion/Accordion.svelte": `<script>\n  import { uid } from "../utils/uid.js";\n</script>`,
  "src/Button/Button.svelte": `<script>\n  import { uid } from "../utils/uid.js";\n</script>`,
  "src/Modal/Modal.svelte": `<script>\n  import Button from "../Button/Button.svelte";\n</script>`,
  "src/utils/uid.js": "export const uid = () => 1;",
  "src/types.d.ts": "export {};",
  "css/all.scss": `@import "button";`,
  "css/_button.scss": ".bx--btn {}",
  "tests/setup-tests.ts": `import "@testing-library/jest-dom/vitest";`,
  "tests/user.ts": "export const user = {};",
  "tests/Accordion/Accordion.test.ts": `import Accordion from "../Accordion/Accordion.test.svelte";`,
  "tests/Accordion/Accordion.test.svelte": `<script>\n  import Accordion from "carbon-components-svelte/Accordion/Accordion.svelte";\n</script>`,
  "tests/Button/Button.test.ts": `import Button from "carbon-components-svelte/Button/Button.svelte";\nimport { user } from "../user";`,
  "tests/Modal/Modal.test.ts": `import { Modal } from "carbon-components-svelte";`,
  "tests/css/button.test.ts": `import { readFileSync } from "node:fs";\n// @depends-on css/_button.scss`,
  "tests/css/unknown.test.ts": `import { readFileSync } from "node:fs";`,
  "e2e/fixtures/mount.ts": `import "carbon-components-svelte/css/all.css";`,
  "e2e/fixtures/accordion.html": `<script type="module" src="./accordion.ts"></script>`,
  "e2e/fixtures/accordion.ts": `import F from "./AccordionFixture.svelte";\nimport { mount } from "./mount";`,
  "e2e/fixtures/AccordionFixture.svelte": `<script>\n  import { Accordion } from "carbon-components-svelte";\n</script>`,
  "e2e/fixtures/modal.html": `<script type="module" src="./modal.ts"></script>`,
  "e2e/fixtures/modal.ts": `import F from "./ModalFixture.svelte";\nimport { mount } from "./mount";`,
  "e2e/fixtures/ModalFixture.svelte": `<script>\n  import { Modal, Header } from "carbon-components-svelte";\n</script>`,
  "e2e/accordion.test.ts": `test("x", async ({ page }) => {\n  await page.goto("/accordion.html");\n});`,
  "e2e/modal.test.ts": `test("x", async ({ page }) => {\n  await page.goto("/modal.html?theme=g10");\n});`,
  "e2e/vite.config.ts": `import { defineConfig } from "vite";`,
  "scripts/build-css.ts": `import { watch } from "node:fs";\n// @depends-on css/**`,
  "scripts/test-changed.ts": `import { readFileSync } from "node:fs";\n// @depends-on **`,
  "crassus.config.ts": `import path from "node:path";`,
  "tests/scripts/crassus-config.test.ts": `import config from "../../crassus.config";`,
  "docs/src/token-reference.ts": "export const groups = [];",
  "tests/docs/token-reference.test.ts": `import { groups } from "../../docs/src/token-reference";`,
};

export const PACKAGE: PackageJson = {
  name: "carbon-components-svelte",
  exports: {
    ".": { types: "./src/index.d.ts", svelte: "./src/index.js" },
    "./css/*.css": { types: "./css/css.d.ts", default: "./css/*.css" },
    "./src/*.svelte": {
      types: "./src/*.svelte.d.ts",
      import: "./src/*.svelte",
    },
    "./src/*.js": { types: "./src/*.d.ts", import: "./src/*.js" },
  },
  sideEffects: ["css/*.css"],
  devDependencies: {
    svelte: "^5.0.0",
    vite: "^7.0.0",
    "@testing-library/jest-dom": "^6.0.0",
  },
};

/** carbon-components-svelte's selector, as config. */
export const CONFIG: Config = {
  suites: {
    unit: {
      tests: "tests/**/*.{test,spec}.{js,ts}",
      root: "tests",
      nonInputs: ["**/*.test-d.ts", "**/tsconfig.compat-check.json"],
      wiring: ["tests-svelte{3,4}/**"],
    },
    e2e: {
      tests: "e2e/**/*.{test,spec}.{js,ts}",
      root: "e2e",
      urls: { "/*": "e2e/fixtures/*" },
      pages: "e2e/fixtures/**/*.html",
    },
  },
  roots: [
    "src",
    "tests",
    "e2e",
    "css",
    "scripts",
    "crassus.config.ts",
    "docs/src/token-reference.ts",
  ],
  ignore: ["**/*.md", "docs/**", ".github/workflows/{release,perf}.yml"],
  alias: { "carbon-components-svelte": "src" },
  edges: { "css/*.css": ["css/**", "scripts/build-css.ts"] },
  self: ["scripts/test-changed.ts"],
  importOnly: ["**/*.svelte"],
};

export const config = resolveConfig(CONFIG);

export function packages(json: PackageJson = PACKAGE): Packages {
  return new Map([[".", json]]);
}

export function graphOf(
  files: Record<string, string> = REPO,
  options: { config?: Config; packages?: Packages } = {},
): Graph {
  return buildGraph(new Map(Object.entries(files)), {
    config: options.config ? resolveConfig(options.config) : config,
    packages: options.packages ?? packages(),
  });
}

/** One file's dependencies, read in the fixture repo plus `extra` files. */
export function deps(
  path: string,
  source: string,
  extra: Record<string, string> = {},
  options: { config?: Config; packages?: Packages } = {},
) {
  const graph = graphOf({ ...REPO, ...extra, [path]: source }, options);
  const result = graph.get(path);
  if (!result) throw new Error(`no node ${path}`);
  return {
    files: sorted([...result.files].filter((f) => !f.startsWith("pkg:"))),
    packages: sorted([...result.files].filter((f) => f.startsWith("pkg:"))),
    patterns: result.patterns.map(String),
    unknown: result.unknown,
  };
}
