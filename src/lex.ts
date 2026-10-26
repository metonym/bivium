import {
  DEPENDS_ON,
  GLOB_REGISTRY,
  type ImportRef,
  LIST_SEPARATOR,
  namedBindings,
  READS,
} from "./syntax.ts";

// One-pass JavaScript/TypeScript lexer that reads only what the graph needs.
//
// It tracks code, `//` and `/* *\/` comments, `'`/`"` strings, template
// literals (with a stack for `${`), regular expressions, and JSX in
// JavaScript and `.tsx` files. Whether a `/` starts a regex or divides is
// decided from the previous significant token, as es-module-lexer does.
// Only code counts: an import spelled inside a string or a comment adds no
// edge. Comments are read for annotations and JSDoc type imports only.
//
// Anything that leaves the lexer in an inconsistent state (an unterminated
// string, template, comment or regex, an unbalanced bracket) throws a
// `LexError`, and the caller falls back to the regex extractor for the file.
//
// Keyword handlers are lookaheads: they record what follows the keyword and
// never consume input, so the main loop still lexes every character once
// as code and keeps its bracket stack and previous token right.

export interface Lexed {
  imports: ImportRef[];
  // Literal first arguments of `import.meta.glob`, as written.
  globs: string[];
  // Raw first arguments of `.goto(…)` calls.
  gotos: string[];
  dependsOn: string[];
  reads: string[];
  // A `@glob-registry` annotation: the file's globs add no edges.
  registry: boolean;
  // An `import()`, `require()` or `vi.mock()` path it can't read.
  nonLiteralImport: boolean;
  // An `import.meta.glob` argument it can't read.
  nonLiteralGlob: boolean;
  // Imports `fs`/`child_process`, or calls `Bun.file`/`Glob`/`spawn`.
  readsDisk: boolean;
}

export function createLexed(): Lexed {
  return {
    imports: [],
    globs: [],
    gotos: [],
    dependsOn: [],
    reads: [],
    registry: false,
    nonLiteralImport: false,
    nonLiteralGlob: false,
    readsDisk: false,
  };
}

// The file can't be lexed cleanly; `message` says why.
export class LexError extends Error {}

// `jsx`: JSX may appear (JavaScript, `.tsx`). `tsx`: `<T,>` is a generic.
export interface Dialect {
  jsx: boolean;
  tsx: boolean;
}

export const TS: Dialect = { jsx: false, tsx: false };
export const JS: Dialect = { jsx: true, tsx: false };
export const TSX: Dialect = { jsx: true, tsx: true };

const JS_FILE = /\.[cm]?jsx?$/;

export function dialectOf(path: string): Dialect {
  if (path.endsWith(".tsx")) return TSX;
  if (JS_FILE.test(path)) return JS;
  return TS;
}

// Previous significant token.
const T_START = 0; // start of input: a regex or a block may follow
const T_PUNCT = 1; // an operator, `(`, `[`: a regex or an object may follow
const T_OPERAND = 2; // a value ended: `/` divides
const T_IDENT = 3; // depends on the word (`return /x/` vs `a / b`)
const T_DOT = 4; // member access: the next word is a property
const T_CLOSE_PAREN = 5;
const T_CLOSE_KW = 6; // `)` of `if (…)`, `for (…)`, `while (…)`, `with (…)`
const T_CLOSE_BLOCK = 7;
const T_ARROW = 8;
const T_SEMI = 9;
const T_LBRACE = 10;

// Bracket stack entries.
const M_PAREN = 0;
const M_PAREN_KW = 1;
const M_BRACKET = 2;
const M_BLOCK = 3;
const M_EXPR = 4;
const M_TEMPLATE = 5;

const DISK = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
]);

const VI_CALLS = new Set([
  "mock",
  "doMock",
  "unmock",
  "importActual",
  "importMock",
]);

// How a call's literal path counts.
const CALL_IMPORT = 0; // `import()`, `require()`: unknown if not literal
const CALL_PROPERTY = 1; // `x.require()`: a literal counts, nothing else
const CALL_MOCK = 2; // `vi.mock()`: unknown if not literal, never a disk read
const CALL_ACTUAL = 3; // `vi.importActual()`: may read the disk

let src = "";
let end = 0;
let out: Lexed = createLexed();
let dialect: Dialect = TS;
// Next `@` / `import` at or after the last comment that looked; both only
// move forward, so finding them is linear in the file.
let nextAt = -1;
let nextImport = -1;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
// Whether the file has line terminators other than `\n`.
let oddLines = false;
// Set by `template()`: it stopped at `${` rather than the closing backtick.
let templateOpen = false;

function fail(message: string, at: number): never {
  throw new LexError(`${message} at ${at}`);
}

