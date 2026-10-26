/**
 * Golden replay: re-plans the PR groups Phase 0 replayed and compares
 *
 * - the recorded Phase 0 plans with carbon's frozen selector, rerun here
 *   (checks this harness),
 * - the recorded plans with bivium and `phase0.config.ts`,
 * - carbon's selector at the checkout's commit with bivium and
 *   `bivium.config.ts`.
 *
 *   bun eval/carbon/replay.ts --carbon <checkout> <clone> <out.jsonl>
 *     [--strict] [--subset] [--cache <dir>] [--baseline <bivium checkout>]
 *
 * `--carbon` is the carbon-components-svelte checkout holding the selector
 * and Phase 0's data (`.context/test-graph-package/phase0`). `<clone>` is a
 * scratch clone of carbon, checked out at every group's last commit.
 *
 * `--strict` uses `phase0-strict.config.ts` and `strict.config.ts`, which bind
 * barrel names only for the package entry, as carbon does.
 *
 * `--subset` replays the 40 most recent groups and 20 older ones, evenly
 * spaced. `--cache <dir>` plans each group three ways, with no cache, with
 * the cache earlier groups left (some hits, some writes) and with the
 * cache that run filled (all hits), and checks the three graphs are
 * identical and each plan matches. `--baseline` also plans each group with
 * an earlier bivium (both configs) and checks graphs and plans are
 * identical to it.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Computed, computePlan } from "../../src/compute.ts";
import { loadConfig } from "../../src/config.ts";
import { formatSelection } from "../../src/plan.ts";
import type { Selection } from "../../src/types.ts";
import { parseArgs, usage } from "../args.ts";
import {
  exported,
  importModule,
  isGraph,
  isRecord,
  isStrings,
  readItems,
} from "../untyped.ts";
import { graphKey } from "./graph-key.ts";
import { type CarbonPlan, oracle, selectors } from "./oracle.ts";

const args = parseArgs(process.argv.slice(2), [
  "--carbon",
  "--cache",
  "--baseline",
]);
const carbon = args.option("--carbon");
const [clone, out] = args.positional;
if (!carbon || !clone || !out) {
  usage("replay.ts --carbon <checkout> <clone> <out.jsonl> [options]");
}
const cacheDir = args.option("--cache");
const baseline = args.option("--baseline");
const strict = args.flag("--strict");
const subset = args.flag("--subset");
const phase0 = join(carbon, ".context/test-graph-package/phase0/out");
const here = import.meta.dir;

interface Group {
  pr: number | null;
  first: string;
  last: string;
}
interface Recorded {
  c: string;
  changed: string[];
  unitFiles: string | string[];
  e2eFiles: string | string[];
  reasons: string[];
}

function isGroup(value: unknown): value is Group {
  return (
    isRecord(value) &&
    (value.pr === null || typeof value.pr === "number") &&
    typeof value.first === "string" &&
    typeof value.last === "string"
  );
}

function isFiles(value: unknown): value is string | string[] {
  return typeof value === "string" || isStrings(value);
}

function isRecorded(value: unknown): value is Recorded {
  return (
    isRecord(value) &&
    typeof value.c === "string" &&
    isStrings(value.changed) &&
    isFiles(value.unitFiles) &&
    isFiles(value.e2eFiles) &&
    isStrings(value.reasons)
  );
}

function load<T>(file: string, is: (value: unknown) => value is T): T[] {
  const text = readFileSync(join(phase0, file), "utf-8");
  return readItems(text, file.endsWith(".jsonl"), is);
}

const sets = [
  {
    name: "window",
    groups: load("groups.json", isGroup),
    recorded: load("pr-pass1.jsonl", isRecorded),
  },
  {
    name: "older",
    groups: load("groups-ext.json", isGroup),
    recorded: load("ext-pr-pass1.jsonl", isRecorded),
  },
];
// Groups run oldest first; the window's last 40 are the most recent.
function picked(set: string, length: number): number[] {
  const all = Array.from({ length }, (_, i) => i);
  if (!subset) return all;
  if (set === "window") return all.slice(-40);
  return Array.from({ length: 20 }, (_, i) => Math.floor((i * length) / 20));
}
if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });

function git(...gitArgs: string[]) {
  const result = spawnSync("git", ["-C", clone, ...gitArgs], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

const configNames = [
  `phase0${strict ? "-strict" : ""}.config.ts`,
  `${strict ? "strict" : "bivium"}.config.ts`,
];
const roots = (await loadConfig(clone, join(here, configNames[1]))).config
  .roots;
const frozen = await oracle(selectors(carbon).phase0, roots);
const master = await oracle(selectors(carbon).master, roots);
const [phase0Config, carbonConfig] = await Promise.all(
  configNames.map(
    async (name) => (await loadConfig(clone, join(here, name))).config,
  ),
);

interface Baseline {
  plan: unknown;
  graph: Computed["graph"];
}

// An earlier bivium checkout: its config loader and planner, whose
// results are only compared, plan by plan and graph by graph.
async function earlierPlanner(dir: string) {
  const loader = await importModule(join(dir, "src/config.ts"));
  const computeFile = existsSync(join(dir, "src/compute.ts"))
    ? "src/compute.ts"
    : "src/load.ts";
  const planner = await importModule(join(dir, computeFile));
  const loadEarlier = exported(loader, "loadConfig");
  const planEarlier = exported(planner, "computePlan");
  const configs = await Promise.all(
    configNames.map(async (name) => {
      const loaded = await loadEarlier(clone, join(dir, "eval/carbon", name));
      if (!isRecord(loaded)) throw new Error("loadConfig returned no config");
      return loaded.config;
    }),
  );
  return async (base: string): Promise<Baseline[]> => {
    const plans: Baseline[] = [];
    for (const config of configs) {
      // biome-ignore lint/performance/noAwaitInLoops: plans share the clone's cache
      const computed = await planEarlier(clone, base, config);
      if (!isRecord(computed) || !isGraph(computed.graph)) {
        throw new Error("computePlan returned no graph");
      }
      plans.push({ plan: computed.plan, graph: computed.graph });
    }
    return plans;
  };
}
const earlier =
  baseline === undefined ? undefined : await earlierPlanner(baseline);

// Today's reason for a Svelte 3/4 harness change, in bivium's words.
const normalize = (reasons: string[]) =>
  reasons.map((reason) =>
    reason.replace(": Svelte 3/4 harness changed", ": wires the unit suite"),
  );
const fmt = (selection: Selection) => formatSelection(selection);
const recordedFmt = (files: string | string[]) =>
  Array.isArray(files) ? files.join(" ") : files;
interface Shape {
  unit: string;
  e2e: string;
  reasons: string[];
}
const shape = (unit: string, e2e: string, reasons: string[]): Shape => ({
  unit,
  e2e,
  reasons: normalize(reasons),
});
const carbonShape = (plan: CarbonPlan) =>
  shape(fmt(plan.unit), fmt(plan.e2e), plan.reasons);
const biviumShape = ({ plan }: Computed) =>
  shape(
    fmt(plan.suites.unit ?? { mode: "none" }),
    fmt(plan.suites.e2e ?? { mode: "none" }),
    plan.reasons,
  );
// What a plan selects, and why: the fields every bivium version has.
const selected = (plan: unknown) =>
  isRecord(plan) ? { suites: plan.suites, reasons: plan.reasons } : plan;
const same = (a: Shape, b: Shape) => JSON.stringify(a) === JSON.stringify(b);
const flag = (
  result: { plans: boolean; graphs: boolean } | undefined,
  letter: string,
) => {
  if (!result) return "";
  return result.plans && result.graphs ? "." : letter;
};

writeFileSync(out, "");
for (const { name: set, groups, recorded } of sets) {
  for (const i of picked(set, groups.length)) {
    const group = groups[i];
    git("checkout", "-q", "--detach", group.last);
    // A fresh checkout leaves the index racy, so every diff would re-hash.
    spawnSync("git", ["-C", clone, "update-index", "-q", "--refresh"]);
    const parent = git("rev-parse", `${group.first}^`);
    const rec = recorded[i];
    if (rec.c !== group.last) {
      throw new Error(`${set} ${i}: group/record mismatch`);
    }
    const want = shape(
      recordedFmt(rec.unitFiles),
      recordedFmt(rec.e2eFiles),
      rec.reasons,
    );

    // biome-ignore lint/performance/noAwaitInLoops: every group checks out the shared clone
    const frozenShape = carbonShape(await frozen(clone, parent));
    const masterShape = carbonShape(await master(clone, parent));
    // Cold first: the comparisons below use it. Extraction doesn't depend
    // on config, so both configs share one cache.
    const runs: Computed[][] = [];
    for (const cache of cacheDir ? [false, cacheDir, cacheDir] : [false]) {
      runs.push([
        // biome-ignore lint/performance/noAwaitInLoops: each run reads the cache the last one left
        await computePlan(clone, parent, phase0Config, { cache }),
        await computePlan(clone, parent, carbonConfig, { cache }),
      ]);
    }
    const [p0, sc] = runs[0];
    const before = earlier && (await earlier(parent));
    const sameAsBaseline = before && {
      plans:
        JSON.stringify(before.map((c) => selected(c.plan))) ===
        JSON.stringify(runs[0].map((c) => selected(c.plan))),
      graphs:
        before.map((c) => graphKey(c.graph)).join() ===
        runs[0].map((c) => graphKey(c.graph)).join(),
    };
    const cache = cacheDir
      ? {
          plans:
            new Set(
              runs.map((run) =>
                JSON.stringify(run.map((c) => selected(c.plan))),
              ),
            ).size === 1,
          graphs:
            new Set(runs.map((run) => run.map((c) => graphKey(c.graph)).join()))
              .size === 1,
          extracted: runs.slice(1).map(([, c]) => c.extracted),
        }
      : undefined;
    const p0Shape = biviumShape(p0);
    const scShape = biviumShape(sc);
    const row = {
      set,
      i,
      pr: group.pr,
      last: group.last,
      parent,
      changedSame: JSON.stringify(rec.changed) === JSON.stringify(sc.changed),
      harness: same(want, frozenShape),
      phase0: same(want, p0Shape),
      master: same(masterShape, scShape),
      masterIsRecorded: same(want, masterShape),
      ...(same(want, frozenShape) ? {} : { want, frozen: frozenShape }),
      ...(same(want, p0Shape) ? {} : { want, biviumPhase0: p0Shape }),
      ...(same(masterShape, scShape)
        ? {}
        : { masterPlan: masterShape, bivium: scShape }),
      ...(cache && { cache }),
      ...(sameAsBaseline && { baseline: sameAsBaseline }),
      changed: sc.changed,
    };
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    const flags = `${row.harness ? "." : "H"}${row.phase0 ? "." : "P"}${row.master ? "." : "M"}${flag(cache, "C")}${flag(sameAsBaseline, "B")}`;
    console.error(set, i, group.pr, flags);
  }
}
