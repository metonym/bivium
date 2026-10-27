// Times each phase of a plan on a real repository, with narrowers off so
// only bivium's own work counts: git, the extraction cache, lexing,
// resolution and the walk. The synthetic fixture can't show how a real
// repository's size and history split the time.
//
//   bun bench/phases.ts <repo> [base] [--cold]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir, ExtractionCache } from "../src/cache.ts";
import { collectPackages, extractRevision } from "../src/compute.ts";
import { loadConfig } from "../src/config.ts";
import { readRevision } from "../src/git.ts";
import { graphFrom } from "../src/graph.ts";
import { planTests } from "../src/plan.ts";
import { readTsconfigs } from "../src/tsconfig.ts";

const [root, base = "HEAD"] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"));
if (!root) throw new Error("usage: bun bench/phases.ts <repo> [base] [--cold]");
const cold = process.argv.includes("--cold");
const { config: loaded } = await loadConfig(root);
const config = { ...loaded, narrowers: [] };
const t: Record<string, number> = {};
const lap = async <T>(name: string, f: () => Promise<T> | T): Promise<T> => {
  const s = performance.now();
  const r = await f();
  t[name] = (t[name] ?? 0) + performance.now() - s;
  return r;
};
const total = performance.now();
const dir = cold ? undefined : cacheDir(root, config.cache);
const revision = await lap("git (readRevision)", () =>
  readRevision(root, base, config.roots, { blobs: dir !== undefined }),
);
const cache = await lap("cache open", () => ExtractionCache.open(dir));
const rootJson = await readFile(join(root, "package.json"), "utf-8");
const ex = await lap("extract (read + lex or cache)", () =>
  extractRevision(root, revision, cache),
);
const ts = await lap("tsconfigs", () =>
  readTsconfigs(["tsconfig.json"], (f) =>
    readFile(join(root, f), "utf-8").catch(() => undefined),
  ),
);
const packages = collectPackages(rootJson, ex.manifests);
const graph = await lap("graph (resolve)", () =>
  graphFrom(ex.files, ex.extractions, {
    config,
    packages,
    tsconfigs: ts.tsconfigs,
  }),
);
await lap("cache save", () => cache.save());
await lap("plan (classify + walk)", () =>
  planTests(graph, revision.changed, config, { barrelNames: [], narrowed: [] }),
);
t.total = performance.now() - total;
console.log(
  JSON.stringify({
    files: ex.files.length,
    changed: revision.changed.length,
    extracted: ex.extracted,
    ms: Object.fromEntries(
      Object.entries(t).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    ),
  }),
);
