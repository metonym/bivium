import { defineConfig } from "../../src/index.ts";
import carbon from "./bivium.config.ts";

/**
 * The selector Phase 0 replayed (frozen before b65b46a6c): without the
 * type-check-only and deleted-`.svelte` exemptions from the orphan rule, and
 * with the no-test workflows still outside the graph.
 */
export default defineConfig({
  ...carbon,
  suites: {
    unit: { ...carbon.suites.unit, nonInputs: [] },
    e2e: carbon.suites.e2e,
  },
  ignore: [carbon.ignore ?? []]
    .flat()
    .filter(
      (glob) => !glob.startsWith(".github/") || glob === ".github/FUNDING.yml",
    ),
  importOnly: [],
});
