/**
 * Replays a repository's history through two bivium builds: each of its
 * last N first-parent commits is planned against its parent, cold, with
 * each build, and the selections are compared.
 *
 *   bun eval/replay.ts <repository> [--old <ref>] [--new <ref>] [--ref <rev>]
 *     [--commits N] [--config <file> | --config-at <rev>]
 *     [--node-modules <dir>] [--out <jsonl>]
 *   bun eval/replay.ts --summary <jsonl>
 *
 * `--old` defaults to the newest `v*` tag and `--new` to this working tree;
 * each is built into a temporary worktree. The history replayed ends at
 * `--ref`, by default the repository's `origin/HEAD` (its local branch may
 * be behind). Each commit is planned with the config the repository had at
 * that commit, and a commit without one is skipped: today's config over
 * older code reports gaps its annotations have since closed. `--config`
 * plans every commit with one file instead, to try a config change, and
 * `--config-at` with the repository's config at a commit. Both builds
 * then plan with the same config, so to compare builds, `--config-at
 * origin/HEAD` replays history from before the repository adopted bivium
 * too. `--node-modules` links an install into the checkout, for a config
 * that imports a narrower's dependencies.
 *
 * The report gives, per build, the test files selected out of every suite's
 * tests, the commits with a full run by cause, and median plan time; then
 * every commit where `--new` selects a test `--old` doesn't, a miss `--old`
 * had or a regression, and every one where it drops one, a narrowing a
 * change meant or a miss; and the commits a build failed to plan.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs, usage } from "./args.ts";

const args = parseArgs(process.argv.slice(2), [
  "--old",
  "--new",
  "--commits",
  "--ref",
  "--config",
  "--config-at",
  "--node-modules",
  "--out",
  "--summary",
]);
const BIVIUM = resolve(import.meta.dir, "..");
const CONFIGS = ["ts", "mts", "mjs", "js", "json"].map(
  (ext) => `bivium.config.${ext}`,
);
// A config's `from "x"` import, which the copy outside the checkout rewrites.
const REASON_FILE = /^[^:]+: /;
const IMPORT = /(from\s*|import\s*\(\s*)(["'])([^"']+)\2/g;

interface Plan {
  ms: number;
  // Each suite's mode, or its files when some.
  suites: Record<string, "all" | "none" | string[]>;
  totals: Record<string, number>;
  causes: string[];
}

interface Row {
  sha: string;
  subject: string;
  old: Plan | { error: string };
  new: Plan | { error: string };
}

function run(cwd: string, command: string, ...rest: string[]) {
  const result = spawnSync(command, rest, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1 << 28,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function git(cwd: string, ...rest: string[]): string {
  const result = run(cwd, "git", ...rest);
  if (result.status !== 0)
    throw new Error(`git ${rest.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// A build of bivium at `ref`, or of this working tree: its CLI and index.
function build(ref: string | undefined, scratch: string) {
  let dir = BIVIUM;
  if (ref !== undefined) {
    dir = join(scratch, `bivium-${ref.replaceAll("/", "-")}`);
    git(BIVIUM, "worktree", "add", "--detach", dir, ref);
    symlinkSync(join(BIVIUM, "node_modules"), join(dir, "node_modules"));
  }
  const built = run(dir, "bun", "run", "build");
  if (built.status !== 0)
    throw new Error(`build of ${ref ?? "the working tree"} failed`);
  return {
    cli: join(dir, "dist/cli.js"),
    index: join(dir, "dist/index.js"),
    dir,
  };
}

let copies = 0;

// The config `source`, copied outside the checkout (an untracked file in it
// would be a change) with its imports made absolute: `bivium` to the
// build's index, a relative one to the file next to `source`.
function configFor(source: string, index: string, scratch: string): string {
  const text = readFileSync(source, "utf-8").replace(
    IMPORT,
    (match, lead: string, quote: string, specifier: string) => {
      if (specifier === "bivium") return `${lead}${quote}${index}${quote}`;
      if (!specifier.startsWith(".")) return match;
      const path = resolve(dirname(source), specifier);
      return `${lead}${quote}${path}${quote}`;
    },
  );
  copies++;
  const dir = join(scratch, "configs");
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `config-${copies}${source.slice(source.lastIndexOf("."))}`,
  );
  writeFileSync(file, text);
  return file;
}

function plan(
  checkout: string,
  cli: string,
  sha: string,
  config: string,
): Plan | { error: string } {
  const started = performance.now();
  const result = run(
    checkout,
    "bun",
    cli,
    "plan",
    `${sha}~1`,
    "--json",
    "--no-cache",
    "--config",
    config,
  );
  const ms = Math.round(performance.now() - started);
  try {
    const json: {
      suites: Record<
        string,
        { mode: "all" | "none" } | { mode: "some"; files: string[] }
      >;
      totals?: Record<string, number>;
      causes?: { kind: string }[];
      reasons: string[];
    } = JSON.parse(result.stdout);
    const suites: Plan["suites"] = {};
    for (const [name, selection] of Object.entries(json.suites)) {
      suites[name] =
        selection.mode === "some" ? selection.files : selection.mode;
    }
    // Before 0.3.0, plans had no causes: the reason's sentence stands in.
    const causes =
      json.causes?.map((cause) => cause.kind) ??
      json.reasons.map((reason) => reason.replace(REASON_FILE, ""));
    return { ms, suites, totals: json.totals ?? {}, causes };
  } catch {
    return { error: (result.stderr || result.stdout).slice(0, 500) };
  }
}

function replay(repository: string): string {
  const origin = resolve(repository);
  const remote = run(
    origin,
    "git",
    "rev-parse",
    "--verify",
    "--quiet",
    "origin/HEAD",
  );
  const tip = git(
    origin,
    "rev-parse",
    args.option("--ref") ?? (remote.status === 0 ? "origin/HEAD" : "HEAD"),
  );
  const at = args.option("--config-at");
  const file = args.option("--config");
  if (file !== undefined && at !== undefined) {
    throw new Error("--config and --config-at are exclusive");
  }
  if (file !== undefined && !existsSync(file)) {
    throw new Error(`--config: no file ${file}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "bivium-replay-"));
  const out = args.option("--out") ?? join(scratch, "replay.jsonl");
  const oldRef =
    args.option("--old") ??
    git(BIVIUM, "describe", "--tags", "--abbrev=0", "--match", "v*");
  const newRef = args.option("--new");
  const count = args.option("--commits") ?? "60";
  const modules = args.option("--node-modules");
  const checkout = join(scratch, "repository");
  const builds: ReturnType<typeof build>[] = [];
  let skipped = 0;
  try {
    git(scratch, "clone", "--quiet", "--shared", origin, checkout);
    // Linked dependencies mustn't show up as a change.
    appendFileSync(join(checkout, ".git/info/exclude"), "node_modules\n");
    if (modules) symlinkSync(resolve(modules), join(checkout, "node_modules"));
    let fixed = file === undefined ? undefined : resolve(file);
    if (at !== undefined) {
      // The config at `at`, in a tree of its own: the files it imports
      // stay as they were there while the checkout moves.
      const tree = join(scratch, "config-tree");
      const rev = git(origin, "rev-parse", at);
      git(checkout, "worktree", "add", "--quiet", "--detach", tree, rev);
      if (modules) symlinkSync(resolve(modules), join(tree, "node_modules"));
      fixed = CONFIGS.map((name) => join(tree, name)).find(existsSync);
      if (fixed === undefined) {
        throw new Error(`--config-at ${at}: no bivium config there`);
      }
    }
    const old = build(oldRef, scratch);
    builds.push(old);
    const next = build(newRef, scratch);
    builds.push(next);
    writeFileSync(out, "");
    const commits = git(
      checkout,
      "rev-list",
      "--first-parent",
      "-n",
      count,
      tip,
    );
    for (const sha of commits.split("\n")) {
      git(checkout, "checkout", "--quiet", "--detach", sha);
      const own = CONFIGS.map((name) => join(checkout, name)).find(existsSync);
      const source = fixed ?? own;
      if (source === undefined) {
        skipped++;
        continue;
      }
      const row: Row = {
        sha: sha.slice(0, 9),
        subject: git(checkout, "log", "-1", "--format=%s"),
        old: plan(
          checkout,
          old.cli,
          sha,
          configFor(source, old.index, scratch),
        ),
        new: plan(
          checkout,
          next.cli,
          sha,
          configFor(source, next.index, scratch),
        ),
      };
      appendFileSync(out, `${JSON.stringify(row)}\n`);
    }
  } finally {
    for (const { dir } of builds) {
      if (dir !== BIVIUM) git(BIVIUM, "worktree", "remove", "--force", dir);
    }
    rmSync(checkout, { recursive: true, force: true });
    rmSync(join(scratch, "config-tree"), { recursive: true, force: true });
    rmSync(join(scratch, "configs"), { recursive: true, force: true });
    if (args.option("--out") !== undefined) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  console.log(
    `${oldRef} → ${newRef ?? "working tree"}; ${skipped} commits without a config skipped; rows in ${out}`,
  );
  return out;
}

function isPlan(value: Plan | { error: string }): value is Plan {
  return !("error" in value);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function summarize(file: string) {
  const rows: Row[] = readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const planned = rows.flatMap((row) =>
    isPlan(row.old) && isPlan(row.new)
      ? [{ row, old: row.old, new: row.new }]
      : [],
  );
  console.log(
    `${planned.length} commits planned, ${rows.length - planned.length} with an error`,
  );
  // Test counts come from the newer build, which reports them.
  const totalsOf = (p: (typeof planned)[number]) =>
    Object.keys(p.new.totals).length > 0 ? p.new.totals : p.old.totals;
  const files = (
    chosen: Plan,
    totals: Record<string, number>,
    suite: string,
  ) => {
    const selection = chosen.suites[suite];
    if (selection === "all") return totals[suite] ?? 0;
    return selection === "none" || selection === undefined
      ? 0
      : selection.length;
  };
  for (const side of ["old", "new"] as const) {
    let selected = 0;
    let all = 0;
    const causes = new Map<string, number>();
    for (const p of planned) {
      const totals = totalsOf(p);
      for (const suite of Object.keys(totals)) {
        selected += files(p[side], totals, suite);
        all += totals[suite] ?? 0;
      }
      for (const cause of new Set(p[side].causes)) {
        causes.set(cause, (causes.get(cause) ?? 0) + 1);
      }
    }
    const full = planned.filter((p) => p[side].causes.length > 0).length;
    const share = all === 0 ? 0 : (100 * selected) / all;
    const top = [...causes].sort(([, a], [, b]) => b - a).slice(0, 5);
    console.log(
      `${side}: ${selected} of ${all} test files (${share.toFixed(1)}%), ${full} commits with a full run (${top.map(([cause, n]) => `${n} ${cause}`).join(", ")}), median plan ${median(planned.map((p) => p[side].ms))} ms`,
    );
  }
  const selects = (chosen: Plan, suite: string, test: string) => {
    const selection = chosen.suites[suite];
    return (
      selection === "all" ||
      (Array.isArray(selection) && selection.includes(test))
    );
  };
  // The tests `a` selects that `b` doesn't.
  const beyond = (
    a: Plan,
    b: Plan,
    totals: Record<string, number>,
    suite: string,
  ) => {
    const selection = a.suites[suite];
    if (Array.isArray(selection)) {
      return selection.filter((test) => !selects(b, suite, test)).length;
    }
    if (selection === "all" && b.suites[suite] !== "all") {
      return files(a, totals, suite) - files(b, totals, suite);
    }
    return 0;
  };
  // Each needs reading: a test `new` adds is a miss `old` had or a
  // regression, and one it drops is a narrowing a change meant, or a miss.
  const wider: string[] = [];
  const narrower: string[] = [];
  for (const p of planned) {
    const totals = totalsOf(p);
    let more = 0;
    let fewer = 0;
    for (const suite of Object.keys(totals)) {
      more += beyond(p.new, p.old, totals, suite);
      fewer += beyond(p.old, p.new, totals, suite);
    }
    const commit = `  ${p.row.sha} ${p.row.subject.slice(0, 60)}`;
    if (more > 0) wider.push(`${commit}: ${more} more`);
    if (fewer > 0) narrower.push(`${commit}: ${fewer} fewer`);
  }
  console.log(`new selects more tests on ${wider.length} commits:`);
  for (const line of wider) console.log(line);
  console.log(`and fewer on ${narrower.length}:`);
  for (const line of narrower) console.log(line);
  for (const row of rows) {
    for (const side of ["old", "new"] as const) {
      const result = row[side];
      if (!isPlan(result)) {
        console.log(
          `  ${row.sha} ${side} failed: ${result.error.split("\n")[0]}`,
        );
      }
    }
  }
}

const summary = args.option("--summary");
if (summary === undefined) {
  const [repository] = args.positional;
  if (repository === undefined) {
    usage(
      "replay.ts <repository> [--old <ref>] [--new <ref>] [--ref <rev>] [--commits N] [--config <file> | --config-at <rev>] [--node-modules <dir>] [--out <jsonl>] | --summary <jsonl>",
    );
  }
  summarize(replay(repository));
} else summarize(summary);
