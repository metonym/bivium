import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkConfig,
  defineConfig,
  inRoot,
  loadConfig,
  resolveConfig,
} from "../src/config.ts";
import type { SuiteConfig } from "../src/types.ts";

const dirs: string[] = [];
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "bivium-config-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SUITES = { unit: { tests: "test/**/*.test.ts" } };

describe("defineConfig", () => {
  it("types the suite names", () => {
    const config = defineConfig({ suites: SUITES });
    expectTypeOf(config.suites).toEqualTypeOf<
      Readonly<Record<"unit", SuiteConfig>>
    >();
  });
});

describe("checkConfig", () => {
  it.each([
    [{ suites: SUITES, ignored: ["x"] }, "unknown key ignored"],
    [
      { suites: { unit: { tests: "a/**", roots: "a" } } },
      "unknown key suites.unit.roots",
    ],
    [{ suites: { unit: { tests: 1 } } }, "suites.unit.tests must be"],
    [{ suites: { unit: {} } }, "suite unit has no tests"],
    [{ suites: SUITES, edges: { "a/*.css": [1] } }, "edges must be"],
    [{ suites: SUITES, reads: { "a/*.ts": 1 } }, "reads must be"],
    [
      { suites: SUITES, edges: { "a/*.css": ["b/**", "b/$1/$2.scss"] } },
      `edges["a/*.css"] refers to $2 in b/$1/$2.scss, but its key has 1 wildcard`,
    ],
    [
      { suites: SUITES, reads: { "a/x.ts": "b/$1.snap" } },
      `reads["a/x.ts"] refers to $1 in b/$1.snap, but its key has 0 wildcards`,
    ],
    [
      { suites: SUITES, reads: { "a/*.ts": "b/$0.snap" } },
      `reads["a/*.ts"] refers to $0 in b/$0.snap, but captures count from $1`,
    ],
    [
      { suites: SUITES, deadGlobs: [{ file: "a.ts", glob: "b/**" }] },
      "deadGlobs[0] needs a file, glob and reason",
    ],
    [[], "not an object"],
  ])("rejects %j", (config, message) => {
    expect(() => checkConfig(config)).toThrow(message);
  });

  it("accepts captures a key has, and values without any", () => {
    const config = {
      suites: SUITES,
      edges: { "dist/*.css": ["styles/**", "styles/$1.scss"] },
      reads: { "test/**/*.test.ts": "test/$1__snapshots__/$2.test.ts.snap" },
    };
    expect(checkConfig(config)).toMatchObject(config);
  });
});

describe("loadConfig", () => {
  it.each([
    [
      "bivium.config.ts",
      `export default { suites: { unit: { tests: "a/**" } } } satisfies object;`,
    ],
    [
      "bivium.config.mjs",
      `export default { suites: { unit: { tests: "a/**" } } };`,
    ],
    [
      "bivium.config.json",
      JSON.stringify({ suites: { unit: { tests: "a/**" } } }),
    ],
  ])("finds and loads %s", async (name, text) => {
    const dir = repo({ [name]: text });
    const { config, file } = await loadConfig(dir);
    expect(file).toBe(name);
    expect(config.suites.map((suite) => suite.name)).toEqual(["unit"]);
    expect(config.suites[0].isTest("a/x.ts")).toBe(true);
  });

  it("prefers .ts and loads an explicit path, inside or outside the repo", async () => {
    const dir = repo({
      "bivium.config.ts": `export default { suites: { ts: { tests: "**" } } };`,
      "bivium.config.json": JSON.stringify({
        suites: { json: { tests: "**" } },
      }),
    });
    expect((await loadConfig(dir)).config.suites[0].name).toBe("ts");
    const other = repo({
      "custom.mjs": `export default { suites: { custom: { tests: "**" } } };`,
    });
    const loaded = await loadConfig(dir, join(other, "custom.mjs"));
    expect(loaded.config.suites[0].name).toBe("custom");
    expect(loaded.file).toBe(join(other, "custom.mjs"));
  });

  it("fails without a config", async () => {
    await expect(loadConfig(repo({}))).rejects.toThrow("no config found");
  });
});

describe("resolveConfig", () => {
  it("fills in defaults", () => {
    const config = resolveConfig({ suites: SUITES });
    expect(config.roots).toEqual(["."]);
    expect(config.suites[0].roots).toEqual(["."]);
    expect(config.isIgnored("README.md")).toBe(false);
    expect(config.isSelf("x")).toBe(false);
    expect(config.extensions).toContain(".ts");
  });

  it("normalizes roots and sorts aliases longest first", () => {
    const config = resolveConfig({
      suites: { unit: { tests: "t/**", root: "./tests/" } },
      roots: ["src/", "./lib"],
      alias: { a: "./src/", "a/b": "lib" },
    });
    expect(config.roots).toEqual(["src", "lib"]);
    expect(config.suites[0].roots).toEqual(["tests"]);
    expect(config.alias).toEqual([
      ["a/b", "lib"],
      ["a", "src"],
    ]);
  });

  it("rejects a config without suites", () => {
    expect(() => resolveConfig({ suites: {} })).toThrow("no suites");
  });
});

describe("inRoot", () => {
  it("matches the root itself and files under it", () => {
    expect(inRoot("src/a.ts", "src")).toBe(true);
    expect(inRoot("src", "src")).toBe(true);
    expect(inRoot("srcfoo/a.ts", "src")).toBe(false);
    expect(inRoot("anything", ".")).toBe(true);
  });
});
