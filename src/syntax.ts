export interface ImportRef {
  specifier: string;
  // Set for a static import or re-export with only named bindings, so a
  // barrel can bind each name. Absent means the whole module.
  names?: string[];
}

export interface Scan {
  imports: ImportRef[];
  // Root-relative globs from `import.meta.glob` (none for a registry).
  globs: string[];
  // Raw `goto()` arguments, when asked for.
  gotos: string[];
  // `@depends-on` globs: transitive.
  dependsOn: string[];
  // `@reads` globs: only a direct change to a match counts.
  reads: string[];
  // Why this file's dependencies can't be known.
  unknown: string[];
  // Why the lexer failed, when the regex extractor read the file instead.
  fallback?: string;
}

export const QUERY = /[?#].*$/;

export const URL_REF = /^[a-z]+:|^\/\//;

// Commas inside `{a,b}` belong to the glob.
export const LIST_SEPARATOR = /[\s,]+(?![^{]*\})/;

export const DEPENDS_ON =
  /^\s*(?:\/\/|\/?\*+)\s*@depends-on\s+(.+?)\s*(?:\*\/)?\s*$/gm;

export const READS = /^\s*(?:\/\/|\/?\*+)\s*@reads\s+(.+?)\s*(?:\*\/)?\s*$/gm;

export const GLOB_REGISTRY = /^\s*(?:\/\/|\/?\*+)\s*@glob-registry\b/m;

const AS = /\s+as\s+/;
const TYPE_PREFIX = /^type\s+/;
const NAMED_CLAUSE = /\{([^}]*)\}/;
const DEFAULT_OR_NAMESPACE = /^\s*[\w$*]/;

// Names in `{ … }`, or `undefined` for default/namespace imports.
export function namedBindings(clause: string): string[] | undefined {
  const named = NAMED_CLAUSE.exec(clause);
  if (!named || DEFAULT_OR_NAMESPACE.test(clause.replace(NAMED_CLAUSE, ""))) {
    return undefined;
  }
  return named[1]
    .split(",")
    .map((part) => part.trim().replace(TYPE_PREFIX, "").split(AS)[0].trim())
    .filter(Boolean);
}
