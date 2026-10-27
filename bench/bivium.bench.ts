import { rmSync } from "node:fs";
import { join } from "node:path";
import { group, task } from "ostia";
import { check } from "../src/check.ts";
import { type Computed, computePlan } from "../src/compute.ts";
import { resolveConfig } from "../src/config.ts";
import { readRevision } from "../src/git.ts";
import { affectedBy, buildGraph, graphFrom } from "../src/graph.ts";
import { readPackageDiff } from "../src/lockfile.ts";
import type { Packages } from "../src/resolve.ts";
import {
  type Extraction,
  extract,
  formatOf,
  SCANNED,
  scan,
} from "../src/scan.ts";
import { scanRegex } from "../src/scan-regex.ts";
import { explain } from "../src/why.ts";
import {
  annotated,
  checkout,
  config,
  lockfile,
  repository,
} from "./fixture.ts";

const files = repository();
const scanned = [...files].filter(([path]) => SCANNED.test(path));
const resolved = resolveConfig(config);
const packages: Packages = new Map([
  [".", { name: "fixture", sideEffects: false }],
]);
const extractions = new Map<string, Extraction>(
  scanned.map(([path, text]) => [path, extract(formatOf(path), text)]),
);

group(`scan (${scanned.length} files)`, () => {
  task("lexer", () => scanned.map(([path, text]) => scan(path, text)), {
    baseline: true,
  });
  task("regex", () => scanned.map(([path, text]) => scanRegex(path, text)));
});

group(`graph (${files.size} files)`, () => {
  task("extract and resolve", () =>
    buildGraph(files, { config: resolved, packages }),
  );
  task("resolve only", () =>
    graphFrom(files.keys(), extractions, { config: resolved, packages }),
  );
});

let dir = "";
const cache = () => join(dir, "node_modules/.cache/bivium");
group(
  "plan, one component changed",
  () => {
    task("cold: no cache", () =>
      computePlan(dir, "HEAD", resolved, { cache: false }),
    );
    task("warm: every unchanged file cached", () =>
      computePlan(dir, "HEAD", resolved, { cache: cache() }),
    );
  },
  {
    before: async () => {
      dir = checkout(files);
      await computePlan(dir, "HEAD", resolved, { cache: cache() });
    },
    after: () => rmSync(dir, { recursive: true, force: true }),
  },
);

// The walk alone: the reverse index is built on the first call and kept
// for the graph, so these time what every plan pays per seed.
const graph = graphFrom(files.keys(), extractions, {
  config: resolved,
  packages,
});
group("walk", () => {
  task("one component changed", () =>
    affectedBy(graph, ["src/components/Component7/Component7.svelte"]),
  );
  task("a util most components reach", () =>
    affectedBy(graph, ["src/utils/util0.ts"]),
  );
  task("reverse index, then a walk", () =>
    affectedBy(new Map(graph), ["src/utils/util0.ts"]),
  );
});

// git is most of a warm plan on a real repository (carbon: ~45 of
// ~70 ms), so its cost is tracked apart from what bivium computes.
let gitDir = "";
group(
  "git: list and diff the checkout",
  () => {
    task("with blob OIDs (cached plan)", () =>
      readRevision(gitDir, "HEAD", resolved.roots, { blobs: true }),
    );
    task("without (no cache)", () =>
      readRevision(gitDir, "HEAD", resolved.roots),
    );
  },
  {
    before: () => {
      gitDir = checkout(files);
    },
    after: () => rmSync(gitDir, { recursive: true, force: true }),
  },
);

// A change that reaches most tests, through a util and the barrel, whose
// base version is read to find the names that moved.
let wideDir = "";
group(
  "plan, util and barrel changed",
  () => {
    task("warm", () =>
      computePlan(wideDir, "HEAD", resolved, {
        cache: join(wideDir, "node_modules/.cache/bivium"),
      }),
    );
  },
  {
    before: async () => {
      wideDir = checkout(files, ["src/utils/util0.ts", "src/index.js"]);
      await computePlan(wideDir, "HEAD", resolved, {
        cache: join(wideDir, "node_modules/.cache/bivium"),
      });
    },
    after: () => rmSync(wideDir, { recursive: true, force: true }),
  },
);

// A dependency bump in an 800-package lockfile: parse both sides, diff,
// and walk the dependency tree back to the packages that declare them.
const lockBase = lockfile();
const lockHead = lockfile(800, ["pkg-3", "pkg-400"]);
group("lockfile: bun.lock bump", () => {
  task("parse and diff", () =>
    readPackageDiff(
      ["bun.lock"],
      ["bun.lock"],
      async (path) => (path === "bun.lock" ? lockBase : undefined),
      async (path) => (path === "bun.lock" ? lockHead : undefined),
    ),
  );
});

// `check` and `why` on a computed plan: dead globs over the listing,
// unknown nodes, and one chain per change for `why --all`.
let inspectDir = "";
let computed: Computed | undefined;
const changes = [0, 50, 120, 300].map(
  (c) => `src/components/Component${c}/Component${c}.svelte`,
);
group(
  "inspect",
  () => {
    task("check", () => check(inspectDir, resolved, need(computed)));
    task("why --all, 4 changes", () =>
      explain(
        inspectDir,
        resolved,
        need(computed),
        "tests/Component300.test.ts",
        undefined,
        { all: true },
      ),
    );
  },
  {
    before: async () => {
      inspectDir = checkout(annotated(files), changes);
      computed = await computePlan(inspectDir, "HEAD", resolved, {
        cache: false,
      });
    },
    after: () => rmSync(inspectDir, { recursive: true, force: true }),
  },
);

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("bench: before() didn't run");
  return value;
}
