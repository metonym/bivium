import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { version } from "../package.json" with { type: "json" };
import { check, failed, formatReport, summarize } from "./check.ts";
import { type Computed, computePlan, prepare } from "./compute.ts";
import type { ResolvedConfig } from "./config.ts";
import { BiviumError, didYouMean, type ErrorKind } from "./errors.ts";
import { formatGraph, graphReport } from "./fanin.ts";
import { formatSelection } from "./plan.ts";
import type { Selection } from "./types.ts";
import { explain, formatExplanation, isFormat } from "./why.ts";

const USAGE = `Usage:
  bivium plan [base] [--json] [--github]   print the tests a change can affect
  bivium run [base] [--suite <name>]       run a suite's selected tests
  bivium why <test> [file] [--base <ref>]  the chain from a change (or file) to a test
             [--format <f>] [--all] [--json]
  bivium check [--max-unknown <n>] [--json]
                                           what the graph can't read, and dead globs
  bivium graph [--suite <name>] [--top <n>] [--json]
                                           each file's test fan-in, and the graph
  bivium --version                         print the version
  bivium --help                            print this

  base defaults to the config's base, else the upstream default branch.
  Options go before or after the command, as --flag value or --flag=value.
  Paths may be repo-relative, relative to the current directory, or
  absolute.

Options:
  --config <file>   config file (default: bivium.config.{ts,mts,mjs,js,json})
  --cwd <dir>       repository (default: the current directory)
  --no-cache        read every file; don't read or write the extraction cache
  --suite <name>    for run: the suite (default: the first one); for graph:
                    only this suite (default: every one)
  --json            for plan, why, check and graph: print JSON
  --github          for plan: also write each suite's selection to
                    $GITHUB_OUTPUT as <output>=all|none|<files>
  --base <ref>      for why and check: the base ref
  --format <f>      for why: tree (default), chain (from the change to the
                    test), source (each hop's line of source) or json
  --all             for why: every change's chain to the test, not only the
                    shortest
  --max-unknown <n> for check: fail when more unknown nodes than this reach
                    a test
  --top <n>         for graph: how many files to list per suite (default: 10)

Exit status: 0 done; 1 check found problems; 2 a usage, configuration or
git error. run exits with its command's status. With --json, an error is
also printed to stdout as { "schemaVersion", "error": { "kind", "message" } },
kind one of usage, config, git or other.

Examples:
  bivium plan origin/main --json
  bivium why tests/Button.test.ts src/Button.svelte --format chain
  bivium check --json`;

const WHITESPACE = /\s+/;
const VALUED = new Set([
  "--config",
  "--cwd",
  "--suite",
  "--base",
  "--format",
  "--max-unknown",
  "--top",
]);
const COMMON = ["--config", "--cwd", "--no-cache"];
const FLAGS: Record<string, readonly string[]> = {
  plan: [...COMMON, "--json", "--github"],
  run: [...COMMON, "--suite"],
  why: [...COMMON, "--base", "--json", "--format", "--all"],
  check: [...COMMON, "--base", "--max-unknown", "--json"],
  graph: [...COMMON, "--suite", "--top", "--json"],
};
const POSITIONAL: Record<string, number> = {
  plan: 1,
  run: 1,
  why: 2,
  check: 0,
  graph: 0,
};

interface Args {
  flags: Map<string, string>;
  positional: string[];
}

// The JSON outputs' shape. A change that drops or retypes a field bumps it.
const SCHEMA_VERSION = 1;

function usageError(message: string): BiviumError {
  return new BiviumError("usage", message);
}

// An unknown flag is an error: a misspelled --github would skip the outputs
// CI reads, and a step that reads none runs nothing.
function unknownOption(command: string, flag: string): BiviumError {
  const known = FLAGS[command] ?? [];
  const others = Object.keys(FLAGS).filter(
    (other) => other !== command && FLAGS[other].includes(flag),
  );
  const hint =
    others.length > 0
      ? ` (${others.join(" and ")} ${others.length === 1 ? "takes" : "take"} it)`
      : didYouMean(flag, known);
  return usageError(`bivium ${command}: unknown option ${flag}${hint}`);
}

