import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { version } from "../package.json" with { type: "json" };
import { check, formatReport, widening } from "./check.ts";
import { type Computed, computePlan, prepare } from "./compute.ts";
import type { ResolvedConfig } from "./config.ts";
import { formatSelection } from "./plan.ts";
import type { Selection } from "./types.ts";
import { explain, formatExplanation, isFormat } from "./why.ts";

const USAGE = `Usage:
  bivium plan [base] [--json] [--github]   print the tests a change can affect
  bivium run [base] [--suite <name>]       run a suite's selected tests
  bivium why <test> [file] [--base <ref>]  the chain from a change (or file) to a test
             [--format <f>] [--all]
  bivium check [--max-unknown <n>]         what the graph can't read, and dead globs
  bivium --version                         print the version

  base defaults to the config's base, else the upstream default branch.

Options:
  --config <file>   config file (default: bivium.config.{ts,mts,mjs,js,json})
  --cwd <dir>       repository (default: the current directory)
  --no-cache        read every file; don't read or write the extraction cache
  --suite <name>    for run: the suite (default: the first one)
  --json            for plan: print the plan as JSON, with its reasons
  --github          for plan: also write each suite's selection to
                    $GITHUB_OUTPUT as <output>=all|none|<files>
  --base <ref>      for why and check: the base ref
  --format <f>      for why: tree (default), chain (from the change to the
                    test) or source (each hop's line of source)
  --all             for why: every change's chain to the test, not only the
                    shortest
  --max-unknown <n> for check: fail when more unknown nodes than this reach
                    a test`;

const WHITESPACE = /\s+/;
const VALUED = new Set([
  "--config",
  "--cwd",
  "--suite",
  "--base",
  "--format",
  "--max-unknown",
]);
const COMMON = ["--config", "--cwd", "--no-cache"];
const FLAGS: Record<string, readonly string[]> = {
  plan: [...COMMON, "--json", "--github"],
  run: [...COMMON, "--suite"],
  why: [...COMMON, "--base", "--json", "--format", "--all"],
  check: [...COMMON, "--base", "--max-unknown", "--json"],
};
// Positional arguments each command takes at most.
const POSITIONAL: Record<string, number> = {
  plan: 1,
  run: 1,
  why: 2,
  check: 0,
};

interface Args {
  flags: Map<string, string>;
  positional: string[];
}

// An unknown flag is an error: a misspelled --github would skip the outputs
// CI reads, and a step that reads none runs nothing.
function parseArgs(command: string, argv: string[]): Args {
  const known = FLAGS[command] ?? [];
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!known.includes(arg)) {
      throw new Error(`bivium ${command}: unknown option ${arg}`);
    }
    if (!VALUED.has(arg)) {
      flags.set(arg, "");
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`bivium: ${arg} needs a value`);
    }
    flags.set(arg, value);
  }
  if (positional.length > (POSITIONAL[command] ?? 0)) {
    throw new Error(`bivium ${command}: unexpected ${positional.at(-1)}`);
  }
  return { flags, positional };
}

// Splits a `run` command and puts the files where `{files}` is, or at the end.
export function commandFor(run: string, files: string[]): string[] {
  const words = run.split(WHITESPACE).filter(Boolean);
  const at = words.indexOf("{files}");
  if (at === -1) return [...words, ...files];
  return [...words.slice(0, at), ...files, ...words.slice(at + 1)];
}

function logSelection(label: string, selection: Selection) {
  const count =
    selection.mode === "some"
      ? `${selection.files.length} files`
      : selection.mode;
  console.log(`${label}: ${count}`);
  if (selection.mode === "some") {
    for (const file of selection.files) console.log(`  ${file}`);
  }
}

function logPlan({ plan, narrowed }: Computed) {
  for (const reason of plan.reasons) console.log(`Full run: ${reason}`);
  for (const line of plan.packages) console.log(line);
  for (const { narrower, result } of narrowed) {
    if ("note" in result && result.note) {
      console.log(`${narrower.name}: ${result.note}`);
    }
  }
  for (const [name, selection] of Object.entries(plan.suites)) {
    logSelection(`${name} tests`, selection);
  }
}

