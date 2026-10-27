import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Computed } from "./compute.ts";
import type { PathMap, ResolvedConfig } from "./config.ts";
import { globToRegExp } from "./glob.ts";
import { affectedBy, type Via } from "./graph.ts";
import { causeLine, specifierLine, textLine } from "./locate.ts";
import { createResolver } from "./resolve.ts";
import { extract, formatOf, SCANNED } from "./scan.ts";

// One edge of a chain: `node` depends on the next link's node.
interface Link {
  node: string;
  kind: Via["kind"];
  // `file:line` where the edge is spelled, when it can be found.
  at?: string;
}

export type Explanation =
  | { kind: "full"; suite: string; reasons: string[] }
  | { kind: "unselected"; suite: string; from?: string }
  | {
      kind: "chain";
      suite: string;
      test: string;
      links: Link[];
      // The node the chain ends at, and why it seeds the walk.
      root: string;
      cause: string;
      // For a test that depends on everything: why, and where.
      unknown: { cause: string; at?: string }[];
    };

export async function sourceOf(root: string, file: string) {
  try {
    // A config file outside the repository is absolute.
    return await readFile(isAbsolute(file) ? file : join(root, file), "utf-8");
  } catch {
    return;
  }
}

function fileOf(node: string) {
  const hash = node.indexOf("#");
  return hash === -1 ? node : node.slice(0, hash);
}

// Where `node` spells its edge to `target`.
async function edgeAt(
  root: string,
  config: ResolvedConfig,
  computed: Computed,
  node: string,
  via: Via,
): Promise<string | undefined> {
  const file = fileOf(node);
  // Whether a config `edges` or `reads` entry gives `node` this edge.
  const configured = (maps: PathMap[]) =>
    maps.some((map) => map.targets(node)?.some((re) => re.test(via.from)));
  const source = SCANNED.test(file) ? await sourceOf(root, file) : undefined;
  if (source === undefined) {
    if (via.kind === "glob" && configured(config.generated)) {
      return "edges in the config";
    }
    if (via.kind === "reads" && configured(config.reads)) {
      return "reads in the config";
    }
    return undefined;
  }
  const extraction = extract(formatOf(file), source);
  const at = (line: number | undefined) =>
    line === undefined ? undefined : `${file}:${line}`;
  const names = (globs: string[]) =>
    globs.some((glob) => globToRegExp(glob).test(via.from));
  if (via.kind === "reads") {
    if (!names(extraction.reads) && configured(config.reads)) {
      return "reads in the config";
    }
    return at(textLine(source, "@reads"));
  }
  if (via.kind === "unknown") return undefined;
  if (via.kind === "glob") {
    if (names(extraction.dependsOn)) return at(textLine(source, "@depends-on"));
    if (configured(config.generated)) return "edges in the config";
    if (extraction.globs.length > 0)
      return at(textLine(source, "import.meta.glob"));
    return "edges in the config";
  }
  if (node.includes("#")) {
    const name = node.slice(node.indexOf("#") + 1);
    const specifier = extraction.barrel?.names.get(name);
    return specifier === undefined
      ? undefined
      : at(specifierLine(source, specifier));
  }
  const resolve = createResolver({
    files: new Set(computed.graph.keys()),
    config,
    packages: computed.packages,
    tsconfigs: computed.tsconfigs,
  });
  const target = fileOf(via.from);
  for (const { specifier } of extraction.imports) {
    const resolved = resolve(file, specifier);
    if (resolved && "files" in resolved && resolved.files.includes(target)) {
      return at(specifierLine(source, specifier));
    }
  }
  // A page a `goto()` opens, by its name in the URL.
  return at(textLine(source, target.slice(target.lastIndexOf("/") + 1)));
}

function rootCause(
  computed: Computed,
  rootNode: string,
  from: string | undefined,
) {
  if (from !== undefined) return "given";
  if (computed.changed.includes(rootNode)) return "changed";
  if (computed.barrelNames.includes(rootNode)) return "barrel name moved";
  for (const { narrower, result } of computed.narrowed) {
    if ("seeds" in result && result.seeds.includes(rootNode)) {
      return `seeded by the ${narrower.name} narrower`;
    }
  }
  return "changed";
}

// Why a node depends on every change, and where each cause is spelled.
export async function causesOf(
  root: string,
  computed: Computed,
  node: string,
): Promise<{ cause: string; at?: string }[]> {
  const file = fileOf(node);
  const source = await sourceOf(root, file);
  return (computed.graph.get(node)?.unknown ?? []).map((cause) => {
    const line = source === undefined ? undefined : causeLine(source, cause);
    return line === undefined ? { cause } : { cause, at: `${file}:${line}` };
  });
}