function parseArgs(command: string, argv: string[]): Args {
  const known = FLAGS[command] ?? [];
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // A lone "-" is a value (stdin, by convention), never an option.
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    // A single-dash option other than -h and -v (handled before this) is
    // unknown, not a base ref.
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (!known.includes(flag)) throw unknownOption(command, flag);
    if (!VALUED.has(flag)) {
      if (equals !== -1) {
        throw usageError(`bivium ${command}: ${flag} takes no value`);
      }
      flags.set(flag, "");
      continue;
    }
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw usageError(`bivium: ${flag} needs a value`);
    }
    flags.set(flag, value);
  }
  if (positional.length > (POSITIONAL[command] ?? 0)) {
    throw usageError(`bivium ${command}: unexpected ${positional.at(-1)}`);
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

// The selection with its scale, and a full run told apart from every test
// being reached.
function logSelection(
  label: string,
  selection: Selection,
  total: number,
  forced: boolean,
) {
  const files = total === 1 ? "file" : "files";
  let count: string;
  if (selection.mode === "some") {
    count = `${selection.files.length} of ${total} ${files}`;
  } else if (selection.mode === "none") count = "none";
  else if (forced) count = "all (full run)";
  else count = `all ${total} ${files} (each reaches a change)`;
  console.log(`${label}: ${count}`);
  if (selection.mode === "some") {
    for (const file of selection.files) console.log(`  ${file}`);
  }
}

// What the plan was made against, which `--json` gives as fields.
async function logContext(
  base: string,
  config: ResolvedConfig,
  computed: Computed,
) {
  const mergeBase = (await computed.mergeBase()).slice(0, 7);
  const count = computed.changed.length;
  const changed = `${count} changed ${count === 1 ? "file" : "files"}`;
  const file = config.file ? `, config ${config.file}` : "";
  console.log(`Against ${base} (merge base ${mergeBase}): ${changed}${file}`);
}

function logPlan({ plan, narrowed }: Computed) {
  for (const reason of plan.reasons) console.log(`Full run: ${reason}`);
  for (const line of plan.packages) console.log(line);
  for (const line of plan.settings) console.log(line);
  for (const { narrower, result } of narrowed) {
    if ("note" in result && result.note) {
      console.log(`${narrower.name}: ${result.note}`);
    }
  }
  for (const [name, selection] of Object.entries(plan.suites)) {
    const total = plan.totals[name] ?? 0;
    logSelection(`${name} tests`, selection, total, plan.full.includes(name));
  }
}

function githubOutput(): string {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    throw usageError(
      "bivium plan: --github writes to $GITHUB_OUTPUT, which is not set (it is in a GitHub Actions step)",
    );
  }
  return output;
}

function writeOutputs(
  output: string,
  config: ResolvedConfig,
  { plan }: Computed,
) {
  const lines = config.suites.map(
    (suite) => `${suite.output}=${formatSelection(plan.suites[suite.name])}\n`,
  );
  appendFileSync(output, lines.join(""));
}

function json(value: object): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...value }, null, 2);
}

function findSuite(config: ResolvedConfig, name: string | undefined) {
  if (name === undefined) return;
  const suite = config.suites.find((candidate) => candidate.name === name);
  if (suite) return suite;
  const names = config.suites.map((candidate) => candidate.name);
  throw usageError(
    `bivium: no suite "${name}"${didYouMean(name, names)}; the config has ${names.join(", ")}`,
  );
}

// A path as the repository names it. One given relative to the current
// directory (./x, ../x, or from a subdirectory) or absolute is mapped onto
// the root, so a path a shell completed names the same file; a bare path
// that's in the graph as written stays repo-relative, as it always was.
function repoPath(root: string, arg: string, known: (path: string) => boolean) {
  const fromCwd = relative(root, resolve(arg)).split("\\").join("/");
  const inside = !(fromCwd.startsWith("..") || isAbsolute(fromCwd));
  if (isAbsolute(arg)) return inside ? fromCwd : arg;
  const asWritten = posix.normalize(arg.split("\\").join("/"));
  if (known(asWritten)) return asWritten;
  return inside && known(fromCwd) ? fromCwd : asWritten;
}

async function inspect(
  command: "why" | "check",
  { flags, positional }: Args,
): Promise<0 | 1> {
  const format = flags.get("--format") ?? "tree";
  if (format !== "json" && !isFormat(format)) {
    throw usageError(
      `bivium why: --format takes tree, chain, source or json${didYouMean(format, ["tree", "chain", "source", "json"])}`,
    );
  }
  const maxFlag = flags.get("--max-unknown");
  const max = maxFlag === undefined ? undefined : Number(maxFlag);
  if (max !== undefined && !Number.isInteger(max)) {
    throw usageError("bivium check: --max-unknown takes a whole number");
  }
  const [testArg, fileArg] = positional;
  if (command === "why" && testArg === undefined) {
    throw usageError("bivium why: which test? bivium why <test> [file]");
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
    const report = await check(root, config, computed);
    const ok = !failed(report, max);
    console.log(
      flags.has("--json")
        ? json({ ok, summary: summarize(report), ...report })
        : formatReport(report, max),
    );
    return ok ? 0 : 1;
  }
  const inGraph = (path: string) => computed.graph.has(path);
  const isTest = (path: string) =>
    config.suites.some((suite) => suite.isTest(path));
  const test = repoPath(
    root,
    testArg ?? "",
    (path) => inGraph(path) && isTest(path),
  );
  const file =
    fileArg === undefined ? undefined : repoPath(root, fileArg, inGraph);
  if (!isTest(test) || !inGraph(test)) {
    const tests = [...computed.graph.keys()].filter(isTest);
    throw usageError(
      inGraph(test)
        ? `bivium why: ${test} is no suite's test: name a test first, as in bivium why <test> ${test}`
        : `bivium why: no test ${test}${didYouMean(test, tests)}`,
    );
  }
  if (file !== undefined && !inGraph(file)) {
    throw usageError(
      `bivium why: no file ${file}${didYouMean(file, computed.graph.keys())}`,
    );
  }
  const explanation = await explain(root, config, computed, test, file, {
    all: flags.has("--all"),
  });
  console.log(
    flags.has("--json") || format === "json"
      ? json(explanation)
      : formatExplanation(explanation, format),
  );
  return 0;
}

