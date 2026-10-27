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
function repo(extra: Record<string, string> = {}) {
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
    ...extra,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  write(dir, { "src/a.js": "export const a = 2;" });
  return dir;
}

// An e2e suite whose helper opens a page: comments mention the page and the
// module before the code that loads them.
function e2eRepo() {
  const dir = mkdtempSync(join(tmpdir(), "bivium-why-e2e-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  write(dir, {
    "bivium.config.json": JSON.stringify({
      suites: {
        e2e: {
          tests: "e2e/**/*.test.ts",
          root: "e2e",
          urls: { "/*": "e2e/fixtures/*" },
        },
      },
      roots: ["src", "e2e"],
    }),
    "src/a.js": "export const a = 1;",
    "e2e/host.test.ts": `import { open } from "./helpers/host";\n`,
    "e2e/helpers/host.ts": [
      "/**",
      " * Opens host.html, which mounts a fixture.",
      " */",
      "export async function open(page) {",
      "  // Not `host.html?x`: the query is dropped.",
      `  await page.goto("/host.html");`,
      "}",
      "",
    ].join("\n"),
    "e2e/fixtures/host.html": [
      `<!-- Loads <script src="./host.ts">. -->`,
      `<script type="module" src="./host.ts"></script>`,
      "",
    ].join("\n"),
    "e2e/fixtures/host.ts": [
      `// Like "../../src/a.js", but mounted.`,
      `const path = "../../src/a.js";`,
      `import "../../src/a.js";`,
      "",
    ].join("\n"),
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

function why(dir: string, ...args: string[]) {
  return run(["why", ...args, "--base", "HEAD", "--cwd", dir]);
}

// Kinds of chain: links as `kind at`, from `why --json`.
async function links(dir: string, test: string) {
  const { output } = await why(dir, test, "--json");
  const explanation: { links: { kind: string; at?: string }[] } =
    JSON.parse(output);
  return explanation.links.map(({ kind, at }) => `${kind} ${at}`);
}

const UNRESOLVED_FIX =
  "no file at that path: fix the import, or add an `edges` entry if a build generates it";
const DISK_FIX =
  "name what it reads: `// @depends-on <glob>`, or `// @reads <glob>` for files read as text; list the file in `hermetic` if it reads no file of the repository";

describe("bivium why", () => {
  it("prints the shortest chain to the change, with where each edge is", async () => {
    const dir = repo();
    const { output } = await why(dir, "test/a.test.js");
    expect(output).toBe(
      [
        "test/a.test.js",
        "└─ name    src/index.js#a    test/a.test.js:2",
        "   └─ export  src/a.js       src/index.js:1",
        "      ● changed",
      ].join("\n"),
    );
  });

  it("says why a test depends on every change", async () => {
    const dir = repo();
    const { output } = await why(dir, "test/u.test.js");
    expect(output).toBe(
      [
        "test/u.test.js",
        "└─ depends on every change:",
        `   ✗ unresolved "./gone.js"                test/u.test.js:2`,
        "   ✗ reads the disk without @depends-on    test/u.test.js:1",
        "   └─ src/a.js",
        "      ● changed",
      ].join("\n"),
    );
  });

  it("explains a given file, and says what it reaches when not this test", async () => {
    const dir = repo({ "test/b.test.js": `import { b } from "lib";\n` });
    expect((await why(dir, "test/a.test.js", "src/b.js")).output).toBe(
      [
        "Not selected by a change to src/b.js: no chain reaches it.",
        "Its chains reach 1 test (1 unit), such as test/b.test.js.",
      ].join("\n"),
    );
    expect((await why(dir, "test/b.test.js")).output).toBe(
      "Not selected: the changed file doesn't reach it.",
    );
    write(dir, { "src/c.js": "export const c = 1;" });
    expect((await why(dir, "test/b.test.js", "src/c.js")).output).toBe(
      [
        "Not selected by a change to src/c.js: no chain reaches it.",
        "Its chains reach no test.",
      ].join("\n"),
    );
    write(dir, { "test/a.test.js": `import { a } from "lib";\nexport {};\n` });
    const given = await why(dir, "test/a.test.js", "src/a.js");
    expect(given.output.split("\n").at(-1)).toBe("      ● given");
  });

  it("cites the call, not a comment that mentions the file", async () => {
    const dir = e2eRepo();
    const { output } = await why(dir, "e2e/host.test.ts");
    expect(output).toBe(
      [
        "e2e/host.test.ts",
        "└─ import  e2e/helpers/host.ts           e2e/host.test.ts:1",
        "   └─ goto    e2e/fixtures/host.html     e2e/helpers/host.ts:6",
        "      └─ html    e2e/fixtures/host.ts    e2e/fixtures/host.html:2",
        "         └─ import  src/a.js             e2e/fixtures/host.ts:3",
        "            ● changed",
      ].join("\n"),
    );
  });

  it("names globs, annotations and config edges apart", async () => {
    const dir = repo({
      "bivium.config.json": JSON.stringify({
        suites: { unit: { tests: "test/**/*.test.js", root: "test" } },
        roots: ["src", "test"],
        edges: { "dist/out.css": "src/*.js" },
      }),
      "test/glob.test.js": `const all = import.meta.glob("../src/*.js");\n`,
      "test/dep.test.js": "// @depends-on src/a.js\nexport {};\n",
      "test/read.test.js": "export {};\n// @reads src/*.js\n",
      "test/css.test.js": `import "../dist/out.css";\n`,
    });
    expect(await links(dir, "test/glob.test.js")).toEqual([
      "glob test/glob.test.js:1",
    ]);
    expect(await links(dir, "test/dep.test.js")).toEqual([
      "depends-on test/dep.test.js:1",
    ]);
    expect(await links(dir, "test/read.test.js")).toEqual([
      "reads test/read.test.js:2",
    ]);
    expect(await links(dir, "test/css.test.js")).toEqual([
      "import test/css.test.js:1",
      "edges edges in the config",
    ]);
  });

  it("says how many more changes reach the test, and --all shows them", async () => {
    const dir = e2eRepo();
    write(dir, {
      "e2e/helpers/host.ts": `export async function open(page) {\n  await page.goto("/host.html");\n}\n`,
      "e2e/fixtures/host.ts": `import "../../src/a.js";\n`,
    });
    expect((await why(dir, "e2e/host.test.ts")).output).toBe(
      [
        "e2e/host.test.ts",
        "└─ import  e2e/helpers/host.ts    e2e/host.test.ts:1",
        "   ● changed",
        "+ 2 more changes reach this test: e2e/fixtures/host.ts, src/a.js (--all shows each chain)",
      ].join("\n"),
    );
    const all = await why(
      dir,
      "e2e/host.test.ts",
      "--all",
      "--format",
      "chain",
    );
    expect(all.output).toBe(
      [
        "e2e/helpers/host.ts changed",
        "  imported by  e2e/host.test.ts:1  ← selected",
        "+ 2 more changes reach this test: e2e/fixtures/host.ts, src/a.js",
        "",
        "e2e/fixtures/host.ts changed",
        "  loaded by page  e2e/fixtures/host.html:2",
        "  opened by       e2e/helpers/host.ts:2",
        "  imported by     e2e/host.test.ts:1  ← selected",
        "",
        "src/a.js changed",
        "  imported by     e2e/fixtures/host.ts:1",
        "  loaded by page  e2e/fixtures/host.html:2",
        "  opened by       e2e/helpers/host.ts:2",
        "  imported by     e2e/host.test.ts:1  ← selected",
      ].join("\n"),
    );
  });

  it("prints the chain from the change with --format chain", async () => {
    const dir = repo();
    expect((await why(dir, "test/a.test.js", "--format", "chain")).output).toBe(
      [
        "src/a.js changed",
        "  exported as a  src/index.js:1",
        "  imported by    test/a.test.js:2  ← selected",
      ].join("\n"),
    );
    const given = await why(
      dir,
      "test/a.test.js",
      "src/a.js",
      "--format",
      "chain",
    );
    expect(given.output.split("\n")[0]).toBe("if src/a.js changes");
  });

  it("says why, where, and how to fix it with --format chain", async () => {
    const dir = repo({
      "src/tool.js": `import { readFileSync } from "node:fs";\n`,
      "test/v.test.js": "// @depends-on src/tool.js\nexport {};\n",
    });
    expect((await why(dir, "test/u.test.js", "--format", "chain")).output).toBe(
      [
        "test/u.test.js runs on every change",
        `  because test/u.test.js:2  unresolved "./gone.js"`,
        `    fix: ${UNRESOLVED_FIX}`,
        "  because test/u.test.js:1  reads the disk without @depends-on",
        `    fix: ${DISK_FIX}`,
      ].join("\n"),
    );
    expect((await why(dir, "test/v.test.js", "--format", "chain")).output).toBe(
      [
        "test/v.test.js runs on every change",
        "  because src/tool.js:1  reads the disk without @depends-on",
        `    fix: ${DISK_FIX}`,
        "  reached via src/tool.js",
        "    depended on by  test/v.test.js:1  ← selected",
      ].join("\n"),
    );
  });

  it("cites each hop's line of source with --format source", async () => {
    const dir = e2eRepo();
    expect(
      (await why(dir, "e2e/host.test.ts", "--format", "source")).output,
    ).toBe(
      [
        "selected: e2e/host.test.ts ← src/a.js (4 hops)",
        "",
        " --> e2e/host.test.ts:1  import",
        `1 | import { open } from "./helpers/host";`,
        " --> e2e/helpers/host.ts:6  goto",
        `6 | await page.goto("/host.html");`,
        " --> e2e/fixtures/host.html:2  html",
        `2 | <script type="module" src="./host.ts"></script>`,
        " --> e2e/fixtures/host.ts:3  import",
        `3 | import "../../src/a.js";`,
        " ● src/a.js: changed",
      ].join("\n"),
    );
    const unknown = repo();
    expect(
      (await why(unknown, "test/u.test.js", "--format", "source")).output,
    ).toBe(
      [
        "selected: test/u.test.js ← every change (its dependencies can't be read)",
        "",
        ` ✗ test/u.test.js:2  unresolved "./gone.js"`,
        `2 | import x from "./gone.js";`,
        `  = fix: ${UNRESOLVED_FIX}`,
        " ✗ test/u.test.js:1  reads the disk without @depends-on",
        `1 | import { readFileSync } from "node:fs";`,
        `  = fix: ${DISK_FIX}`,
      ].join("\n"),
    );
  });

  it("rejects an unknown format", async () => {
    const dir = repo();
    const error = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const { status } = await why(dir, "test/a.test.js", "--format", "dot");
      expect(status).toBe(2);
      expect(error.mock.calls).toEqual([
        ["bivium why: --format takes tree, chain or source"],
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it("lists the reasons for a suite that runs in full", async () => {
    const dir = repo();
    write(dir, { "package.json": "{}" });
    const { output } = await why(dir, "test/a.test.js");
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
    const whyOf = (test: string) =>
      run(["why", test, "--base", "HEAD", "--cwd", dir]);
    expect((await whyOf("test/x.test.js")).output).toBe(
      [
        "test/x.test.js",
        "└─ reads  test/__snapshots__/x.test.js.snap    reads in the config",
        "   ● changed",
      ].join("\n"),
    );
    expect((await whyOf("examples/vite/package.json")).output).toBe(
      [
        "examples/vite/package.json",
        "└─ reads  examples/vite/index.html    reads in the config",
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