// Starts lexing a file into `sink`. Its ranges must then be lexed in order
// (`lexRange`, `lexExpression`), since comment lookups only move forward.
export function openFile(source: string, sink: Lexed): void {
  src = source;
  out = sink;
  nextAt = -1;
  nextImport = -1;
  oddLines =
    source.includes("\r") || source.includes(LS) || source.includes(PS);
}

// Lexes `[start, stop)` of the open file as a whole program (a module, or a
// `<script>` block's content). Throws `LexError`.
export function lexRange(
  start: number,
  stop: number,
  language: Dialect = TS,
): void {
  dialect = language;
  end = stop;
  let i = start;
  if (src.charCodeAt(i) === 0xfeff) i++;
  // A hashbang line.
  if (src.charCodeAt(i) === 35 && src.charCodeAt(i + 1) === 33) {
    i = lineEnd(i);
  }
  code(i, false);
}

// Lexes one `{…}` expression of the open file from after its `{` (Svelte
// markup), up to `stop`. Returns the index after its closing `}`. Throws
// `LexError`.
export function lexExpression(start: number, stop: number): number {
  dialect = TS;
  end = stop;
  return code(start, true);
}

export function lexSource(source: string, language: Dialect = TS): Lexed {
  const sink = createLexed();
  openFile(source, sink);
  lexRange(0, source.length, language);
  return sink;
}

// Whitespace other than line ends, which the main loop also skips.
function isUnicodeSpace(c: number) {
  return (
    c === 0xa0 ||
    c === 0xfeff ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

// ASCII identifier characters: 1 = may start one, 2 = may continue one.
const IDENT = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const letter =
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95;
  if (letter) IDENT[c] = 3;
  else if (c >= 48 && c <= 57) IDENT[c] = 2;
}

// `charCodeAt` past the end is NaN: neither.
function isIdentStart(c: number) {
  return c < 128 ? (IDENT[c] & 1) !== 0 : c >= 128 && !isUnicodeSpace(c);
}

function isIdentPart(c: number) {
  return c < 128 ? IDENT[c] !== 0 : c >= 128 && !isUnicodeSpace(c);
}

function identEnd(start: number) {
  let i = start;

  const s = src;
  const n = end;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c < 128 ? IDENT[c] === 0 : isUnicodeSpace(c)) break;
    i++;
  }
  return i;
}

function isWord(i: number, word: string) {
  return (
    i + word.length <= end &&
    src.startsWith(word, i) &&
    !isIdentPart(src.charCodeAt(i + word.length))
  );
}

function lineEnd(start: number) {
  let i = start;

  if (oddLines) {
    while (i < end) {
      const c = src.charCodeAt(i);
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) return i;
      i++;
    }
    return end;
  }
  const e = src.indexOf("\n", i);
  return e === -1 || e > end ? end : e;
}

// After whitespace and comments from `start`.
function skipTrivia(start: number) {
  let i = start;

  while (i < end) {
    const c = src.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c >= 128 && isUnicodeSpace(c))) {
      i++;
    } else if (c === 47 && src.charCodeAt(i + 1) === 47) {
      i = lineEnd(i + 2);
    } else if (c === 47 && src.charCodeAt(i + 1) === 42) {
      const e = src.indexOf("*/", i + 2);
      if (e === -1 || e + 2 > end) return end;
      i = e + 2;
    } else {
      break;
    }
  }
  return i;
}

// Index after the string literal opening at `i`, or -1.
function stringEnd(i: number) {
  const quote = src.charCodeAt(i);
  let j = i + 1;
  while (j < end) {
    const c = src.charCodeAt(j);
    if (c === quote) return j + 1;
    if (c === 92) {
      j += src.charCodeAt(j + 1) === 13 && src.charCodeAt(j + 2) === 10 ? 3 : 2;
      continue;
    }
    if (c === 10 || c === 13) return -1;
    j++;
  }
  return -1;
}

// Scans template text from `start` (after a backtick or a `${…}`'s `}`) to the
// closing backtick or the next `${`, and returns the index after it.
function template(start: number) {
  let j = start;

  while (j < end) {
    const c = src.charCodeAt(j);
    if (c === 96) {
      templateOpen = false;
      return j + 1;
    }
    if (c === 92) {
      j += 2;
      continue;
    }
    if (c === 36 && src.charCodeAt(j + 1) === 123) {
      templateOpen = true;
      return j + 2;
    }
    j++;
  }
  return fail("unterminated template", j);
}

// Index after the regex literal opening at `i`.
function regex(i: number) {
  let j = i + 1;
  let inClass = false;
  for (;;) {
    if (j >= end) fail("unterminated regex", i);
    const c = src.charCodeAt(j);
    if (c === 92) {
      j += 2;
      continue;
    }
    if (c === 10 || c === 13) fail("unterminated regex", i);
    if (inClass) {
      if (c === 93) inClass = false;
    } else if (c === 47) {
      break;
    } else if (c === 91) {
      inClass = true;
    }
    j++;
  }
  return identEnd(j + 1);
}

