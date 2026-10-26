/**
 * carbon-components-svelte's own selector, run against another checkout:
 * `scripts/test-changed.ts`'s `computePlan` with no CSS narrowing (that needs
 * an install), as Phase 0 replayed it.
 */
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { readSources } from "../../src/compute.ts";
import { readRevision, showAt } from "../../src/git.ts";
import type { Selection } from "../../src/types.ts";
import { exported, importModule, isRecord, isStrings } from "../untyped.ts";

/** The selector at the checkout's commit, and the frozen copy Phase 0 replayed. */
export function selectors(carbon: string) {
  return {
    master: join(carbon, "scripts/lib/test-graph.ts"),
    phase0: join(
      carbon,
      ".context/test-graph-package/phase0/selector/lib/test-graph.ts",
    ),
  };
}

const RUNTIME_BUILTIN = /^(?:node:|bun(?:$|:))/;
const LOCKFILE_PACKAGE = /^\s+"([^"]+)": \["\1@/gm;

function installedPackages(root: string): Set<string> {
  const installed = new Set<string>();
  for (const lockfile of [
    "bun.lock",
    "tests-svelte3/bun.lock",
    "tests-svelte4/bun.lock",
  ]) {
    if (!existsSync(join(root, lockfile))) continue;
    for (const [, name] of readFileSync(join(root, lockfile), "utf-8").matchAll(
      LOCKFILE_PACKAGE,
    )) {
      installed.add(name);
    }
  }
  return installed;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export interface CarbonPlan {
  unit: Selection;
  e2e: Selection;
  reasons: string[];
}

function isSelection(value: unknown): value is Selection {
  if (typeof value !== "object" || value === null || !("mode" in value)) {
    return false;
  }
  if (value.mode === "all" || value.mode === "none") return true;
  return (
    value.mode === "some" &&
    "files" in value &&
    Array.isArray(value.files) &&
    value.files.every((file) => typeof file === "string")
  );
}

function isPlan(value: unknown): value is CarbonPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    "unit" in value &&
    isSelection(value.unit) &&
    "e2e" in value &&
    isSelection(value.e2e) &&
    "reasons" in value &&
    isStrings(value.reasons)
  );
}

function names(value: unknown): string[] {
  if (value instanceof Map) {
    return [...value.keys()].filter((key) => typeof key === "string");
  }
  if (Array.isArray(value)) {
    return value.filter((name) => typeof name === "string");
  }
  throw new Error("selector returned no barrel names");
}

/** Plans `root` against `base` with the selector at `selector`, over `roots`. */
export async function oracle(
  selector: string,
  roots: string[],
): Promise<(root: string, base: string) => Promise<CarbonPlan>> {
  const module = await importModule(selector);
  const barrelPath = isRecord(module) ? module.BARREL : undefined;
  if (typeof barrelPath !== "string") throw new Error("no BARREL in selector");
  const parseBarrel = exported(module, "parseBarrel");
  const buildGraph = exported(module, "buildGraph");
  const changedBarrelNames = exported(module, "changedBarrelNames");
  const planTests = exported(module, "planTests");
  return async (root, base) => {
    const revision = await readRevision(root, base, roots);
    const baseBarrel = showAt(root, revision.mergeBase, barrelPath);
    const sources = await readSources(root, revision.files);
    const exists = new Set(sources.keys());
    const packages = installedPackages(root);
    const builtins = new Set(builtinModules);
    const barrel = parseBarrel(readFileSync(join(root, barrelPath), "utf-8"));
    const graph = buildGraph(sources, {
      exists: (path: string) => exists.has(path),
      isExternal: (specifier: string) =>
        RUNTIME_BUILTIN.test(specifier) ||
        builtins.has(specifier) ||
        packages.has(packageName(specifier)),
      barrel,
    });
    const before = await baseBarrel;
    const moved =
      before === undefined
        ? names(barrel)
        : names(changedBarrelNames(parseBarrel(before), barrel));
    const plan = planTests(graph, revision.changed, moved);
    if (!isPlan(plan)) throw new Error("selector returned no plan");
    return plan;
  };
}
