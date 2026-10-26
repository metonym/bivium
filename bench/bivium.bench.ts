import { rmSync } from "node:fs";
import { join } from "node:path";
import { group, task } from "ostia";
import { computePlan } from "../src/compute.ts";
import { resolveConfig } from "../src/config.ts";
import { buildGraph, graphFrom } from "../src/graph.ts";
import type { Packages } from "../src/resolve.ts";
import {
  type Extraction,
  extract,
  formatOf,
  SCANNED,
  scan,
} from "../src/scan.ts";
import { scanRegex } from "../src/scan-regex.ts";
import { checkout, config, repository } from "./fixture.ts";

const files = repository();
const scanned = [...files].filter(([path]) => SCANNED.test(path));
const resolved = resolveConfig(config);
const packages: Packages = new Map([
  [".", { name: "fixture", sideEffects: false }],
]);
const extractions = new Map<string, Extraction>(
  scanned.map(([path, text]) => [path, extract(formatOf(path), text)]),
);

group(`scan (${scanned.length} files)`, () => {
  task("lexer", () => scanned.map(([path, text]) => scan(path, text)), {
    baseline: true,
  });
  task("regex", () => scanned.map(([path, text]) => scanRegex(path, text)));
});

group(`graph (${files.size} files)`, () => {
  task("extract and resolve", () =>
    buildGraph(files, { config: resolved, packages }),
  );
  task("resolve only", () =>
    graphFrom(files.keys(), extractions, { config: resolved, packages }),
  );
});

let dir = "";
const cache = () => join(dir, "node_modules/.cache/bivium");
group(
  "plan, one component changed",
  () => {
    task("cold: no cache", () =>
      computePlan(dir, "HEAD", resolved, { cache: false }),
    );
    task("warm: every unchanged file cached", () =>
      computePlan(dir, "HEAD", resolved, { cache: cache() }),
    );
  },
  {
    before: async () => {
      dir = checkout(files);
      await computePlan(dir, "HEAD", resolved, { cache: cache() });
    },
    after: () => rmSync(dir, { recursive: true, force: true }),
  },
);