// Is the word `src[start, stop)` one of `words` (all of one length)?
function isOneOf(start: number, stop: number, words: readonly string[]) {
  if (stop - start !== words[0].length) return false;
  const c = src.charCodeAt(start);
  for (const word of words) {
    if (word.charCodeAt(0) === c && src.startsWith(word, start)) return true;
  }
  return false;
}

// Keywords by length, so most words are rejected on their length alone.
const EXPRESSION_KEYWORDS: (readonly string[] | undefined)[] = [];
const PAREN_KEYWORDS: (readonly string[] | undefined)[] = [];
const BLOCK_KEYWORDS: (readonly string[] | undefined)[] = [];
function byLength(table: (readonly string[] | undefined)[], words: string[]) {
  for (const word of words) {
    table[word.length] = [...(table[word.length] ?? []), word];
  }
}
// After these, `/` starts a regex.
byLength(EXPRESSION_KEYWORDS, [
  ...["in", "do", "new", "case", "else", "void", "throw", "yield"],
  ...["await", "return", "typeof", "delete", "default", "instanceof"],
]);
// Their `(…)` is followed by a statement, so `/` after it is a regex.
byLength(PAREN_KEYWORDS, ["if", "for", "with", "while"]);
// Their `{` opens a block, not an object literal.
byLength(BLOCK_KEYWORDS, ["do", "try", "else", "finally"]);

function isKeyword(
  table: (readonly string[] | undefined)[],
  start: number,
  stop: number,
) {
  const words = table[stop - start];
  return words !== undefined && isOneOf(start, stop, words);
}

function isExpressionKeyword(start: number, stop: number) {
  return isKeyword(EXPRESSION_KEYWORDS, start, stop);
}

function isParenKeyword(start: number, stop: number) {
  return isKeyword(PAREN_KEYWORDS, start, stop);
}

function isBlockKeyword(start: number, stop: number) {
  return isKeyword(BLOCK_KEYWORDS, start, stop);
}

function isWordAt(start: number, stop: number, word: string) {
  return stop - start === word.length && src.startsWith(word, start);
}

