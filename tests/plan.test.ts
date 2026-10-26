import { resolveConfig } from "../src/config.ts";
import { matcher } from "../src/glob.ts";
import type { Graph } from "../src/graph.ts";
import { formatSelection, planTests } from "../src/plan.ts";
import type { NarrowResult } from "../src/types.ts";
import { BARREL, CONFIG, config, graphOf, REPO } from "./fixture.ts";

const graph = graphOf();

function plan(
  changed: string[],
  barrelNames: string[] = [],
  narrowed?: NarrowResult,
  on: Graph = graph,
) {
  const { suites, reasons } = planTests(on, changed, config, {
    barrelNames: barrelNames.map((name) => `${BARREL}#${name}`),
    narrowed: narrowed && [
      {
        narrower: {
          name: "css/",
          suites: ["e2e"],
          match: matcher("css/**"),
          opaque: matcher("css/*.css"),
          narrow: () => Promise.resolve(narrowed),
        },
        result: narrowed,
      },
    ],
  });
  return {
    unit: formatSelection(suites.unit),
    e2e: formatSelection(suites.e2e),
    reasons,
  };
}

describe("planTests", () => {
  it("runs a leaf component's tests, fixtures, and unknown-dependency tests", () => {
    expect(plan(["src/Accordion/Accordion.svelte"])).toEqual({
      unit: "tests/Accordion/Accordion.test.ts tests/css/unknown.test.ts",
      e2e: "e2e/accordion.test.ts",
      reasons: [],
    });
  });

  it("runs the tests of every component that composes the changed one", () => {
    expect(plan(["src/Button/Button.svelte"])).toEqual({
      unit: "tests/Button/Button.test.ts tests/Modal/Modal.test.ts tests/css/unknown.test.ts",
      e2e: "e2e/modal.test.ts",
      reasons: [],
    });
  });

  it("selects barrel importers only for barrel names that moved", () => {
    expect(plan([BARREL], ["Header"])).toEqual({
      unit: "tests/css/unknown.test.ts",
      e2e: "e2e/modal.test.ts",
      reasons: [],
    });
  });

  it("runs every e2e test and declared css tests for a stylesheet change", () => {
    expect(plan(["css/_button.scss"])).toEqual({
      unit: "tests/css/button.test.ts tests/css/unknown.test.ts",
      e2e: "all",
      reasons: [],
    });
  });

  it("lets a narrower replace a stylesheet change's seeds", () => {
    const narrowed = { seeds: ["src/Accordion/Accordion.svelte"] };
    expect(plan(["css/_button.scss"], [], narrowed)).toEqual({
      unit: "tests/css/button.test.ts tests/css/unknown.test.ts",
      e2e: "e2e/accordion.test.ts",
      reasons: [],
    });
    expect(plan(["css/_button.scss"], [], { seeds: [] }).e2e).toBe("none");
    // A build script change still reaches every page through all.css.
    expect(
      plan(["css/_button.scss", "scripts/build-css.ts"], [], { seeds: [] }).e2e,
    ).toBe("all");
  });

  it("runs the narrowed suites in full when the narrower can't decide", () => {
    expect(plan(["css/_button.scss"], [], { all: "`:root` changed" })).toEqual({
      unit: "tests/css/button.test.ts tests/css/unknown.test.ts",
      e2e: "all",
      reasons: ["css/: `:root` changed"],
    });
  });

  it("runs a root-level config's importers, not everything", () => {
    expect(plan(["crassus.config.ts"])).toEqual({
      unit: "tests/css/unknown.test.ts tests/scripts/crassus-config.test.ts",
      e2e: "none",
      reasons: [],
    });
  });

  it("skips pages no test opens, and what only they load", () => {
    const files = {
      ...REPO,
      "e2e/fixtures/index.html": `<a href="/accordion.html">Accordion</a>`,
      "e2e/fixtures/matrix.html": `<script type="module" src="./matrix.ts"></script>`,
      "e2e/fixtures/matrix.ts": `import { mount } from "./mount";`,
    };
    const pages = graphOf(files);
    for (const file of Object.keys(files).slice(-3)) {
      const { e2e, reasons } = plan([file], [], undefined, pages);
      expect({ e2e, reasons }).toEqual({ e2e: "none", reasons: [] });
    }
  });

  it("runs a whole suite when its setup file changes", () => {
    expect(plan(["tests/setup-tests.ts"])).toMatchObject({
      unit: "all",
      reasons: ["tests/setup-tests.ts: no unit test imports it"],
    });
    expect(plan(["e2e/vite.config.ts"]).e2e).toBe("all");
  });

  it("runs everything for files outside the graph and selector changes", () => {
    for (const file of ["package.json", "scripts/test-changed.ts"]) {
      expect(plan([file])).toMatchObject({ unit: "all", e2e: "all" });
    }
    expect(plan(["package.json"]).reasons).toEqual([
      "package.json: outside the dependency graph",
    ]);
    expect(plan(["scripts/test-changed.ts"]).reasons).toEqual([
      "scripts/test-changed.ts: test selector changed",
    ]);
  });

  it("runs only the suite a wiring file wires", () => {
    expect(plan(["tests-svelte3/setup-tests.ts"])).toEqual({
      unit: "all",
      e2e: "none",
      reasons: ["tests-svelte3/setup-tests.ts: wires the unit suite"],
    });
  });

  it("skips ignored files and deleted tests", () => {
    expect(plan(["docs/src/pages/index.svx", "README.md"])).toEqual({
      unit: "none",
      e2e: "none",
      reasons: [],
    });
    expect(plan(["tests/Gone/Gone.test.ts"]).reasons).toEqual([]);
  });

  it("selects the tests that import an ignored file", () => {
    expect(plan(["docs/src/token-reference.ts"])).toEqual({
      unit: "tests/css/unknown.test.ts tests/docs/token-reference.test.ts",
      e2e: "none",
      reasons: [],
    });
  });

  it("skips deleted import-only files, non-inputs and ignored workflows", () => {
    for (const file of [
      "tests/Gone/Gone.test.svelte",
      "tests/types.test-d.ts",
      "tests/tsconfig.compat-check.json",
      ".github/workflows/release.yml",
    ]) {
      const { unit, e2e, reasons } = plan([file]);
      expect({ unit: unit === "all", e2e, reasons }).toEqual({
        unit: false,
        e2e: "none",
        reasons: [],
      });
    }
    expect(plan([".github/workflows/checks.yml"]).unit).toBe("all");
  });

  it("runs a whole suite when a deleted helper leaves no importer", () => {
    expect(plan(["tests/gone-helper.ts"]).unit).toBe("all");
  });

  it("defaults a suite's root to the whole repo, so an unreached change runs it", () => {
    const strict = resolveConfig({
      ...CONFIG,
      suites: { unit: { tests: "tests/**/*.test.ts" } },
    });
    const { suites, reasons } = planTests(graph, ["src/types.d.ts"], strict);
    // Only tests/css/unknown.test.ts reaches it, through its unknown deps,
    // which the orphan rule doesn't count.
    expect(formatSelection(suites.unit)).toBe("all");
    expect(reasons).toEqual(["src/types.d.ts: no unit test imports it"]);
  });

  it("selects nothing and gives no reason for no change", () => {
    expect(plan([])).toEqual({ unit: "none", e2e: "none", reasons: [] });
  });
});
