import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cacheDir, ExtractionCache, SCANNER_VERSION } from "../src/cache.ts";
import { computePlan } from "../src/compute.ts";
import { resolveConfig } from "../src/config.ts";
import { extract } from "../src/scan.ts";
import { sorted } from "../src/sorted.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const OID = "a".repeat(40);
const ROW_COUNT = /"rows":\d+/;
const OTHER = "b".repeat(40);

describe("ExtractionCache", () => {
  it("round-trips every field", async () => {
    const dir = temp("bivium-cache-");
    const extractions = [
      extract(
        "ts",
        `import { a, b as c } from "./a";\nimport "./side";\nexport * from "./star";\nconst x = import(y);\nawait page.goto("/x.html");\n// @depends-on css/**\n// @reads data/*.json\nimport.meta.glob("./g/*.ts?raw");`,
      ),
      extract("js", `export { a } from "./a.js";\nexport * from "./b.js";`),
      extract("ts", "const s = 'unterminated"),
      extract("html", `<script src="./x.js"></script>`),
    ];
    expect(extractions[1].barrel).toBeDefined();
    expect(extractions[2].fallback).toBeDefined();
    const cache = await ExtractionCache.open(dir);
    extractions.forEach((e, i) => {
      cache.set(String(i).repeat(40), "ts", e);
    });
    await cache.save();
    const back = await ExtractionCache.open(dir);
    expect(back.size).toBe(4);
    extractions.forEach((e, i) => {
      expect(back.get(String(i).repeat(40), "ts")).toEqual(e);
    });
    // The format is part of the key: a `.ts` file's blob isn't a `.svelte` one's.
    expect(back.get("0".repeat(40), "svelte")).toBeUndefined();
    // Written atomically, and ignored by git.
    expect(readdirSync(dir).sort()).toEqual([".gitignore", "extractions.json"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe("*\n");
  });

  /** A saved cache holding one entry, and its file's text. */
  async function saved() {
    const dir = temp("bivium-cache-");
    const cache = await ExtractionCache.open(dir);
    cache.set(OID, "ts", extract("ts", `import "./a";`));
    await cache.save();
    const file = join(dir, "extractions.json");
    return { dir, file, good: readFileSync(file, "utf-8") };
  }

  it.each([
    ["truncated", (good: string) => good.slice(0, good.length / 2)],
    ["not JSON", () => "not json"],
    ["not a cache", () => "{}"],
    [
      "from another scanner",
      (good: string) =>
        good.replace(`"scanner":${SCANNER_VERSION}`, `"scanner":0`),
    ],
    [
      "with a wrong row count",
      (good: string) => good.replace(ROW_COUNT, `"rows":9`),
    ],
  ])("ignores a file that is %s", async (_, corrupt) => {
    const { dir, file, good } = await saved();
    writeFileSync(file, corrupt(good));
    const loaded = await ExtractionCache.open(dir);
    expect(loaded.size).toBe(0);
    expect(loaded.get(OID, "ts")).toBeUndefined();
  });

  it("misses on a row whose string ids point nowhere", async () => {
    const { dir, file, good } = await saved();
    const [header, strings, rows] = JSON.parse(good);
    rows[0][1] = [99];
    writeFileSync(file, JSON.stringify([header, strings, rows]));
    expect((await ExtractionCache.open(dir)).get(OID, "ts")).toBeUndefined();
  });

  it("keeps what a run used, and at most half as many unused entries", async () => {
    const dir = temp("bivium-cache-");
    const first = await ExtractionCache.open(dir);
    for (let i = 0; i < 10; i++) {
      first.set(
        i.toString(16).repeat(40),
        "ts",
        extract("ts", `import "./${i}";`),
      );
    }
    await first.save();
    const second = await ExtractionCache.open(dir);
    expect(second.get("0".repeat(40), "ts")).toBeDefined();
    second.set(OTHER, "js", extract("js", `import "./new";`));
    second.set(OID.replace(/a/g, "c"), "js", extract("js", `import "./new2";`));
    await second.save();
    const third = await ExtractionCache.open(dir);
    // 3 used + 1 unused.
    expect(third.size).toBe(4);
    expect(third.get(OTHER, "js")?.imports).toEqual([{ specifier: "./new" }]);
    expect(third.get("0".repeat(40), "ts")).toBeDefined();
  });

  it("writes nothing when every entry was a hit", async () => {
    const dir = temp("bivium-cache-");
    const cache = await ExtractionCache.open(dir);
    await cache.save();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("cacheDir", () => {
  it("defaults to node_modules/.cache, else .bivium/cache", () => {
    const root = temp("bivium-root-");
    expect(cacheDir(root, undefined)).toBe(join(root, ".bivium", "cache"));
    mkdirSync(join(root, "node_modules"));
    expect(cacheDir(root, true)).toBe(
      join(root, "node_modules", ".cache", "bivium"),
    );
    expect(cacheDir(root, "tmp/c")).toBe(join(root, "tmp/c"));
    expect(cacheDir(root, false)).toBeUndefined();
  });
});

// What `extract` returns depends on these files. A change to any of them
// must bump SCANNER_VERSION, which drops every cache written before it; then
// update the fingerprint here.
const SCANNER_SOURCES = [
  "barrel.ts",
  "host.ts",
  "lex.ts",
  "scan-regex.ts",
  "scan.ts",
  "syntax.ts",
];
const FINGERPRINT = {
  version: 1,
  sha1: "472b6554f42a4d3df1cc0f5538b2bf3df08a6764",
};

describe("SCANNER_VERSION", () => {
  it("is bumped when the scanner changes", () => {
    const hash = createHash("sha1");
    for (const file of SCANNER_SOURCES) {
      hash.update(readFileSync(join(import.meta.dir, "../src", file)));
    }
    expect({ version: SCANNER_VERSION, sha1: hash.digest("hex") }).toEqual(
      FINGERPRINT,
    );
  });
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

describe("computePlan with the cache", () => {
  const config = resolveConfig({
    suites: { unit: { tests: "test/**/*.test.js", root: "test" } },
    roots: ["src", "test"],
  });
  const BASE_TEST = `import { a } from "../src/a.js";`;
  const EDITED_TEST = `import { a } from "../src/a.js";\nimport "./helper.js";`;

  /** `test/helper.js` is reached only once `a.test.js` imports it. */
  function repo() {
    const dir = temp("bivium-cache-git-");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    write(dir, {
      "package.json": JSON.stringify({ name: "lib" }),
      "src/a.js": "export const a = 1;",
      "src/b.js": "export const b = 2;",
      "test/a.test.js": BASE_TEST,
      "test/b.test.js": `import { b } from "../src/b.js";`,
      "test/helper.js": "export const help = 1;",
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "branch", "base");
    return dir;
  }
  const plan = (dir: string, base = "base") =>
    computePlan(dir, base, config, { cache: join(dir, ".cache") });
  const edges = (computed: Awaited<ReturnType<typeof plan>>, file: string) =>
    sorted(computed.graph.get(file)?.files ?? []);

  it("reads every file once, then only what git can't vouch for", async () => {
    const dir = repo();
    expect((await plan(dir)).extracted).toEqual({ cached: 0, read: 5 });
    expect((await plan(dir)).extracted).toEqual({ cached: 5, read: 0 });
    // The cache inside the repo isn't an untracked change.
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("uses a cached extraction for an unchanged file", async () => {
    const dir = repo();
    await plan(dir);
    // Poison the entry for b.test.js's blob: a hit must use it.
    const oid = git(dir, "rev-parse", "HEAD:test/b.test.js");
    const cache = await ExtractionCache.open(join(dir, ".cache"));
    cache.set(oid, "js", extract("js", `import "../src/a.js";`));
    await cache.save();
    expect(edges(await plan(dir), "test/b.test.js")).toEqual(["src/a.js"]);
  });

  it("never uses an entry for a file edited since, committed or not", async () => {
    const dir = repo();
    await plan(dir);
    // Uncommitted: the index still lists the old blob, whose entry is cached.
    write(dir, {
      "test/a.test.js": EDITED_TEST,
      "test/helper.js": "export const help = 2;",
    });
    const dirty = await plan(dir);
    expect(edges(dirty, "test/a.test.js")).toEqual([
      "src/a.js",
      "test/helper.js",
    ]);
    // Reached, so not orphaned: a stale a.test.js would run every test.
    expect(dirty.plan.suites.unit).toEqual({
      mode: "some",
      files: ["test/a.test.js"],
    });

    git(dir, "commit", "-q", "-am", "edit");
    const committed = await plan(dir);
    expect(committed.plan).toEqual(dirty.plan);
    expect(edges(committed, "test/a.test.js")).toEqual(
      edges(dirty, "test/a.test.js"),
    );
    // Against the new commit nothing changed, and the new blob is cached.
    const head = await plan(dir, "HEAD");
    expect(head.plan.suites.unit).toEqual({ mode: "none" });
    expect(edges(head, "test/a.test.js")).toContain("test/helper.js");
    const again = await plan(dir, "HEAD");
    expect(again.extracted).toEqual({ cached: 5, read: 0 });
    expect(edges(again, "test/a.test.js")).toContain("test/helper.js");
  });

  it("reads a file whose staged blob the working tree reverted", async () => {
    const dir = repo();
    await plan(dir);
    write(dir, { "test/a.test.js": EDITED_TEST });
    git(dir, "commit", "-q", "-am", "edit");
    // Stage the base version (its blob is cached), keep the edit on disk.
    write(dir, { "test/a.test.js": BASE_TEST });
    git(dir, "add", "test/a.test.js");
    write(dir, { "test/a.test.js": EDITED_TEST });
    const computed = await plan(dir, "HEAD");
    expect(computed.changed).toEqual([]);
    expect(edges(computed, "test/a.test.js")).toContain("test/helper.js");
  });

  it("drops a file deleted from the working tree, read or not", async () => {
    const dir = repo();
    write(dir, { "test/data.txt": "x" });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "data");
    await plan(dir, "HEAD");
    rmSync(join(dir, "test/data.txt"));
    rmSync(join(dir, "test/helper.js"));
    const computed = await plan(dir, "HEAD");
    expect(computed.graph.has("test/data.txt")).toBe(false);
    expect(computed.graph.has("test/helper.js")).toBe(false);
  });
});
