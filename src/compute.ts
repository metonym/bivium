import { readFile, stat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { cacheDir, ExtractionCache } from "./cache.ts";
import {
  checkConfig,
  loadConfig,
  type ResolvedConfig,
  resolveConfig,
} from "./config.ts";
import { defaultBase, type Revision, readRevision } from "./git.ts";
import {
  affectedBy,
  baseBarrelNames,
  changedBarrelNames,
  type Graph,
  graphFrom,
  importersOf,
} from "./graph.ts";
import { type PackageDiff, readPackageDiff } from "./lockfile.ts";
import { classify, type Narrowed, type Plan, planTests } from "./plan.ts";
import { type PackageJson, type Packages, toPackageJson } from "./resolve.ts";
import { type Extraction, extract, formatOf, SCANNED } from "./scan.ts";
import { readTsconfigs, type TsConfigs } from "./tsconfig.ts";
import type { Config, GraphView, PlanOptions, PlanResult } from "./types.ts";

function hasCode(error: unknown, codes: readonly string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

// The index can list a file the working tree deleted, or a directory where
// a submodule's checkout is missing.
async function readIfFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if (hasCode(error, ["ENOENT", "EISDIR"])) return undefined;
    throw error;
  }
}

// Reads files in parallel: a third of the time on a warm disk and a tenth on
// a cold one. Files the index lists but the working tree deleted are left out.
export async function readSources(
  root: string,
  files: string[],
): Promise<Map<string, string>> {
  const texts = await Promise.all(
    files.map((file) => readIfFile(join(root, file))),
  );
  const sources = new Map<string, string>();
  for (const [i, file] of files.entries()) {
    const text = texts[i];
    if (text !== undefined) sources.set(file, text);
  }
  return sources;
}

// The root `package.json` and every one under the roots.
export function collectPackages(
  rootJson: string | undefined,
  sources: Map<string, string>,
): Packages {
  const packages: Packages = new Map();
  const parse = (text: string): PackageJson => {
    try {
      return toPackageJson(JSON.parse(text));
    } catch {
      return {};
    }
  };
  if (rootJson !== undefined) packages.set(".", parse(rootJson));
  for (const [path, text] of sources) {
    if (path === "package.json" || !path.endsWith("/package.json")) continue;
    packages.set(posix.dirname(path), parse(text));
  }
  return packages;
}

export interface Computed {
  plan: Plan;
  graph: Graph;
  changed: string[];
  mergeBase: () => Promise<string>;
  barrelNames: string[];
  narrowed: Narrowed[];
  packages: Packages;
  tsconfigs: TsConfigs;
  // `tsconfig.json` files (or files they extend) that don't parse.
  unparsedTsconfigs: { file: string; reason: string }[];
  // What each scanned file declares, globs as written: `check` reports a
  // dead glob by its source text, which the graph's RegExps lose.
  extractions: Map<string, Extraction>;
  // Every file the repository lists, which a declared glob can match.
  listed: string[];
  // Files the lexer couldn't read, which the regex extractor read instead.
  fallbacks: Map<string, string>;
  // How the scanned files were read: from the cache, or from disk.
  extracted: { cached: number; read: number };
}

interface ComputeOptions {
  // `false` for none, a directory, or (the default) the config's `cache`,
  // else `node_modules/.cache/bivium`.
  cache?: boolean | string;
  // The suites the caller will use. A narrower for none of them doesn't
  // run, and its suites keep the coarse selection.
  suites?: readonly string[];
  // The caller will ask for the merge base: find it alongside git's other
  // calls rather than on first use.
  mergeBase?: boolean;
}

// Whether the working tree has `path` as a file (or a link to one).
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (hasCode(error, ["ENOENT", "ENOTDIR"])) return false;
    throw error;
  }
}

