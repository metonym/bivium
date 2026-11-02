import { resolveConfig } from "../src/config.ts";
import { fanIn, formatGraph, graphReport } from "../src/fanin.ts";
import { affectedBy, type Graph, importersOf } from "../src/graph.ts";
import type { Config } from "../src/types.ts";
import { CONFIG, config, graphOf, REPO } from "./fixture.ts";

// What a change to each node selects, one walk per node: what fanIn
// computes without them.
function bruteForce(graph: Graph, suite: (typeof config.suites)[number]) {
  return new Map(
    [...graph.keys()].map((node) => [
      node,
      [
        ...affectedBy(graph, [node], {
          includeUnknown: false,
          types: suite.types,
        }),
      ].filter(suite.isTest).length,
    ]),
  );
}

describe("fanIn", () => {
  it("counts what a walk back from each node selects", () => {
    const graph = graphOf();
    for (const suite of config.suites) {
      expect(fanIn(graph, suite)).toEqual(bruteForce(graph, suite));
    }
  });

  it("counts reads, lists, setup files and type-only edges as plan does", () => {
    const files = {
      ...REPO,
      "tests/setup.ts": `import "../src/utils/uid.js";`,
      "tests/snap.test.ts":
        "// @reads tests/__snapshots__/**\n// @lists src/**\nexport {};",
      "tests/__snapshots__/a.snap": "x",
      "tests/types.test.ts": `import type { T } from "../src/types.ts";`,
      "src/types.ts": `import "./utils/uid.js";\nexport type T = 1;`,
    };
    for (const types of [true, false]) {
      const extra: Config = {
        ...CONFIG,
        suites: {
          ...CONFIG.suites,
          unit: { ...CONFIG.suites.unit, setup: "tests/setup.ts", types },
        },
      };
      const graph = graphOf(files, { config: extra });
      for (const suite of resolveConfig(extra).suites) {
        expect(fanIn(graph, suite)).toEqual(bruteForce(graph, suite));
      }
    }
  });
});

const HEADER = /^unit: \d+ tests; 1 run on any change/;
const RANKED = /^ +\d+ {2}\S+$/;
const MORE = /^ {2}… \d+ more \(--top <n> shows more\)$/;

describe("formatGraph", () => {
  it("ranks files by fan-in and buckets them", () => {
    const graph = graphOf();
    const report = graphReport(
      graph,
      config.suites.filter((suite) => suite.name === "unit"),
      (node) => importersOf(graph, node),
      () => ["tests/css/unknown.test.ts"],
    );
    const text = formatGraph(report, 2);
    expect(text.split("\n").slice(0, 5)).toEqual([
      expect.stringMatching(HEADER),
      "  tests  file",
      expect.stringMatching(RANKED),
      expect.stringMatching(RANKED),
      expect.stringMatching(MORE),
    ]);
    expect(text).toContain(
      "files by how many unit tests a change to one selects:",
    );
  });
});
