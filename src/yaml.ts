// The subset of YAML that `pnpm-lock.yaml` is written in: block mappings
// and sequences by indentation, plain and quoted scalars, and comments.
// A flow collection (`{integrity: …}`, `[x64]`) is kept as its text, which
// is all a lockfile diff compares. Anything else (anchors, tags, block
// scalars, a flow collection over several lines) throws: the caller then
// can't read the file, and fails closed.

export type Yaml = string | Yaml[] | { [key: string]: Yaml };

interface Line {
  indent: number;
  text: string;
  number: number;
}

const COMMENT = /\s+#.*$/;
const KEY_END = /:(?: |$)/;
const EMPTY_MAP = /^\{\s*\}(?:\s+#.*)?$/;
const EMPTY_LIST = /^\[\s*\](?:\s+#.*)?$/;
const UNSUPPORTED = /^[&*!|>%@`]/;

class YamlError extends Error {}

function fail(line: Line | undefined, message: string): never {
  throw new YamlError(`${message} at line ${line?.number ?? "end"}`);
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const content = line.trimStart();
    if (content === "" || content.startsWith("#")) continue;
    const indent = line.length - content.length;
    if (line.slice(0, indent).includes("\t")) {
      fail({ indent, text: content, number: i + 1 }, "a tab in indentation");
    }
    lines.push({ indent, text: content.trimEnd(), number: i + 1 });
  }
  return lines;
}

// The index after the quoted scalar opening at `start`, or -1.
function quoteEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (quote === "'" && text[i] === "'") {
      if (text[i + 1] === "'") i++;
      else return i + 1;
    } else if (quote === '"' && text[i] === "\\") i++;
    else if (quote === '"' && text[i] === '"') return i + 1;
  }
  return -1;
}

function unquote(quoted: string): string {
  if (quoted.startsWith("'")) return quoted.slice(1, -1).replaceAll("''", "'");
  const value: unknown = JSON.parse(quoted);
  if (typeof value !== "string") throw new YamlError("bad quoted scalar");
  return value;
}

// A flow collection's text, which must close on its line.
function flowEnd(text: string, line: Line): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = quoteEnd(text, i);
      if (end === -1) fail(line, "an unterminated string");
      i = end - 1;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return i + 1;
    }
  }
  return fail(line, "a flow collection over several lines");
}

function scalar(text: string, line: Line): string {
  if (text.startsWith("'") || text.startsWith('"')) {
    const end = quoteEnd(text, 0);
    if (end === -1) fail(line, "an unterminated string");
    if (text.slice(end).replace(COMMENT, "").trim() !== "") {
      fail(line, "text after a quoted scalar");
    }
    return unquote(text.slice(0, end));
  }
  if (text.startsWith("{") || text.startsWith("[")) {
    const end = flowEnd(text, line);
    if (text.slice(end).replace(COMMENT, "").trim() !== "") {
      fail(line, "text after a flow collection");
    }
    return text.slice(0, end);
  }
  if (UNSUPPORTED.test(text)) fail(line, `unsupported syntax "${text[0]}"`);
  return text.replace(COMMENT, "");
}

// A mapping line's key and the text after its `:`, or `undefined` if the
// line isn't one.
function keyOf(
  text: string,
  line: Line,
): { key: string; rest: string } | undefined {
  if (text.startsWith("'") || text.startsWith('"')) {
    const end = quoteEnd(text, 0);
    if (end === -1) fail(line, "an unterminated key");
    if (text[end] !== ":") return undefined;
    return { key: unquote(text.slice(0, end)), rest: text.slice(end + 1) };
  }
  const colon = text.search(KEY_END);
  if (colon === -1) return undefined;
  return { key: text.slice(0, colon), rest: text.slice(colon + 1) };
}

class Parser {
  at = 0;
  readonly lines: Line[];

  constructor(lines: Line[]) {
    this.lines = lines;
  }

  // The block whose lines are indented exactly `indent`.
  block(indent: number): Yaml {
    const first = this.lines[this.at];
    if (!first || first.indent !== indent) return "";
    return first.text === "-" || first.text.startsWith("- ")
      ? this.sequence(indent)
      : this.mapping(indent, {});
  }

  // A value after a key or a `-`: inline, or the block indented under it.
  // An empty flow collection is an empty one; any other is its text.
  value(rest: string, indent: number, line: Line): Yaml {
    const text = rest.trim();
    if (EMPTY_MAP.test(text)) return {};
    if (EMPTY_LIST.test(text)) return [];
    if (text !== "" && !text.startsWith("#")) return scalar(text, line);
    const next = this.lines[this.at];
    return next && next.indent > indent ? this.block(next.indent) : "";
  }

  mapping(
    indent: number,
    into: { [key: string]: Yaml },
  ): { [key: string]: Yaml } {
    for (let line = this.lines[this.at]; line; line = this.lines[this.at]) {
      if (line.indent < indent) break;
      if (line.indent > indent) fail(line, "unexpected indentation");
      const entry = keyOf(line.text, line);
      if (!entry) fail(line, "a line that isn't a key");
      if (Object.hasOwn(into, entry.key)) fail(line, "a duplicate key");
      this.at++;
      into[entry.key] = this.value(entry.rest, indent, line);
    }
    return into;
  }

  sequence(indent: number): Yaml[] {
    const items: Yaml[] = [];
    for (let line = this.lines[this.at]; line; line = this.lines[this.at]) {
      if (line.indent < indent) break;
      if (line.indent > indent) fail(line, "unexpected indentation");
      if (line.text !== "-" && !line.text.startsWith("- ")) break;
      this.at++;
      const text = line.text.slice(1).trimStart();
      const inner = { ...line, indent: line.indent + 2, text };
      // `- key: value` opens a mapping whose other keys line up with it.
      if (text !== "" && keyOf(text, line)) {
        this.lines.splice(this.at, 0, inner);
        items.push(this.mapping(inner.indent, {}));
      } else {
        items.push(this.value(text, indent, line));
      }
    }
    return items;
  }
}

/** One YAML document in the subset `pnpm-lock.yaml` uses. Throws otherwise. */
export function parseYaml(text: string): Yaml {
  const parser = new Parser(linesOf(text));
  const value = parser.block(0);
  const left = parser.lines[parser.at];
  if (left) fail(left, "unexpected indentation");
  return value;
}
