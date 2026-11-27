import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { BiviumError, type BiviumErrorCode, didYouMean } from "./errors.ts";
import {
  captureGlob,
  captureReferences,
  expandGlob,
  globToRegExp,
  type Matcher,
  matcher,
} from "./glob.ts";
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
  targets: string[];
}

export interface ResolvedSuite {
  name: string;
  isTest: Matcher;
  run?: string;
  runAll?: string;
  roots: string[];
  urls: UrlPattern[];
  isPage: Matcher;
  isWiring: Matcher;
  // Setup files, and the globs as written, which `check` reports.
  isSetup: Matcher;
  setup: string[];
  isNonInput: Matcher;
  output: string;
  // Whether a type-only edge can select its tests.
  types: boolean;
}

export interface ResolvedNarrower {
  name: string;
  match: Matcher;
  opaque: Matcher;
  suites: string[];
  narrow: (context: NarrowContext) => Promise<NarrowResult>;
}

type DeadGlobEntry = NonNullable<Config["deadGlobs"]>[number];
type KnownUnknown = NonNullable<Config["knownUnknowns"]>[number];

export interface PathMap {
  key: string;
  exact: boolean;
  pattern: RegExp;
  values: string[];
  targets: (path: string) => RegExp[] | undefined;
}

export interface ResolvedConfig {
  suites: ResolvedSuite[];
  narrowers: ResolvedNarrower[];
  roots: string[];
  isIgnored: Matcher;
  // Longest prefix first.
  alias: [string, string][];
  generated: PathMap[];
  reads: PathMap[];
  isSelf: Matcher;
  isImportOnly: Matcher;
  isHermetic: Matcher;
  isBarrel: Matcher;
  external: Set<string>;
  isInert: Matcher;
  // `undefined` when the config doesn't say: any package may be.
  isLoadedByName?: Matcher;
  extensions: readonly string[];
  deadGlobs: readonly DeadGlobEntry[];
  // `undefined` when the config doesn't list them: `check` then counts.
  knownUnknowns?: readonly KnownUnknown[];
  base?: string;
  cache?: boolean | string;
  // The file it was loaded from, which `check` reports its dead globs under.
  file?: string;
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

// `inRoot` compares a root as a prefix, so `src/` and `./src` must become
// `src`, and `./` the whole repo's `.`.
function normalizeRoot(root: string) {
  return (
    root.replace(LEADING_DOT_SLASH, "").replace(TRAILING_SLASHES, "") || "."
  );
}

function pathMaps(record: Readonly<Record<string, Globs>> = {}): PathMap[] {
  return Object.entries(record).map(([key, globs]) => {
    const { pattern, wildcards } = captureGlob(key);
    const values = list(globs, []);
    // A value without references is the same for every match, so it
    // compiles once.
    const fixed = values.map((value) =>
      captureReferences(value).length === 0 ? globToRegExp(value) : undefined,
    );
    return {
      key,
      exact: wildcards === 0,
      pattern,
      values,
      targets: (path) => {
        const match = pattern.exec(path);
        if (!match) return;
        const captures = match.slice(1);
        return values.map(
          (value, i) => fixed[i] ?? expandGlob(value, captures),
        );
      },
    };
  });
}

// bivium itself is always inert: no test runs it, so a bump changes which
// tests later plans pick, never what a test does.
function isInertOf(inert: Globs | undefined): Matcher {
  const listed = matcher(inert);
  return (name) => name === "bivium" || listed(name);
}

// An optional key is left out, never set to `undefined`, which
// `exactOptionalPropertyTypes` rejects.
function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  const out: { [P in K]?: V } = {};
  if (value !== undefined) out[key] = value;
  return out;
}

