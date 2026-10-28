import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computePlan } from "../src/compute.ts";
import { checkConfig, resolveConfig } from "../src/config.ts";
import {
  type Config,
  defineConfig,
  type NarrowContext,
  type Narrower,
  type NarrowResult,
  type PrepareContext,
  plan,
} from "../src/index.ts";
import { explain } from "../src/why.ts";

// The module itself, whose `graphFrom` a test wraps to time the build.
const graphModule = await import("../src/graph.ts");

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

type Suites = "e2e" | "unit";

function configWithPrepare<T>(
  prepare: (context: PrepareContext) => T | Promise<T>,
  narrow: (
    context: NarrowContext<Suites, T>,
  ) => NarrowResult | Promise<NarrowResult>,
  extra: Partial<Config<Suites>> = {},
) {
  const css: Narrower<Suites, T> = {
    name: "css",
    match: "styles/**",
    opaque: "dist/*.css",
    suites: ["e2e"],
    prepare,
    narrow,
  };
  return defineConfig({
    ...configWith(() => ({ all: "" })),
    ...extra,
    narrowers: [css],
  });
}

const FAILED = /^css: failed: /;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Blocks the thread, as resolving a large repository does.
function busy(ms: number) {
  const until = performance.now() + ms;
  let spins = 0;
  while (performance.now() < until) spins++;
  return spins;
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

describe("a narrower's prepare", () => {
  it("passes what it returns to narrow", async () => {
    const dir = repo();
    const seen: unknown[] = [];
    const result = await plan({
      cwd: dir,
      base: "HEAD",
      config: configWithPrepare(
        async ({ root, base, head, changed }) => {
          seen.push(root === dir, changed);
          return {
            before: await base.read("styles/a.css"),
            after: await head.read("styles/a.css"),
          };
        },
        ({ prepared, changed }) => {
          seen.push(prepared, changed);
          return { seeds: ["src/x.js"] };
        },
      ),
    });
    expect(seen).toEqual([
      true,
      ["styles/a.css"],
      { before: ".a { color: red }", after: ".a { color: blue }" },
      ["styles/a.css"],
    ]);
    expect(result.suites.e2e).toEqual({
      mode: "some",
      files: ["e2e/x.test.js"],
    });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("no install");
      },
    ],
    ["rejects", () => Promise.reject(new Error("no install"))],
  ])(
    "runs its suites in full when it %s, without calling narrow",
    async (_, prepare) => {
      let narrowed = 0;
      const result = await plan({
        cwd: repo(),
        base: "HEAD",
        config: configWithPrepare(prepare, () => {
          narrowed++;
          return { seeds: [] };
        }),
      });
      expect(narrowed).toBe(0);
      expect(result.suites).toEqual({
        e2e: { mode: "all" },
        unit: { mode: "none" },
      });
      expect(result.reasons).toEqual(["css: failed to prepare: no install"]);
    },
  );

  // Bivium can't check what prepare returns: narrow is what can't use it.
  it("runs its suites in full when narrow can't use what it returned", async () => {
    const thrown = await plan({
      cwd: repo(),
      base: "HEAD",
      config: configWithPrepare(
        (): { sheets: string[] } => JSON.parse("null"),
        ({ prepared }) => ({ seeds: prepared.sheets }),
      ),
    });
    expect(thrown.suites.e2e).toEqual({ mode: "all" });
    expect(thrown.reasons).toEqual([expect.stringMatching(FAILED)]);
  });

  it("doesn't run for other changes or for suites no one asked for", async () => {
    let calls = 0;
    const config = resolveConfig(
      configWithPrepare(
        () => {
          calls++;
        },
        () => ({ seeds: [] }),
      ),
    );
    const dir = repo();
    await computePlan(dir, "HEAD", config, { cache: false, suites: ["unit"] });
    expect(calls).toBe(0);
    git(dir, "checkout", "-q", "styles/a.css");
    write(dir, { "src/y.js": "export const y = 2;" });
    await computePlan(dir, "HEAD", config, { cache: false });
    expect(calls).toBe(0);
  });

  it("runs again with the graph's files when git's listing differs", async () => {
    // styles/gone.css is ignored and deleted: git still lists it, but the
    // graph doesn't have it, so it isn't one of the narrower's changes.
    const dir = repo({ "styles/gone.css": ".gone {}" });
    rmSync(join(dir, "styles/gone.css"));
    const calls: (readonly string[])[] = [];
    const result = await plan({
      cwd: dir,
      base: "HEAD",
      config: configWithPrepare(
        ({ changed }) => {
          calls.push(changed);
          return changed;
        },
        ({ prepared, changed }) => ({
          seeds: prepared === changed ? ["src/x.js"] : [],
        }),
        { ignore: "styles/gone.css" },
      ),
    });
    expect(calls).toEqual([
      ["styles/a.css", "styles/gone.css"],
      ["styles/a.css"],
    ]);
    expect(result.suites.e2e).toEqual({
      mode: "some",
      files: ["e2e/x.test.js"],
    });
  });

  it("runs from a config nothing has type-checked", async () => {
    const config = checkConfig({
      suites: { e2e: { tests: "e2e/**/*.test.js" } },
      narrowers: [
        {
          name: "css",
          match: "styles/**",
          opaque: "dist/*.css",
          prepare: () => 42,
          narrow: ({ prepared }: { prepared: unknown }) => ({
            seeds: prepared === 42 ? ["src/x.js"] : [],
          }),
        },
      ],
    });
    const result = await plan({ cwd: repo(), base: "HEAD", config });
    expect(result.narrowed).toEqual([
      { name: "css", result: { seeds: ["src/x.js"] } },
    ]);
  });

  // The point of `prepare`: its wait and the graph's build overlap, so the
  // plan costs the longer of the two, not their sum.
  it("starts before the graph is built, and overlaps with it", async () => {
    const WAIT = 300;
    const at: Record<string, number> = {};
    const original = graphModule.graphFrom;
    const graphFrom = jest
      .spyOn(graphModule, "graphFrom")
      .mockImplementation((...args) => {
        at.graphStart = performance.now();
        busy(WAIT);
        const graph = original(...args);
        at.graphEnd = performance.now();
        return graph;
      });
    try {
      const config = configWithPrepare(
        async () => {
          at.prepareStart = performance.now();
          await sleep(WAIT);
          return "compiled";
        },
        ({ prepared }) => {
          at.narrow = performance.now();
          return { all: prepared };
        },
      );
      const start = performance.now();
      const result = await plan({ cwd: repo(), base: "HEAD", config });
      const overlapped = performance.now() - start;
      expect(result.reasons).toEqual(["css: compiled"]);
      expect(at.prepareStart).toBeLessThan(at.graphStart);
      // The wait ran out while the graph was built: narrow ran right after.
      expect(at.narrow - at.graphEnd).toBeLessThan(WAIT / 2);

      // The same wait inside narrow comes after the graph.
      const start2 = performance.now();
      await plan({
        cwd: repo(),
        base: "HEAD",
        config: configWith(async () => {
          await sleep(WAIT);
          return { all: "compiled" };
        }),
      });
      const sequential = performance.now() - start2;
      expect(sequential).toBeGreaterThanOrEqual(2 * WAIT);
      expect(overlapped).toBeLessThan(sequential - WAIT / 2);
    } finally {
      graphFrom.mockRestore();
    }
  });

  it("can't reject unhandled when a later step throws", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    const graphFrom = jest
      .spyOn(graphModule, "graphFrom")
      .mockImplementation(() => {
        throw new Error("graph broke");
      });
    const { promise: done, resolve: rejected } = Promise.withResolvers<void>();
    try {
      const config = configWithPrepare(
        async () => {
          await sleep(20);
          setTimeout(rejected, 0);
          throw new Error("late");
        },
        () => ({ seeds: [] }),
      );
      await expect(plan({ cwd: repo(), base: "HEAD", config })).rejects.toThrow(
        "graph broke",
      );
      await done;
      await sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      graphFrom.mockRestore();
      process.off("unhandledRejection", record);
    }
  });

  it("types prepared by what prepare returns", () => {
    const typed: Narrower<Suites, number> = {
      name: "n",
      match: "**",
      opaque: "**",
      prepare: () => 1,
      narrow: ({ prepared }) => {
        expectTypeOf(prepared).toEqualTypeOf<number>();
        return { all: "" };
      },
    };
    const plain: Narrower<Suites> = {
      name: "n",
      match: "**",
      opaque: "**",
      narrow: ({ prepared }) => {
        expectTypeOf(prepared).toEqualTypeOf<undefined>();
        return { all: "" };
      },
    };
    // @ts-expect-error: narrow needs what prepare returns, so it's required.
    const missing: Narrower<Suites, number> = {
      name: "n",
      match: "**",
      opaque: "**",
      narrow: () => ({ all: "" }),
    };
    expect([typed, plain, missing]).toHaveLength(3);
  });
});