// The main loop. Lexes code from `start` to `end`; with `brace`, stops after the
// `}` that closes an enclosing `{` and returns the index after it.
function code(start: number, brace: boolean): number {
  let i = start;

  const s = src;
  const n = end;
  const stack: number[] = [];
  let last = T_START;
  let wordStart = 0;
  let wordEnd = 0;
  // The word was a property name (`x.return`), so not a keyword.
  let wordIsProperty = false;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c < 128 ? (IDENT[c] & 1) !== 0 : !isUnicodeSpace(c)) {
      let j = i + 1;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d < 128 ? IDENT[d] === 0 : isUnicodeSpace(d)) break;
        j++;
      }
      const property = last === T_DOT;
      switch (j - i) {
        case 2:
          if (c === 118 && src.charCodeAt(i + 1) === 105) vi(j);
          break;
        case 3:
          if (c === 66 && src.startsWith("Bun", i)) bun(j);
          break;
        case 4:
          if (c === 103 && property && src.startsWith("goto", i)) goto(j);
          break;
        case 6:
          if (!property) {
            if (c === 105 && src.startsWith("import", i)) importAt(j);
            else if (c === 101 && src.startsWith("export", i)) exportAt(j);
          }
          break;
        case 7:
          if (c === 114 && src.startsWith("require", i)) {
            requireAt(j, property);
          }
          break;
      }
      last = T_IDENT;
      wordStart = i;
      wordEnd = j;
      wordIsProperty = property;
      i = j;
      continue;
    }
    switch (c) {
      case 32:
      case 9:
      case 10:
      case 11:
      case 12:
      case 13:
        i++;
        continue;
      case 47: {
        const next = src.charCodeAt(i + 1);
        if (next === 47) {
          const e = lineEnd(i + 2);
          comment(i, e, false);
          i = e;
        } else if (next === 42) {
          const e = src.indexOf("*/", i + 2);
          if (e === -1 || e + 2 > end) fail("unterminated comment", i);
          comment(i, e + 2, true);
          i = e + 2;
        } else if (
          last === T_OPERAND ||
          last === T_CLOSE_PAREN ||
          (last === T_IDENT &&
            (wordIsProperty || !isExpressionKeyword(wordStart, wordEnd)))
        ) {
          i++;
          last = T_PUNCT;
        } else {
          i = regex(i);
          last = T_OPERAND;
        }
        continue;
      }
      case 39:
      case 34: {
        const e = stringEnd(i);
        if (e === -1) fail("unterminated string", i);
        i = e;
        last = T_OPERAND;
        continue;
      }
      case 96:
        i = template(i + 1);
        if (templateOpen) {
          stack.push(M_TEMPLATE);
          last = T_PUNCT;
        } else {
          last = T_OPERAND;
        }
        continue;
      case 123: {
        const block =
          last === T_START ||
          last === T_SEMI ||
          last === T_LBRACE ||
          last === T_CLOSE_PAREN ||
          last === T_CLOSE_KW ||
          last === T_CLOSE_BLOCK ||
          last === T_ARROW ||
          (last === T_IDENT &&
            !wordIsProperty &&
            isBlockKeyword(wordStart, wordEnd));
        stack.push(block ? M_BLOCK : M_EXPR);
        last = T_LBRACE;
        i++;
        continue;
      }
      case 125: {
        if (stack.length === 0) {
          if (brace) return i + 1;
          fail("unbalanced }", i);
        }
        const open = stack.pop();
        if (open === M_TEMPLATE) {
          i = template(i + 1);
          if (templateOpen) {
            stack.push(M_TEMPLATE);
            last = T_PUNCT;
          } else {
            last = T_OPERAND;
          }
          continue;
        }
        if (open === M_BLOCK) last = T_CLOSE_BLOCK;
        else if (open === M_EXPR) last = T_OPERAND;
        else fail("unbalanced }", i);
        i++;
        continue;
      }
      case 40:
        stack.push(
          last === T_IDENT &&
            !wordIsProperty &&
            isParenKeyword(wordStart, wordEnd)
            ? M_PAREN_KW
            : M_PAREN,
        );
        last = T_PUNCT;
        i++;
        continue;
      case 41: {
        const open = stack.pop();
        if (open === M_PAREN) last = T_CLOSE_PAREN;
        else if (open === M_PAREN_KW) last = T_CLOSE_KW;
        else fail("unbalanced )", i);
        i++;
        continue;
      }
      case 91:
        stack.push(M_BRACKET);
        last = T_PUNCT;
        i++;
        continue;
      case 93:
        if (stack.pop() !== M_BRACKET) fail("unbalanced ]", i);
        last = T_OPERAND;
        i++;
        continue;
      case 59:
        last = T_SEMI;
        i++;
        continue;
      case 46:
        if (src.charCodeAt(i + 1) === 46 && src.charCodeAt(i + 2) === 46) {
          last = T_PUNCT;
          i += 3;
        } else if (isDigit(src.charCodeAt(i + 1))) {
          i = numberEnd(i + 1);
          last = T_OPERAND;
        } else {
          last = T_DOT;
          i++;
        }
        continue;
      case 61:
        if (src.charCodeAt(i + 1) === 62) {
          last = T_ARROW;
          i += 2;
        } else {
          last = T_PUNCT;
          i++;
        }
        continue;
      case 43:
      case 45:
        if (src.charCodeAt(i + 1) === c) {
          // Postfix after a value, prefix otherwise.
          last =
            last === T_OPERAND || last === T_IDENT || last === T_CLOSE_PAREN
              ? T_OPERAND
              : T_PUNCT;
          i += 2;
        } else {
          last = T_PUNCT;
          i++;
        }
        continue;
      case 33:
        // A TypeScript non-null assertion ends a value: `a! / b`.
        last =
          (last === T_OPERAND ||
            (last === T_IDENT &&
              (wordIsProperty || !isExpressionKeyword(wordStart, wordEnd))) ||
            last === T_CLOSE_PAREN) &&
          src.charCodeAt(i + 1) !== 61
            ? T_OPERAND
            : T_PUNCT;
        i++;
        continue;
      case 60:
        // `<<`, `<=`: one operator, so the second `<` can't open JSX.
        if (src.charCodeAt(i + 1) === 60 || src.charCodeAt(i + 1) === 61) {
          last = T_PUNCT;
          i += 2;
        } else if (
          dialect.jsx &&
          !(
            last === T_OPERAND ||
            last === T_CLOSE_PAREN ||
            (last === T_IDENT &&
              (wordIsProperty || !isExpressionKeyword(wordStart, wordEnd)))
          ) &&
          isJsxStart(i)
        ) {
          i = jsxElement(i);
          last = T_OPERAND;
        } else {
          last = T_PUNCT;
          i++;
        }
        continue;
      case 35:
        // A private name is a value, never a keyword: `this.#import`.
        if (isIdentStart(src.charCodeAt(i + 1))) {
          i = identEnd(i + 1);
          last = T_OPERAND;
        } else {
          last = T_PUNCT;
          i++;
        }
        continue;
      default:
        if (isDigit(c)) {
          i = numberEnd(i + 1);
          last = T_OPERAND;
          continue;
        }
        // Past `isIdentStart`, a non-ASCII character is whitespace.
        if (c < 128) last = T_PUNCT;
        i++;
        continue;
    }
  }
  if (brace) fail("unterminated expression", i);
  if (stack.length > 0) {
    fail(
      stack[stack.length - 1] === M_TEMPLATE
        ? "unterminated template"
        : "unbalanced brackets",
      i,
    );
  }
  return i;
}

