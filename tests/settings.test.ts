import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computePlan } from "../src/compute.ts";
import { resolveConfig } from "../src/config.ts";
import type { Config } from "../src/index.ts";
import { explain } from "../src/why.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, files: Record<string, string | undefined>) {
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    if (text === undefined) {
      rmSync(path);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

const CONFIG: Config = {
  suites: { unit: { tests: "**/*.test.js", root: "test" } },
  roots: [
    "src",
    "test",
    "packages",
    "package.json",
    "tsconfig.json",
    "tsconfig.base.json",
  ],
};

const json = (value: unknown) => JSON.stringify(value, null, 2);

// The root package maps `#lib` to src/lib.js with tsconfig `paths`;
// packages/a has its own package.json and a tsconfig.json that extends
// tsconfig.base.json; packages/b has neither.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "bivium-settings-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  write(dir, {
    "package.json": json({ name: "app", version: "1.0.0", type: "module" }),
    "tsconfig.json": json({
      compilerOptions: { paths: { "#lib": ["./src/lib.js"] } },
    }),
    "tsconfig.base.json": json({ compilerOptions: { strict: true } }),
    "src/lib.js": "export const lib = 1;",
    "src/other.js": "export const other = 1;",
    "test/lib.test.js": `import { lib } from "#lib";`,
    "test/other.test.js": `import { other } from "../src/other.js";`,
    "packages/a/package.json": json({ name: "a", version: "1.0.0" }),
    "packages/a/tsconfig.json": json({ extends: "../../tsconfig.base.json" }),
    "packages/a/a.js": "export const a = 1;",
    "packages/a/a.test.js": `import { a } from "./a.js";`,
    "packages/b/b.js": "export const b = 1;",
    "packages/b/b.test.js": `import { b } from "./b.js";`,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

async function planOf(dir: string) {
  const config = resolveConfig(CONFIG);
  const computed = await computePlan(dir, "HEAD", config, { cache: false });
  const { suites, reasons, settings } = computed.plan;
  return { unit: suites.unit, reasons, settings, computed, config };
}

describe("a changed tsconfig.json", () => {
  it("selects the tests of the files it governs", async () => {
    const dir = repo();
    write(dir, {
      "tsconfig.json": json({
        compilerOptions: { paths: { "#lib": ["./src/other.js"] } },
      }),
    });
    const { unit, reasons, settings } = await planOf(dir);
    // packages/a has a tsconfig.json of its own.
    expect(unit).toEqual({
      mode: "some",
      files: ["packages/b/b.test.js", "test/lib.test.js", "test/other.test.js"],
    });
    expect(reasons).toEqual([]);
    expect(settings).toEqual([
      "tsconfig.json: changes how the 9 files it governs resolve or compile",
    ]);
  });

  it("selects nothing when only formatting or comments changed", async () => {
    const dir = repo();
    write(dir, {
      "tsconfig.json": `{
  // Comments are allowed.
  "compilerOptions": { "paths": { "#lib": ["./src/lib.js"] } },
}`,
    });
    expect(await planOf(dir)).toMatchObject({
      unit: { mode: "none" },
      settings: [
        "tsconfig.json: only formatting or comments changed, which no file resolves or runs by",
      ],
    });
  });

  it("selects the files of the configs that extend a changed file", async () => {
    const dir = repo();
    write(dir, {
      "tsconfig.base.json": json({ compilerOptions: { strict: false } }),
    });
    expect(await planOf(dir)).toMatchObject({
      unit: { mode: "some", files: ["packages/a/a.test.js"] },
    });
  });

  it("selects the files a deleted one governed", async () => {
    const dir = repo();
    write(dir, { "packages/a/tsconfig.json": undefined });
    expect(await planOf(dir)).toMatchObject({
      unit: { mode: "some", files: ["packages/a/a.test.js"] },
    });
  });

  it("isn't an orphan under a suite's root", async () => {
    const dir = repo();
    write(dir, { "test/tsconfig.json": json({ compilerOptions: {} }) });
    expect(await planOf(dir)).toMatchObject({
      unit: {
        mode: "some",
        files: ["test/lib.test.js", "test/other.test.js"],
      },
      reasons: [],
    });
  });

  it("explains a selection by the change", async () => {
    const dir = repo();
    write(dir, { "tsconfig.json": json({ compilerOptions: {} }) });
    const { computed, config } = await planOf(dir);
    expect(
      await explain(dir, config, computed, "test/other.test.js"),
    ).toMatchObject({
      kind: "chain",
      cause: "governed by tsconfig.json, which changed",
    });
  });
});

describe("a changed package.json", () => {
  it("selects nothing when only metadata changed", async () => {
    const dir = repo();
    write(dir, {
      "package.json": json({ name: "app", version: "1.1.0", type: "module" }),
    });
    expect(await planOf(dir)).toMatchObject({
      unit: { mode: "none" },
      settings: [
        "package.json: only version changed, which no file resolves or runs by",
      ],
    });
  });

  it("selects the files of its package when another field changed", async () => {
    const dir = repo();
    write(dir, {
      "package.json": json({ name: "app", version: "1.0.0", type: "commonjs" }),
    });
    // packages/a is its own package.
    expect(await planOf(dir)).toMatchObject({
      unit: {
        mode: "some",
        files: [
          "packages/b/b.test.js",
          "test/lib.test.js",
          "test/other.test.js",
        ],
      },
      reasons: [],
    });
  });

  it("selects only a nested package's files", async () => {
    const dir = repo();
    write(dir, {
      "packages/a/package.json": json({
        name: "a",
        version: "1.0.0",
        type: "module",
      }),
    });
    expect(await planOf(dir)).toMatchObject({
      unit: { mode: "some", files: ["packages/a/a.test.js"] },
    });
  });
});
