// Where in a file's source an edge or an unknown cause is spelled, for
// `why` and `check`. The scanner keeps no offsets (the cache would have to
// store them), so these search the text: a line is a pointer for a reader,
// and a miss only drops it. A search prefers an occurrence in code, on a
// line that looks like the edge (`goto(`, `import`, `src=`), over one in a
// comment or prose that merely mentions it.

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Computed } from "./compute.ts";

const DISK_READ =
  /\bfrom\s*["'](?:node:)?(?:fs|fs\/promises|child_process)["']|\brequire\s*\(\s*["'](?:node:)?(?:fs|fs\/promises|child_process)["']|\bBun\.(?:file|Glob|spawn)/;
const NON_LITERAL_IMPORT =
  /\b(?:import|require|vi\.(?:mock|doMock|unmock|importActual|importMock))\s*(?:<[^>]*>)?\(\s*(?!["'][^"'`$]*["']\s*[,)])/;
const GLOB_CALL = /\bimport\.meta\.glob/;
const QUOTED_CAUSE = /"([^"]+)"/;
// A line that loads a module: an import, re-export, `require`, mock, or an
// HTML tag's `src` or `href`.
const LOADS =
  /\b(?:import|export|from|require|mock|doMock|unmock|importActual|importMock)\b|\b(?:src|href)\s*=/;
const GOTO_CALL = /\bgoto\s*\(/;

function lineAt(source: string, index: number): number {
  let line = 1;
  for (
    let i = source.indexOf("\n");
    i !== -1 && i < index;
    i = source.indexOf("\n", i + 1)
  ) {
    line++;
  }
  return line;
}

function lineOf(source: string, needle: string | RegExp): number | undefined {
  const index =
    typeof needle === "string" ? source.indexOf(needle) : source.search(needle);
  return index === -1 ? undefined : lineAt(source, index);
}

// Where `source`'s comments are: `//`, `/* */` and `<!-- -->`, outside
// strings. A sketch of the lexer, not the lexer: a regex literal with a quote
// in it can throw it off until the end of its line, which costs a pointer at
// worst. A quote doesn't span lines, so an apostrophe in markup prose can't
// hide the rest of the file.
function commentRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'") {
      while (++i < source.length && source[i] !== c && source[i] !== "\n") {
        if (source[i] === "\\") i++;
      }
    } else if (c === "`") {
      while (++i < source.length && source[i] !== "`") {
        if (source[i] === "\\") i++;
      }
    } else if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      ranges.push([i, end === -1 ? source.length : end]);
      i = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", i) || source.startsWith("<!--", i)) {
      const close = c === "/" ? "*/" : "-->";
      const end = source.indexOf(close, i + 2);
      const stop = end === -1 ? source.length : end + close.length;
      ranges.push([i, stop]);
      i = stop - 1;
    }
  }
  return ranges;
}

function lineTextAt(source: string, index: number) {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? source.length : end);
}

// The line of the best occurrence of any of `needles`: in code, on a line
// `near` matches; else in code; else anywhere.
function bestLine(
  source: string,
  needles: string[],
  near?: RegExp,
): number | undefined {
  let comments: [number, number][] | undefined;
  const inComment = (index: number) => {
    comments ??= commentRanges(source);
    return comments.some(([start, end]) => index >= start && index < end);
  };
  let code: number | undefined;
  let any: number | undefined;
  for (const needle of needles) {
    for (
      let index = source.indexOf(needle);
      index !== -1;
      index = source.indexOf(needle, index + 1)
    ) {
      any ??= index;
      if (inComment(index)) continue;
      if (near === undefined || near.test(lineTextAt(source, index))) {
        return lineAt(source, index);
      }
      code ??= index;
    }
  }
  const found = code ?? any;
  return found === undefined ? undefined : lineAt(source, found);
}

/** The line that spells `specifier` as a string, quoted any way. */
export function specifierLine(
  source: string,
  specifier: string,
): number | undefined {
  const quoted = ['"', "'", "`"].map((quote) => `${quote}${specifier}${quote}`);
  return bestLine(source, quoted, LOADS) ?? bestLine(source, [specifier]);
}

/**
 * The line of a `goto()` that opens a page: by its argument as written, else
 * by the page's file name.
 */
export function gotoLine(
  source: string,
  argument: string | undefined,
  page: string,
): number | undefined {
  return (
    (argument === undefined
      ? undefined
      : bestLine(source, [argument], GOTO_CALL)) ??
    bestLine(source, [page.slice(page.lastIndexOf("/") + 1)], GOTO_CALL)
  );
}

/** The line of a call such as `import.meta.glob`, in code if it can be. */
export function callLine(source: string, call: string): number | undefined {
  return bestLine(source, [call]);
}

/** The line behind one of a file's unknown causes. */
function causeLine(source: string, cause: string): number | undefined {
  if (cause.startsWith("unresolved ")) {
    const specifier = QUOTED_CAUSE.exec(cause)?.[1];
    return specifier === undefined
      ? undefined
      : specifierLine(source, specifier);
  }
  if (cause === "non-literal dynamic import")
    return lineOf(source, NON_LITERAL_IMPORT);
  if (cause === "non-literal glob import") return lineOf(source, GLOB_CALL);
  if (cause === "reads the disk without @depends-on") {
    return lineOf(source, DISK_READ);
  }
  if (cause.startsWith("non-literal goto(")) {
    return lineOf(source, cause.slice("non-literal ".length, -1));
  }
  const url = QUOTED_CAUSE.exec(cause)?.[1];
  return url === undefined ? undefined : lineOf(source, url);
}

/** The line of an annotation or call, such as `@depends-on`. */
export function textLine(source: string, text: string): number | undefined {
  return lineOf(source, text);
}

export function annotationLine(
  source: string,
  tag: string,
  glob: string,
): number | undefined {
  const index = source
    .split("\n")
    .findIndex((line) => line.includes(tag) && line.includes(glob));
  return index === -1 ? undefined : index + 1;
}

/** The text of line `line` (1-based), trimmed. */
export function lineText(source: string, line: number): string {
  let start = 0;
  for (let n = 1; n < line; n++) {
    const next = source.indexOf("\n", start);
    if (next === -1) return "";
    start = next + 1;
  }
  const end = source.indexOf("\n", start);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

export async function sourceOf(root: string, file: string) {
  try {
    // A config file outside the repository is absolute.
    return await readFile(isAbsolute(file) ? file : join(root, file), "utf-8");
  } catch {
    return;
  }
}

/** The file a node is in: a barrel name's barrel, or the node itself. */
export function fileOf(node: string): string {
  const hash = node.indexOf("#");
  return hash === -1 ? node : node.slice(0, hash);
}

/** Why a node depends on every change, and where each cause is spelled. */
export async function causesOf(
  root: string,
  computed: Computed,
  node: string,
): Promise<{ cause: string; at?: string; text?: string }[]> {
  const file = fileOf(node);
  const source = await sourceOf(root, file);
  return (computed.graph.get(node)?.unknown ?? []).map((cause) => {
    if (source === undefined) return { cause };
    const line = causeLine(source, cause);
    return line === undefined
      ? { cause }
      : { cause, at: `${file}:${line}`, text: lineText(source, line) };
  });
}
