import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { globToRegExp, type Matcher, matcher } from "./glob.ts";
import type {
  Config,
  Globs,
  NarrowContext,
  Narrower,
  NarrowResult,
  SuiteConfig,
} from "./types.ts";

/** Types a config. Returns it unchanged. */
export function defineConfig<Suite extends string>(
  config: Config<Suite>,
): Config<Suite> {
  return config;
}

interface UrlPattern {
  key: string;
  target: string;
}

export interface ResolvedSuite {
  name: string;
  isTest: Matcher;
  run?: string;
  roots: string[];
  urls: UrlPattern[];
  isPage: Matcher;
  isWiring: Matcher;
  isNonInput: Matcher;
  output: string;
}

export interface ResolvedNarrower {
  name: string;
  match: Matcher;
  opaque: Matcher;
  suites: string[];
  narrow: (context: NarrowContext) => Promise<NarrowResult>;
}

type DeadGlobEntry = NonNullable<Config["deadGlobs"]>[number];

export interface ResolvedConfig {
  suites: ResolvedSuite[];
  narrowers: ResolvedNarrower[];
  roots: string[];
  isIgnored: Matcher;
  // Longest prefix first.
  alias: [string, string][];
  generated: { pattern: RegExp; inputs: RegExp[] }[];
  isSelf: Matcher;
  isImportOnly: Matcher;
  isBarrel: Matcher;
  external: Set<string>;
  extensions: readonly string[];
  deadGlobs: readonly DeadGlobEntry[];
  base?: string;
  cache?: boolean | string;
}

const DEFAULT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
  ".svelte",
  ".vue",
  ".json",
];

function list(value: Globs | undefined, fallback: readonly string[]) {
  if (value === undefined) return [...fallback];
  return typeof value === "string" ? [value] : [...value];
}

const LEADING_DOT_SLASH = /^\.\//;
const TRAILING_SLASHES = /\/+$/;

// `src/` and `./src` both mean `src`; `.` and `./` mean the whole repo.
function normalizeRoot(root: string) {
  return (
    root.replace(LEADING_DOT_SLASH, "").replace(TRAILING_SLASHES, "") || "."
  );
}

export function resolveConfig(config: Config): ResolvedConfig {
  const names = Object.keys(config.suites);
  if (names.length === 0) throw new Error("bivium config: no suites");
  const suites = Object.entries(config.suites).map(
    ([name, suite]): ResolvedSuite => ({
      name,
      isTest: matcher(suite.tests),
      run: suite.run,
      roots: list(suite.root, ["."]).map(normalizeRoot),
      urls: Object.entries(suite.urls ?? {}).map(([key, target]) => ({
        key,
        target,
      })),
      isPage: matcher(suite.pages),
      isWiring: matcher(suite.wiring),
      isNonInput: matcher(suite.nonInputs),
      output: suite.output ?? `${name}-tests`,
    }),
  );
  const narrowers = (config.narrowers ?? []).map(
    (narrower): ResolvedNarrower => {
      const unknown = narrower.suites?.find((name) => !names.includes(name));
      if (unknown !== undefined) {
        throw new Error(
          `bivium config: narrower ${narrower.name} names no suite ${unknown}`,
        );
      }
      return {
        name: narrower.name,
        match: matcher(narrower.match),
        opaque: matcher(narrower.opaque),
        suites: [...(narrower.suites ?? names)],
        narrow: async (context) => checkResult(await narrower.narrow(context)),
      };
    },
  );
  return {
    suites,
    narrowers,
    roots: list(config.roots, ["."]).map(normalizeRoot),
    isIgnored: matcher(config.ignore),
    alias: Object.entries(config.alias ?? {})
      .map(([key, path]): [string, string] => [key, normalizeRoot(path)])
      .sort(([a], [b]) => b.length - a.length),
    generated: Object.entries(config.edges ?? {}).map(([glob, inputs]) => ({
      pattern: globToRegExp(glob),
      inputs: list(inputs, []).map(globToRegExp),
    })),
    isSelf: matcher(config.self),
    isImportOnly: matcher(config.importOnly),
    isBarrel: config.barrels ? matcher(config.barrels) : () => true,
    external: new Set(config.external),
    extensions: config.extensions ?? DEFAULT_EXTENSIONS,
    deadGlobs: config.deadGlobs ?? [],
    base: config.base,
    cache: config.cache,
  };
}

