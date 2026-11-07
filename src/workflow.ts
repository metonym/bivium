import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp } from "./glob.ts";
import { parseYaml, type Yaml } from "./yaml.ts";

// A path filter in a GitHub Actions workflow that decides whether tests
// run: a trigger's `paths` or `paths-ignore`, which gates the whole
// workflow, or a `dorny/paths-filter` filter named after a suite, which
// gates that suite's job.
interface PathFilter {
  workflow: string;
  // Where in the workflow: `on.pull_request.paths`.
  where: string;
  // The suite it gates, or `undefined` for every suite.
  suite?: string;
  // How to let a change to `file` alone through, or `undefined` if it
  // passes.
  blocks: (file: string) => string | undefined;
}

export interface Workflows {
  filters: PathFilter[];
  unreadable: { file: string; reason: string }[];
}

interface Pattern {
  text: string;
  negated: boolean;
  re: RegExp;
}

const EVENTS = ["pull_request", "pull_request_target", "push"];
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const PATHS_FILTER = /^dorny\/paths-filter@/;
const FLOW_ITEM = /^(['"])(.*)\1$/;

function literal(char: string): string {
  return char.replace(REGEX_SPECIAL, "\\$&");
}

// GitHub's filter patterns: `*` within a segment, `**` across them, `?`
// and `+` repeat the character before them, `[…]` a class, `\` escapes.
function githubGlob(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "\\") source += literal(pattern[++i] ?? "");
    else if (char === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?" || char === "+") source += char;
    else if (char === "[" && pattern.indexOf("]", i + 1) !== -1) {
      const end = pattern.indexOf("]", i + 1);
      source += pattern.slice(i, end + 1);
      i = end;
    } else source += literal(char);
  }
  return new RegExp(`^${source}$`);
}

function patternsOf(texts: string[], compile: (glob: string) => RegExp) {
  return texts.map((text): Pattern => {
    const negated = text.startsWith("!");
    return { text, negated, re: compile(negated ? text.slice(1) : text) };
  });
}

function isMapping(value: Yaml | undefined): value is Record<string, Yaml> {
  return typeof value === "object" && !Array.isArray(value);
}

// A list of strings, in block or flow (`[a, "b"]`) form.
function strings(value: Yaml | undefined, where: string): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string") throw new Error(`${where}: not a string`);
      return item;
    });
  }
  if (typeof value === "string" && value.startsWith("[")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map((item) => FLOW_ITEM.exec(item)?.[2] ?? item);
  }
  if (typeof value === "string") return [value];
  throw new Error(`${where}: not a list`);
}

// The last pattern matching `file` decides, as GitHub reads `paths`.
function lastMatch(patterns: Pattern[], file: string): Pattern | undefined {
  return patterns.findLast((pattern) => pattern.re.test(file));
}

function triggerFilters(workflow: string, on: Yaml | undefined): PathFilter[] {
  // `on: push` or `on: [push, pull_request]` runs on every path.
  if (!isMapping(on)) return [];
  const filters: PathFilter[] = [];
  for (const event of EVENTS) {
    const trigger = on[event];
    if (!isMapping(trigger)) continue;
    const paths = trigger.paths;
    const ignore = trigger["paths-ignore"];
    if (paths !== undefined) {
      const where = `on.${event}.paths`;
      const patterns = patternsOf(strings(paths, where), githubGlob);
      filters.push({
        workflow,
        where,
        blocks: (file) => {
          const last = lastMatch(patterns, file);
          if (last && !last.negated) return;
          const after = last ? `, after "${last.text}"` : "";
          return `add "${file}" to ${where}${after}`;
        },
      });
    } else if (ignore !== undefined) {
      const where = `on.${event}.paths-ignore`;
      const patterns = patternsOf(strings(ignore, where), githubGlob);
      filters.push({
        workflow,
        where,
        blocks: (file) => {
          const last = lastMatch(patterns, file);
          if (!last || last.negated) return;
          return `"${last.text}" in ${where} skips it: narrow it, or use \`paths\` with "!${last.text}" and then "${file}"`;
        },
      });
    }
  }
  return filters;
}

// A filter's patterns: strings, lists of them, and the patterns a
// `{ "added|modified": … }` entry applies to a modified file.
function filterPatterns(value: Yaml): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap(filterPatterns);
  }
  return Object.entries(value).flatMap(([changes, item]) =>
    changes.split("|").includes("modified") ? filterPatterns(item) : [],
  );
}

function pathsFilters(
  root: string,
  workflow: string,
  jobs: Yaml | undefined,
  suites: readonly string[],
): PathFilter[] {
  if (!isMapping(jobs)) return [];
  const filters: PathFilter[] = [];
  for (const [job, body] of Object.entries(jobs)) {
    const steps = isMapping(body) ? body.steps : undefined;
    if (!Array.isArray(steps)) continue;
    for (const [i, step] of steps.entries()) {
      if (!isMapping(step)) continue;
      const uses = step.uses;
      if (typeof uses !== "string" || !PATHS_FILTER.test(uses)) continue;
      const options = isMapping(step.with) ? step.with : {};
      const at = `jobs.${job}.steps[${i}]`;
      const spec = options.filters;
      if (typeof spec !== "string") throw new Error(`${at}: no filters`);
      // Inline YAML, or the path of a file of it.
      const text =
        spec.includes("\n") || spec.includes(":")
          ? spec
          : readFileSync(join(root, spec), "utf-8");
      const parsed = parseYaml(text);
      if (!isMapping(parsed)) throw new Error(`${at}: filters isn't a map`);
      const every = options["predicate-quantifier"] === "every";
      for (const [name, value] of Object.entries(parsed)) {
        if (!suites.includes(name)) continue;
        const where = `${at} filter "${name}"`;
        const patterns = patternsOf(filterPatterns(value), globToRegExp);
        const passes = (pattern: Pattern, file: string) =>
          pattern.re.test(file) !== pattern.negated;
        filters.push({
          workflow,
          where,
          suite: name,
          blocks: (file) => {
            if (every) {
              const failing = patterns.find((p) => !passes(p, file));
              return failing && `its "${failing.text}" doesn't match it`;
            }
            if (patterns.some((p) => passes(p, file))) return;
            return `add "${file}" to it`;
          },
        });
      }
    }
  }
  return filters;
}

// The path filters of each workflow `check` is given: its triggers', and
// its `dorny/paths-filter` filters named after a suite.
export function readWorkflows(
  root: string,
  files: readonly string[],
  suites: readonly string[],
): Workflows {
  const result: Workflows = { filters: [], unreadable: [] };
  for (const file of files) {
    try {
      const workflow = parseYaml(readFileSync(join(root, file), "utf-8"));
      if (!isMapping(workflow)) throw new Error("not a workflow");
      result.filters.push(
        ...triggerFilters(file, workflow.on),
        ...pathsFilters(root, file, workflow.jobs, suites),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.unreadable.push({ file, reason });
    }
  }
  return result;
}
