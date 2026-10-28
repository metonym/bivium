import { fixFor } from "./check.ts";
import type { Computed } from "./compute.ts";
import type { PathMap, ResolvedConfig } from "./config.ts";
import { globToRegExp } from "./glob.ts";
import { affectedBy, gotoPage, type Via } from "./graph.ts";
import {
  annotationLine,
  callLine,
  causesOf,
  fileOf,
  gotoLine,
  lineText,
  sourceOf,
  specifierLine,
  textLine,
} from "./locate.ts";
import { createResolver, type Resolver } from "./resolve.ts";
import { extract, finish, formatOf, SCANNED } from "./scan.ts";
import { sorted } from "./sorted.ts";

// One edge of a chain: `node` depends on the next link's node.
interface Link {
  node: string;
  kind: Via["kind"];
  // `file:line` where the edge is spelled, when it can be found, and the
  // line itself.
  at?: string;
  text?: string;
}

interface Cause {
  cause: string;
  at?: string;
  text?: string;
  fix: string;
}

interface Chain {
  links: Link[];
  // The node the chain ends at, and why it seeds the walk.
  root: string;
  cause: string;
  // For a test that depends on everything: why, and where.
  unknown: Cause[];
}

type Explanation =
  | { kind: "full"; suite: string; reasons: string[] }
  | {
      kind: "unselected";
      suite: string;
      from?: string;
      // How many files changed against the base.
      changed: number;
      // For a given file: how many tests of each suite its chains reach,
      // and one of them, from this suite if it can be.
      reaches?: Record<string, number>;
      example?: string;
    }
  | ({
      kind: "chain";
      suite: string;
      test: string;
      // The other changes whose chains reach the test, and with `all`, their
      // chains. Empty for a given file, and for a test that depends on
      // every change.
      more: string[];
      others: Chain[];
    } & Chain);

interface Context {
  root: string;
  config: ResolvedConfig;
  computed: Computed;
  resolve: Resolver;
}

const CONFIG_EDGES = "edges in the config";
const CONFIG_READS = "reads in the config";

// Where `node` spells its edge to `via.from`, and the line.
async function edgeAt(
  context: Context,
  node: string,
  via: Via,
): Promise<{ at?: string; text?: string }> {
  if (via.kind === "edges") return { at: CONFIG_EDGES };
  if (via.kind === "unknown") return {};
  const file = fileOf(node);
  const source = SCANNED.test(file)
    ? await sourceOf(context.root, file)
    : undefined;
  // Whether a config `reads` entry gives `node` this edge: a file that
  // can't hold a comment, or a reader whose own `@reads` doesn't name it.
  const configured = (maps: PathMap[]) =>
    maps.some((map) => map.targets(node)?.some((re) => re.test(via.from)));
  if (via.kind === "reads" && configured(context.config.reads)) {
    const declared =
      source !== undefined &&
      extract(formatOf(file), source).reads.some((glob) =>
        globToRegExp(glob).test(via.from),
      );
    if (!declared) return { at: CONFIG_READS };
  }
  if (source === undefined) return {};
  const line = edgeLine(context, node, via, source);
  return line === undefined
    ? {}
    : { at: `${file}:${line}`, text: lineText(source, line) };
}

function edgeLine(
  { config, resolve }: Context,
  node: string,
  via: Via,
  source: string,
): number | undefined {
  const file = fileOf(node);
  const extraction = extract(formatOf(file), source);
  const matches = (glob: string) => globToRegExp(glob).test(via.from);
  if (via.kind === "reads" || via.kind === "depends-on") {
    const tag = `@${via.kind}`;
    const globs =
      via.kind === "reads" ? extraction.reads : extraction.dependsOn;
    const glob = globs.find(matches);
    return (
      (glob === undefined ? undefined : annotationLine(source, tag, glob)) ??
      textLine(source, tag)
    );
  }
  if (via.kind === "glob") {
    const relative = finish(file, extraction).globs;
    const glob = extraction.globs.find((_, i) => matches(relative[i]));
    return (
      (glob === undefined ? undefined : specifierLine(source, glob)) ??
      callLine(source, "import.meta.glob")
    );
  }
  const target = fileOf(via.from);
  if (via.kind === "goto") {
    const argument = extraction.gotos.find(
      (candidate) => gotoPage(config, file, candidate) === target,
    );
    return gotoLine(source, argument, target);
  }
  const loads = (specifier: string) => {
    const resolved = resolve(file, specifier);
    return (
      resolved !== undefined &&
      "files" in resolved &&
      resolved.files.includes(target)
    );
  };
  if (via.kind === "export") {
    const barrel = extraction.barrel;
    if (!barrel) return undefined;
    // The name's own re-export, or one with side effects any import runs.
    const own = barrel.names.get(node.slice(node.indexOf("#") + 1));
    const specifier = [
      ...(own === undefined ? [] : [own]),
      ...barrel.names.values(),
      ...barrel.stars,
    ].find(loads);
    return specifier === undefined
      ? undefined
      : specifierLine(source, specifier);
  }
  const imported = extraction.imports.find(({ specifier }) => loads(specifier));
  return imported === undefined
    ? undefined
    : specifierLine(source, imported.specifier);
}

