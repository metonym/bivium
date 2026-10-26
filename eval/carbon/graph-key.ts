import type { FileDeps, Graph } from "../../src/graph.ts";
import { sorted } from "../../src/sorted.ts";

function nodeKey(path: string, deps: FileDeps) {
  return [
    path,
    sorted(deps.files),
    deps.patterns.map(String),
    deps.reads.map(String),
    deps.unknown,
    deps.barrel ? [...deps.barrel] : null,
  ];
}

/**
 * A graph as canonical text: every node with its edges, patterns, reads,
 * unknowns and barrel names, so two graphs are equal exactly when their
 * keys are.
 */
export function graphKey(graph: Graph): string {
  const nodes = sorted(graph.keys()).flatMap((path) => {
    const deps = graph.get(path);
    return deps ? [nodeKey(path, deps)] : [];
  });
  return JSON.stringify(nodes);
}

/** The first node whose entry differs, for a report. */
export function firstDifference(a: Graph, b: Graph): string | undefined {
  for (const path of sorted(new Set([...a.keys(), ...b.keys()]))) {
    const one = a.get(path);
    const other = b.get(path);
    if (!one || !other) return path;
    const same =
      JSON.stringify(nodeKey(path, one)) ===
      JSON.stringify(nodeKey(path, other));
    if (!same) return path;
  }
  return undefined;
}
