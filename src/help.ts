import { version } from "../package.json" with { type: "json" };
import { type Paint, SEPARATOR } from "./terminal.ts";

// A status line, Usage, Commands, Options, Examples, then the agent
// section, within 80 columns. Section heads are bold and defaults gray,
// so a reader scans for the flag, not the fine print.

const row = (p: Paint, name: string, does: string, preset?: string) =>
  `  ${name.padEnd(21)}${does}${preset === undefined ? "" : p.dim(`${SEPARATOR}${preset}`)}`;

// Examples carry their intent as a comment, so a reader picks one by
// what it's for.
const example = (p: Paint, intent: string, command: string) =>
  `  ${p.dim(`# ${intent}`)}\n  ${command}`;

export function usage(p: Paint): string {
  return `${p.bold("bivium")} ${version}${p.dim(`${SEPARATOR}run only the tests your change can reach`)}

${p.bold("Usage")}
  bivium <command> [arguments] [options]

${p.bold("Commands")}
${row(p, "plan [base]", "the tests a change can affect, per suite")}
${row(p, "run [base]", "run a suite's selected tests")}
${row(p, "why <test> [file]", "the chain from a change, or a file, to a test")}
${row(p, "check", "what the graph can't read, and dead globs")}
${row(p, "graph", "each file's test fan-in, and the graph")}

  base defaults to the config's base, else the upstream default branch.
  Options go before or after the command, as --flag value or --flag=value.
  A path is repo-relative, relative to the current directory, or absolute.

${p.bold("Options")}
${row(p, "--config <file>", "the config file", "bivium.config.{ts,mts,mjs,js,json}")}
${row(p, "--cwd <dir>", "the repository", "the current directory")}
${row(p, "--no-cache", "read every file; skip the extraction cache")}
${row(p, "--json", "plan, why, check, graph: print JSON")}
${row(p, "--color, --no-color", "force color on or off", "on in a terminal")}
${row(p, "-h, --help", "this help")}
${row(p, "-v, --version", "the version")}

${p.bold("  plan")}
${row(p, "--list", "the files, as when piped, on a terminal too")}
${row(p, "--github", "also write each suite's selection to $GITHUB_OUTPUT")}
${p.bold("  run")}
${row(p, "--suite <name>", "the suite to run", "the first")}
${p.bold("  why")}
${row(p, "--base <ref>", "the base ref", "as for plan")}
${row(p, "--format <f>", "tree, chain, source or json", "tree")}
${row(p, "--all", "every change's chain, not only the shortest")}
${p.bold("  check")}
${row(p, "--base <ref>", "the base ref", "HEAD")}
${row(p, "--all", "every file, and each fix whole")}
${row(p, "--max-unknown <n>", "fail past n unknown files that reach a test")}
${p.bold("  graph")}
${row(p, "--suite <name>", "only this suite", "every suite")}
${row(p, "--top <n>", "files to list per suite", "10")}

${p.bold("Examples")}
${example(p, "the tests this branch needs, as data", "bivium plan origin/main --json")}
${example(p, "how a change to a file reaches a test", "bivium why tests/Button.test.ts src/Button.svelte --format chain")}
${example(p, "fail CI when a file bivium can't follow reaches a test", "bivium check --max-unknown 0")}

${p.bold("For agents")}
  Run with --json; read ok and summary. Exit 0 done, 1 check found
  problems, 2 a usage, config or git error; run exits with its command's.
  With --json, an error is JSON too: error.kind (usage, config, git or
  other), error.code and error.message.`;
}