// The files of `revision` the working tree has, and the extractions of the
// ones the scanner reads. A file the index vouches for (`blobs`) comes from
// the cache when it can; other scanned files, and `package.json` files, are
// read. Leaves are never read: one git doesn't vouch for is only checked to
// exist.
export async function extractRevision(
  root: string,
  revision: Revision,
  cache: ExtractionCache,
): Promise<{
  files: string[];
  extractions: Map<string, Extraction>;
  manifests: Map<string, string>;
  extracted: Computed["extracted"];
}> {
  const extractions = new Map<string, Extraction>();
  const texts = new Map<string, string>();
  const missing = new Set<string>();
  const pending: Promise<void>[] = [];
  let cached = 0;
  const read = async (file: string) => {
    const text = await readIfFile(join(root, file));
    if (text === undefined) missing.add(file);
    return text;
  };
  for (const file of revision.files) {
    if (SCANNED.test(file)) {
      const format = formatOf(file);
      const oid = revision.blobs.get(file);
      const hit = oid === undefined ? undefined : cache.get(oid, format);
      if (hit) {
        extractions.set(file, hit);
        cached++;
        continue;
      }
      pending.push(
        read(file).then((source) => {
          if (source === undefined) return;
          const extraction = extract(format, source);
          extractions.set(file, extraction);
          if (oid !== undefined) cache.set(oid, format, extraction);
        }),
      );
    } else if (file.endsWith("/package.json")) {
      pending.push(
        read(file).then((source) => {
          if (source !== undefined) texts.set(file, source);
        }),
      );
    } else if (!revision.present.has(file)) {
      pending.push(
        isFile(join(root, file)).then((found) => {
          if (!found) missing.add(file);
        }),
      );
    }
  }
  await Promise.all(pending);
  const files = revision.files.filter((file) => !missing.has(file));
  // In file order, as reads finish in any.
  const manifests = new Map<string, string>();
  for (const file of files) {
    const text = texts.get(file);
    if (text !== undefined) manifests.set(file, text);
  }
  return {
    files,
    extractions,
    manifests,
    extracted: { cached, read: extractions.size - cached },
  };
}

