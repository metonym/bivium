import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { version } from "../package.json" with { type: "json" };
import { defineConfig, plan, type Selection } from "../src/index.ts";
import { commandFor, main } from "../src/main.ts";

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
  return result.stdout.trim();
}

/** A git repo with a barrel and two tests, committed as `base`. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "bivium-cli-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, {
    "package.json": JSON.stringify({
      name: "lib",
      exports: { ".": "./src/index.js" },
      sideEffects: false,
    }),
    "bivium.config.json": JSON.stringify({
      suites: {
        unit: {
          tests: "test/**/*.test.js",
          root: "test",
          run: "node record.mjs {files}",
        },
      },
      roots: ["src", "test"],
      ignore: ["**/*.md"],
    }),
    "record.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync("ran.json", JSON.stringify(process.argv.slice(2)));`,
    "src/index.js": `export { a } from "./a.js";\nexport { b } from "./b.js";`,
    "src/a.js": "export const a = 1;",
    "src/b.js": "export const b = 2;",
    "test/a.test.js": `import { a } from "lib";`,
    "test/b.test.js": `import { b } from "../src/index.js";`,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "branch", "base");
  return dir;
}

async function run(args: readonly string[]) {
  const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const status = await main([...args]);
    return {
      status,
      output: log.mock.calls.map((call) => call.join(" ")).join("\n"),
    };
  } finally {
    log.mockRestore();
  }
}

async function planJson(dir: string) {
  const { output } = await run(["plan", "base", "--json", "--cwd", dir]);
  return JSON.parse(output);
}

