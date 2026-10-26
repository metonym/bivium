import { posix } from "node:path";
import { type Barrel, parseReExports } from "./barrel.ts";
import { type Host, hostOf, lexHost } from "./host.ts";
import {
  createLexed,
  dialectOf,
  JS,
  LexError,
  type Lexed,
  lexRange,
  openFile,
  TS,
  TSX,
} from "./lex.ts";
import { extractRegex } from "./scan-regex.ts";
import { QUERY, type Scan } from "./syntax.ts";

// Raw dependency extraction from source text, before resolution: a one-pass
// lexer (`lex.ts`, with `host.ts` for files that embed scripts), which
// falls back to the regex extractor (`scan-regex.ts`) for a file it can't
// lex cleanly. Anything neither can read is reported as unknown, never
// dropped.

// Files whose source the scanner reads; any other file is a leaf.
export const SCANNED = /\.(?:svelte|vue|astro|html|[cm]?[jt]sx?)$/;

// How a file is read, from its name alone: a host format (`svelte`, `vue`,
// `astro`, `html`) or a script dialect (`ts`, `tsx`, `js`). Two files with
// the same content and format extract the same.
export type Format = Host | "ts" | "tsx" | "js";

export function formatOf(path: string): Format {
  const host = hostOf(path);
  if (host) return host;
  const dialect = dialectOf(path);
  if (dialect === TSX) return "tsx";
  return dialect === JS ? "js" : "ts";
}

// A file's raw dependencies as its content and format alone determine them:
// what the scan cache stores. `scan` adds what depends on the path.
export type Extraction = Omit<Scan, "globs"> & {
  // `import.meta.glob` patterns as written, relative to the file.
  globs: string[];
  // Every `goto()` argument; `scan` keeps them only when asked.
  gotos: string[];
  // The re-exports, for a script made only of them.
  barrel?: Barrel;
};

export function extract(format: Format, source: string): Extraction {
  const lexed = createLexed();
  let extraction: Extraction;
  try {
    openFile(source, lexed);
    if (isHost(format)) lexHost(source, lexed, format);
    else lexRange(0, source.length, DIALECTS[format]);
    extraction = fromLexed(lexed);
  } catch (error) {
    // Anything else is a lexer bug (or a stack overflow on absurd nesting):
    // the regex extractor is still sound, so it reads the file instead.
    const fallback =
      error instanceof LexError ? error.message : `lexer error: ${error}`;
    extraction = { ...extractRegex(source, format === "html"), fallback };
  }
  if (!isHost(format)) {
    const barrel = parseReExports(source);
    if (barrel) extraction.barrel = barrel;
  }
  return extraction;
}

// The path-dependent part of a scan: globs are made root-relative.
export function finish(
  path: string,
  extraction: Extraction,
  { gotos = false }: { gotos?: boolean } = {},
): Scan {
  const { globs } = extraction;
  const dir = globs.length > 0 ? posix.dirname(path) : "";
  const result: Scan = {
    imports: extraction.imports,
    globs: globs.map((glob) => posix.join(dir, glob)),
    gotos: gotos ? extraction.gotos : [],
    dependsOn: extraction.dependsOn,
    reads: extraction.reads,
    unknown: extraction.unknown,
  };
  if (extraction.fallback !== undefined) result.fallback = extraction.fallback;
  return result;
}

export function scan(
  path: string,
  source: string,
  options: { gotos?: boolean } = {},
): Scan {
  return finish(path, extract(formatOf(path), source), options);
}

const DIALECTS = { ts: TS, tsx: TSX, js: JS };
const isHost = (format: Format): format is Host =>
  format !== "ts" && format !== "tsx" && format !== "js";

function fromLexed(lexed: Lexed): Extraction {
  const unknown: string[] = [];
  if (lexed.nonLiteralImport) unknown.push("non-literal dynamic import");
  if (lexed.nonLiteralGlob) unknown.push("non-literal glob import");
  const globs: string[] = [];
  for (const glob of lexed.registry ? [] : lexed.globs) {
    // Negated patterns only narrow the match.
    if (glob.startsWith("!")) continue;
    globs.push(glob.replace(QUERY, ""));
  }
  if (lexed.readsDisk && lexed.dependsOn.length + lexed.reads.length === 0) {
    unknown.push("reads the disk without @depends-on");
  }
  return {
    imports: lexed.imports,
    globs,
    gotos: lexed.gotos,
    dependsOn: lexed.dependsOn,
    reads: lexed.reads,
    unknown,
  };
}

const STRING_LITERAL = /^["'`]([^"'`$]*)["'`]$/;
// A template literal that only interpolates after `?` or `#`, so the page is
// still known: `/modal.html?variant=${variant}`.
const STATIC_PATH_TEMPLATE = /^`([^`$?#]*)[?#][^`]*`$/;

// The URL a `goto()` argument names, or `undefined` if it isn't static.
export function gotoUrl(argument: string): string | undefined {
  return (
    STRING_LITERAL.exec(argument)?.[1] ??
    STATIC_PATH_TEMPLATE.exec(argument)?.[1]
  );
}
