// A deterministic, carbon-shaped repository for the benchmarks: Svelte
// components that import utilities and each other, a barrel that
// re-exports them, a unit test per component, and e2e tests that open
// fixture pages. The same seed always yields the same files.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/types.ts";

const COMPONENTS = 400;
const UTILS = 60;

// mulberry32: small and seedable, so every run gets the same repository.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lorem = (next: () => number, lines: number) =>
  Array.from(
    { length: lines },
    (_, i) =>
      `  const value${i} = ${Math.floor(next() * 1000)} / 7; // ${"x".repeat(Math.floor(next() * 40))}`,
  ).join("\n");

export function repository(seed = 1): Map<string, string> {
  const next = random(seed);
  const pick = (n: number) => Math.floor(next() * n);
  const files = new Map<string, string>();
  for (let u = 0; u < UTILS; u++) {
    const imports =
      u > 0 ? `import { util${pick(u)} } from "./util${pick(u)}";\n` : "";
    files.set(
      `src/utils/util${u}.ts`,
      `${imports}export function util${u}(input: string): string {\n${lorem(next, 8)}\n  return input.slice(${u % 5});\n}\n`,
    );
  }
  const exports: string[] = [];
  for (let c = 0; c < COMPONENTS; c++) {
    const name = `Component${c}`;
    const lines = [
      `  import { util${pick(UTILS)} } from "../../utils/util${pick(UTILS)}";`,
    ];
    if (c > 0 && next() < 0.6) {
      const child = `Component${pick(c)}`;
      lines.push(`  import ${child} from "../${child}/${child}.svelte";`);
    }
    files.set(
      `src/components/${name}/${name}.svelte`,
      `<script lang="ts">\n${lines.join("\n")}\n  export let label = "${name}";\n${lorem(next, 20)}\n</script>\n\n<div class="bx--${name.toLowerCase()}">{label}</div>\n`,
    );
    exports.push(
      `export { default as ${name} } from "./components/${name}/${name}.svelte";`,
    );
    files.set(
      `tests/${name}.test.ts`,
      `import { ${name} } from "../src/index.js";\nimport { render } from "./render";\n\ntest("${name}", () => render(${name}));\n`,
    );
  }
  files.set("src/index.js", `${exports.join("\n")}\n`);
  files.set(
    "tests/render.ts",
    "export function render(component: unknown) { return component; }\n",
  );
  for (let p = 0; p < 40; p++) {
    files.set(
      `e2e/fixtures/page${p}.html`,
      `<script type="module" src="./page${p}.ts"></script>\n`,
    );
    files.set(
      `e2e/fixtures/page${p}.ts`,
      `import { Component${pick(COMPONENTS)} } from "../../src/index.js";\n`,
    );
    files.set(
      `e2e/page${p}.test.ts`,
      `test("page${p}", async ({ page }) => {\n  await page.goto("/page${p}.html");\n});\n`,
    );
  }
  files.set(
    "package.json",
    JSON.stringify({
      name: "fixture",
      sideEffects: false,
      devDependencies: { svelte: "*" },
    }),
  );
  return files;
}

export const config: Config<"unit" | "e2e"> = {
  suites: {
    unit: { tests: "tests/**/*.test.ts", root: "tests" },
    e2e: {
      tests: "e2e/**/*.test.ts",
      root: "e2e",
      urls: { "/*": "e2e/fixtures/*" },
      pages: "e2e/fixtures/**/*.html",
    },
  },
  roots: ["src", "tests", "e2e"],
};

// The repository on disk as a git checkout, with one component edited
// since the commit, as a pull request's working tree is.
export function checkout(files: Map<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bivium-bench-"));
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git(
    "-c",
    "user.email=b@example.com",
    "-c",
    "user.name=b",
    "commit",
    "-q",
    "-m",
    "base",
  );
  const edited = "src/components/Component7/Component7.svelte";
  writeFileSync(join(dir, edited), `${files.get(edited)}\n<p>edited</p>\n`);
  return dir;
}
