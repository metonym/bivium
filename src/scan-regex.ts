import { posix } from "node:path";
import {
  DEPENDS_ON,
  GLOB_REGISTRY,
  LIST_SEPARATOR,
  namedBindings,
  QUERY,
  READS,
  type Scan,
  URL_REF,
} from "./syntax.ts";

// The regex extractor, ported from carbon-components-svelte's selector. It
// reads every pattern anywhere in the text, comments and strings included, so
// it over-approximates; the lexer (`lex.ts`) falls back to it for a file it
// can't lex cleanly, and so never drops an edge this keeps.

const COMMENTS = /\/\/.*$|\/\*[\s\S]*?\*\//gm;
const QUOTED = /["']([^"']+)["']/g;

// `>` lets a one-line `<script>import …</script>` through.
const STATIC_IMPORT =
  /(?:^|[\n;>])\s*(?:import|export)\s+(?:type\s+)?([^;"'`]*?)\s*from\s*["']([^"'\n]+)["']/g;
const SIDE_EFFECT_IMPORT = /(?:^|[\n;>])\s*import\s*["']([^"'\n]+)["']/g;
const CALL_WITH_LITERAL =
  /\b(?:import|require|vi\.(?:mock|doMock|unmock|importActual|importMock))\(\s*(["'`])([^"'`$\n]+)\1\s*[,)]/g;
const NON_LITERAL_CALL = /(?<![.\w])(?:import|require)\(\s*(?!["'`])[^)\s]/;
const TEMPLATE_CALL =
  /(?<![.\w])(?:import|require|vi\.(?:mock|doMock|unmock|importActual|importMock))\(\s*`[^`]*\$\{/;
// One level of nested generics: `glob<Record<string, string>>(…)`.
const GLOB_CALL =
  /\bimport\.meta\.glob(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*(\[[^\]]*\]|["'][^"']*["'])/g;
const GLOB_CALL_ANY = /\bimport\.meta\.glob[<(]/g;
const GOTO = /\.goto\(\s*([^,)]*)/g;
const HTML_REF =
  /<(?:script|link|iframe)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g;
const READS_DISK =
  /\b(?:from|import|require|importActual)\s*\(?\s*["'](?:node:)?(?:fs|fs\/promises|child_process)["']|\bBun\.(?:file|Glob|spawn)/;

export function scanRegex(
  path: string,
  source: string,
  { gotos = false }: { gotos?: boolean } = {},
): Scan {
  const result = extractRegex(source, path.endsWith(".html"));
  const dir = posix.dirname(path);
  result.globs = result.globs.map((glob) => posix.join(dir, glob));
  if (!gotos) result.gotos = [];
  return result;
}

// `scanRegex` before the path is known: globs as written (relative to the
// file), and every `goto()` argument.
export function extractRegex(source: string, html: boolean): Scan {
  const result: Scan = {
    imports: [],
    globs: [],
    gotos: [],
    dependsOn: [],
    reads: [],
    unknown: [],
  };

  if (html) {
    for (const [, ref] of source.matchAll(HTML_REF)) {
      if (!URL_REF.test(ref)) {
        result.imports.push({
          specifier: ref.startsWith(".") ? ref : `./${ref}`,
        });
      }
    }
  }

  for (const [, clause, specifier] of source.matchAll(STATIC_IMPORT)) {
    const names = namedBindings(clause.replace(COMMENTS, ""));
    result.imports.push(names ? { specifier, names } : { specifier });
  }
  for (const [, specifier] of source.matchAll(SIDE_EFFECT_IMPORT)) {
    result.imports.push({ specifier });
  }
  // Each pattern below needs a literal substring; `includes` skips the
  // regex for the files that lack it.
  const calls =
    source.includes("import(") ||
    source.includes("require(") ||
    source.includes("vi.");
  for (const [, , specifier] of calls
    ? source.matchAll(CALL_WITH_LITERAL)
    : []) {
    result.imports.push({ specifier });
  }
  if (calls && (NON_LITERAL_CALL.test(source) || TEMPLATE_CALL.test(source))) {
    result.unknown.push("non-literal dynamic import");
  }

  const globbing = source.includes("import.meta.glob");
  const globs = globbing ? [...source.matchAll(GLOB_CALL)] : [];
  if (globbing && globs.length !== [...source.matchAll(GLOB_CALL_ANY)].length) {
    result.unknown.push("non-literal glob import");
  }
  for (const [, argument] of GLOB_REGISTRY.test(source) ? [] : globs) {
    for (const [, glob] of argument.matchAll(QUOTED)) {
      // Negated patterns only narrow the match.
      if (glob.startsWith("!")) continue;
      result.globs.push(glob.replace(QUERY, ""));
    }
  }

  if (source.includes(".goto(")) {
    for (const [, argument] of source.matchAll(GOTO)) {
      result.gotos.push(argument.trim());
    }
  }

  result.dependsOn = [
    ...(source.includes("@depends-on") ? source.matchAll(DEPENDS_ON) : []),
  ].flatMap(([, list]) => list.split(LIST_SEPARATOR).filter(Boolean));
  result.reads = [
    ...(source.includes("@reads") ? source.matchAll(READS) : []),
  ].flatMap(([, list]) => list.split(LIST_SEPARATOR).filter(Boolean));
  const disk =
    source.includes("fs") ||
    source.includes("child_process") ||
    source.includes("Bun.");
  if (
    disk &&
    READS_DISK.test(source) &&
    result.dependsOn.length + result.reads.length === 0
  ) {
    result.unknown.push("reads the disk without @depends-on");
  }

  return result;
}