describe("bivium plan", () => {
  it("selects the importers of a changed file, untracked ones too", async () => {
    const dir = repo();
    write(dir, { "src/a.js": "export const a = 3;" });
    expect(await planJson(dir)).toMatchObject({
      base: "base",
      changed: ["src/a.js"],
      suites: { unit: { mode: "some", files: ["test/a.test.js"] } },
      reasons: [],
      narrowed: [],
    });
    write(dir, { "test/c.test.js": `import { b } from "lib";` });
    expect((await planJson(dir)).suites.unit.files).toEqual([
      "test/a.test.js",
      "test/c.test.js",
    ]);
  });

  it("selects importers of a barrel name that moved since the merge base", async () => {
    const dir = repo();
    write(dir, {
      "src/index.js": `export { a } from "./a.js";\nexport { b as b } from "./a.js";`,
    });
    expect((await planJson(dir)).suites.unit).toEqual({
      mode: "some",
      files: ["test/b.test.js"],
    });
  });

  it("plans from the merge base of a base that isn't an ancestor", async () => {
    const dir = repo();
    const fork = git(dir, "rev-parse", "HEAD");
    // The base branch moves on: its barrel already has the edit made below,
    // and it changes a file this branch never touches.
    const moved = `export { a } from "./a.js";\nexport { b as b } from "./a.js";`;
    git(dir, "checkout", "-q", "base");
    write(dir, { "src/index.js": moved, "src/b.js": "export const b = 9;" });
    git(dir, "commit", "-q", "-am", "base moves on");
    git(dir, "checkout", "-q", "main");
    write(dir, { "src/index.js": moved });
    git(dir, "commit", "-q", "-am", "move b");
    const expected = {
      base: "base",
      mergeBase: fork,
      changed: ["src/index.js"],
      // Against the base branch's tip no name moved.
      suites: { unit: { mode: "some", files: ["test/b.test.js"] } },
    };
    expect(await planJson(dir)).toMatchObject(expected);
    expect(await plan({ cwd: dir, base: "base" })).toMatchObject(expected);
  });

  it("resolves through tsconfig paths, skipping an extends git doesn't list", async () => {
    const dir = repo();
    write(dir, {
      ".gitignore": ".svelte-kit/\n",
      // If it were read, its baseUrl would point the paths elsewhere.
      ".svelte-kit/tsconfig.json": `{ "compilerOptions": { "baseUrl": "elsewhere" } }`,
      "tsconfig.json": `{
        "extends": "./.svelte-kit/tsconfig.json",
        // Tests import the package's source by name.
        "compilerOptions": { "paths": { "lib/*": ["./src/*"] } },
      }`,
      "test/c.test.js": `import { b } from "lib/b.js";`,
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "paths");
    git(dir, "branch", "-f", "base");
    write(dir, { "src/b.js": "export const b = 3;" });
    expect((await planJson(dir)).suites.unit).toEqual({
      mode: "some",
      files: ["test/b.test.js", "test/c.test.js"],
    });
  });

  it("reaches a generated file git ignores through its edges", async () => {
    const dir = repo();
    write(dir, {
      ".gitignore": ".velite/\n",
      ".velite/index.js": "export const docs = [];",
      "content/a.md": "# a",
      "tsconfig.json": `{ "compilerOptions": { "paths": { "#velite": ["./.velite"] } } }`,
      "bivium.config.json": JSON.stringify({
        suites: { unit: { tests: "test/**/*.test.js", root: "test" } },
        roots: ["src", "test", "content"],
        edges: { ".velite/*": "content/**" },
      }),
      "test/docs.test.js": `import { docs } from "#velite";`,
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "velite");
    git(dir, "branch", "-f", "base");
    const check = await run(["check", "--json", "--cwd", dir]);
    expect(JSON.parse(check.output)).toMatchObject({
      unknown: [],
      deadGlobs: [],
    });
    write(dir, { "content/a.md": "# b" });
    expect((await planJson(dir)).suites.unit).toEqual({
      mode: "some",
      files: ["test/docs.test.js"],
    });
  });

  it("selects through type-only edges only for a suite that observes types", async () => {
    const dir = repo();
    const suites = (types?: boolean) => ({
      unit: {
        tests: "test/**/*.test.ts",
        root: "src",
        types,
        // Types only: nothing loads it at runtime.
        nonInputs: "src/types.ts",
      },
    });
    write(dir, {
      "bivium.config.json": JSON.stringify({ suites: suites(false) }),
      "src/types.ts": "export type Props = { a: string };",
      "src/feature.ts": `import type { Props } from "./types.ts";\nexport const feature = (p: Props) => p.a;`,
      "src/reexport.ts": `export type { Props as P } from "./types.ts";`,
      "src/shape.d.ts": "export type Shape = 1;",
      "test/feature.test.ts": `import { feature } from "../src/feature.ts";`,
      "test/reexport.test.ts": `import type { P } from "../src/reexport.ts";`,
      "test/shape.test.ts": `/** @type {import("../src/shape").Shape} */\nexport const s = 1;`,
      "test/other.test.ts": `import { b } from "../src/b.js";`,
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "types");
    git(dir, "branch", "-f", "base");
    const changes = {
      "src/types.ts": "export type Props = { a: string; b?: number };",
      "src/shape.d.ts": "export type Shape = 2;",
    };
    write(dir, changes);
    // Reached only through types: no test, and no orphan rule.
    expect(await planJson(dir)).toMatchObject({
      suites: { unit: { mode: "none" } },
      reasons: [],
    });
    // The config is the selector's own file: commit it before the change.
    git(dir, "checkout", "-q", ".");
    write(dir, {
      "bivium.config.json": JSON.stringify({ suites: suites(undefined) }),
    });
    git(dir, "commit", "-q", "-am", "observe types");
    git(dir, "branch", "-f", "base");
    write(dir, changes);
    expect((await planJson(dir)).suites.unit).toEqual({
      mode: "some",
      files: [
        "test/feature.test.ts",
        "test/reexport.test.ts",
        "test/shape.test.ts",
      ],
    });
    const { output } = await run([
      "why",
      "test/feature.test.ts",
      "src/types.ts",
      "--format",
      "chain",
      "--cwd",
      dir,
      "--base",
      "base",
    ]);
    expect(output).toBe(
      [
        "if src/types.ts changes",
        "  type-imported by  src/feature.ts:1",
        "  imported by       test/feature.test.ts:1  ← selected",
      ].join("\n"),
    );
  });

  it("selects an @lists test when a path comes or goes, not when it's edited", async () => {
    const dir = repo();
    write(dir, {
      "bivium.config.json": JSON.stringify({
        suites: { unit: { tests: "test/**/*.test.js", root: "." } },
      }),
      "pages/about/page.js": "export default 1;",
      "pages/blog/page.js": "export default 2;",
      "test/layout.test.js": [
        "// @lists pages/**",
        `import { readdirSync } from "node:fs";`,
        `readdirSync("pages");`,
      ].join("\n"),
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "pages");
    git(dir, "branch", "-f", "base");
    write(dir, { "pages/about/page.js": "export default 3;" });
    // Edited: no test lists contents, and the listing counts as reaching
    // it, so the orphan rule doesn't run the suite.
    expect(await planJson(dir)).toMatchObject({
      suites: { unit: { mode: "none" } },
      reasons: [],
    });
    write(dir, { "pages/careers/page.js": "export default 4;" });
    expect((await planJson(dir)).suites.unit).toEqual({
      mode: "some",
      files: ["test/layout.test.js"],
    });
    git(dir, "checkout", "-q", ".");
    rmSync(join(dir, "pages/careers"), { recursive: true });
    unlinkSync(join(dir, "pages/blog/page.js"));
    expect((await planJson(dir)).suites.unit).toEqual({
      mode: "some",
      files: ["test/layout.test.js"],
    });
    const { output } = await run([
      "why",
      "test/layout.test.js",
      "--format",
      "chain",
      "--cwd",
      dir,
      "--base",
      "base",
    ]);
    expect(output).toBe(
      [
        "pages/blog/page.js changed",
        "  listed by  test/layout.test.js:1  ← selected",
      ].join("\n"),
    );
  });

  it("prints each selection's scale, and tells a full run from every test reached", async () => {
    const dir = repo();
    const text = async () => (await run(["plan", "base", "--cwd", dir])).output;
    write(dir, { "src/a.js": "export const a = 3;" });
    expect(await text()).toBe("unit tests: 1 of 2 files\n  test/a.test.js");
    write(dir, { "src/b.js": "export const b = 3;" });
    expect(await text()).toBe(
      "unit tests: all 2 files (each reaches a change)",
    );
    write(dir, { "package.json": "{}" });
    expect(await text()).toBe(
      [
        "Full run: package.json: outside the dependency graph",
        "unit tests: all (full run)",
      ].join("\n"),
    );
  });

  it("doesn't let a type import stand in for a runtime edge in a suite that runs code", async () => {
    const dir = repo();
    write(dir, {
      ".gitignore": "src/parser.js\n",
      "bivium.config.json": JSON.stringify({
        suites: {
          unit: {
            tests: "test/**/*.test.ts",
            root: ".",
            setup: "test/setup.ts",
            types: false,
          },
        },
      }),
      "src/helper.ts": "export const help = 1;",
      "src/global-setup.ts": "export default () => {};",
      "src/shape.d.ts": "export type Shape = 1;",
      "src/parser.d.ts": "export declare const parse: () => void;",
      "src/parser.js": "export const parse = () => {};",
      "test/setup.ts": `import { help } from "../src/helper.ts";\nexport type Ctx = typeof help;`,
      "test/a.test.ts": [
        `import type { Ctx } from "./setup.ts";`,
        `import type Setup from "../src/global-setup.ts";`,
        `import type { Shape } from "../src/shape.d.ts";`,
      ].join("\n"),
      "test/b.test.ts": "export {};",
      "test/p.test.ts": `import { parse } from "../src/parser.js";`,
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "types");
    git(dir, "branch", "-f", "base");
    // The setup file runs before every test, type import or not.
    write(dir, { "src/helper.ts": "export const help = 2;" });
    // Every test is reached (a full run would have a reason).
    expect(await planJson(dir)).toMatchObject({
      suites: { unit: { mode: "all" } },
      reasons: [],
    });
    const why = await run([
      "why",
      "test/a.test.ts",
      "src/helper.ts",
      "--format",
      "chain",
      "--cwd",
      dir,
      "--base",
      "base",
    ]);
    expect(why.output).toContain("a setup file of  test/a.test.ts");
    git(dir, "checkout", "-q", ".");
    // Only a type import reaches it, and it has runtime code: the runner
    // may load it, so the orphan rule runs the suite.
    write(dir, { "src/global-setup.ts": "export default () => 1;" });
    expect((await planJson(dir)).reasons).toEqual([
      "src/global-setup.ts: no unit test imports it (only type imports reach it: list it in the suite's `nonInputs` if nothing loads it at runtime)",
    ]);
    git(dir, "checkout", "-q", ".");
    // A declaration file never runs.
    write(dir, { "src/shape.d.ts": "export type Shape = 2;" });
    expect(await planJson(dir)).toMatchObject({
      suites: { unit: { mode: "some", files: ["test/p.test.ts"] } },
      reasons: [],
    });
    // The parser's runtime file isn't in the graph: its importer is unknown.
    const check = JSON.parse(
      (await run(["check", "--json", "--cwd", dir])).output,
    );
    expect(
      check.unknown
        .find(({ node }: { node: string }) => node === "test/p.test.ts")
        ?.causes.map(({ cause }: { cause: string }) => cause),
    ).toEqual([`only declarations for "../src/parser.js"`]);
  });

  it("runs everything for a change outside the roots or to its config", async () => {
    const dir = repo();
    write(dir, { "README.md": "x", "package.json": "{}" });
    expect(await planJson(dir)).toMatchObject({
      suites: { unit: { mode: "all" } },
      reasons: ["package.json: outside the dependency graph"],
      causes: [
        {
          kind: "outside",
          suites: ["unit"],
          file: "package.json",
          message: "package.json: outside the dependency graph",
        },
      ],
      totals: { unit: 2 },
    });
    git(dir, "checkout", "-q", "package.json");
    write(dir, {
      "bivium.config.json": readFileSync(
        join(dir, "bivium.config.json"),
        "utf-8",
      ).replace("**/*.md", "*.md"),
    });
    expect((await planJson(dir)).causes).toEqual([
      {
        kind: "self",
        suites: ["unit"],
        file: "bivium.config.json",
        message: "bivium.config.json: test selector changed",
      },
    ]);
  });

  it("caches extractions under .bivium/cache, unless --no-cache", async () => {
    const dir = repo();
    await run(["plan", "base", "--no-cache", "--cwd", dir]);
    expect(existsSync(join(dir, ".bivium"))).toBe(false);
    await run(["plan", "base", "--cwd", dir]);
    expect(existsSync(join(dir, ".bivium/cache/extractions.json"))).toBe(true);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("writes each suite's GitHub step output, named by default or by config", async () => {
    const dir = repo();
    const config = JSON.parse(
      readFileSync(join(dir, "bivium.config.json"), "utf-8"),
    );
    config.suites.e2e = {
      tests: "e2e/**/*.test.js",
      root: "e2e",
      output: "e2e-files",
    };
    config.roots.push("e2e");
    write(dir, {
      "bivium.config.json": JSON.stringify(config),
      "e2e/a.test.js": `import { a } from "lib";`,
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "e2e");
    write(dir, { "src/b.js": "export const b = 3;" });
    const output = join(dir, ".git", "github-output");
    process.env.GITHUB_OUTPUT = output;
    try {
      await run(["plan", "HEAD", "--github", "--cwd", dir]);
    } finally {
      delete process.env.GITHUB_OUTPUT;
    }
    expect(readFileSync(output, "utf-8")).toBe(
      "unit-tests=test/b.test.js\ne2e-files=none\n",
    );
  });

  it("rejects an unknown option instead of ignoring it", async () => {
    const dir = repo();
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect(await main(["plan", "base", "--githb", "--cwd", dir])).toBe(2);
      expect(error.mock.calls[0]?.[0]).toBe(
        "bivium plan: unknown option --githb",
      );
    } finally {
      error.mockRestore();
    }
  });
});

describe("bivium run", () => {
  it("execs the suite's command with the selected files", async () => {
    const dir = repo();
    write(dir, { "src/a.js": "export const a = 3;" });
    expect((await run(["run", "base", "--cwd", dir])).status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "ran.json"), "utf-8"))).toEqual([
      "test/a.test.js",
    ]);
  });

  it("skips when nothing is affected", async () => {
    const dir = repo();
    const { status, output } = await run(["run", "base", "--cwd", dir]);
    expect(status).toBe(0);
    expect(output).toContain("No unit tests affected against base; skipping.");
    expect(() => unlinkSync(join(dir, "ran.json"))).toThrow();
  });
});

describe("commandFor", () => {
  it("puts the files at {files}, or at the end", () => {
    expect(commandFor("vitest run {files} --bail", ["a", "b"])).toEqual([
      "vitest",
      "run",
      "a",
      "b",
      "--bail",
    ]);
    expect(commandFor("vitest run", ["a"])).toEqual(["vitest", "run", "a"]);
    expect(commandFor("vitest run {files}", [])).toEqual(["vitest", "run"]);
  });
});

describe("plan", () => {
  it("plans with an inline config, typed by its suite names", async () => {
    const dir = repo();
    write(dir, { "src/a.js": "export const a = 3;" });
    const result = await plan({
      cwd: dir,
      base: "base",
      config: defineConfig({
        suites: { unit: { tests: "test/**/*.test.js", root: "test" } },
        roots: ["src", "test"],
      }),
    });
    expectTypeOf(result.suites).toEqualTypeOf<Record<"unit", Selection>>();
    expect(result).toMatchObject({
      suites: { unit: { mode: "some", files: ["test/a.test.js"] } },
      reasons: [],
      base: "base",
      changed: ["src/a.js"],
    });
  });
});

describe("the command line", () => {
  it("takes options before the command", async () => {
    const dir = repo();
    write(dir, { "src/a.js": "export const a = 3;" });
    const { status, output } = await run([
      "--no-cache",
      "--cwd",
      dir,
      "plan",
      "base",
      "--json",
    ]);
    expect(status).toBe(0);
    expect(JSON.parse(output).suites.unit.files).toEqual(["test/a.test.js"]);
  });

  it.each([
    { args: ["--help"] },
    { args: ["-h"] },
    { args: ["plan", "--help"] },
    { args: ["help"] },
  ])("prints usage for $args, and exits 0", async ({ args }) => {
    const { status, output } = await run(args);
    expect({ status, usage: output.startsWith("Usage:") }).toEqual({
      status: 0,
      usage: true,
    });
  });

  it.each([
    { args: [] },
    { args: ["nope"] },
    { args: ["--bogus"] },
    { args: ["plan", "--bogus"] },
  ])("exits 2 for the usage error $args", async ({ args }) => {
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect((await run(args)).status).toBe(2);
    } finally {
      error.mockRestore();
    }
  });
});

describe("bivium graph", () => {
  it("prints each node's edges and test fan-in, and ranks files", async () => {
    const dir = repo();
    const { status, output } = await run(["graph", "--json", "--cwd", dir]);
    expect(status).toBe(0);
    const report = JSON.parse(output);
    expect(report.suites).toEqual({ unit: { total: 2, everyChange: [] } });
    expect(
      report.nodes.find(({ node }: { node: string }) => node === "src/a.js"),
    ).toEqual({
      node: "src/a.js",
      imports: [],
      importers: ["src/index.js", "src/index.js#a"],
      fanIn: { unit: 1 },
      unknown: false,
    });
    const text = await run(["graph", "--cwd", dir, "--top", "1"]);
    expect(text.output.split("\n").slice(0, 4)).toEqual([
      "unit: 2 tests",
      "  tests  file",
      "      1  src/a.js",
      "  … 3 more (--top <n> shows more)",
    ]);
  });
});

describe("bivium --version", () => {
  it.each(["--version", "-v"])(
    "%s prints the package version",
    async (flag) => {
      expect(await run([flag])).toEqual({ status: 0, output: version });
    },
  );
});
