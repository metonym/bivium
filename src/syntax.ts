export interface ImportRef {
  specifier: string;
  // Set for a static import or re-export with only named bindings, so a
  // barrel can bind each name. Absent means the whole module.
  names?: string[];
  // `import type`, `export type … from`, or a JSDoc type: erased before
  // anything runs. An inline `import { type A }` isn't: under
  // `verbatimModuleSyntax` it still loads the module.
  type?: true;
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
  // `@lists` globs: only adding or deleting a match counts.
  lists: string[];
  // Why this file's dependencies can't be known.
  unknown: string[];
  // Why the lexer failed, when the regex extractor read the file instead.
  fallback?: string;
}

export const QUERY: RegExp = /[?#].*$/;

export const UNDECLARED_READS = "reads the disk without @depends-on";

// spec: Node and TypeScript read a specifier as relative only when it is
// `.`, `..`, or starts with `./` or `../`, so `.velite` is bare.
export const RELATIVE: RegExp = /^\.\.?(?:\/|$)/;

export const URL_REF: RegExp = /^[a-z]+:|^\/\//;

// Never split at a comma inside `{a,b}`: it belongs to the glob.
export const LIST_SEPARATOR: RegExp = /[\s,]+(?![^{]*\})/;

export const DEPENDS_ON: RegExp =
  /^\s*(?:\/\/|\/?\*+)\s*@depends-on\s+(.+?)\s*(?:\*\/)?\s*$/gm;

export const READS: RegExp =
  /^\s*(?:\/\/|\/?\*+)\s*@reads\s+(.+?)\s*(?:\*\/)?\s*$/gm;

export const LISTS: RegExp =
  /^\s*(?:\/\/|\/?\*+)\s*@lists\s+(.+?)\s*(?:\*\/)?\s*$/gm;

export const GLOB_REGISTRY: RegExp = /^\s*(?:\/\/|\/?\*+)\s*@glob-registry\b/m;

const AS = /\s+as\s+/;
const TYPE_PREFIX = /^type\s+/;
const NAMED_CLAUSE = /\{([^}]*)\}/;
const DEFAULT_OR_NAMESPACE = /^\s*[\w$*]/;

// `undefined` when the clause also binds a default or a namespace, since
// those need the whole module.
export function namedBindings(clause: string): string[] | undefined {
  const named = NAMED_CLAUSE.exec(clause);
  if (!named || DEFAULT_OR_NAMESPACE.test(clause.replace(NAMED_CLAUSE, ""))) {
    return undefined;
  }
  return captured(named, 1)
    .split(",")
    .map((part) =>
      (part.trim().replace(TYPE_PREFIX, "").split(AS)[0] ?? "").trim(),
    )
    .filter(Boolean);
}

// invariant: only for a group the pattern always fills, so an unset one
// means the pattern changed, not the input.
export function captured(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`bivium: scan: group ${index} of ${match[0]} is unset.`);
  }
  return value;
}
