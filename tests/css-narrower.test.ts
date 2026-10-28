import {
  type CssTools,
  cssNarrower,
  stylesheetEntries,
} from "../eval/carbon/css-narrower.ts";
import { graphView } from "../src/compute.ts";
import { matcher } from "../src/glob.ts";
import { planTests } from "../src/plan.ts";
import type { Tree } from "../src/types.ts";
import { config, graphOf, REPO } from "./fixture.ts";

const graph = graphOf();
const view = graphView(graph, config);
const head: Tree = {
  commit: undefined,
  read: (path) => Promise.resolve(REPO[path]),
};
const base: Tree = { commit: "abc", read: () => Promise.resolve(undefined) };

function tools(overrides: Partial<CssTools> = {}): CssTools {
  return {
    compileAt: (ref) =>
      Promise.resolve({ sheets: { all: { css: ref ? "before" : "after" } } }),
    changedSelectors: () => ({ selectors: [".bx--accordion"] }),
    selectorSources: (pages) => ({
      files: [...pages.keys()].filter((file) => file.includes("Accordion")),
    }),
    ...overrides,
  };
}

async function narrow(loaded: CssTools | Error) {
  const narrower = cssNarrower(() =>
    loaded instanceof Error ? Promise.reject(loaded) : Promise.resolve(loaded),
  );
  return narrower.narrow({
    root: "/repo",
    base,
    head,
    changed: ["css/_button.scss"],
    graph: view,
    prepared: undefined,
  });
}

describe("carbon's CSS narrower", () => {
  it("compiles the sheets e2e tests load", () => {
    expect(stylesheetEntries(view)).toEqual(["all"]);
  });

  it("seeds the sources that spell a changed rule's classes", async () => {
    const calls: unknown[] = [];
    const result = await narrow(
      tools({
        compileAt: (ref, options) => {
          calls.push([ref, options]);
          return Promise.resolve({ sheets: { all: { css: String(ref) } } });
        },
      }),
    );
    expect(calls).toEqual([
      ["abc", { cwd: "/repo", entries: ["all"] }],
      [undefined, { cwd: "/repo", entries: ["all"] }],
    ]);
    expect(result).toEqual({
      seeds: [
        "src/Accordion/Accordion.svelte",
        "e2e/fixtures/AccordionFixture.svelte",
      ],
      note: "1 changed selectors, rendered by 2 sources",
    });
    if (!("seeds" in result)) throw new Error("no seeds");
    const { suites } = planTests(graph, ["css/_button.scss"], config, {
      narrowed: [
        {
          narrower: {
            name: "css/",
            match: matcher("css/**"),
            opaque: matcher("css/*.css"),
            suites: ["e2e"],
            narrow: () => Promise.resolve(result),
          },
          result,
        },
      ],
    });
    expect(suites.e2e).toEqual({
      mode: "some",
      files: ["e2e/accordion.test.ts"],
    });
  });

  it.each([
    [
      "a rule requires no class",
      tools({
        changedSelectors: () => ({ reason: '":root" requires no class' }),
      }),
      'all.css: ":root" requires no class',
    ],
    [
      "no source spells a class",
      tools({ selectorSources: () => ({ reason: "no source spells .x" }) }),
      "no source spells .x",
    ],
    [
      "the tools don't load",
      new Error("Cannot find package 'crassus'"),
      "couldn't diff the compiled CSS: Cannot find package 'crassus'",
    ],
  ])(
    "runs every e2e test when %s, with carbon's reason",
    async (_, loaded, reason) => {
      expect(await narrow(loaded)).toEqual({ all: reason });
    },
  );
});