export function graphView(graph: Graph, config: ResolvedConfig): GraphView {
  const nodes = [...graph.keys()];
  return {
    nodes: () => nodes,
    importers: (node) => importersOf(graph, node),
    dependents: (from) => affectedBy(graph, from, { includeUnknown: false }),
    tests: (name) => {
      const suite = config.suites.find((candidate) => candidate.name === name);
      if (!suite) throw new Error(`bivium: no suite "${name}"`);
      return nodes.filter(suite.isTest);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runNarrowers(
  root: string,
  revision: Revision,
  graph: Graph,
  config: ResolvedConfig,
  suites: readonly string[] | undefined,
  packages: PackageDiff | undefined,
): Promise<Narrowed[]> {
  const { relevant } = classify(graph, revision.changed, config, packages);
  const wanted = config.narrowers.filter(
    (narrower) =>
      relevant.some(narrower.match) &&
      (suites === undefined ||
        narrower.suites.some((name) => suites.includes(name))),
  );
  if (wanted.length === 0) return [];
  const view = graphView(graph, config);
  const base = {
    commit: await revision.mergeBase(),
    read: revision.readBase,
  };
  const head = {
    commit: undefined,
    read: (path: string) => readIfFile(join(root, path)),
  };
  return Promise.all(
    wanted.map(async (narrower): Promise<Narrowed> => {
      const changed = relevant.filter(narrower.match);
      try {
        const result = await narrower.narrow({
          root,
          base,
          head,
          changed,
          graph: view,
        });
        return { narrower, result };
      } catch (error) {
        return { narrower, result: { all: `failed: ${messageOf(error)}` } };
      }
    }),
  );
}

export async function computePlan(
  root: string,
  base: string,
  config: ResolvedConfig,
  {
    cache: cacheOption = config.cache,
    suites,
    mergeBase = false,
  }: ComputeOptions = {},
): Promise<Computed> {
  const dir = cacheDir(root, cacheOption);
  const [revision, rootJson, cache] = await Promise.all([
    readRevision(root, base, config.roots, {
      blobs: dir !== undefined,
      mergeBase,
    }),
    readFile(join(root, "package.json"), "utf-8").catch(() => undefined),
    ExtractionCache.open(dir),
  ]);
  // A narrower that may run needs the merge base once the graph is built,
  // which would hold back the call's callback: ask for it now.
  if (
    revision.changed.some((file) =>
      config.narrowers.some((narrower) => narrower.match(file)),
    )
  ) {
    revision.mergeBase();
  }
  // A file an `extends` names is read only if git lists it, so that a
  // change to it is a change (an ignored `.svelte-kit/tsconfig.json` isn't).
  let listed: Set<string> | undefined;
  const readTsconfig = async (file: string, extended: boolean) => {
    if (extended) {
      listed ??= new Set(revision.listed);
      if (!listed.has(file)) return;
    }
    return readIfFile(join(root, file));
  };
  const [{ files, extractions, manifests, extracted }, ts, packageDiff] =
    await Promise.all([
      extractRevision(root, revision, cache),
      readTsconfigs(
        [
          "tsconfig.json",
          ...revision.files.filter((file) => file.endsWith("/tsconfig.json")),
        ],
        readTsconfig,
      ),
      readPackageDiff(
        revision.changed,
        revision.listed,
        revision.readBase,
        (path) => readIfFile(join(root, path)),
      ),
    ]);
  const { tsconfigs } = ts;
  // Changed barrels need their base version; fetched while the graph builds.
  const basePending = new Map(
    revision.changed
      .filter((file) => config.isBarrel(file) && extractions.get(file)?.barrel)
      .map((file) => [file, revision.readBase(file)] as const),
  );
  const packages = collectPackages(rootJson, manifests);
  const graph = graphFrom(files, extractions, {
    config,
    packages,
    tsconfigs,
  });
  const saved = cache.save();

  const moved = await Promise.all(
    [...basePending].map(async ([file, pending]) => {
      const head = graph.get(file)?.barrel;
      if (!head) return [];
      const before = baseBarrelNames(
        file,
        await pending,
        { config, packages, tsconfigs },
        graph,
      );
      const names = before
        ? changedBarrelNames(before, head)
        : [...head.keys()];
      return names.map((name) => `${file}#${name}`);
    }),
  );
  const barrelNames = moved.flat();

  const narrowed = await runNarrowers(
    root,
    revision,
    graph,
    config,
    suites,
    packageDiff,
  );
  const planned = planTests(graph, revision.changed, config, {
    barrelNames,
    narrowed,
    packages: packageDiff,
  });
  await saved;
  return {
    plan: planned,
    graph,
    changed: revision.changed,
    mergeBase: revision.mergeBase,
    barrelNames,
    narrowed,
    packages,
    tsconfigs,
    unparsedTsconfigs: ts.unparsed,
    extractions,
    listed: revision.listed,
    fallbacks: new Map(
      [...extractions].flatMap(([file, extraction]) =>
        extraction.fallback === undefined ? [] : [[file, extraction.fallback]],
      ),
    ),
    extracted,
  };
}

interface Prepared {
  root: string;
  base: string;
  config: ResolvedConfig;
}

// The repository, base ref and config to plan with. A loaded config's own
// file is one of the selector's files: a change to it can't be trusted to
// select itself.
export async function prepare({
  cwd = process.cwd(),
  base,
  config,
  configFile,
}: {
  cwd?: string;
  base?: string;
  config?: Config;
  configFile?: string;
}): Promise<Prepared> {
  const root = resolve(cwd);
  let resolved: ResolvedConfig;
  if (config) {
    resolved = resolveConfig(checkConfig(config));
  } else {
    const loaded = await loadConfig(root, configFile);
    const isSelf = loaded.config.isSelf;
    resolved = {
      ...loaded.config,
      file: loaded.file,
      isSelf: (path) => path === loaded.file || isSelf(path),
    };
  }
  return {
    root,
    base: base ?? resolved.base ?? (await defaultBase(root)),
    config: resolved,
  };
}

/**
 * Picks the tests of each suite that the working tree's changes against
 * `base` can affect.
 */
export function plan<Suite extends string>(
  options: PlanOptions<Suite> & { config: Config<Suite> },
): Promise<PlanResult<Suite>>;
export function plan(options?: PlanOptions): Promise<PlanResult>;
export async function plan(options: PlanOptions = {}): Promise<PlanResult> {
  const { root, base, config } = await prepare(options);
  const computed = await computePlan(root, base, config, {
    ...(options.cache !== undefined && { cache: options.cache }),
    mergeBase: true,
  });
  return {
    suites: computed.plan.suites,
    reasons: computed.plan.reasons,
    packages: computed.plan.packages,
    base,
    mergeBase: await computed.mergeBase(),
    changed: computed.changed,
    narrowed: computed.narrowed.map(({ narrower, result }) => ({
      name: narrower.name,
      result,
    })),
  };
}