function rootCause(
  computed: Computed,
  rootNode: string,
  from: string | undefined,
) {
  if (from !== undefined) return "given";
  if (computed.changed.includes(rootNode)) return "changed";
  const bumped = computed.plan.packageCauses.get(rootNode);
  if (bumped !== undefined) return bumped;
  if (computed.barrelNames.includes(rootNode)) return "barrel name moved";
  for (const { narrower, result } of computed.narrowed) {
    if ("seeds" in result && result.seeds.includes(rootNode)) {
      return `seeded by the ${narrower.name} narrower`;
    }
  }
  return "changed";
}

interface Walk {
  seeds: string[];
  opaque: ((path: string) => boolean) | undefined;
}

// The walks that selected the suite's tests, as planTests ran them.
function walks(
  computed: Computed,
  suite: string,
  from: string | undefined,
): Walk[] {
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

// The edges from `test` back to the seed the first walk that reaches it
// started from. A file with unknown dependencies ends the chain: it depends
// on every change, whichever one the walk started from.
function shortestChain(
  computed: Computed,
  candidates: Walk[],
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

// The seeds other than `except` whose walk alone reaches `test`. A walk from
// several seeds reaches what the walks from each reach, so this is every
// change that would select the test by itself.
function reachers(
  computed: Computed,
  candidates: Walk[],
  test: string,
  except: string,
): string[] {
  const found = new Set<string>();
  for (const { seeds, opaque } of candidates) {
    for (const seed of seeds) {
      if (seed === except || found.has(seed)) continue;
      if (affectedBy(computed.graph, [seed], { opaque }).has(test)) {
        found.add(seed);
      }
    }
  }
  return sorted(found);
}

async function chainOf(
  context: Context,
  { edges, root }: { edges: [string, Via][]; root: string },
  from: string | undefined,
): Promise<Chain> {
  const last = edges.at(-1);
  const [links, causes] = await Promise.all([
    Promise.all(
      edges.map(
        async ([node, via]): Promise<Link> => ({
          node,
          kind: via.kind,
          ...(await edgeAt(context, node, via)),
        }),
      ),
    ),
    last?.[1].kind === "unknown"
      ? causesOf(context.root, context.computed, last[0])
      : [],
  ]);
  return {
    links,
    root,
    cause: rootCause(context.computed, root, from),
    unknown: causes.map((cause) => ({ ...cause, fix: fixFor(cause.cause) })),
  };
}

function unselected(
  config: ResolvedConfig,
  computed: Computed,
  suite: string,
  from: string | undefined,
): Explanation {
  const changed = computed.changed.length;
  if (from === undefined) return { kind: "unselected", suite, changed };
  // What the file's own chains reach: a test that runs on every change
  // would be selected by any file, so it says nothing about this one.
  const reached = sorted(
    affectedBy(computed.graph, [from], { includeUnknown: false }),
  );
  const reaches: Record<string, number> = {};
  let example: string | undefined;
  for (const { name, isTest } of config.suites) {
    const tests = reached.filter((node) => isTest(node));
    if (tests.length === 0) continue;
    reaches[name] = tests.length;
    if (name === suite || example === undefined) example = tests[0];
  }
  return {
    kind: "unselected",
    suite,
    from,
    changed,
    reaches,
    ...(example !== undefined && { example }),
  };
}

/**
 * Why `test` is selected: the shortest chain of edges from it to a changed
 * file (or to `from`), with where each edge is spelled, and the other
 * changes that reach it (with `all`, their chains too).
 */
export async function explain(
  root: string,
  config: ResolvedConfig,
  computed: Computed,
  test: string,
  from?: string,
  { all = false }: { all?: boolean } = {},
): Promise<Explanation> {
  const suite = config.suites.find((candidate) => candidate.isTest(test));
  if (!suite) throw new Error(`bivium why: ${test} is no suite's test`);
  if (!computed.graph.has(test)) throw new Error(`bivium why: no file ${test}`);
  if (from === undefined && computed.plan.full.includes(suite.name)) {
    return { kind: "full", suite: suite.name, reasons: computed.plan.reasons };
  }
  const candidates = walks(computed, suite.name, from);
  const found = shortestChain(computed, candidates, test);
  if (!found) return unselected(config, computed, suite.name, from);
  const context: Context = {
    root,
    config,
    computed,
    resolve: createResolver({
      files: new Set(computed.graph.keys()),
      config,
      packages: computed.packages,
      tsconfigs: computed.tsconfigs,
    }),
  };
  const everything = found.edges.at(-1)?.[1].kind === "unknown";
  const more =
    from !== undefined || everything
      ? []
      : reachers(computed, candidates, test, found.root);
  const [chain, others] = await Promise.all([
    chainOf(context, found, from),
    Promise.all(
      (all ? more : []).map((seed) => {
        const alone = candidates.map((walk) => ({
          ...walk,
          seeds: walk.seeds.filter((candidate) => candidate === seed),
        }));
        const other = shortestChain(computed, alone, test);
        return other && chainOf(context, other, undefined);
      }),
    ),
  ]);
  return {
    kind: "chain",
    suite: suite.name,
    test,
    ...chain,
    more,
    others: others.filter((other) => other !== undefined),
  };
}

type Format = "tree" | "chain" | "source";

const FORMATS: readonly Format[] = ["tree", "chain", "source"];

export function isFormat(value: string): value is Format {
  return FORMATS.some((format) => format === value);
}

// How a node is reached, in a chain read from the change to the test.
const VERBS: Record<Exclude<Via["kind"], "export">, string> = {
  import: "imported by",
  goto: "opened by",
  html: "loaded by page",
  name: "imported by",
  glob: "globbed by",
  "depends-on": "depended on by",
  edges: "an input of",
  reads: "read as text by",
  unknown: "depends on every change",
};

const LIST = 3;

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function nameOf(node: string) {
  return node.slice(node.indexOf("#") + 1);
}

// Rows of text with an optional location, the locations in one column.
function aligned(rows: [string, string | undefined][]): string[] {
  const width = Math.max(
    0,
    ...rows.filter(([, at]) => at !== undefined).map(([text]) => text.length),
  );
  return rows.map(([text, at]) =>
    at === undefined ? text : `${text.padEnd(width)}    ${at}`,
  );
}

function tree(test: string, chain: Chain): string[] {
  const rows: [string, string | undefined][] = [[test, undefined]];
  const width = Math.max(
    0,
    ...chain.links
      .filter((link) => link.kind !== "unknown")
      .map((link) => link.kind.length),
  );
  let indent = "";
  for (const [i, link] of chain.links.entries()) {
    const next = chain.links[i + 1]?.node ?? chain.root;
    if (link.kind === "unknown") {
      rows.push([`${indent}└─ depends on every change:`, undefined]);
      for (const { cause, at } of chain.unknown) {
        rows.push([`${indent}   ✗ ${cause}`, at]);
      }
      indent += "   ";
      rows.push([`${indent}└─ ${next}`, undefined]);
      indent += "   ";
      break;
    }
    rows.push([`${indent}└─ ${link.kind.padEnd(width)}  ${next}`, link.at]);
    indent += "   ";
  }
  rows.push([`${indent}● ${chain.cause}`, undefined]);
  return aligned(rows);
}

function verbOf(link: Link) {
  return link.kind === "export"
    ? `exported as ${nameOf(link.node)}`
    : VERBS[link.kind];
}

function whereOf(link: Link) {
  if (link.kind === "edges") return `${link.node} (${CONFIG_EDGES})`;
  return link.at ?? link.node;
}

// Steps from the change to the test: each one reached, and where.
function steps(links: Link[]): string[] {
  const rows = [...links]
    .reverse()
    .map((link): [string, string] => [verbOf(link), whereOf(link)]);
  const width = Math.max(0, ...rows.map(([verb]) => verb.length));
  return rows.map(
    ([verb, where], i) =>
      `${verb.padEnd(width)}  ${where}${i === rows.length - 1 ? "  ← selected" : ""}`,
  );
}

function header({ root, cause }: Chain) {
  if (cause === "changed") return `${root} changed`;
  if (cause === "given") return `if ${root} changes`;
  return `${root}: ${cause}`;
}

function chained(test: string, chain: Chain): string[] {
  const unknownAt = chain.links.findIndex((link) => link.kind === "unknown");
  if (unknownAt === -1) {
    return [header(chain), ...steps(chain.links).map((step) => `  ${step}`)];
  }
  const node = chain.links[unknownAt].node;
  const where = chain.unknown.map(({ at }) => at ?? node);
  const width = Math.max(0, ...where.map((at) => at.length));
  const lines = [`${test} runs on every change`];
  for (const [i, { cause, fix }] of chain.unknown.entries()) {
    lines.push(
      `  because ${where[i].padEnd(width)}  ${cause}`,
      `    fix: ${fix}`,
    );
  }
  if (unknownAt > 0) {
    lines.push(
      `  reached via ${node}`,
      ...steps(chain.links.slice(0, unknownAt)).map((step) => `    ${step}`),
    );
  }
  return lines;
}

const LINE_NUMBER = /:(\d+)$/;

function lineNumber(at: string | undefined) {
  return at === undefined ? undefined : LINE_NUMBER.exec(at)?.[1];
}

function sourced(test: string, chain: Chain): string[] {
  const unknownAt = chain.links.findIndex((link) => link.kind === "unknown");
  const hops = unknownAt === -1 ? chain.links : chain.links.slice(0, unknownAt);
  const numbers = [...chain.links, ...chain.unknown].map(({ at }) =>
    lineNumber(at),
  );
  const width = Math.max(0, ...numbers.map((n) => n?.length ?? 0));
  const gutter = " ".repeat(width);
  const cited = (at: string | undefined, text: string | undefined) => {
    const n = lineNumber(at);
    return n === undefined || text === undefined
      ? []
      : [`${n.padStart(width)} | ${text}`];
  };
  const count = plural(hops.length, "hop", "hops");
  const lines =
    unknownAt === -1
      ? [
          `selected: ${test} ← ${chain.root} (${count}${chain.cause === "changed" ? "" : `, ${chain.cause}`})`,
        ]
      : [
          `selected: ${test} ← every change (${unknownAt === 0 ? "its dependencies can't be read" : `${count} to ${chain.links[unknownAt].node}, whose dependencies can't be read`})`,
        ];
  lines.push("");
  for (const link of hops) {
    const where = link.kind === "edges" ? link.node : (link.at ?? link.node);
    const kind = link.kind === "edges" ? CONFIG_EDGES : link.kind;
    lines.push(`${gutter}--> ${where}  ${kind}`, ...cited(link.at, link.text));
  }
  if (unknownAt === -1) {
    lines.push(`${gutter}● ${chain.root}: ${chain.cause}`);
    return lines;
  }
  const node = chain.links[unknownAt].node;
  for (const { cause, at, text, fix } of chain.unknown) {
    lines.push(
      `${gutter}✗ ${at ?? node}  ${cause}`,
      ...cited(at, text),
      `${gutter} = fix: ${fix}`,
    );
  }
  return lines;
}

const RENDER: Record<Format, (test: string, chain: Chain) => string[]> = {
  tree,
  chain: chained,
  source: sourced,
};

function moreLine(more: string[], all: boolean) {
  const shown = more.slice(0, LIST).join(", ");
  const rest = more.length > LIST ? ", …" : "";
  const changes = plural(
    more.length,
    "more change reaches",
    "more changes reach",
  );
  const hint = all ? "" : " (--all shows each chain)";
  return `+ ${changes} this test: ${shown}${rest}${hint}`;
}

function unselectedMessage(
  explanation: Extract<Explanation, { kind: "unselected" }>,
) {
  const { from, changed, reaches, example } = explanation;
  if (from === undefined) {
    return changed === 0
      ? "Not selected: nothing changed."
      : `Not selected: ${changed === 1 ? "the changed file doesn't reach" : `none of the ${changed} changed files reaches`} it.`;
  }
  const counts = Object.entries(reaches ?? {}).map(
    ([suite, count]) => `${count} ${suite}`,
  );
  const total = Object.values(reaches ?? {}).reduce((a, b) => a + b, 0);
  return [
    `Not selected by a change to ${from}: no chain reaches it.`,
    total === 0
      ? "Its chains reach no test."
      : `Its chains reach ${plural(total, "test", "tests")} (${counts.join(", ")}), such as ${example}.`,
  ].join("\n");
}

/** `why`'s output, in one of its formats. */
export function formatExplanation(
  explanation: Explanation,
  format: Format = "tree",
): string {
  if (explanation.kind === "full") {
    return [
      `The ${explanation.suite} suite runs in full:`,
      ...explanation.reasons.map((reason) => `  ${reason}`),
    ].join("\n");
  }
  if (explanation.kind === "unselected") return unselectedMessage(explanation);
  const { test, more, others } = explanation;
  const render = RENDER[format];
  const lines = render(test, explanation);
  if (more.length > 0) lines.push(moreLine(more, others.length > 0));
  for (const other of others) lines.push("", ...render(test, other));
  return lines.join("\n");
}