function writeOutputs(config: ResolvedConfig, { plan }: Computed) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("bivium: GITHUB_OUTPUT is not set");
  const lines = config.suites.map(
    (suite) => `${suite.output}=${formatSelection(plan.suites[suite.name])}\n`,
  );
  appendFileSync(output, lines.join(""));
}

async function inspect(
  command: "why" | "check",
  { flags, positional }: Args,
): Promise<0 | 1> {
  const format = flags.get("--format") ?? "tree";
  if (!isFormat(format)) {
    throw new Error("bivium why: --format takes tree, chain or source");
  }
  const { root, base, config } = await prepare({
    cwd: flags.get("--cwd"),
    // What the graph can't read doesn't depend on the base.
    base: flags.get("--base") ?? (command === "check" ? "HEAD" : undefined),
    configFile: flags.get("--config"),
  });
  const computed = await computePlan(root, base, config, {
    ...(flags.has("--no-cache") && { cache: false }),
  });
  if (command === "check") {
    const maxFlag = flags.get("--max-unknown");
    const max = maxFlag === undefined ? undefined : Number(maxFlag);
    if (max !== undefined && !Number.isInteger(max)) {
      throw new Error("bivium check: --max-unknown takes a whole number");
    }
    const report = await check(root, config, computed);
    console.log(
      flags.has("--json")
        ? JSON.stringify(report, null, 2)
        : formatReport(report, max),
    );
    const failed =
      (max !== undefined && widening(report).length > max) ||
      report.deadGlobs.length > 0 ||
      report.staleDeadGlobs.length > 0;
    return failed ? 1 : 0;
  }
  const [test, file] = positional;
  if (test === undefined) throw new Error("bivium why: which test?");
  const explanation = await explain(root, config, computed, test, file, {
    all: flags.has("--all"),
  });
  console.log(
    flags.has("--json")
      ? JSON.stringify(explanation, null, 2)
      : formatExplanation(explanation, format),
  );
  return 0;
}

async function runCommand(
  command: string,
  { flags, positional }: Args,
): Promise<number> {
  const { root, base, config } = await prepare({
    cwd: flags.get("--cwd"),
    base: positional[0],
    configFile: flags.get("--config"),
  });
  const suiteName = flags.get("--suite");
  const suite =
    suiteName === undefined
      ? config.suites[0]
      : config.suites.find((candidate) => candidate.name === suiteName);
  if (!suite) {
    console.error(`bivium: no suite "${suiteName}"`);
    return 1;
  }
  const computed = await computePlan(root, base, config, {
    ...(flags.has("--no-cache") && { cache: false }),
    // Running one suite needs no narrower that narrows only others.
    ...(command === "run" && { suites: [suite.name] }),
    mergeBase: command === "plan" && flags.has("--json"),
  });

  if (command === "plan") {
    if (flags.has("--json")) {
      const { suites, reasons, packages } = computed.plan;
      const narrowed = computed.narrowed.map((ran) => ({
        name: ran.narrower.name,
        result: ran.result,
      }));
      console.log(
        JSON.stringify(
          {
            base,
            mergeBase: await computed.mergeBase(),
            changed: computed.changed,
            suites,
            reasons,
            packages,
            narrowed,
          },
          null,
          2,
        ),
      );
    } else {
      logPlan(computed);
    }
    if (flags.has("--github")) writeOutputs(config, computed);
    return 0;
  }

  logPlan(computed);
  if (!suite.run) {
    console.error(`bivium: suite "${suite.name}" has no run command`);
    return 1;
  }
  const selection = computed.plan.suites[suite.name];
  if (selection.mode === "none") {
    console.log(`No ${suite.name} tests affected against ${base}; skipping.`);
    return 0;
  }
  const [program, ...args] = commandFor(
    suite.run,
    selection.mode === "some" ? selection.files : [],
  );
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit" });
  return result.status ?? 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    console.log(version);
    return 0;
  }
  if (!command || command === "help" || rest.includes("--help")) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (!(command in FLAGS)) {
    console.error(`bivium: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  try {
    const args = parseArgs(command, rest);
    if (command === "why" || command === "check")
      return await inspect(command, args);
    return await runCommand(command, args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
