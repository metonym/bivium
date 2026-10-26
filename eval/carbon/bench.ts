/**
 * Plan time on carbon, interleaved: each round runs every variant once, in
 * an order that rotates, so load drifts hit them alike.
 *
 *   bun eval/carbon/bench.ts <clone> [rounds=5] [groups=10]
 *     [--baseline <dir>] [--cache <dir>]
 *
 * Variants: carbon's frozen selector (Phase 0's timing), or with
 * `--baseline` another bivium checkout (an earlier phase, say); bivium with
 * no cache (`cold`); and with `--cache`, bivium on a cache filled at the
 * group's checkout (`warm`).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs, usage } from "../args.ts";
import { isRecord, readItems } from "../untyped.ts";

const args = parseArgs(process.argv.slice(2), [
  "--carbon",
  "--baseline",
  "--cache",
]);
const carbon = args.option("--carbon");
const baseline = args.option("--baseline");
const cache = args.option("--cache");
const [clone, roundsArg, groupsArg] = args.positional;
if (!carbon || !clone)
  usage("bench.ts --carbon <checkout> <clone> [rounds] [groups]");
const rounds = Number(roundsArg ?? 5);
const PHASE0 = join(carbon, ".context/test-graph-package/phase0");
const isGroup = (value: unknown): value is { first: string; last: string } =>
  isRecord(value) &&
  typeof value.first === "string" &&
  typeof value.last === "string";
const groups = readItems(
  readFileSync(join(PHASE0, "out/groups.json"), "utf-8"),
  false,
  isGroup,
);
const count = Number(groupsArg ?? 10);
const picked = Array.from(
  { length: count },
  (_, i) => groups[Math.floor((i * groups.length) / count)],
);

const git = (...gitArgs: string[]) =>
  spawnSync("git", ["-C", clone, ...gitArgs], {
    encoding: "utf-8",
  }).stdout.trim();
const timed = (command: string[], env: Record<string, string> = {}) => {
  const start = performance.now();
  const result = spawnSync("bun", command, {
    cwd: clone,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const wallMs = performance.now() - start;
  if (result.status !== 0) throw new Error(result.stderr);
  const last: unknown = JSON.parse(
    result.stdout.trim().split("\n").at(-1) ?? "",
  );
  if (!isRecord(last) || typeof last.selectorMs !== "number") {
    throw new Error(`no selectorMs in ${result.stdout}`);
  }
  return { inProcess: last.selectorMs, wallMs };
};

const here = import.meta.dir;
const old = baseline ? "baseline" : "carbon";
const variants: Record<string, (parent: string) => string[]> = {
  [old]: (parent) =>
    baseline
      ? [`${baseline}/eval/carbon/time-bivium.ts`, clone, parent]
      : [`${PHASE0}/selector/test-changed.ts`, parent],
  cold: (parent) => [`${here}/time-bivium.ts`, clone, parent, "--no-cache"],
};
if (cache) {
  variants.warm = (parent) => [`${here}/time-bivium.ts`, clone, parent, cache];
}
const names = Object.keys(variants);
interface Samples {
  inProcess: number[];
  wall: number[];
}
const samples = new Map<string, Samples>(
  names.map((name) => [name, { inProcess: [], wall: [] }]),
);
const samplesOf = (name: string): Samples => {
  const found = samples.get(name);
  if (!found) throw new Error(`no variant ${name}`);
  return found;
};
const loads: number[] = [];

for (const group of picked) {
  git("checkout", "-q", "--detach", group.last);
  spawnSync("git", ["-C", clone, "update-index", "-q", "--refresh"]);
  const parent = git("rev-parse", `${group.first}^`);
  if (cache) {
    // Filled at this checkout, as CI restores the base's cache and a
    // developer's last run left theirs.
    rmSync(cache, { recursive: true, force: true });
    timed(variants.warm(parent));
  }
  for (let round = 0; round < rounds; round++) {
    const shift = round % names.length;
    const order = [...names.slice(shift), ...names.slice(0, shift)];
    for (const name of order) {
      const t = timed(
        variants[name](parent),
        name === "carbon" ? { REPLAY_ROOT: clone } : {},
      );
      samplesOf(name).inProcess.push(t.inProcess);
      samplesOf(name).wall.push(t.wallMs);
    }
    loads.push(loadavg()[0]);
  }
}
if (cache) rmSync(cache, { recursive: true, force: true });

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const row = (label: string, values: number[]) =>
  `${label.padEnd(22)} median ${quantile(values, 0.5).toFixed(0)} ms  p90 ${quantile(values, 0.9).toFixed(0)} ms  min ${Math.min(...values).toFixed(0)} ms`;
console.log(`${picked.length} groups × ${rounds} rounds, interleaved`);
for (const name of names) {
  console.log(row(`${name}, in-process`, samplesOf(name).inProcess));
}
for (const name of names) {
  console.log(row(`${name}, process wall`, samplesOf(name).wall));
}
for (const name of names.slice(1)) {
  const ratios = samplesOf(name).inProcess.map(
    (value, i) => value / samplesOf(old).inProcess[i],
  );
  console.log(
    `${name} / ${old}, paired: median ${quantile(ratios, 0.5).toFixed(2)}×`,
  );
}
console.log(
  `load average (1 min): median ${quantile(loads, 0.5).toFixed(1)}, range ${Math.min(...loads).toFixed(1)}–${Math.max(...loads).toFixed(1)}`,
);