export function inRoot(file: string, root: string): boolean {
  return root === "." || file === root || file.startsWith(`${root}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isGlobs(value: unknown): value is Globs {
  return typeof value === "string" || isStrings(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isGlobsRecord(value: unknown): value is Record<string, Globs> {
  return isRecord(value) && Object.values(value).every(isGlobs);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isCache(value: unknown): value is boolean | string {
  return typeof value === "boolean" || typeof value === "string";
}

function field<T>(
  record: Record<string, unknown>,
  key: string,
  is: (value: unknown) => value is T,
  path: string,
  expected: string,
): T | undefined {
  const value = record[key];
  if (value === undefined || is(value)) return value;
  throw new Error(`bivium config: ${path}${key} must be ${expected}`);
}

const SUITE_KEYS = new Set([
  "tests",
  "run",
  "root",
  "urls",
  "pages",
  "wiring",
  "nonInputs",
  "output",
]);
const NARROWER_KEYS = new Set(["name", "match", "opaque", "suites", "narrow"]);
const DEAD_GLOB_KEYS = new Set(["file", "glob", "reason"]);
const CONFIG_KEYS = new Set([
  "suites",
  "narrowers",
  "roots",
  "ignore",
  "alias",
  "edges",
  "self",
  "importOnly",
  "barrels",
  "external",
  "extensions",
  "deadGlobs",
  "base",
  "cache",
]);

// A misspelled key would silently select less, so it's an error.
function checkKeys(
  record: Record<string, unknown>,
  known: Set<string>,
  path: string,
) {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new Error(`bivium config: unknown key ${path}${key}`);
    }
  }
}

function checkSuite(name: string, value: unknown): SuiteConfig {
  if (!isRecord(value)) {
    throw new Error(`bivium config: suites.${name} must be an object`);
  }
  const at = `suites.${name}.`;
  checkKeys(value, SUITE_KEYS, at);
  const tests = field(value, "tests", isGlobs, at, "a glob or a list of globs");
  if (tests === undefined || tests.length === 0) {
    throw new Error(`bivium config: suite ${name} has no tests`);
  }
  const globs = "a glob or a list of globs";
  return {
    tests,
    run: field(value, "run", isString, at, "a command"),
    root: field(value, "root", isGlobs, at, "a path or a list of paths"),
    urls: field(value, "urls", isStringRecord, at, "a map of URL patterns"),
    pages: field(value, "pages", isGlobs, at, globs),
    wiring: field(value, "wiring", isGlobs, at, globs),
    nonInputs: field(value, "nonInputs", isGlobs, at, globs),
    output: field(value, "output", isString, at, "an output name"),
  };
}

function isResult(value: unknown): value is NarrowResult {
  if (!isRecord(value)) return false;
  if ("all" in value) return typeof value.all === "string";
  return (
    "seeds" in value &&
    isStrings(value.seeds) &&
    (!("note" in value) || typeof value.note === "string")
  );
}

// A narrower is code from the config: what it returns is checked too.
function checkResult(value: unknown): NarrowResult {
  if (isResult(value)) return value;
  throw new Error("returned neither { seeds: string[] } nor { all: string }");
}

function checkNarrower(value: unknown, at: string): Narrower {
  if (!isRecord(value)) {
    throw new Error(`bivium config: ${at} must be an object`);
  }
  checkKeys(value, NARROWER_KEYS, `${at}.`);
  const name = field(value, "name", isString, `${at}.`, "a string");
  const match = field(value, "match", isGlobs, `${at}.`, "globs");
  const opaque = field(value, "opaque", isGlobs, `${at}.`, "globs");
  const suites = field(value, "suites", isStrings, `${at}.`, "suite names");
  const { narrow } = value;
  if (name === undefined || match === undefined || opaque === undefined) {
    throw new Error(`bivium config: ${at} needs a name, match and opaque`);
  }
  if (typeof narrow !== "function") {
    throw new Error(`bivium config: ${at}.narrow must be a function`);
  }
  return {
    name,
    match,
    opaque,
    suites,
    narrow: async (context) => {
      const result: unknown = await Reflect.apply(narrow, value, [context]);
      return checkResult(result);
    },
  };
}

// A reason is required: an entry without one is a dead glob nobody looked at.
function checkDeadGlob(value: unknown, at: string): DeadGlobEntry {
  if (!isRecord(value)) {
    throw new Error(`bivium config: ${at} must be an object`);
  }
  checkKeys(value, DEAD_GLOB_KEYS, `${at}.`);
  const file = field(value, "file", isString, `${at}.`, "a path");
  const glob = field(value, "glob", isString, `${at}.`, "a glob");
  const reason = field(value, "reason", isString, `${at}.`, "a string");
  if (!(file && glob && reason)) {
    throw new Error(`bivium config: ${at} needs a file, glob and reason`);
  }
  return { file, glob, reason };
}

// Checks a config read from a file, which nothing has type-checked.
export function checkConfig(value: unknown): Config {
  if (!isRecord(value)) throw new Error("bivium config: not an object");
  if (!isRecord(value.suites)) {
    throw new Error("bivium config: suites must be an object");
  }
  checkKeys(value, CONFIG_KEYS, "");
  const { narrowers, deadGlobs } = value;
  if (narrowers !== undefined && !Array.isArray(narrowers)) {
    throw new Error("bivium config: narrowers must be a list");
  }
  if (deadGlobs !== undefined && !Array.isArray(deadGlobs)) {
    throw new Error("bivium config: deadGlobs must be a list");
  }
  const suites: Record<string, SuiteConfig> = {};
  for (const [name, suite] of Object.entries(value.suites)) {
    suites[name] = checkSuite(name, suite);
  }
  const globs = "a glob or a list of globs";
  return {
    suites,
    narrowers: narrowers?.map((narrower, i) =>
      checkNarrower(narrower, `narrowers[${i}]`),
    ),
    roots: field(value, "roots", isGlobs, "", "a path or a list of paths"),
    ignore: field(value, "ignore", isGlobs, "", globs),
    alias: field(value, "alias", isStringRecord, "", "a map of paths"),
    edges: field(value, "edges", isGlobsRecord, "", "a map of globs"),
    self: field(value, "self", isGlobs, "", globs),
    importOnly: field(value, "importOnly", isGlobs, "", globs),
    barrels: field(value, "barrels", isGlobs, "", globs),
    external: field(value, "external", isStrings, "", "a list of packages"),
    extensions: field(value, "extensions", isStrings, "", "a list"),
    deadGlobs: deadGlobs?.map((entry: unknown, i) =>
      checkDeadGlob(entry, `deadGlobs[${i}]`),
    ),
    base: field(value, "base", isString, "", "a ref"),
    cache: field(value, "cache", isCache, "", "a directory or a boolean"),
  };
}

const CONFIG_FILES = [
  "bivium.config.ts",
  "bivium.config.mts",
  "bivium.config.mjs",
  "bivium.config.js",
  "bivium.config.json",
];

export interface LoadedConfig {
  config: ResolvedConfig;
  // Repo-relative when it's inside the repo, as changed files are.
  file: string;
}

async function readConfig(file: string): Promise<unknown> {
  if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf-8"));
  const module: unknown = await import(pathToFileURL(file).href);
  return isRecord(module) ? module.default : undefined;
}

// A `.ts` config loads natively on Bun and on Node ≥ 22.18 (type stripping).
export async function loadConfig(
  root: string,
  path?: string,
): Promise<LoadedConfig> {
  const file =
    path === undefined
      ? CONFIG_FILES.map((name) => join(root, name)).find((f) => existsSync(f))
      : resolve(process.cwd(), path);
  if (!file || !existsSync(file)) {
    throw new Error(
      `bivium: no config found${path ? ` at ${path}` : ` in ${root}`}`,
    );
  }
  const inside = relative(root, file);
  return {
    config: resolveConfig(checkConfig(await readConfig(file))),
    file: inside.startsWith("..") || isAbsolute(inside) ? file : inside,
  };
}