function isDigit(c: number) {
  return c >= 48 && c <= 57;
}

function numberEnd(start: number) {
  let i = start;

  while (i < end) {
    const c = src.charCodeAt(i);
    if (isIdentPart(c) || c === 46) i++;
    else break;
  }
  return i;
}

function comment(start: number, stop: number, block: boolean) {
  if (nextAt < start) nextAt = indexOrEnd("@", start);
  while (nextAt < stop) {
    if (
      src.startsWith("@depends-on", nextAt) ||
      src.startsWith("@reads", nextAt) ||
      src.startsWith("@glob-registry", nextAt)
    ) {
      annotations(start, stop);
      nextAt = indexOrEnd("@", stop);
      break;
    }
    nextAt = indexOrEnd("@", nextAt + 1);
  }
  // JSDoc types: `/** @type {import("./x").T} */`, `/** @import … */`.
  if (block && src.charCodeAt(start + 2) === 42) {
    if (nextImport < start) nextImport = indexOrEnd("import", start);
    while (nextImport < stop) {
      jsdocImport(start, nextImport, stop);
      nextImport = indexOrEnd("import", nextImport + 6);
    }
  }
}

function indexOrEnd(text: string, from: number) {
  const at = src.indexOf(text, from);
  return at === -1 ? src.length : at;
}

const BLANK = /^[ \t]*$/;

// Annotations in one comment, read as the regex extractor reads them: on a
// line that starts with the comment (or with `*` inside a block comment).
function annotations(start: number, stop: number) {
  const lineStart = src.lastIndexOf("\n", start - 1) + 1;
  const prefix = src.slice(lineStart, start);
  // Code before the comment on its first line: that line doesn't count.
  const text = (BLANK.test(prefix) ? prefix : "x") + src.slice(start, stop);
  for (const [, list] of text.matchAll(DEPENDS_ON)) {
    out.dependsOn.push(...list.split(LIST_SEPARATOR).filter(Boolean));
  }
  for (const [, list] of text.matchAll(READS)) {
    out.reads.push(...list.split(LIST_SEPARATOR).filter(Boolean));
  }
  if (GLOB_REGISTRY.test(text)) out.registry = true;
}

const JSDOC_IMPORT_TYPE = /import\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/y;
const JSDOC_IMPORT_TAG = /@import\s+([^;"'`]*?)\s*from\s*(["'])([^"'\n]+)\2/y;
const JSDOC_LINE_STAR = /\n\s*\*/g;

// Is `at` inside a tag's type, `@type {…}`, in the comment that starts at
// `start`? Prose and `@example` code aren't types.
function inTagType(start: number, at: number) {
  let depth = 0;
  let outer = -1;
  for (let i = start; i < at; i++) {
    const c = src.charCodeAt(i);
    if (c === 123) {
      if (depth++ === 0) outer = i;
    } else if (c === 125 && depth > 0) {
      depth--;
    }
  }
  if (depth === 0) return false;
  let p = outer - 1;
  while (p > start && isSpace(src.charCodeAt(p))) p--;
  while (p > start && isIdentPart(src.charCodeAt(p))) p--;
  return src.charCodeAt(p) === 64 && p + 1 < outer;
}

function jsdocImport(start: number, at: number, stop: number) {
  if (src.charCodeAt(at - 1) === 64) {
    JSDOC_IMPORT_TAG.lastIndex = at - 1;
    const tag = JSDOC_IMPORT_TAG.exec(src);
    if (tag && JSDOC_IMPORT_TAG.lastIndex <= stop) {
      const clause = tag[1].replace(JSDOC_LINE_STAR, "\n");
      const names = clause.includes("{") ? namedBindings(clause) : undefined;
      out.imports.push(
        names ? { specifier: tag[3], names } : { specifier: tag[3] },
      );
    }
    return;
  }
  if (isIdentPart(src.charCodeAt(at - 1)) || src.charCodeAt(at - 1) === 46) {
    return;
  }
  if (!inTagType(start, at)) return;
  JSDOC_IMPORT_TYPE.lastIndex = at;
  const type = JSDOC_IMPORT_TYPE.exec(src);
  if (type && JSDOC_IMPORT_TYPE.lastIndex <= stop) {
    out.imports.push({ specifier: type[2] });
  }
}

function record(specifier: string, names: string[] | undefined, disk: boolean) {
  if (specifier === "") return;
  out.imports.push(names ? { specifier, names } : { specifier });
  if (disk && DISK.has(specifier)) out.readsDisk = true;
}

function isSpace(c: number) {
  return c === 32 || (c >= 9 && c <= 13);
}

function isQuote(c: number) {
  return c === 39 || c === 34;
}