async function graphCommand({ flags }: Args): Promise<number> {
  const top = Number(flags.get("--top") ?? "10");
  if (!Number.isInteger(top) || top < 0) {
    throw usageError("bivium graph: --top takes a whole number");
  }
  const { root, base, config } = await prepare({
    cwd: flags.get("--cwd"),
    // The graph doesn't depend on the base.
    base: "HEAD",
    configFile: flags.get("--config"),
  });
  const one = findSuite(config, flags.get("--suite"));
  const suites = one ? [one] : config.suites;
  const { graph } = await computePlan(root, base, config, {
    ...(flags.has("--no-cache") && { cache: false }),
  });
  const report = graphReport(graph, suites);
  console.log(flags.has("--json") ? json(report) : formatGraph(report, top));
  return 0;
}

async function runCommand(
  command: string,
  { flags, positional }: Args,
): Promise<number> {
  // Checked before planning, so a failed step prints no plan.
  const output = flags.has("--github") ? githubOutput() : undefined;
  const { root, base, config } = await prepare({
    cwd: flags.get("--cwd"),
    base: positional[0],
    configFile: flags.get("--config"),
  });
  const suite = findSuite(config, flags.get("--suite")) ?? config.suites[0];
  if (command === "run" && !suite.run) {
    throw usageError(
      `bivium run: suite "${suite.name}" has no run command: add suites.${suite.name}.run to the config`,
    );
  }
  const computed = await computePlan(root, base, config, {
    ...(flags.has("--no-cache") && { cache: false }),
    // Running one suite needs no narrower that narrows only others.
    ...(command === "run" && { suites: [suite.name] }),
    mergeBase: true,
  });

  if (command === "plan") {
    if (flags.has("--json")) {
      const { suites, reasons, causes, totals, packages } = computed.plan;
      const narrowed = computed.narrowed.map((ran) => ({
        name: ran.narrower.name,
        result: ran.result,
      }));
      console.log(
        json({
          base,
          mergeBase: await computed.mergeBase(),
          config: config.file,
          changed: computed.changed,
          suites,
          reasons,
          causes,
          totals,
          packages,
          narrowed,
        }),
      );
    } else {
      await logContext(base, config, computed);
      logPlan(computed);
    }
    if (output !== undefined) writeOutputs(output, config, computed);
    return 0;
  }

  await logContext(base, config, computed);
  logPlan(computed);
  const selection = computed.plan.suites[suite.name];
  if (selection.mode === "none") {
    console.log(`No ${suite.name} tests affected against ${base}; skipping.`);
    return 0;
  }
  const [program, ...args] = commandFor(
    suite.run ?? "",
    selection.mode === "some" ? selection.files : [],
  );
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit" });
  return result.status ?? 1;
}

// The command: the first argument that's neither an option nor an
// option's value, so options can come before it.
function commandAt(argv: string[]) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) return i;
    if (VALUED.has(arg)) i++;
  }
  return -1;
}

const COMMANDS = Object.keys(FLAGS);

// Whether the caller asked for JSON, so an error is printed as JSON too.
function wantsJson(argv: string[]) {
  return argv.some(
    (arg, i) =>
      arg === "--json" ||
      arg === "--format=json" ||
      (arg === "--format" && argv[i + 1] === "json"),
  );
}

function fail(argv: string[], kind: ErrorKind, message: string): 2 {
  console.error(message);
  if (wantsJson(argv)) console.log(json({ error: { kind, message } }));
  return 2;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(version);
    return 0;
  }
  const at = commandAt(argv);
  const command = at === -1 ? undefined : argv[at];
  if (command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (command === undefined) {
    return fail(
      argv,
      "usage",
      `bivium: which command? ${COMMANDS.join(", ")} (bivium --help for usage)`,
    );
  }
  if (!(command in FLAGS)) {
    return fail(
      argv,
      "usage",
      `bivium: unknown command "${command}"${didYouMean(command, COMMANDS)}; the commands are ${COMMANDS.join(", ")} (bivium --help for usage)`,
    );
  }
  const rest = [...argv.slice(0, at), ...argv.slice(at + 1)];
  try {
    const args = parseArgs(command, rest);
    if (command === "why" || command === "check")
      return await inspect(command, args);
    if (command === "graph") return await graphCommand(args);
    return await runCommand(command, args);
  } catch (error) {
    if (error instanceof BiviumError) {
      return fail(argv, error.kind, error.message);
    }
    // Anything else is a bug or an environment problem bivium didn't name.
    const message = error instanceof Error ? error.message : String(error);
    return fail(argv, "other", message);
  }
}