// The walks that selected the suite's tests, as planTests ran them.
function walks(computed: Computed, suite: string, from: string | undefined) {
  const { plan, graph } = computed;
  if (from !== undefined) return [{ seeds: [from], opaque: undefined }];
  const narrowings = plan.narrowings.get(suite);
  if (!narrowings) return [{ seeds: plan.seeds, opaque: undefined }];
  const matched = new Set(narrowings.flatMap((narrowing) => narrowing.matched));
  return [
    {
      seeds: plan.seeds.filter((seed) => !matched.has(seed)),
      opaque: undefined,
    },
    ...narrowings.map((narrowing) => ({
      seeds: [...narrowing.matched, ...narrowing.seeds].filter(
        (seed) => graph.has(seed) || computed.changed.includes(seed),
      ),
      opaque: narrowing.narrower.opaque,
    })),
  ];
}

/**
 * Why `test` is selected: the shortest chain of edges from it to a changed
 * file (or to `from`), with where each edge is spelled.
 */
export async function explain(
  root: string,
  config: ResolvedConfig,
  computed: Computed,
  test: string,
  from?: string,
): Promise<Explanation> {
  const suite = config.suites.find((candidate) => candidate.isTest(test));
  if (!suite) throw new Error(`bivium why: ${test} is no suite's test`);
  if (!computed.graph.has(test)) throw new Error(`bivium why: no file ${test}`);
  if (from === undefined && computed.plan.full.includes(suite.name)) {
    return { kind: "full", suite: suite.name, reasons: computed.plan.reasons };
  }
  const chain = shortestChain(
    computed,
    walks(computed, suite.name, from),
    test,
  );
  if (!chain) return { kind: "unselected", suite: suite.name, from };
  const [links, unknown] = await Promise.all([
    Promise.all(
      chain.edges.map(
        async ([node, via]): Promise<Link> => ({
          node,
          kind: via.kind,
          at: await edgeAt(root, config, computed, node, via),
        }),
      ),
    ),
    chain.edges.at(-1)?.[1].kind === "unknown"
      ? causesOf(root, computed, chain.edges.at(-1)?.[0] ?? test)
      : [],
  ]);
  return {
    kind: "chain",
    suite: suite.name,
    test,
    links,
    root: chain.root,
    cause: rootCause(computed, chain.root, from),
    unknown,
  };
}

// The edges from `test` back to the seed the first walk that reaches it
// started from. A file with unknown dependencies ends the chain: it depends
// on every change, whichever one the walk started from.
function shortestChain(
  computed: Computed,
  candidates: {
    seeds: string[];
    opaque: ((path: string) => boolean) | undefined;
  }[],
  test: string,
): { edges: [string, Via][]; root: string } | undefined {
  for (const walk of candidates) {
    const parents = new Map<string, Via>();
    const reached = affectedBy(computed.graph, walk.seeds, {
      opaque: walk.opaque,
      parents,
    });
    if (!reached.has(test)) continue;
    const edges: [string, Via][] = [];
    let node = test;
    for (let via = parents.get(node); via; via = parents.get(node)) {
      edges.push([node, via]);
      node = via.from;
      if (via.kind === "unknown") break;
    }
    return { edges, root: node };
  }
  return undefined;
}

/** `why`'s output, as plan §2.3 sketches it. */
export function formatExplanation(explanation: Explanation): string {
  if (explanation.kind === "full") {
    return [
      `The ${explanation.suite} suite runs in full:`,
      ...explanation.reasons.map((reason) => `  ${reason}`),
    ].join("\n");
  }
  if (explanation.kind === "unselected") {
    return explanation.from === undefined
      ? "Not selected: no change reaches it."
      : `Not selected by a change to ${explanation.from}: no chain reaches it.`;
  }
  const lines = [explanation.test];
  let indent = "";
  for (const [i, link] of explanation.links.entries()) {
    const next = explanation.links[i + 1]?.node ?? explanation.root;
    if (link.kind === "unknown") {
      lines.push(`${indent}└─ depends on every change:`);
      for (const { cause, at } of explanation.unknown) {
        lines.push(`${indent}   ✗ ${cause}${at ? `    ${at}` : ""}`);
      }
      indent += "   ";
      lines.push(`${indent}└─ ${next}`);
      indent += "   ";
      break;
    }
    lines.push(
      `${indent}└─ ${link.kind.padEnd(6)}  ${next}${link.at ? `    ${link.at}` : ""}`,
    );
    indent += "   ";
  }
  lines.push(`${indent}● ${explanation.cause}`);
  return lines.join("\n");
}
