/**
 * Where a plan's time goes on a carbon checkout, stage by stage, as
 * `computePlan` runs them: git, the cache load, extraction (reads plus
 * scans, or cache hits), resolution into the graph, planning, and the cache
 * write. Runs `rounds` cold (no cache), prime (an empty cache, written) and
 * warm plans, interleaved.
 *
 *   bun eval/carbon/profile.ts <clone> <base> <cache dir> [rounds=7]
 */
import { readFile, rm } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { ExtractionCache } from "../../src/cache.ts";
import {
  collectPackages,
  computePlan,
  extractRevision,
} from "../../src/compute.ts";
import { loadConfig } from "../../src/config.ts";
import { readRevision } from "../../src/git.ts";
import { graphFrom } from "../../src/graph.ts";
import { planTests } from "../../src/plan.ts";

const [clone, base, dir, roundsArg] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 7);
const { config } = await loadConfig(
  clone,
  `${import.meta.dir}/bivium.config.ts`,
);
// Fill the cache.
await rm(dir, { recursive: true, force: true });
await rm(`${dir}-prime`, { recursive: true, force: true });
await computePlan(clone, base, config, { cache: dir });

type Stages = Record<string, number>;
type Mode = "cold" | "prime" | "warm";
async function once(mode: Mode): Promise<Stages> {
  const cached = mode !== "cold";
  const cacheIn = mode === "prime" ? `${dir}-prime` : dir;
  if (mode === "prime") await rm(cacheIn, { recursive: true, force: true });
  const t0 = performance.now();
  const [revision, rootJson, cache] = await Promise.all([
    readRevision(clone, base, config.roots, { blobs: cached }),
    readFile(join(clone, "package.json"), "utf-8"),
    ExtractionCache.open(cached ? cacheIn : undefined),
  ]);
  const t1 = performance.now();
  const { files, extractions, manifests } = await extractRevision(
    clone,
    revision,
    cache,
  );
  const t2 = performance.now();
  const packages = collectPackages(rootJson, manifests);
  const graph = graphFrom(files, extractions, { config, packages });
  const t3 = performance.now();
  planTests(graph, revision.changed, config);
  const t4 = performance.now();
  await cache.save();
  const t5 = performance.now();
  return {
    "git+cache load": t1 - t0,
    extract: t2 - t1,
    resolve: t3 - t2,
    plan: t4 - t3,
    save: t5 - t4,
    total: t5 - t0,
  };
}

const modes: Mode[] = ["cold", "prime", "warm"];
const samples: Record<Mode, Stages[]> = { cold: [], prime: [], warm: [] };
const loads: number[] = [];
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? modes : [...modes].reverse();
  for (const mode of order) {
    // biome-ignore lint/performance/noAwaitInLoops: timed runs must not overlap
    samples[mode].push(await once(mode));
  }
  loads.push(loadavg()[0]);
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[values.length >> 1];
for (const mode of modes) {
  const stages = Object.keys(samples[mode][0]);
  console.log(
    `${mode.padEnd(5)} ${stages
      .map(
        (stage) =>
          `${stage} ${median(samples[mode].map((s) => s[stage])).toFixed(1)}`,
      )
      .join("  ")} ms (medians)`,
  );
}
console.log(
  `${rounds} rounds, load ${Math.min(...loads).toFixed(1)}–${Math.max(...loads).toFixed(1)}`,
);
await rm(dir, { recursive: true, force: true });
await rm(`${dir}-prime`, { recursive: true, force: true });
