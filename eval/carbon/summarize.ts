/**
 * Summarizes a replay: how many groups match, and for each difference, the
 * tests one side selects that the other doesn't.
 *
 *   bun eval/carbon/summarize.ts <replay.jsonl> [--drop <test>]…
 *
 * `--drop` names a test bivium is known to stop selecting (a documented
 * precision gain): a difference that is only that test leaving a selection
 * is counted as explained and listed by PR, not detailed.
 */
import { readFileSync } from "node:fs";

interface Shape {
  unit: string;
  e2e: string;
  reasons: string[];
}
interface Row {
  set: string;
  i: number;
  pr: number | null;
  harness: boolean;
  phase0: boolean;
  master: boolean;
  changedSame: boolean;
  masterIsRecorded?: boolean;
  want?: Shape;
  biviumPhase0?: Shape;
  masterPlan?: Shape;
  bivium?: Shape;
}

const [input, ...rest] = process.argv.slice(2);
const drops = rest.filter((_, i) => rest[i - 1] === "--drop");
const rows: Row[] = readFileSync(input, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const count = (of: Row[], key: keyof Row) =>
  of.filter((row) => row[key]).length;
for (const set of [...new Set(rows.map((row) => row.set))]) {
  const of = rows.filter((row) => row.set === set);
  console.log(
    `${set}: ${of.length} groups. Identical: harness ${count(of, "harness")}, ` +
      `bivium vs recorded (phase0 config) ${count(of, "phase0")}, ` +
      `bivium vs carbon b65b46a6c ${count(of, "master")}, ` +
      `changed lists ${count(of, "changedSame")}` +
      (of[0].masterIsRecorded === undefined
        ? ""
        : `; carbon b65b46a6c vs recorded ${count(of, "masterIsRecorded")}`),
  );
}

const files = (selection: string) =>
  selection === "all" || selection === "none" ? [] : selection.split(" ");
function describe(label: string, old: Shape, now: Shape) {
  const parts: string[] = [];
  for (const suite of ["unit", "e2e"] as const) {
    if (old[suite] === now[suite]) continue;
    if (files(old[suite]).length === 0 || files(now[suite]).length === 0) {
      parts.push(
        `${suite} ${old[suite].split(" ").length > 1 ? `${files(old[suite]).length} files` : old[suite]} → ${now[suite].split(" ").length > 1 ? `${files(now[suite]).length} files` : now[suite]}`,
      );
      continue;
    }
    const before = new Set(files(old[suite]));
    const after = new Set(files(now[suite]));
    const lost = [...before].filter((file) => !after.has(file));
    const gained = [...after].filter((file) => !before.has(file));
    parts.push(
      `${suite} ${before.size} → ${after.size}` +
        (lost.length > 0 ? ` −[${lost.join(", ")}]` : "") +
        (gained.length > 0 ? ` +[${gained.join(", ")}]` : ""),
    );
  }
  if (JSON.stringify(old.reasons) !== JSON.stringify(now.reasons)) {
    parts.push(
      `reasons ${JSON.stringify(old.reasons)} → ${JSON.stringify(now.reasons)}`,
    );
  }
  console.log(`  ${label}: ${parts.join("; ")}`);
}

/** `now` is `old` minus the dropped tests. */
function onlyDrops(old: Shape | undefined, now: Shape | undefined) {
  if (!old || !now || drops.length === 0) return false;
  if (JSON.stringify(old.reasons) !== JSON.stringify(now.reasons)) return false;
  return (["unit", "e2e"] as const).every((suite) => {
    const kept = files(old[suite]).filter((test) => !drops.includes(test));
    if (files(old[suite]).length === 0) return old[suite] === now[suite];
    return (kept.length > 0 ? kept.join(" ") : "none") === now[suite];
  });
}
const explained = (row: Row) =>
  row.harness &&
  (row.phase0 || onlyDrops(row.want, row.biviumPhase0)) &&
  (row.master || onlyDrops(row.masterPlan, row.bivium));
if (drops.length > 0) {
  for (const set of [...new Set(rows.map((row) => row.set))]) {
    const of = rows.filter((row) => row.set === set);
    const gains = of.filter(
      (row) => !(row.phase0 && row.master) && explained(row),
    );
    console.log(
      `${set}: ${of.filter((row) => row.phase0 && row.master).length} identical, ` +
        `${gains.length} differ only by dropping ${drops.join(", ")}, ` +
        `${of.filter((row) => !explained(row)).length} otherwise`,
    );
    if (gains.length > 0) {
      console.log(
        `  PRs: ${gains.map((row) => row.pr ?? `#${row.i}`).join(" ")}`,
      );
    }
  }
}

for (const row of rows) {
  if (row.harness && row.phase0 && row.master) continue;
  if (drops.length > 0 && explained(row)) continue;
  console.log(`${row.set} #${row.i} PR ${row.pr}`);
  if (row.want && row.biviumPhase0) {
    describe("recorded → bivium (phase0 config)", row.want, row.biviumPhase0);
  }
  if (row.masterPlan && row.bivium) {
    describe("carbon b65b46a6c → bivium", row.masterPlan, row.bivium);
  }
  if (!row.harness)
    console.log(
      "  harness mismatch: the frozen selector rerun differs from the record",
    );
}
