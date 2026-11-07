// The subset of YAML that `pnpm-lock.yaml` and GitHub Actions workflows are
// written in: block mappings and sequences by indentation, plain (over
// several lines too), quoted and block (`|`, `>`) scalars, and comments.
// A flow collection (`{integrity: …}`, `[x64]`) is kept as its text, which
// is all a lockfile diff compares. Anything else (anchors, tags, a flow
// collection over several lines) throws: the caller then can't read the
// file, and fails closed.

export type Yaml = string | Yaml[] | { [key: string]: Yaml };

interface Line {
  indent: number;
  text: string;
  number: number;
  // A tab in its indentation, which only a block scalar's text may have.
  tab: boolean;
}

const COMMENT = /\s+#.*$/;
const KEY_END = /:(?: |$)/;
const EMPTY_MAP = /^\{\s*\}(?:\s+#.*)?$/;
const EMPTY_LIST = /^\[\s*\](?:\s+#.*)?$/;
const UNSUPPORTED = /^[&*!|>%@`]/;
const BLOCK_SCALAR = /^([|>])([1-9]?)([-+]?)([1-9]?)(?:\s+#.*)?$/;
const LEADING_SPACES = /^ */;
const DOCUMENT_START = /^---(?:\s|$)/;
const QUOTED_OR_FLOW = /^['"{[]/;
// In a folded scalar, a line break between two lines of text is a space,
// and a run of blank lines is that many newlines less one. More-indented
// lines keep their breaks.
const FOLDED_BREAK = /([^\n])\n(?=[^\n ])/g;
const BLANK_RUN = /\n(\n+)/g;

class YamlError extends Error {}

function fail(line: Line | undefined, message: string): never {
  throw new YamlError(`${message} at line ${line?.number ?? "end"}`);
}

function sourceOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function linesOf(source: string[]): Line[] {
  const lines: Line[] = [];
  for (const [i, line] of source.entries()) {
    const content = line.trimStart();
    if (content === "" || content.startsWith("#")) continue;
    // A document's start marker, before its first line.
    if (lines.length === 0 && DOCUMENT_START.test(content)) continue;
    const indent = line.length - content.length;
    const tab = line.slice(0, indent).includes("\t");
    lines.push({ indent, text: content.trimEnd(), number: i + 1, tab });
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
  readonly source: string[];
  readonly lines: Line[];

  constructor(source: string[]) {
    this.source = source;
    this.lines = linesOf(source);
  }

  // The next line, as a key or a sequence item: its indentation can't have
  // a tab.
  next(): Line | undefined {
    const line = this.lines[this.at];
    if (line?.tab) fail(line, "a tab in indentation");
    return line;
  }

  // A `|` or `>` scalar's text: the source lines after `line` indented past
  // `indent`, and the blank lines among them. Comments in it are text.
  blockScalar(header: RegExpExecArray, indent: number, line: Line): string {
    const [, style, before, chomp, after] = header;
    const explicit = Number(before || after || 0);
    let width = explicit === 0 ? 0 : indent + explicit;
    const body: string[] = [];
    let end = 0;
    for (const raw of this.source.slice(line.number)) {
      if (raw.trim() === "") {
        body.push("");
        continue;
      }
      const spaces = LEADING_SPACES.exec(raw)?.[0].length ?? 0;
      if (spaces <= indent) break;
      if (width === 0) width = spaces;
      if (spaces < width) fail(line, "a block scalar line indented too little");
      body.push(raw.slice(width));
      end = body.length;
    }
    const last = line.number + end;
    while ((this.lines[this.at]?.number ?? Number.POSITIVE_INFINITY) <= last)
      this.at++;
    const lines = body.slice(0, end);
    const text =
      style === "|"
        ? lines.join("\n")
        : lines
            .join("\n")
            .replace(FOLDED_BREAK, "$1 ")
            .replace(BLANK_RUN, "$1");
    if (end === 0 || chomp === "-") return text;
    // `+` keeps the blank lines after the text; the default, one newline.
    return `${text}\n${chomp === "+" ? "\n".repeat(body.length - end) : ""}`;
  }

  // A plain scalar, and the lines indented past `indent` that continue it,
  // folded with spaces.
  plain(text: string, indent: number, line: Line): string {
    const value = scalar(text, line);
    if (QUOTED_OR_FLOW.test(text)) return value;
    const parts = [value];
    for (
      let next = this.lines[this.at];
      next && next.indent > indent;
      next = this.lines[this.at]
    ) {
      this.at++;
      parts.push(next.text.replace(COMMENT, ""));
    }
    return parts.join(" ");
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
    const header = BLOCK_SCALAR.exec(text);
    if (header) return this.blockScalar(header, indent, line);
    if (text !== "" && !text.startsWith("#")) {
      return this.plain(text, indent, line);
    }
    const next = this.lines[this.at];
    return next && next.indent > indent ? this.block(next.indent) : "";
  }

  mapping(
    indent: number,
    into: { [key: string]: Yaml },
  ): { [key: string]: Yaml } {
    for (let line = this.next(); line; line = this.next()) {
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
    for (let line = this.next(); line; line = this.next()) {
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

/** One YAML document in the subset above. Throws otherwise. */
export function parseYaml(text: string): Yaml {
  const parser = new Parser(sourceOf(text));
  const value = parser.block(0);
  const left = parser.lines[parser.at];
  if (left) fail(left, "unexpected indentation");
  return value;
}
