// Where in a file's source an edge or an unknown cause is spelled, for
// `why` and `check`. The scanner keeps no offsets (the cache would have to
// store them), so these search the text: a line is a pointer for a reader,
// and a miss only drops it.

const DISK_READ =
  /\bfrom\s*["'](?:node:)?(?:fs|fs\/promises|child_process)["']|\brequire\s*\(\s*["'](?:node:)?(?:fs|fs\/promises|child_process)["']|\bBun\.(?:file|Glob|spawn)/;
const NON_LITERAL_IMPORT =
  /\b(?:import|require|vi\.(?:mock|doMock|unmock|importActual|importMock))\s*(?:<[^>]*>)?\(\s*(?!["'][^"'`$]*["']\s*[,)])/;
const GLOB_CALL = /\bimport\.meta\.glob/;
const QUOTED_CAUSE = /"([^"]+)"/;

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

/** The line that spells `specifier` as a string, quoted any way. */
export function specifierLine(
  source: string,
  specifier: string,
): number | undefined {
  for (const quote of ['"', "'", "`"]) {
    const line = lineOf(source, `${quote}${specifier}${quote}`);
    if (line !== undefined) return line;
  }
  return lineOf(source, specifier);
}

/** The line behind one of a file's unknown causes. */
export function causeLine(source: string, cause: string): number | undefined {
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
