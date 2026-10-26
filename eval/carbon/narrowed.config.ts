import { join } from "node:path";
import { defineConfig } from "../../src/index.ts";
import { exported, importModule } from "../untyped.ts";
import carbon from "./bivium.config.ts";
import { type CssTools, cssNarrower } from "./css-narrower.ts";

function isCompiled(
  value: unknown,
): value is Awaited<ReturnType<CssTools["compileAt"]>> {
  return (
    typeof value === "object" &&
    value !== null &&
    "sheets" in value &&
    typeof value.sheets === "object" &&
    value.sheets !== null
  );
}

function isChange(
  value: unknown,
): value is ReturnType<CssTools["changedSelectors"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    ("selectors" in value || "reason" in value)
  );
}

function isSeeds(
  value: unknown,
): value is ReturnType<CssTools["selectorSources"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    ("files" in value || "reason" in value)
  );
}

// The checkout's own css-delta.ts and its installed crassus, as carbon's
// script loads them. Run from an installed carbon checkout:
//
//   bun src/cli.ts plan --cwd <carbon> --config eval/carbon/narrowed.config.ts
async function loadFrom(root: string): Promise<CssTools> {
  const delta = await importModule(join(root, "scripts/lib/css-delta.ts"));
  const git = await importModule(Bun.resolveSync("crassus/git", root));
  const compile = exported(git, "compileAt");
  const changed = exported(delta, "changedSelectors");
  const sources = exported(delta, "selectorSources");
  return {
    async compileAt(ref, options) {
      const compiled = await compile(ref, options);
      if (!isCompiled(compiled))
        throw new Error("compileAt returned no sheets");
      return compiled;
    },
    changedSelectors(base, head) {
      const change = changed(base, head);
      if (!isChange(change))
        throw new Error("changedSelectors returned no change");
      return change;
    },
    selectorSources(pages, selectors) {
      const seeds = sources(pages, selectors);
      if (!isSeeds(seeds)) throw new Error("selectorSources returned no files");
      return seeds;
    },
  };
}

/** `bivium.config.ts` with carbon's CSS narrowing, which needs an install. */
export default defineConfig({
  ...carbon,
  narrowers: [cssNarrower(loadFrom)],
});
