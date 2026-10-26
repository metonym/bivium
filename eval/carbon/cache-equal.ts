/**
 * The extraction cache can't change a graph: on a carbon checkout, builds
 * the graph four ways and checks they're identical, node by node (edges,
 * patterns, reads, unknowns, barrel names), with identical plans.
 *
 * - `reference`: Phase 2's path, every file read and scanned (`buildGraph`).
 * - `cold`: `computePlan` with no cache (leaves unread).
 * - `prime`: an empty cache, which this run fills.
 * - `warm`: the cache `prime` wrote. Only files git can't vouch for are read.
 *
 *   bun eval/carbon/cache-equal.ts <clone> <cache dir> <base>…
 */
import { readFileSync, rmSync } from "node:fs";
import { loadavg } from "node:os";
import {
  collectPackages,
  computePlan,
  readSources,
} from "../../src/compute.ts";
import { loadConfig } from "../../src/config.ts";
import { readRevision } from "../../src/git.ts";
import { buildGraph } from "../../src/graph.ts";
import { planTests } from "../../src/plan.ts";
import { firstDifference, graphKey } from "./graph-key.ts";

const [clone, dir, ...bases] = process.argv.slice(2);
if (!clone || !dir || bases.length === 0) {
  throw new Error("usage: cache-equal.ts <clone> <cache dir> <base>…");
}
const { config } = await loadConfig(
  clone,
  `${import.meta.dir}/bivium.config.ts`,
);

let failed = false;
for (const base of bases) {
  // biome-ignore lint/performance/noAwaitInLoops: each base fills and reuses one cache dir
  const revision = await readRevision(clone, base, config.roots);
  const sources = await readSources(clone, revision.files);
  const rootJson = readFileSync(`${clone}/package.json`, "utf-8");
  const packages = collectPackages(rootJson, sources);
  const reference = buildGraph(sources, { config, packages });
  const referencePlan = planTests(reference, revision.changed, config);

  const cold = await computePlan(clone, base, config, { cache: false });
  rmSync(dir, { recursive: true, force: true });
  const prime = await computePlan(clone, base, config, { cache: dir });
  const warm = await computePlan(clone, base, config, { cache: dir });

  const want = graphKey(reference);
  const runs = { cold, prime, warm };
  const report: string[] = [];
  for (const [name, run] of Object.entries(runs)) {
    const sameGraph = graphKey(run.graph) === want;
    // Barrel names need the merge base's barrels, which the reference
    // doesn't fetch; compare the plans with no barrel seeds.
    const samePlan =
      JSON.stringify(planTests(run.graph, run.changed, config)) ===
      JSON.stringify(referencePlan);
    if (!sameGraph || !samePlan) failed = true;
    report.push(
      `${name} ${sameGraph ? "graph=" : `graph≠ (${firstDifference(reference, run.graph)})`} ${samePlan ? "plan=" : "plan≠"} cached ${run.extracted.cached} read ${run.extracted.read}`,
    );
  }
  const plans = [cold, prime, warm].map((run) => JSON.stringify(run.plan));
  if (new Set(plans).size !== 1) {
    failed = true;
    report.push("full plans differ");
  }
  console.log(
    `${base}: ${reference.size} nodes, ${revision.changed.length} changed; ${report.join("; ")}; load ${loadavg()[0].toFixed(1)}`,
  );
}
rmSync(dir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
