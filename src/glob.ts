const GLOB_LITERAL = /[.+^$()|[\]\\]/g;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const DIGIT = /[0-9]/;
const CAPTURE_REFERENCE = /\$(\d+)/g;

interface Compiled {
  source: string;
  // How many wildcards (`*`, `**`, `?`, `{…}`) the glob has.
  wildcards: number;
}

// With `capture`, each wildcard is a group, numbered by where it starts. With
// `captures`, `$1`, `$2`… are what those groups matched, literally; one that
// matched nothing (inside an alternative not taken) matches anything, so a
// reference can only widen.
function compile(
  glob: string,
  {
    capture = false,
    captures,
  }: { capture?: boolean; captures?: readonly (string | undefined)[] } = {},
): Compiled {
  let source = "";
  let wildcards = 0;
  const group = (body: string) => {
    wildcards++;
    return capture ? `(${body})` : body;
  };
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (captures && char === "$" && DIGIT.test(glob[i + 1] ?? "")) {
      let end = i + 1;
      while (DIGIT.test(glob[end] ?? "")) end++;
      const text = captures[Number(glob.slice(i + 1, end)) - 1];
      source += text === undefined ? ".*" : text.replace(REGEX_SPECIAL, "\\$&");
      i = end - 1;
    } else if (char === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      source += group(slash ? "(?:.*/)?" : ".*");
      i += slash ? 2 : 1;
    } else if (char === "*") source += group("[^/]*");
    else if (char === "?") source += group("[^/]");
    else if (char === "{") {
      wildcards++;
      source += capture ? "(" : "(?:";
    } else if (char === "}") source += ")";
    else if (char === ",") source += "|";
    else source += char.replace(GLOB_LITERAL, "\\$&");
  }
  return { source: `^${source}$`, wildcards };
}

// Compiles a root-relative glob (`**`, `*`, `?`, `{a,b}`) to a RegExp.
export function globToRegExp(glob: string): RegExp {
  return new RegExp(compile(glob).source);
}

// A config key: each wildcard captures what it matched, so `$1`… in its
// values can refer back to it. `**/` captures its trailing slash.
export function captureGlob(glob: string): {
  pattern: RegExp;
  wildcards: number;
} {
  const { source, wildcards } = compile(glob, { capture: true });
  return { pattern: new RegExp(source), wildcards };
}

// The capture numbers a config value refers to, in order.
export function captureReferences(glob: string): number[] {
  return [...glob.matchAll(CAPTURE_REFERENCE)].map((match) => Number(match[1]));
}

// A config value, with `$1`… replaced by what its key's wildcards matched.
export function expandGlob(
  glob: string,
  captures: readonly (string | undefined)[],
): RegExp {
  return new RegExp(compile(glob, { captures }).source);
}

export type Matcher = (path: string) => boolean;

// One test for a list of globs; an empty list matches nothing.
export function matcher(globs: string | readonly string[] = []): Matcher {
  const list = typeof globs === "string" ? [globs] : globs;
  if (list.length === 0) return () => false;
  const res = list.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}