// `import` (not a property) ends at `j`.
function importAt(j: number) {
  const k = skipTrivia(j);
  const c = src.charCodeAt(k);
  if (c === 40) {
    call(k, CALL_IMPORT);
  } else if (c === 46) {
    meta(k);
  } else if (isQuote(c)) {
    const e = stringEnd(k);
    if (e !== -1) record(src.slice(k + 1, e - 1), undefined, true);
  } else {
    declaration(k);
  }
}

// `import <clause> from "x"`: reads up to the specifier, if it is one.
function declaration(k: number) {
  let clauseStart = k;
  // `import type X from` (the regex extractor's `type\s+`).
  if (src.startsWith("type", k) && isSpace(src.charCodeAt(k + 4))) {
    clauseStart = k + 5;
    while (clauseStart < end && isSpace(src.charCodeAt(clauseStart))) {
      clauseStart++;
    }
  }
  let p = k;
  for (let steps = 0; steps < 256; steps++) {
    p = skipTrivia(p);
    if (p >= end) return;
    const c = src.charCodeAt(p);
    if (isIdentStart(c)) {
      const q = identEnd(p + 1);
      if (q - p === 4 && src.startsWith("from", p)) {
        const r = skipTrivia(q);
        if (isQuote(src.charCodeAt(r))) {
          const e = stringEnd(r);
          if (e !== -1) {
            record(src.slice(r + 1, e - 1), clauseNames(clauseStart, p), true);
          }
          return;
        }
      }
      p = q;
    } else if (c === 123) {
      p = braceEnd(p);
      if (p === -1) return;
    } else if (c === 42 || c === 44) {
      p++;
    } else {
      return;
    }
  }
}

// Named bindings of the clause `src[start, stop)`, as the regex reads them.
function clauseNames(start: number, stop: number) {
  const clause = src.slice(start, stop);
  if (!clause.includes("{")) return;
  return namedBindings(clause.replace(COMMENTS, ""));
}

const COMMENTS = /\/\/.*$|\/\*[\s\S]*?\*\//gm;

// Index after the `}` matching the `{` at `open` (an import clause), or -1.
function braceEnd(open: number) {
  let p = open;

  let depth = 0;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c === 123) {
      depth++;
      p++;
    } else if (c === 125) {
      p++;
      if (--depth === 0) return p;
    } else if (isQuote(c)) {
      p = stringEnd(p);
      if (p === -1) return -1;
    } else if (c === 47 && src.charCodeAt(p + 1) === 47) {
      p = lineEnd(p + 2);
    } else if (c === 47 && src.charCodeAt(p + 1) === 42) {
      const e = src.indexOf("*/", p + 2);
      if (e === -1) return -1;
      p = e + 2;
    } else if (c === 59 || c === 40 || c === 96) {
      return -1;
    } else {
      p++;
    }
  }
  return -1;
}

// `export {…} from "x"`, `export * [as n] from "x"`.
function exportAt(j: number) {
  let p = skipTrivia(j);
  if (isWord(p, "type")) {
    const q = skipTrivia(p + 4);
    const c = src.charCodeAt(q);
    if (c === 123 || c === 42) p = q;
  }
  const clauseStart = p;
  const c = src.charCodeAt(p);
  let q: number;
  if (c === 123) {
    q = braceEnd(p);
    if (q === -1) return;
  } else if (c === 42) {
    q = skipTrivia(p + 1);
    if (isWord(q, "as")) {
      q = skipTrivia(q + 2);
      const n = src.charCodeAt(q);
      if (isQuote(n)) q = stringEnd(q);
      else if (isIdentStart(n)) q = identEnd(q + 1);
      else return;
      if (q === -1) return;
    }
  } else {
    return;
  }
  q = skipTrivia(q);
  if (!isWord(q, "from")) return;
  const r = skipTrivia(q + 4);
  if (!isQuote(src.charCodeAt(r))) return;
  const e = stringEnd(r);
  if (e === -1) return;
  record(src.slice(r + 1, e - 1), clauseNames(clauseStart, q), true);
}

// The literal first argument of the call whose `(` is at `k`.
function call(k: number, kind: number) {
  const a = skipTrivia(k + 1);
  const c = src.charCodeAt(a);
  if (c === 41) return;
  let e: number;
  if (isQuote(c)) {
    e = stringEnd(a);
  } else if (c === 96) {
    e = template(a + 1);
    if (templateOpen) e = -1;
  } else {
    e = -1;
  }
  const next = e === -1 ? -1 : src.charCodeAt(skipTrivia(e));
  if (next === 44 || next === 41) {
    record(
      src.slice(a + 1, e - 1),
      undefined,
      kind === CALL_IMPORT || kind === CALL_PROPERTY || kind === CALL_ACTUAL,
    );
  } else if (kind !== CALL_PROPERTY && !isSignature(k, a)) {
    out.nonLiteralImport = true;
  }
}

