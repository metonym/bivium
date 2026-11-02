import type { ResolvedSuite } from "./config.ts";
import type { Graph } from "./graph.ts";
import { sorted } from "./sorted.ts";

// How many of a suite's tests a change to each node selects through the
// graph's edges, as `plan` walks them, leaving out the tests whose
// dependencies are unknown: they run on any change, which says nothing
// about one file.
//
// A walk back from every node would cost a walk per node. This walks
// forward from each test instead, which reaches what reaches it: a test's
// imports and patterns, transitively, plus what any file on the way reads
// or lists, which counts only directly, as in `affectedBy`.
export function fanIn(graph: Graph, suite: ResolvedSuite): Map<string, number> {
  const ids = new Map<string, number>();
  const nodes = [...graph.keys()];
  for (const [i, node] of nodes.entries()) ids.set(node, i);
  // The nodes a pattern matches, once per pattern source.
  const matches = new Map<string, number[]>();
  const matching = (re: RegExp) => {
    let found = matches.get(re.source);
    if (!found) {
      found = [];
      for (const [i, node] of nodes.entries()) if (re.test(node)) found.push(i);
      matches.set(re.source, found);
    }
    return found;
  };
  // Forward edges, and the nodes read or listed (direct only), by id.
  const forward: number[][] = [];
  const direct: number[][] = [];
  for (const node of nodes) {
    const deps = graph.get(node);
    const out: number[] = [];
    const read: number[] = [];
    if (deps) {
      for (const file of deps.files) {
        if (!suite.types && deps.types?.has(file)) continue;
        const id = ids.get(file);
        if (id !== undefined) out.push(id);
      }
      for (const re of deps.patterns) out.push(...matching(re));
      for (const re of [...deps.reads, ...(deps.lists ?? [])]) {
        read.push(...matching(re));
      }
    }
    forward.push(out);
    direct.push(read);
  }
  const counts = new Uint32Array(nodes.length);
  const stamp = new Int32Array(nodes.length).fill(-1);
  const stack: number[] = [];
  for (const [t, test] of nodes.entries()) {
    if (!suite.isTest(test)) continue;
    const reached: number[] = [];
    const visit = (id: number) => {
      if (stamp[id] === t) return;
      stamp[id] = t;
      reached.push(id);
    };
    visit(t);
    stack.push(t);
    while (stack.length > 0) {
      const at = stack.pop() ?? 0;
      for (const next of forward[at]) {
        if (stamp[next] === t) continue;
        visit(next);
        stack.push(next);
      }
    }
    for (const id of [...reached]) for (const read of direct[id]) visit(read);
    for (const id of reached) counts[id]++;
  }
  const result = new Map<string, number>();
  for (const [i, node] of nodes.entries()) result.set(node, counts[i]);
  return result;
}

export interface GraphReport {
  // Each suite's test count, and the tests that run on any change because
  // they reach a node whose dependencies are unknown.
  suites: Record<string, { tests: number; everyChange: string[] }>;
  nodes: {
    id: string;
    imports: string[];
    importers: string[];
    // How many of each suite's tests a change to it selects.
    tests: Record<string, number>;
    unknown: boolean;
  }[];
}

export function graphReport(
  graph: Graph,
  suites: readonly ResolvedSuite[],
  importers: (node: string) => readonly string[],
  everyChange: (suite: ResolvedSuite) => string[],
): GraphReport {
  const counts = suites.map(
    (suite) => [suite.name, fanIn(graph, suite)] as const,
  );
  const nodes = [...graph].map(([id, deps]) => ({
    id,
    imports: sorted(deps.files),
    importers: sorted(importers(id)),
    tests: Object.fromEntries(
      counts.map(([name, count]) => [name, count.get(id) ?? 0]),
    ),
    unknown: deps.unknown.length > 0,
  }));
  return {
    suites: Object.fromEntries(
      suites.map((suite) => [
        suite.name,
        {
          tests: [...graph.keys()].filter(suite.isTest).length,
          everyChange: everyChange(suite),
        },
      ]),
    ),
    nodes,
  };
}

// Bucket bounds for the histogram: 0, 1, then up to each power of ten.
function buckets(total: number): [number, number][] {
  const list: [number, number][] = [
    [0, 0],
    [1, 1],
  ];
  for (let low = 2, high = 10; low < total; low = high + 1, high *= 10) {
    list.push([low, Math.min(high, total - 1)]);
  }
  if (total > 1) list.push([total, total]);
  return list;
}

/** `bivium graph`'s text: per suite, the files that reach the most tests, and how files spread. */
export function formatGraph(report: GraphReport, top: number): string {
  const lines: string[] = [];
  const files = report.nodes.filter(
    ({ id }) => !id.startsWith("pkg:") && !id.includes("#"),
  );
  for (const [name, { tests, everyChange }] of Object.entries(report.suites)) {
    const any = everyChange.length;
    lines.push(
      `${name}: ${tests} ${tests === 1 ? "test" : "tests"}${any > 0 ? `; ${any} run on any change (\`bivium check\` says why)` : ""}`,
    );
    const ranked = files
      .map(({ id, tests: count }) => [id, count[name] ?? 0] as const)
      .filter(([, count]) => count > 0)
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
    const width = String(tests).length;
    if (ranked.length > 0) {
      lines.push(`  ${"tests".padStart(width)}  file`);
      for (const [id, count] of ranked.slice(0, top)) {
        lines.push(`  ${String(count).padStart(Math.max(width, 5))}  ${id}`);
      }
      if (ranked.length > top) {
        lines.push(`  … ${ranked.length - top} more (--top <n> shows more)`);
      }
    }
    lines.push(`  files by how many ${name} tests a change to one selects:`);
    const rows = buckets(tests).map(([low, high]) => {
      const label = low === high ? String(low) : `${low}–${high}`;
      const count = files.filter(({ tests: reached }) => {
        const n = reached[name] ?? 0;
        return n >= low && n <= high;
      }).length;
      return [label, count] as const;
    });
    const labelWidth = Math.max(...rows.map(([label]) => label.length));
    for (const [label, count] of rows) {
      lines.push(`    ${label.padStart(labelWidth)}  ${count}`);
    }
  }
  return lines.join("\n");
}
