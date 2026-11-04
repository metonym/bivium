import { posix } from "node:path";
import { isRecord } from "./resolve.ts";
import { plural } from "./text.ts";
import { parseJsonc } from "./tsconfig.ts";

// `package.json` fields no resolver, runtime or bundler reads: a change to
// only these can't change what a file imports or how it runs. Any other
// field might (`type`, `exports`, `imports`, `name`, `sideEffects`,
// `browser`, a runner's own key), so it counts.
const METADATA = new Set([
  "author",
  "bugs",
  "contributors",
  "description",
  "engines",
  "files",
  "funding",
  "homepage",
  "keywords",
  "license",
  "maintainers",
  "private",
  "publishConfig",
  "repository",
  "version",
]);

const MANIFEST = /(?:^|\/)package\.json$/;
const TSCONFIG = /(?:^|\/)tsconfig\.json$/;

/** What a changed setting file can affect, and a line saying so. */
export interface SettingChange {
  // The files it governs, which seed the walk: empty when nothing that
  // changed can change how a file resolves or runs.
  seeds: string[];
  note: string;
}

interface Settings {
  changed: readonly string[];
  // The repository files the graph has.
  files: readonly string[];
  // Each `tsconfig.json`'s directory → the files it reads (itself and what
  // it extends).
  tsconfigs: ReadonlyMap<string, readonly string[]>;
  // The directories with a `package.json`.
  packages: Iterable<string>;
  // Changed `package.json` files the package diff accounts for.
  accounted: ReadonlySet<string>;
  base: (path: string) => Promise<string | undefined>;
  head: (path: string) => Promise<string | undefined>;
}

function within(file: string, dir: string): boolean {
  return dir === "." || file.startsWith(`${dir}/`);
}

// The files whose nearest directory among `dirs` is `dir`.
function governed(
  files: readonly string[],
  dirs: readonly string[],
  dir: string,
): string[] {
  const deeper = dirs.filter((other) => other !== dir && within(other, dir));
  return files.filter(
    (file) => within(file, dir) && !deeper.some((other) => within(file, other)),
  );
}

function parsed(text: string | undefined, jsonc: boolean): unknown {
  if (text === undefined) return undefined;
  try {
    return jsonc ? parseJsonc(text) : JSON.parse(text);
  } catch {
    return null;
  }
}

// The top-level keys whose values differ, or `undefined` when either side
// is missing or isn't an object.
function changedKeys(before: unknown, after: unknown): string[] | undefined {
  if (!(isRecord(before) && isRecord(after))) return undefined;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

/**
 * The changed `tsconfig.json` files (and files one extends) and
 * `package.json` files whose change can reach files no import names: a
 * config's options and `paths`, or a package's `type` or `exports`, change
 * what the files under it import or how they compile. Each seeds the files
 * it governs, those it's the nearest of its kind to. A change the parsed
 * file doesn't show, or to `package.json` metadata alone, seeds nothing. A
 * `package.json` whose dependency change the package diff accounts for is
 * left to it.
 */
export async function settingChanges({
  changed,
  files,
  tsconfigs,
  packages,
  accounted,
  base,
  head,
}: Settings): Promise<Map<string, SettingChange>> {
  const tsDirs = [...tsconfigs.keys()];
  const packageDirs = [...packages];
  const candidates = changed.filter(
    (file) =>
      TSCONFIG.test(file) ||
      (MANIFEST.test(file) && !accounted.has(file)) ||
      tsDirs.some((dir) => tsconfigs.get(dir)?.includes(file)),
  );
  const texts = await Promise.all(
    candidates.map((file) => Promise.all([base(file), head(file)])),
  );
  const result = new Map<string, SettingChange>();
  for (const [i, file] of candidates.entries()) {
    const [before, after] = texts[i];
    const manifest = MANIFEST.test(file);
    const keys = changedKeys(
      parsed(before, !manifest),
      parsed(after, !manifest),
    );
    const counted = keys?.filter((key) => !(manifest && METADATA.has(key)));
    // A `tsconfig.json` claims its directory, as a `package.json` does,
    // whether it's there now or was at the merge base.
    const own = posix.dirname(file);
    const dirs = manifest
      ? [own]
      : tsDirs.filter((dir) => tsconfigs.get(dir)?.includes(file));
    if (TSCONFIG.test(file) && !dirs.includes(own)) dirs.push(own);
    const kinds = manifest ? packageDirs : tsDirs;
    const all = [...new Set([...kinds, ...dirs])];
    if (keys !== undefined && counted?.length === 0) {
      const what =
        keys.length === 0
          ? "only formatting or comments"
          : `only ${keys.join(", ")}`;
      result.set(file, {
        seeds: [],
        note: `${file}: ${what} changed, so no file resolves or runs differently`,
      });
      continue;
    }
    const seeds = [
      ...new Set(dirs.flatMap((dir) => governed(files, all, dir))),
    ];
    const what = manifest ? "resolve or run" : "resolve or compile";
    result.set(file, {
      seeds,
      note: `${file}: changes how the ${plural(seeds.length, "file")} it governs ${what}`,
    });
  }
  return result;
}
