// Terminal output shared by metonym's command-line tools: color, tables,
// trees, the closing line and the progress line. Each tool carries an
// identical copy, since a package here has no runtime dependencies; a
// change is made once and copied to all of them.

/**
 * Color for the human format on a terminal only: the agent format and
 * JSON are read by programs. Each color marks a verdict or recedes,
 * never decorates.
 */
export type Paint = {
  good: (text: string) => string;
  warn: (text: string) => string;
  bad: (text: string) => string;
  dim: (text: string) => string;
  bold: (text: string) => string;
  faint: (text: string) => string;
};

const asIs = (text: string) => text;

export const PLAIN: Paint = {
  good: asIs,
  warn: asIs,
  bad: asIs,
  dim: asIs,
  bold: asIs,
  faint: asIs,
};

// The 16 ANSI colors, never a fixed hex: each terminal theme defines
// its own green or gray, picked to read on its own background, light,
// dark or pink. The codes are written out, not asked of Bun.color, so
// a package that also runs on Node prints the same.
export function createPaint(): Paint {
  const wrap = (code: number) => (text: string) =>
    text === "" ? text : `\x1b[${code}m${text}\x1b[39m`;
  return {
    good: wrap(32),
    warn: wrap(33),
    bad: wrap(31),
    // Bright black, the gray every theme dims secondary text with.
    dim: wrap(90),
    // Bold is a weight, not a color: names and section heads.
    bold: (text) => (text === "" ? text : `\x1b[1m${text}\x1b[22m`),
    // Faint is the text color at lower intensity, so a table's header
    // recedes in every theme, even one whose gray is odd.
    faint: (text) => (text === "" ? text : `\x1b[2m${text}\x1b[22m`),
  };
}

// The person's explicit ask wins, because they know where the output
// goes: the flag, then NO_COLOR and FORCE_COLOR (no-color.org,
// force-color.org). Otherwise color only for a terminal that reads
// escape codes and no coding agent reads, since they're noise to
// a program.
export function wantsColor(
  forced: boolean | undefined,
  terminal: boolean,
  env: Readonly<Record<string, string | undefined>>,
  agent: boolean,
): boolean {
  if (forced !== undefined) return forced;
  if ((env.NO_COLOR ?? "") !== "") return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0";
  return terminal && !agent && !isDumb(env);
}

// TERM=dumb says the terminal knows no escape sequence: no color, and no
// carriage-return redraw, so a progress line would print every frame.
export const isDumb = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => env.TERM === "dumb";

// "n/a", because an em dash for a missing value reads as punctuation.
export const MISSING = "n/a";

// A zero difference has no sign, so "±" only ever means noise. The
// minus is ASCII, so a pasted number parses.
export const signed = (value: number, show: (n: number) => string): string =>
  value === 0 ? show(0) : `${value > 0 ? "+" : "-"}${show(Math.abs(value))}`;

// The one separator, so every header and status line splits its parts
// the same way.
export const SEPARATOR = " · ";

// A sub-row's branch, so a group's last row closes it: ├ then └.
export const branch = (index: number, count: number): string =>
  index === count - 1 ? "└ " : "├ ";

// A note under a row, indented past the label's branch, as a reason or
// a problem that would push the row past 80 columns.
export const NOTE_INDENT = "    ";

// The last line of a run that finished: what it did and what it took,
// so a person sees it ended and why it took that long.
export function closingLine(
  paint: Paint,
  what: string,
  detail?: string,
): string {
  return `${paint.good("✓")} ${what}${detail === undefined ? "" : paint.dim(`${SEPARATOR}${detail}`)}`;
}

// A run that found problems ends in a cross, so the last line says
// whether to act, as the check mark does when there's nothing to do.
export function failLine(paint: Paint, what: string, detail?: string): string {
  return `${paint.bad("✗")} ${what}${detail === undefined ? "" : paint.dim(`${SEPARATOR}${detail}`)}`;
}

