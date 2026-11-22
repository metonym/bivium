// A barrel is a module made only of re-exports. A named import from one
// binds to `barrel#Name`, which depends on the one file that exports the
// name, instead of on every file the barrel re-exports.

export interface Barrel {
  // Exported name → specifier it's re-exported from.
  names: Map<string, string>;
  // `export * from` specifiers: their names are unknown here.
  stars: string[];
}

const COMMENTS = /\/\/.*$|\/\*[\s\S]*?\*\//gm;
const AS = /\s+as\s+/;
const TYPE_PREFIX = /^type\s+/;
const NAMED_EXPORT =
  /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']\s*;?/g;
const STAR_EXPORT =
  /export\s+(?:type\s+)?\*(?:\s+as\s+([\w$]+))?\s+from\s*["']([^"']+)["']\s*;?/g;
const BARREL_FILE = /\.[cm]?[jt]sx?$/;
const ONLY_SEPARATORS = /^[\s;]*$/;
// A barrel's first statement, after any comments, must be an export:
// most modules fail this test before the full parse runs.
const STARTS_WITH_EXPORT = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*export\b/;

export function parseBarrel(path: string, source: string): Barrel | undefined {
  return BARREL_FILE.test(path) ? parseReExports(source) : undefined;
}

// Only for a caller that already knows the file is a script:
// it skips `parseBarrel`'s extension test.
export function parseReExports(source: string): Barrel | undefined {
  if (!STARTS_WITH_EXPORT.test(source)) return undefined;
  const code = source.replace(COMMENTS, "");
  const barrel: Barrel = { names: new Map(), stars: [] };
  let rest = code.replace(NAMED_EXPORT, (_, list: string, from: string) => {
    for (const part of list.split(",")) {
      const name = part.trim().replace(TYPE_PREFIX, "").split(AS).pop();
      if (name) barrel.names.set(name, from);
    }
    return "";
  });
  rest = rest.replace(
    STAR_EXPORT,
    (_, name: string | undefined, from: string) => {
      if (name) barrel.names.set(name, from);
      else barrel.stars.push(from);
      return "";
    },
  );
  if (barrel.names.size + barrel.stars.length === 0) return undefined;
  return ONLY_SEPARATORS.test(rest) ? barrel : undefined;
}