// The `(` at `k` (first argument at `a`) opens parameters, not arguments:
// `import(node) {…}` (a method), `require(id: string)` (a declaration).
function isSignature(k: number, a: number) {
  if (isIdentStart(src.charCodeAt(a))) {
    const p = skipTrivia(identEnd(a + 1));
    const c = src.charCodeAt(p);
    if (c === 58 || (c === 63 && src.charCodeAt(skipTrivia(p + 1)) === 58)) {
      return true;
    }
  }
  const close = parenEnd(k);
  return close !== -1 && src.charCodeAt(skipTrivia(close)) === 123;
}

// Index after the `)` matching the `(` at `k`, or -1.
function parenEnd(k: number) {
  let depth = 0;
  let p = k;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c === 40 || c === 91 || c === 123) {
      depth++;
    } else if (c === 41 || c === 93 || c === 125) {
      if (--depth === 0) return p + 1;
    } else if (isQuote(c) || c === 96) {
      p = c === 96 ? templateEnd(p) : stringEnd(p);
      if (p === -1) return -1;
      continue;
    } else if (
      c === 47 &&
      (src.charCodeAt(p + 1) === 47 || src.charCodeAt(p + 1) === 42)
    ) {
      p = skipTrivia(p);
      continue;
    }
    p++;
  }
  return -1;
}

// `require` ends at `j`; `property` for `module.require`.
function requireAt(j: number, property: boolean) {
  const k = skipTrivia(j);
  if (src.charCodeAt(k) === 40) call(k, property ? CALL_PROPERTY : CALL_IMPORT);
}

// `vi` ends at `j`: `vi.mock(…)` and the rest of the family.
function vi(j: number) {
  const p = skipTrivia(j);
  if (src.charCodeAt(p) !== 46) return;
  const q = skipTrivia(p + 1);
  const r = identEnd(q);
  const name = src.slice(q, r);
  if (!VI_CALLS.has(name)) return;
  let s = skipTrivia(r);
  if (src.charCodeAt(s) === 60) {
    s = genericEnd(s);
    if (s === -1) {
      out.nonLiteralImport = true;
      return;
    }
    s = skipTrivia(s);
  }
  if (src.charCodeAt(s) === 40) {
    call(s, name === "importActual" ? CALL_ACTUAL : CALL_MOCK);
  }
}

// `import` is followed by `.` at `k`: `import.meta.glob(…)`.
function meta(k: number) {
  const m = skipTrivia(k + 1);
  if (!isWord(m, "meta")) return;
  const p = skipTrivia(m + 4);
  if (src.charCodeAt(p) !== 46) return;
  const q = skipTrivia(p + 1);
  const r = identEnd(q);
  if (!isWordAt(q, r, "glob") && !isWordAt(q, r, "globEager")) return;
  let s = skipTrivia(r);
  if (src.charCodeAt(s) === 60) {
    s = genericEnd(s);
    if (s === -1) {
      out.nonLiteralGlob = true;
      return;
    }
    s = skipTrivia(s);
  }
  if (src.charCodeAt(s) === 40) globArgument(s);
}

// Index after the type arguments `<…>` opening at `start`, or -1.
function genericEnd(start: number) {
  let p = start;
  let depth = 0;
  while (p < end && p - start < 4096) {
    const c = src.charCodeAt(p);
    if (c === 60) {
      depth++;
    } else if (c === 62 && src.charCodeAt(p - 1) !== 61) {
      if (--depth === 0) return p + 1;
    } else if (isQuote(c)) {
      p = stringEnd(p);
      if (p === -1) return -1;
      continue;
    } else if (c === 96) {
      p = template(p + 1);
      if (templateOpen) return -1;
      continue;
    } else if (c === 59 && depth === 0) {
      return -1;
    }
    p++;
  }
  return -1;
}

// Index after a no-substitution string or template at `a`, or -1.
function literalEnd(a: number) {
  const c = src.charCodeAt(a);
  if (isQuote(c)) return stringEnd(a);
  if (c === 96) {
    const e = template(a + 1);
    return templateOpen ? -1 : e;
  }
  return -1;
}

// `import.meta.glob(` at `k`: a literal pattern or an array of them.
function globArgument(k: number) {
  let a = skipTrivia(k + 1);
  const patterns: string[] = [];
  let e: number;
  if (src.charCodeAt(a) === 91) {
    a = skipTrivia(a + 1);
    for (;;) {
      if (src.charCodeAt(a) === 93) {
        e = a + 1;
        break;
      }
      const f = literalEnd(a);
      if (f === -1) {
        e = -1;
        break;
      }
      patterns.push(src.slice(a + 1, f - 1));
      a = skipTrivia(f);
      const c = src.charCodeAt(a);
      if (c === 44) {
        a = skipTrivia(a + 1);
      } else if (c !== 93) {
        e = -1;
        break;
      }
    }
  } else {
    e = literalEnd(a);
    if (e !== -1) patterns.push(src.slice(a + 1, e - 1));
  }
  const next = e === -1 ? -1 : src.charCodeAt(skipTrivia(e));
  if (next === 44 || next === 41) out.globs.push(...patterns);
  else out.nonLiteralGlob = true;
}

