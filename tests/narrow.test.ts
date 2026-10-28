import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computePlan } from "../src/compute.ts";
import { resolveConfig } from "../src/config.ts";
import {
  type Config,
  defineConfig,
  type NarrowContext,
  type NarrowResult,
  plan,
} from "../src/index.ts";
import { explain } from "../src/why.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

// Only page x loads the compiled stylesheet, so a stylesheet change reaches
// e2e/x.test.js through dist/all.css, and e2e/y.test.js not at all.
function repo(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bivium-narrow-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  write(dir, {
    "package.json": JSON.stringify({ name: "app" }),
    "styles/a.css": ".a { color: red }",
    "src/x.js": "export const x = 1;",
    "src/y.js": "export const y = 1;",
    "pages/x.js": `import "../dist/all.css";\nimport "../src/x.js";`,
    "pages/y.js": `import "../src/y.js";`,
    "e2e/x.test.js": `import "../pages/x.js";`,
    "e2e/y.test.js": `import "../pages/y.js";`,
    "unit/x.test.js": `import "../src/x.js";`,
    ...extra,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  write(dir, { "styles/a.css": ".a { color: blue }" });
  return dir;
}

function configWith(
  narrow: (context: NarrowContext) => NarrowResult | Promise<NarrowResult>,
) {
  return defineConfig({
    suites: {
      e2e: { tests: "e2e/**/*.test.js", root: "e2e" },
      unit: { tests: "unit/**/*.test.js", root: "unit" },
    },
    roots: ["styles", "src", "pages", "e2e", "unit"],
    edges: { "dist/*.css": "styles/**" },
    narrowers: [
      {
        name: "css",
        match: "styles/**",
        opaque: "dist/*.css",
        suites: ["e2e"],
        narrow,
      },
    ],
  });
}

describe("narrowers", () => {
  it("replace a matched change's seeds, and see both trees and the graph", async () => {
    const dir = repo();
    const seen: unknown[] = [];
    const result = await plan({
      cwd: dir,
      base: "HEAD",
      config: configWith(async ({ base, head, changed, graph }) => {
        seen.push(
          changed,
          await base.read("styles/a.css"),
          await head.read("styles/a.css"),
          await base.read("styles/gone.css"),
          base.commit !== undefined && head.commit === undefined,
          graph.tests("e2e"),
          graph.importers("dist/all.css"),
          [...graph.dependents(["src/y.js"])].filter((node) =>
            node.startsWith("e2e/"),
          ),
        );
        return { seeds: ["src/y.js"] };
      }),
    });
    expect(seen).toEqual([
      ["styles/a.css"],
      ".a { color: red }",
      ".a { color: blue }",
      undefined,
      true,
      ["e2e/x.test.js", "e2e/y.test.js"],
      ["pages/x.js"],
      ["e2e/y.test.js"],
    ]);
    // e2e/y.test.js isn't in the coarse walk, so the narrower can't add it,
    // and its seeds replace the walk through dist/all.css.
    expect(result.suites).toEqual({
      e2e: { mode: "none" },
      unit: { mode: "none" },
    });
    expect(result.narrowed).toEqual([
      { name: "css", result: { seeds: ["src/y.js"] } },
    ]);
  });

  it("see the merge base's commit when the caller didn't ask for it", async () => {
    const dir = repo();
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
    }).stdout.trim();
    const seen: unknown[] = [];
    const config = resolveConfig(
      configWith(async ({ base }) => {
        seen.push(base.commit, await base.read("styles/a.css"));
        return { seeds: [] };
      }),
    );
    const computed = await computePlan(dir, "HEAD", config, { cache: false });
    expect(seen).toEqual([head, ".a { color: red }"]);
    expect(await computed.mergeBase()).toBe(head);
  });

  it("keep the tests their seeds reach through the opaque nodes", async () => {
    const result = await plan({
      cwd: repo(),
      base: "HEAD",
      config: configWith(() => ({ seeds: ["src/x.js"] })),
    });
    expect(result.suites.e2e).toEqual({
      mode: "some",
      files: ["e2e/x.test.js"],
    });
  });

  it("show in why's chain as the seed's cause", async () => {
    const dir = repo();
    const config = resolveConfig(configWith(() => ({ seeds: ["src/x.js"] })));
    const computed = await computePlan(dir, "HEAD", config, { cache: false });
    const explanation = await explain(dir, config, computed, "e2e/x.test.js");
    expect(explanation).toMatchObject({
      kind: "chain",
      root: "src/x.js",
      cause: "seeded by the css narrower",
    });
  });

  it.each([
    [
      "can't decide",
      () => ({ all: "`:root` changed" }),
      "css: `:root` changed",
    ],
    [
      "throws",
      () => {
        throw new Error("no install");
      },
      "css: failed: no install",
    ],
  ])("run their suites in full when one %s", async (_, narrow, reason) => {
    const result = await plan({
      cwd: repo(),
      base: "HEAD",
      config: configWith(narrow),
    });
    expect(result.suites.e2e).toEqual({ mode: "all" });
    expect(result.reasons).toEqual([reason]);
  });

  it("are checked when a config file defines them", async () => {
    const dir = repo({
      "bivium.config.mjs": `export default {
  suites: { e2e: { tests: "e2e/**/*.test.js", root: "e2e" } },
  roots: ["styles", "src", "pages", "e2e", "unit"],
  edges: { "dist/*.css": "styles/**" },
  narrowers: [
    { name: "css", match: "styles/**", opaque: "dist/*.css", narrow: () => ({ files: [] }) },
  ],
};`,
    });
    const result = await plan({ cwd: dir, base: "HEAD", cache: false });
    expect(result.reasons).toEqual([
      "css: failed: returned neither { seeds: string[] } nor { all: string }",
    ]);
  });

  it("don't run for other changes or for suites no one asked for", async () => {
    let calls = 0;
    const config: Config<"e2e" | "unit"> = configWith(() => {
      calls++;
      return { seeds: [] };
    });
    const dir = repo();
    const resolved = resolveConfig(config);
    const unitOnly = await computePlan(dir, "HEAD", resolved, {
      cache: false,
      suites: ["unit"],
    });
    expect(calls).toBe(0);
    expect(unitOnly.plan.suites.e2e).toEqual({
      mode: "some",
      files: ["e2e/x.test.js"],
    });
    git(dir, "checkout", "-q", "styles/a.css");
    write(dir, { "src/y.js": "export const y = 2;" });
    await computePlan(dir, "HEAD", resolved, { cache: false });
    expect(calls).toBe(0);
  });

  it("must name configured suites", () => {
    expect(() =>
      resolveConfig({
        suites: { unit: { tests: "**" } },
        narrowers: [
          {
            name: "css",
            match: "**",
            opaque: "**",
            suites: ["e2e"],
            narrow: () => ({ all: "" }),
          },
        ],
      }),
    ).toThrow("narrower css names no suite e2e");
  });
});
