import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Report } from "../src/check.ts";
import { main } from "../src/main.ts";

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

// test/a.test.js reaches src/a.js through a barrel name; test/u.test.js
// can't be read, so it depends on every change.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "bivium-why-"));
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
      suites: { unit: { tests: "test/**/*.test.js", root: "test" } },
      roots: ["src", "test"],
    }),
    "src/index.js": `export { a } from "./a.js";\nexport { b } from "./b.js";\n`,
    "src/a.js": "export const a = 1;",
    "src/b.js": "export const b = 1;",
    "test/a.test.js": `// The barrel, by name.\nimport { a } from "lib";\n`,
    "test/u.test.js": `import { readFileSync } from "node:fs";\nimport x from "./gone.js";\n`,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  write(dir, { "src/a.js": "export const a = 2;" });
  return dir;
}

async function run(args: string[]) {
  const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const status = await main([...args, "--no-cache"]);
    return {
      status,
      output: log.mock.calls.map((call) => call.join(" ")).join("\n"),
    };
  } finally {
    log.mockRestore();
  }
}

describe("bivium why", () => {
  it("prints the shortest chain to the change, with where each edge is", async () => {
    const dir = repo();
    const { output } = await run([
      "why",
      "test/a.test.js",
      "--base",
      "HEAD",
      "--cwd",
      dir,
    ]);
    expect(output).toBe(
      [
        "test/a.test.js",
        "└─ import  src/index.js#a    test/a.test.js:2",
        "   └─ import  src/a.js    src/index.js:1",
        "      ● changed",
      ].join("\n"),
    );
  });

  it("says why a test depends on every change", async () => {
    const dir = repo();
    const { output } = await run([
      "why",
      "test/u.test.js",
      "--base",
      "HEAD",
      "--cwd",
      dir,
    ]);
    expect(output).toBe(
      [
        "test/u.test.js",
        "└─ depends on every change:",
        `   ✗ unresolved "./gone.js"    test/u.test.js:2`,
        "   ✗ reads the disk without @depends-on    test/u.test.js:1",
        "   └─ src/a.js",
        "      ● changed",
      ].join("\n"),
    );
  });

  it("explains a given file, and says when nothing reaches the test", async () => {
    const dir = repo();
    const given = await run([
      "why",
      "test/a.test.js",
      "src/b.js",
      "--base",
      "HEAD",
      "--cwd",
      dir,
    ]);
    expect(given.output).toBe(
      "Not selected by a change to src/b.js: no chain reaches it.",
    );
    write(dir, { "test/a.test.js": `import { a } from "lib";\nexport {};\n` });
    const changed = await run([
      "why",
      "test/a.test.js",
      "src/a.js",
      "--base",
      "HEAD",
      "--cwd",
      dir,
    ]);
    expect(changed.output.split("\n").at(-1)).toBe("      ● given");
  });

  it("lists the reasons for a suite that runs in full", async () => {
    const dir = repo();
    write(dir, { "package.json": "{}" });
    const { output } = await run([
      "why",
      "test/a.test.js",
      "--base",
      "HEAD",
      "--cwd",
      dir,
    ]);
    expect(output).toBe(
      "The unit suite runs in full:\n  package.json: outside the dependency graph",
    );
  });
  it("shows a config `reads` edge, from a scanned file and from a leaf", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bivium-why-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    write(dir, {
      "bivium.config.json": JSON.stringify({
        suites: {
          unit: { tests: "test/*.test.js", root: "test" },
          examples: { tests: "examples/*/package.json", root: "examples" },
        },
        roots: ["test", "examples"],
        reads: {
          "test/*.test.js": "test/__snapshots__/$1.test.js.snap",
          "examples/*/package.json": "examples/$1/**",
        },
      }),
      "test/x.test.js": "export {};",
      "test/__snapshots__/x.test.js.snap": "exports[`x`] = 1;",
      "examples/vite/package.json": "{}",
      "examples/vite/index.html": "<h1>vite</h1>",
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    write(dir, {
      "test/__snapshots__/x.test.js.snap": "exports[`x`] = 2;",
      "examples/vite/index.html": "<h1>vite 2</h1>",
    });
    const why = (test: string) =>
      run(["why", test, "--base", "HEAD", "--cwd", dir]);
    expect((await why("test/x.test.js")).output).toBe(
      [
        "test/x.test.js",
        "└─ reads   test/__snapshots__/x.test.js.snap    reads in the config",
        "   ● changed",
      ].join("\n"),
    );
    expect((await why("examples/vite/package.json")).output).toBe(
      [
        "examples/vite/package.json",
        "└─ reads   examples/vite/index.html    reads in the config",
        "   ● changed",
      ].join("\n"),
    );
  });
});

describe("bivium check", () => {
  it("lists unknown nodes with locations and fixes, and fails past --max-unknown", async () => {
    const dir = repo();
    const { status, output } = await run([
      "check",
      "--max-unknown",
      "0",
      "--cwd",
      dir,
    ]);
    expect(status).toBe(1);
    expect(output).toBe(
      [
        "test/u.test.js",
        `  ✗ unresolved "./gone.js"    test/u.test.js:2`,
        "    fix: no file at that path: fix the import, or add an `edges` entry if a build generates it",
        "  ✗ reads the disk without @depends-on    test/u.test.js:1",
        "    fix: name what it reads: `// @depends-on <glob>`, or `// @reads <glob>` for files read as text; list the file in `hermetic` if it reads no file of the repository",
        "  runs on any change: test/u.test.js",
        "",
        "1 node with unknown dependencies reaches a test (at most 0): each such test runs on any change.",
      ].join("\n"),
    );
    expect(
      (await run(["check", "--max-unknown", "1", "--cwd", dir])).status,
    ).toBe(0);
  });

  it("lists unknown nodes no test reaches apart, and doesn't count them", async () => {
    const dir = repo();
    write(dir, {
      "src/tool.js": `import { readFileSync } from "node:fs";
`,
    });
    const { status, output } = await run([
      "check",
      "--max-unknown",
      "1",
      "--cwd",
      dir,
    ]);
    expect(status).toBe(0);
    expect(output).toContain(
      "Unknown, but no test depends on them, so they widen nothing:\nsrc/tool.js\n",
    );
    expect(output.split("\n").slice(-2)).toEqual([
      "1 node with unknown dependencies reaches a test (at most 1): each such test runs on any change.",
      "1 more no test reaches.",
    ]);
    const json = await run(["check", "--json", "--cwd", dir]);
    const report: Report = JSON.parse(json.output);
    expect(report.unknown.map(({ node, tests }) => ({ node, tests }))).toEqual([
      { node: "src/tool.js", tests: [] },
      { node: "test/u.test.js", tests: ["test/u.test.js"] },
    ]);
  });

  it("lists tsconfig files that don't parse, and leaves what they map unknown", async () => {
    const dir = repo();
    write(dir, {
      "tsconfig.json": `{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } }`,
      "test/p.test.js": `import { a } from "~/a.js";\n`,
    });
    const { output } = await run(["check", "--cwd", dir]);
    expect(output).toContain(
      "tsconfig files that don't parse, whose `paths` are ignored:\n  tsconfig.json: ",
    );
    expect(output).toContain(`test/p.test.js\n  ✗ unresolved "~/a.js"`);
    const json = await run(["check", "--json", "--cwd", dir]);
    const report: Report = JSON.parse(json.output);
    expect(report.unparsedTsconfigs.map(({ file }) => file)).toEqual([
      "tsconfig.json",
    ]);
  });

  it("doesn't count a test that reads an unknown node as text", async () => {
    const dir = repo();
    write(dir, {
      "test/fixtures/x.js": `import gone from "./gone.js";\n`,
      "test/f.test.js": "// @reads test/fixtures/**\nexport {};\n",
    });
    const json = await run(["check", "--json", "--cwd", dir]);
    const report: Report = JSON.parse(json.output);
    expect(report.unknown.map(({ node, tests }) => ({ node, tests }))).toEqual([
      { node: "test/fixtures/x.js", tests: [] },
      { node: "test/u.test.js", tests: ["test/u.test.js"] },
    ]);
    // The plan agrees: the reader runs only when the fixture changes.
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
    write(dir, { "src/b.js": "export const b = 2;" });
    const plan = await run(["plan", "HEAD", "--json", "--cwd", dir]);
    expect(JSON.parse(plan.output).suites.unit).toEqual({
      mode: "some",
      files: ["test/u.test.js"],
    });
  });
});

// test/a.test.js declares the globs. docs/ is outside the roots and
// ignored; src/notes.md is ignored but a node; scripts/ is outside the roots.
function globRepo(test: string, config: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bivium-dead-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  write(dir, {
    "bivium.config.json": JSON.stringify({
      suites: { unit: { tests: "test/**/*.test.js", root: "test" } },
      roots: ["src", "test"],
      ignore: ["docs/**", "src/**/*.md"],
      ...config,
    }),
    "docs/a.md": "",
    "docs/b.md": "",
    "docs/c.md": "",
    "docs/d.md": "",
    "src/a.js": "export const a = 1;",
    "src/notes.md": "",
    "scripts/gen.ts": "",
    "test/a.test.js": test,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

async function checkJson(dir: string) {
  const { status, output } = await run(["check", "--json", "--cwd", dir]);
  const report: Report = JSON.parse(output);
  return {
    status,
    deadGlobs: report.deadGlobs,
    staleDeadGlobs: report.staleDeadGlobs,
  };
}

describe("bivium check: dead globs", () => {
  it("reports a glob that matches nothing", async () => {
    const dir = globRepo("// @depends-on src/fixturs/*.json\nexport {};\n");
    expect(await checkJson(dir)).toEqual({
      status: 1,
      deadGlobs: [
        {
          node: "test/a.test.js",
          kind: "depends-on",
          glob: "src/fixturs/*.json",
          problem: "matches nothing",
          matches: 0,
          ignored: 0,
          examples: [],
          fix: "fix the path",
          at: "test/a.test.js:1",
        },
      ],
      staleDeadGlobs: [],
    });
  });

  it("reports a glob over ignored files outside the graph", async () => {
    const dir = globRepo(
      "// @reads docs/*.md\n// @reads **/*.md\nexport {};\n",
    );
    const { status, output } = await run(["check", "--cwd", dir]);
    expect(status).toBe(1);
    const fix =
      "      fix: point it at files the selector reads, or allowlist it in `deadGlobs` with a reason";
    expect(output).toBe(
      [
        "Dead globs: a change to what they match, or to some of it, selects nothing:",
        "  test/a.test.js",
        "    ✗ reads docs/*.md: matches only ignored files (4: docs/a.md, docs/b.md, docs/c.md, …)    test/a.test.js:1",
        fix,
        "    ✗ reads **/*.md: partly ignored (4 of 5: docs/a.md, docs/b.md, docs/c.md, …)    test/a.test.js:2",
        fix,
        "",
        "0 nodes with unknown dependencies reach a test: each such test runs on any change.",
        "2 dead globs not in `deadGlobs`.",
      ].join("\n"),
    );
  });

  it.each([
    ["ignored files that are graph nodes", "src/*.md"],
    ["files outside the roots that aren't ignored", "scripts/*.ts"],
  ])("passes a glob over %s", async (_, glob) => {
    const dir = globRepo(`// @depends-on ${glob}\nexport {};\n`);
    expect(await checkJson(dir)).toEqual({
      status: 0,
      deadGlobs: [],
      staleDeadGlobs: [],
    });
  });

  it("reports an import.meta.glob that matches nothing, as written", async () => {
    const dir = globRepo(
      `export {};\nconst pages = import.meta.glob("./pages/*.js");\n`,
    );
    const { status, deadGlobs } = await checkJson(dir);
    expect(status).toBe(1);
    expect(deadGlobs).toMatchObject([
      {
        kind: "glob",
        glob: "./pages/*.js",
        problem: "matches nothing",
        at: "test/a.test.js:2",
      },
    ]);
  });

  it("reports a config key or value that matches nothing for every match", async () => {
    const dir = globRepo("export {};\n", {
      edges: { "src/*.js": ["src/$1.js", "gen/$1/**"] },
      reads: {
        "test/*.test.js": "test/__snapshots__/$1.test.js.snap",
        "tset/*.test.js": "test/**",
      },
    });
    const dead = (
      kind: "edges" | "reads",
      glob: string,
      fix = "fix the path",
    ): Report["deadGlobs"][number] => ({
      node: "bivium.config.json",
      kind,
      glob,
      problem: "matches nothing",
      matches: 0,
      ignored: 0,
      examples: [],
      fix,
      at: "bivium.config.json:1",
    });
    const snapshot = dead("reads", "test/__snapshots__/$1.test.js.snap");
    const key = dead(
      "reads",
      "tset/*.test.js",
      "fix the path: no file the graph reads matches it",
    );
    expect(await checkJson(dir)).toEqual({
      status: 1,
      deadGlobs: [dead("edges", "gen/$1/**"), snapshot, key],
      staleDeadGlobs: [],
    });
    // One test's snapshot keeps the glob alive for the tests without one.
    write(dir, { "test/__snapshots__/a.test.js.snap": "" });
    const { deadGlobs } = await checkJson(dir);
    expect(deadGlobs).not.toContainEqual(snapshot);
    expect(deadGlobs).toContainEqual(key);
  });

  it("passes an allowlisted dead glob, and fails a stale entry", async () => {
    const entry = {
      file: "test/a.test.js",
      glob: "docs/*.md",
      reason: "docs-only changes skip CI",
    };
    const dir = globRepo("// @reads docs/*.md\nexport {};\n", {
      deadGlobs: [entry],
    });
    expect(await checkJson(dir)).toEqual({
      status: 0,
      deadGlobs: [],
      staleDeadGlobs: [],
    });
    write(dir, { "test/a.test.js": "// @reads src/*.js\nexport {};\n" });
    expect(await checkJson(dir)).toEqual({
      status: 1,
      deadGlobs: [],
      staleDeadGlobs: [
        { ...entry, fix: "remove the entry: its glob is no longer dead" },
      ],
    });
  });
});