// Cut at a word boundary, so a label never ends mid-word; JSON keeps
// it whole.
export function truncateWords(text: string, max: number): string {
  if ([...text].length <= max) return text;
  const cut = [...text].slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

// Since the file name matters more than its folders, and its first and
// last words more than its middle, folders go from the left first, then
// the stem's middle words, and the build hash and extension always stay,
// as in …/carbon-…DataTableSkeleton-Lp9Rk3Ds.js.
const HASH_TAIL = /[-.][^-./]+\.\w+$/;
const WORD_END = /(?<=[-_.])/;
const width = (text: string) => [...text].length;

export function truncatePath(path: string, max: number): string {
  if (width(path) <= max) return path;
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  for (let keep = parts.length - 1; keep >= 0; keep--) {
    const candidate = `…/${[...parts.slice(parts.length - keep), name].join("/")}`;
    if (width(candidate) <= max) return candidate;
  }
  const prefix = parts.length > 0 ? "…/" : "";
  const tail = HASH_TAIL.exec(name)?.[0] ?? "";
  const stem = name.slice(0, name.length - tail.length);
  const room = max - width(prefix) - width(tail) - 1;
  if (room < 4)
    return `${prefix}…${[...name].slice(-(max - width(prefix) - 1)).join("")}`;
  const words = stem.split(WORD_END);
  const first = words[0] ?? "";
  let end = "";
  for (let i = words.length - 1; i > 0; i--) {
    const word = words[i] ?? "";
    if (width(first) + 1 + width(word + end) > room) break;
    end = word + end;
  }
  return end === ""
    ? `${prefix}${[...stem].slice(0, room).join("")}…${tail}`
    : `${prefix}${first}…${end}${tail}`;
}

// A mark in the left margin for a row that needs work, in its rating's
// color, so a scan finds what to fix while the numbers stay plain.
export function withGutter(
  lines: readonly string[],
  marks: ReadonlyMap<number, (text: string) => string>,
): string[] {
  return lines.map((line, i) => {
    const mark = marks.get(i);
    return mark === undefined ? line : `${mark("▌")}${line.slice(1)}`;
  });
}

// eslint-disable-next-line no-control-regex -- escape codes are what it strips
const ESCAPE = /\x1b\[[0-9;]*m/g;
// eslint-disable-next-line no-control-regex -- escape codes are what it skips
const LEADING_ESCAPE = /^\x1b\[[0-9;]*m/;

// Widths come from Bun when it runs, since it counts wide characters;
// a package that also runs on Node counts one column per code point,
// because the text these tools print has no wide ones.
export const textWidth = (text: string): number =>
  typeof Bun === "undefined"
    ? [...text.replace(ESCAPE, "")].length
    : Bun.stringWidth(text);

// 80 columns, because that's the width a terminal opens at.
export const MEASURE = 80;

// Because a help table's second column starts after a run of two or more
// spaces, a wrapped description continues there, not at the margin.
function hangOf(line: string): number {
  const plain = line.replace(ESCAPE, "");
  const lead = /^ */.exec(plain)?.[0].length ?? 0;
  const gap = /^ *\S.*? {2,}(?=\S)/.exec(plain);
  return gap ? textWidth(gap[0]) : lead;
}

// Columns count only what shows, since a color code in the first half
// would otherwise put the split early.
function splitAt(line: string, columns: number): [string, string] {
  let seen = 0;
  let i = 0;
  while (i < line.length && seen < columns) {
    const escape = LEADING_ESCAPE.exec(line.slice(i));
    if (escape) {
      i += escape[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i) ?? 32);
    seen += textWidth(ch);
    i += ch.length;
  }
  return [line.slice(0, i), line.slice(i)];
}

// Text whose lines are wider than `width`, wrapped at words: help on a
// narrow terminal, where a long line would wrap mid-word. A continuation
// line starts under its line's second column, or under its indent, so a
// table of options and their descriptions stays a table.
// Help and other prose for a person: fit to the terminal, at most 80
// columns, and left whole when piped, since a program reads whole lines.
export const fitTerminal = (
  text: string,
  terminal: boolean,
  columns: number | undefined,
): string =>
  terminal ? fitWidth(text, Math.min(MEASURE, columns || MEASURE)) : text;

export function fitWidth(text: string, width: number): string {
  return text
    .split("\n")
    .flatMap((line) => {
      if (textWidth(line) <= width) return [line];
      let hang = hangOf(line);
      if (hang > width / 2)
        hang = /^ */.exec(line.replace(ESCAPE, ""))?.[0].length ?? 0;
      const [head, rest] = splitAt(line, hang);
      const room = Math.max(1, width - hang);
      const lines: string[] = [];
      let current = "";
      // The separator stays with the word after it, so no line ends on
      // a dangling "·".
      const words: string[] = [];
      for (const word of rest.split(/ +/)) {
        const last = words.at(-1);
        if (last !== undefined && last.replace(ESCAPE, "") === "·") {
          words[words.length - 1] = `${last} ${word}`;
        } else if (word !== "") words.push(word);
      }
      for (const word of words) {
        const next = current === "" ? word : `${current} ${word}`;
        if (current !== "" && textWidth(next) > room) {
          lines.push(current);
          current = word;
        } else {
          current = next;
        }
      }
      if (current !== "") lines.push(current);
      return lines.map((part, k) => (k === 0 ? head : " ".repeat(hang)) + part);
    })
    .join("\n");
}

// A cell that draws a rule as wide as its column, so totals read apart
// from the rows above them.
export const RULE = "\u0000rule";

// Numbers right-align, so the columns in `right` pad on the left. A
// left-aligned last cell is left ragged, since padding it would only add
// trailing spaces.
export function aligned(
  table: readonly (readonly string[])[],
  rightColumns: readonly number[] = [],
  paintRule: (text: string) => string = asIs,
  indent = "  ",
): string[] {
  const blank = (cell: string) => cell === "" || cell === RULE;
  // A column empty in every row, such as noise from one run, is left
  // out, or it would print as a double gap.
  const used = new Set(
    table.flatMap((row) => row.flatMap((cell, i) => (blank(cell) ? [] : [i]))),
  );
  const keep = (row: readonly string[]) => row.filter((_, i) => used.has(i));
  const rows = table.map(keep);
  const right = [...used]
    .sort((a, b) => a - b)
    .flatMap((column, i) => (rightColumns.includes(column) ? [i] : []));
  // Escape codes take no columns, so a colored cell pads as wide as
  // it shows.
  const cellWidth = (cell: string) => (cell === RULE ? 0 : textWidth(cell));
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) {
      if (i === row.length - 1 && !right.includes(i)) continue;
      widths[i] = Math.max(widths[i] ?? 0, cellWidth(cell));
    }
  }
  const pad = (cell: string, i: number) =>
    " ".repeat(Math.max(0, (widths[i] ?? 0) - cellWidth(cell)));
  const columnsWidth = (from: number, to: number) =>
    widths.slice(from, to).reduce((sum, w) => sum + w + 2, 0);
  return rows.map((row) => {
    const first = row.indexOf(RULE);
    if (first !== -1) {
      const last = row.lastIndexOf(RULE);
      const line = "─".repeat(columnsWidth(first, last + 1) - 2);
      return `${indent}${" ".repeat(columnsWidth(0, first))}${paintRule(line)}`;
    }
    // An empty row is a blank line, with no indent left trailing.
    return `${indent}${row
      .map((cell, i) =>
        right.includes(i)
          ? pad(cell, i) + cell
          : i === row.length - 1
            ? cell
            : cell + pad(cell, i),
      )
      .join("  ")}`.trimEnd();
  });
}

// aligned, with a row that overflows the measure shortened in its last
// cell by `shrink`, by just its overflow. Other rows, the header and a
// colored cell, which a cut would break, stay as they are.
export function fitted(
  table: readonly (readonly string[])[],
  rightColumns: readonly number[],
  shrink: (text: string, max: number) => string,
  paintRule: (text: string) => string = asIs,
): string[] {
  const lines = aligned(table, rightColumns, paintRule);
  if (lines.every((line) => textWidth(line) <= MEASURE)) return lines;
  const shrunk = table.map((row, r) => {
    const over = textWidth(lines[r] ?? "") - MEASURE;
    const last = row.length - 1;
    const cell = row[last] ?? "";
    if (r === 0 || over <= 0 || cell === RULE || cell.includes("\x1b")) {
      return row;
    }
    const copy = [...row];
    copy[last] = shrink(cell, textWidth(cell) - over);
    return copy;
  });
  return aligned(shrunk, rightColumns, paintRule);
}

// Lines with notes under some of them, keyed by the line's index, so a
// note follows its row without widening the table.
export function withNotes(
  lines: readonly string[],
  notes: ReadonlyMap<number, readonly string[]>,
): string[] {
  return lines.flatMap((line, i) => [line, ...(notes.get(i) ?? [])]);
}

// A table's header row is read once, then consulted, so it takes the
// smallest effective difference: faint, with no rule under it.
export const headerRow = (paint: Paint, cells: readonly string[]): string[] =>
  cells.map((cell) => paint.faint(cell));

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * One stderr line, rewritten in place while a long run works, so it never
 * looks stuck. Made only when stderr is a terminal, and not for a coding
 * agent or JSON; cleared before the result prints.
 */
export type Progress = {
  step(text: string, doneRatio: number): void;
  clear(): void;
};

export const SILENT: Progress = { step: () => {}, clear: () => {} };

const BAR_WIDTH = 20;
const CLEAR_LINE = "\r\x1b[2K";

export function createProgress(
  write: (text: string) => void,
  paint: Paint,
  nowMs: () => number,
): Progress {
  const startMs = nowMs();
  let text = "";
  let doneRatio = 0;
  const render = () => {
    const done = Math.round(Math.min(1, Math.max(0, doneRatio)) * BAR_WIDTH);
    // Done and to-do differ in shape as well as color, so the bar reads
    // without color too.
    const bar =
      paint.good("━".repeat(done)) + paint.dim("─".repeat(BAR_WIDTH - done));
    const seconds = Math.floor((nowMs() - startMs) / 1000);
    write(`${CLEAR_LINE}${bar}  ${text}${paint.dim(` · ${seconds} s`)}`);
  };
  // A tick each second, so the clock moves while a step is in flight.
  const timer = setInterval(render, 1000);
  timer.unref();
  return {
    step(next, ratio) {
      text = next;
      doneRatio = ratio;
      render();
    },
    clear() {
      clearInterval(timer);
      write(CLEAR_LINE);
    },
  };
}