export function resolveConfig(config: Config): ResolvedConfig {
  const names = Object.keys(config.suites);
  if (names.length === 0) throw new Error("bivium config: no suites");
  const suites = Object.entries(config.suites).map(
    ([name, suite]): ResolvedSuite => ({
      name,
      isTest: matcher(suite.tests),
      ...optional("run", suite.run),
      ...optional("runAll", suite.runAll),
      roots: list(suite.root, ["."]).map(normalizeRoot),
      urls: Object.entries(suite.urls ?? {}).map(([key, targets]) => ({
        key,
        targets: list(targets, []),
      })),
      isPage: matcher(suite.pages),
      isWiring: matcher(suite.wiring),
      isSetup: matcher(suite.setup),
      setup: list(suite.setup, []),
      isNonInput: matcher(suite.nonInputs),
      output: suite.output ?? `${name}-tests`,
      types: suite.types ?? true,
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
    // `{ "@/": "src/" }` means `@/x` → `src/x`, as Vite reads it.
    alias: Object.entries(config.alias ?? {})
      .map(([key, path]): [string, string] => [
        key.replace(TRAILING_SLASHES, "") || key,
        normalizeRoot(path),
      ])
      .sort(([a], [b]) => b.length - a.length),
    generated: pathMaps(config.edges),
    reads: pathMaps(config.reads),
    isSelf: matcher(config.self),
    isImportOnly: matcher(config.importOnly),
    isHermetic: matcher(config.hermetic),
    isBarrel: config.barrels ? matcher(config.barrels) : () => true,
    external: new Set(config.external),
    isInert: isInertOf(config.inert),
    ...(config.loadedByName !== undefined && {
      isLoadedByName: matcher(config.loadedByName),
    }),
    extensions: config.extensions ?? DEFAULT_EXTENSIONS,
    deadGlobs: config.deadGlobs ?? [],
    ...(config.knownUnknowns && { knownUnknowns: config.knownUnknowns }),
    ...optional("base", config.base),
    ...optional("cache", config.cache),
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

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
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
  "runAll",
  "root",
  "urls",
  "pages",
  "wiring",
  "setup",
  "nonInputs",
  "output",
  "types",
]);
const NARROWER_KEYS = new Set(["name", "match", "opaque", "suites", "narrow"]);
const DEAD_GLOB_KEYS = new Set(["file", "glob", "reason"]);
const KNOWN_UNKNOWN_KEYS = new Set(["file", "reason"]);
const CONFIG_KEYS = new Set([
  "suites",
  "narrowers",
  "roots",
  "ignore",
  "alias",
  "edges",
  "reads",
  "self",
  "importOnly",
  "hermetic",
  "barrels",
  "external",
  "inert",
  "loadedByName",
  "extensions",
  "deadGlobs",
  "knownUnknowns",
  "base",
  "cache",
]);

// Every key no shape names, with what it likely meant. A misspelled key
// would silently select less, so it's an error; all of them are listed at
// once, so a config with several takes one run to fix.
function unknownKeys(value: Record<string, unknown>): string[] {
  const found: string[] = [];
  const visit = (record: unknown, known: Set<string>, path: string) => {
    if (!isRecord(record)) return;
    for (const key of Object.keys(record)) {
      if (!known.has(key)) found.push(`${path}${key}${didYouMean(key, known)}`);
    }
  };
  visit(value, CONFIG_KEYS, "");
  if (isRecord(value.suites)) {
    for (const [name, suite] of Object.entries(value.suites)) {
      visit(suite, SUITE_KEYS, `suites.${name}.`);
    }
  }
  const lists = [
    ["narrowers", NARROWER_KEYS],
    ["deadGlobs", DEAD_GLOB_KEYS],
    ["knownUnknowns", KNOWN_UNKNOWN_KEYS],
  ] as const;
  for (const [key, known] of lists) {
    const entries = value[key];
    if (!Array.isArray(entries)) continue;
    for (const [i, entry] of entries.entries()) {
      visit(entry, known, `${key}[${i}].`);
    }
  }
  return found;
}

function checkSuite(name: string, value: unknown): SuiteConfig {
  if (!isRecord(value)) {
    throw new Error(`bivium config: suites.${name} must be an object`);
  }
  const at = `suites.${name}.`;
  const tests = field(value, "tests", isGlobs, at, "a glob or a list of globs");
  if (tests === undefined || tests.length === 0) {
    throw new Error(`bivium config: suite ${name} has no tests`);
  }
  const globs = "a glob or a list of globs";
  return {
    tests,
    ...optional("run", field(value, "run", isString, at, "a command")),
    ...optional("runAll", field(value, "runAll", isString, at, "a command")),
    ...optional("root", paths(value, "root", at)),
    ...optional(
      "urls",
      field(value, "urls", isGlobsRecord, at, "a map of URL patterns"),
    ),
    ...optional("pages", field(value, "pages", isGlobs, at, globs)),
    ...optional("wiring", field(value, "wiring", isGlobs, at, globs)),
    ...optional("setup", field(value, "setup", isGlobs, at, globs)),
    ...optional("nonInputs", field(value, "nonInputs", isGlobs, at, globs)),
    ...optional(
      "output",
      field(value, "output", isString, at, "an output name"),
    ),
    ...optional("types", field(value, "types", isBoolean, at, "a boolean")),
  };
}

const WILDCARD = /[*?{}[\]]/;

// `root` and `roots` are path prefixes: a glob there matches no path, and
// the orphan rule and `goto()` reading quietly stop where it was meant to
// apply, so one is an error.
function paths(
  record: Record<string, unknown>,
  key: string,
  at: string,
): Globs | undefined {
  const value = field(record, key, isGlobs, at, "a path or a list of paths");
  for (const path of typeof value === "string" ? [value] : (value ?? [])) {
    const wildcard = WILDCARD.exec(path);
    if (!wildcard) continue;
    const prefix = normalizeRoot(path.slice(0, wildcard.index));
    throw new Error(
      `bivium config: ${at}${key} takes paths, not globs: "${path}" (the directory is "${prefix}")`,
    );
  }
  return value;
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

// A narrower is code from the config, which nothing type-checked, so what
// it returns is checked too.
function checkResult(value: unknown): NarrowResult {
  if (isResult(value)) return value;
  throw new Error("returned neither { seeds: string[] } nor { all: string }");
}

function checkNarrower(value: unknown, at: string): Narrower {
  if (!isRecord(value)) {
    throw new Error(`bivium config: ${at} must be an object`);
  }
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
    ...optional("suites", suites),
    narrow: async (context) => {
      const result: unknown = await Reflect.apply(narrow, value, [context]);
      return checkResult(result);
    },
  };
}

// A reason is required: an entry without one is a dead glob nobody
// looked at.
function checkDeadGlob(value: unknown, at: string): DeadGlobEntry {
  if (!isRecord(value)) {
    throw new Error(`bivium config: ${at} must be an object`);
  }
  const file = field(value, "file", isString, `${at}.`, "a path");
  const glob = field(value, "glob", isString, `${at}.`, "a glob");
  const reason = field(value, "reason", isString, `${at}.`, "a string");
  if (!(file && glob && reason)) {
    throw new Error(`bivium config: ${at} needs a file, glob and reason`);
  }
  return { file, glob, reason };
}

function checkKnownUnknown(value: unknown, at: string): KnownUnknown {
  if (!isRecord(value)) {
    throw new Error(`bivium config: ${at} must be an object`);
  }
  const file = field(value, "file", isString, `${at}.`, "a path");
  const reason = field(value, "reason", isString, `${at}.`, "a string");
  if (!(file && reason)) {
    throw new Error(`bivium config: ${at} needs a file and reason`);
  }
  return { file, reason };
}

// A value can only refer to a wildcard its key has: `$2` of a key with one
// would stand for nothing.
function checkCaptures(
  name: string,
  record: Readonly<Record<string, Globs>> | undefined,
) {
  for (const [key, globs] of Object.entries(record ?? {})) {
    const { wildcards } = captureGlob(key);
    for (const value of list(globs, [])) {
      const bad = captureReferences(value).find((n) => n < 1 || n > wildcards);
      if (bad === undefined) continue;
      const has = `${wildcards} ${wildcards === 1 ? "wildcard" : "wildcards"}`;
      const why = bad < 1 ? "captures count from $1" : `its key has ${has}`;
      throw new Error(
        `bivium config: ${name}["${key}"] refers to $${bad} in ${value}, but ${why}`,
      );
    }
  }
}

// Nothing type-checks a config as it loads, a `.ts` one included (its
// types are stripped), so every key is checked here.
export function checkConfig(value: unknown): Config {
  if (!isRecord(value)) throw new Error("bivium config: not an object");
  if (!isRecord(value.suites)) {
    throw new Error("bivium config: suites must be an object");
  }
  const unknown = unknownKeys(value);
  if (unknown.length === 1) {
    throw new Error(`bivium config: unknown key ${unknown[0]}`);
  }
  if (unknown.length > 1) {
    throw new Error(
      `bivium config: unknown keys:\n${unknown.map((key) => `  ${key}`).join("\n")}`,
    );
  }
  const { narrowers, deadGlobs, knownUnknowns } = value;
  if (narrowers !== undefined && !Array.isArray(narrowers)) {
    throw new Error("bivium config: narrowers must be a list");
  }
  if (deadGlobs !== undefined && !Array.isArray(deadGlobs)) {
    throw new Error("bivium config: deadGlobs must be a list");
  }
  if (knownUnknowns !== undefined && !Array.isArray(knownUnknowns)) {
    throw new Error("bivium config: knownUnknowns must be a list");
  }
  const suites: Record<string, SuiteConfig> = {};
  for (const [name, suite] of Object.entries(value.suites)) {
    suites[name] = checkSuite(name, suite);
  }
  const globs = "a glob or a list of globs";
  const edges = field(value, "edges", isGlobsRecord, "", "a map of globs");
  const reads = field(value, "reads", isGlobsRecord, "", "a map of globs");
  checkCaptures("edges", edges);
  checkCaptures("reads", reads);
  return {
    suites,
    ...optional(
      "narrowers",
      narrowers?.map((narrower, i) =>
        checkNarrower(narrower, `narrowers[${i}]`),
      ),
    ),
    ...optional("roots", paths(value, "roots", "")),
    ...optional("ignore", field(value, "ignore", isGlobs, "", globs)),
    ...optional(
      "alias",
      field(value, "alias", isStringRecord, "", "a map of paths"),
    ),
    ...optional("edges", edges),
    ...optional("reads", reads),
    ...optional("self", field(value, "self", isGlobs, "", globs)),
    ...optional("importOnly", field(value, "importOnly", isGlobs, "", globs)),
    ...optional("hermetic", field(value, "hermetic", isGlobs, "", globs)),
    ...optional("barrels", field(value, "barrels", isGlobs, "", globs)),
    ...optional(
      "external",
      field(value, "external", isStrings, "", "a list of packages"),
    ),
    ...optional("inert", field(value, "inert", isGlobs, "", globs)),
    ...optional(
      "loadedByName",
      field(value, "loadedByName", isGlobs, "", globs),
    ),
    ...optional(
      "extensions",
      field(value, "extensions", isStrings, "", "a list"),
    ),
    ...optional(
      "deadGlobs",
      deadGlobs?.map((entry: unknown, i) =>
        checkDeadGlob(entry, `deadGlobs[${i}]`),
      ),
    ),
    ...optional(
      "knownUnknowns",
      knownUnknowns?.map((entry: unknown, i) =>
        checkKnownUnknown(entry, `knownUnknowns[${i}]`),
      ),
    ),
    ...optional("base", field(value, "base", isString, "", "a ref")),
    ...optional(
      "cache",
      field(value, "cache", isCache, "", "a directory or a boolean"),
    ),
  };
}

const CONFIG_FILES = [
  "bivium.config.ts",
  "bivium.config.mts",
  "bivium.config.mjs",
  "bivium.config.js",
  "bivium.config.json",
];

interface LoadedConfig {
  config: ResolvedConfig;
  // Repo-relative when it's inside the repo, as changed files are.
  file: string;
}

async function readConfig(file: string): Promise<unknown> {
  if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf-8"));
  const module: unknown = await import(pathToFileURL(file).href);
  return isRecord(module) ? module.default : undefined;
}

const CONFIG_PREFIX = /^bivium config: /;

// compat: a `.ts` config loads natively only on Bun and on Node ≥ 22.18
// (type stripping).
export async function loadConfig(
  root: string,
  path?: string,
): Promise<LoadedConfig> {
  const file =
    path === undefined
      ? CONFIG_FILES.map((name) => join(root, name)).find((f) => existsSync(f))
      : resolve(process.cwd(), path);
  if (!file || !existsSync(file)) {
    throw new BiviumError(
      "BV_CONFIG_NOT_FOUND",
      path
        ? `bivium: no config found at ${path}`
        : `bivium: no config found in ${root}: looked for ${CONFIG_FILES.join(", ")} (--config names another file, --cwd another repository)`,
    );
  }
  const inside = relative(root, file);
  const shown = inside.startsWith("..") || isAbsolute(inside) ? file : inside;
  // Each error names the file, since --config or a parent's config may not
  // be the one the caller had in mind, and a parse error names none.
  const named = (code: BiviumErrorCode, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return new BiviumError(
      code,
      `bivium config: ${shown}: ${message.replace(CONFIG_PREFIX, "")}`,
      { cause: error },
    );
  };
  let raw: unknown;
  try {
    raw = await readConfig(file);
  } catch (error) {
    throw named("BV_CONFIG_UNREADABLE", error);
  }
  let config: ResolvedConfig;
  try {
    config = resolveConfig(checkConfig(raw));
  } catch (error) {
    throw named("BV_CONFIG_INVALID", error);
  }
  return { config, file: shown };
}