// `.goto` ends at `j`: the raw text of its first argument.
function goto(j: number) {
  const k = skipTrivia(j);
  if (src.charCodeAt(k) !== 40) return;
  const a = skipTrivia(k + 1);
  let p = a;
  let depth = 0;
  while (p < end) {
    const c = src.charCodeAt(p);
    if ((c === 44 || c === 41) && depth === 0) break;
    if (c === 40 || c === 91 || c === 123) {
      depth++;
    } else if (c === 41 || c === 93 || c === 125) {
      depth--;
    } else if (isQuote(c) || c === 96) {
      const e = c === 96 ? templateEnd(p) : stringEnd(p);
      if (e === -1) return;
      p = e;
      continue;
    }
    p++;
  }
  out.gotos.push(src.slice(a, p).trim());
}

// Index after the template literal at `p`, `${…}` and all, or -1.
function templateEnd(p: number) {
  let q = template(p + 1);
  while (templateOpen) {
    let depth = 1;
    while (q < end && depth > 0) {
      const c = src.charCodeAt(q);
      if (c === 123) depth++;
      else if (c === 125) depth--;
      else if (isQuote(c)) {
        q = stringEnd(q);
        if (q === -1) return -1;
        continue;
      } else if (c === 96) {
        q = templateEnd(q);
        if (q === -1) return -1;
        continue;
      }
      q++;
    }
    if (depth > 0) return -1;
    q = template(q);
  }
  return q;
}

// `Bun` ends at `j`: `Bun.file`, `Bun.Glob`, `Bun.spawn…` read the disk.
function bun(j: number) {
  if (src.charCodeAt(j) !== 46) return;
  if (
    src.startsWith("file", j + 1) ||
    src.startsWith("Glob", j + 1) ||
    src.startsWith("spawn", j + 1)
  ) {
    out.readsDisk = true;
  }
}

// `<` at `i`, where an expression starts, opens an element.
function isJsxStart(i: number) {
  const c = src.charCodeAt(i + 1);
  if (c === 62) return true;
  if (!isIdentStart(c)) return false;
  if (!dialect.tsx) return true;
  // `<T,>(…) =>` and `<T extends U>(…) =>` are type parameters in `.tsx`.
  const p = skipTrivia(identEnd(i + 2));
  return src.charCodeAt(p) !== 44 && !isWord(p, "extends");
}

function jsxNameEnd(start: number) {
  let p = start;

  while (p < end) {
    const c = src.charCodeAt(p);
    if (isIdentPart(c) || c === 45 || c === 46 || c === 58) p++;
    else break;
  }
  return p;
}

// Index after the JSX element opening at `i`.
function jsxElement(i: number): number {
  let p = i + 1;
  if (src.charCodeAt(p) === 62) return jsxChildren(p + 1);
  p = jsxNameEnd(p);
  for (;;) {
    p = skipTrivia(p);
    if (p >= end) fail("unterminated JSX", i);
    const c = src.charCodeAt(p);
    if (c === 47 && src.charCodeAt(p + 1) === 62) return p + 2;
    if (c === 62) return jsxChildren(p + 1);
    if (c === 123) {
      p = code(p + 1, true);
      continue;
    }
    if (!isIdentStart(c)) fail(`bad JSX attribute in <> at ${i}:`, p);
    p = skipTrivia(jsxNameEnd(p));
    if (src.charCodeAt(p) !== 61) continue;
    p = skipTrivia(p + 1);
    const v = src.charCodeAt(p);
    if (isQuote(v)) {
      const e = src.indexOf(src[p], p + 1);
      if (e === -1 || e >= end) fail("unterminated JSX attribute", p);
      p = e + 1;
    } else if (v === 123) {
      p = code(p + 1, true);
    } else if (v === 60) {
      p = jsxElement(p);
    } else {
      fail("bad JSX attribute", p);
    }
  }
}

// JSX children from `start` through the closing tag.
function jsxChildren(start: number): number {
  let p = start;

  while (p < end) {
    const c = src.charCodeAt(p);
    if (c === 60) {
      if (src.charCodeAt(p + 1) === 47) {
        const e = src.indexOf(">", p);
        if (e === -1 || e >= end) break;
        return e + 1;
      }
      p = jsxElement(p);
    } else if (c === 123) {
      p = code(p + 1, true);
    } else {
      p++;
    }
  }
  return fail("unterminated JSX", p);
}
