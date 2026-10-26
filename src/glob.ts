const GLOB_LITERAL = /[.+^$()|[\]\\]/g;

// Compiles a root-relative glob (`**`, `*`, `?`, `{a,b}`) to a RegExp.
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") source += "(?:";
    else if (char === "}") source += ")";
    else if (char === ",") source += "|";
    else source += char.replace(GLOB_LITERAL, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export type Matcher = (path: string) => boolean;

// One test for a list of globs; an empty list matches nothing.
export function matcher(globs: string | readonly string[] = []): Matcher {
  const list = typeof globs === "string" ? [globs] : globs;
  if (list.length === 0) return () => false;
  const res = list.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}
