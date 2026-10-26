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

async function run(args: string[]) {
  const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const status = await main(args);
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

  it("runs everything for a change outside the roots or to its config", async () => {
    const dir = repo();
    write(dir, { "README.md": "x", "package.json": "{}" });
    expect(await planJson(dir)).toMatchObject({
      suites: { unit: { mode: "all" } },
      reasons: ["package.json: outside the dependency graph"],
    });
    git(dir, "checkout", "-q", "package.json");
    write(dir, {
      "bivium.config.json": readFileSync(
        join(dir, "bivium.config.json"),
        "utf-8",
      ).replace("**/*.md", "*.md"),
    });
    expect((await planJson(dir)).reasons).toEqual([
      "bivium.config.json: test selector changed",
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

describe("bivium --version", () => {
  it.each(["--version", "-v"])(
    "%s prints the package version",
    async (flag) => {
      expect(await run([flag])).toEqual({ status: 0, output: version });
    },
  );
});
