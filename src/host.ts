import {
  type Dialect,
  LexError,
  type Lexed,
  lexExpression,
  lexRange,
  TS,
  TSX,
} from "./lex.ts";
import { URL_REF } from "./syntax.ts";

// Files that embed scripts in markup. Only the code is lexed: `<script>`
// blocks, and for Svelte the `{…}` expressions in markup (where an
// `import()` can appear). `<style>` and HTML comments are skipped.
//
// - `.svelte`: scripts and markup expressions.
// - `.vue`: scripts (template expressions can't import).
// - `.astro`: the `---` frontmatter and scripts.
// - `.html`: inline scripts, and `script[src]`, `link[href]`, `iframe[src]`.
//
// The file must already be open (`openFile`). Throws `LexError`.
export type Host = "svelte" | "vue" | "astro" | "html";

export function hostOf(path: string): Host | undefined {
  const dot = path.lastIndexOf(".");
  const ext = path.slice(dot + 1);
  return ext === "svelte" || ext === "vue" || ext === "astro" || ext === "html"
    ? ext
    : undefined;
}

// `^<tag … src="…"`: the regex extractor's HTML_REF, on one tag, plus
// unquoted values.
const TAG_REF =
  /^<(?:script|link|iframe)\b[^>]*\b(?:src|href)=(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/;
const GENERICS = /\sgenerics=(["'])/;
const LANG_JSX = /\slang=["']?(?:jsx|tsx)\b/;
const LOWERCASE = /[a-z]/;
const FENCE_OPEN = /^\s*---[ \t]*\r?\n/;
const FENCE_CLOSE = /^---[ \t]*$/m;

// Is `src[i…]` `<name` followed by the end of the tag name?
function isTag(src: string, i: number, name: string) {
  for (let k = 0; k < name.length; k++) {
    if ((src.charCodeAt(i + 1 + k) | 0x20) !== name.charCodeAt(k)) return false;
  }
  const c = src.charCodeAt(i + 1 + name.length);
  return c === 62 || c === 47 || c === 32 || (c >= 9 && c <= 13);
}

// Index after the `>` of the tag opening at `i`, skipping quoted values.
function tagEnd(src: string, i: number) {
  let j = i + 1;
  while (j < src.length) {
    const c = src.charCodeAt(j);
    if (c === 62) return j + 1;
    if (c === 34 || c === 39) {
      const e = src.indexOf(src[j], j + 1);
      if (e === -1) break;
      j = e + 1;
    } else {
      j++;
    }
  }
  throw new LexError(`unterminated tag at ${i}`);
}

// Index of `</name` from `from` (any case), or throws.
function closeTag(src: string, from: number, name: string) {
  const lower = src.indexOf(`</${name}`, from);
  if (lower !== -1) return lower;
  const any = src.slice(from).search(new RegExp(`</${name}`, "i"));
  if (any === -1) throw new LexError(`unterminated <${name}> at ${from}`);
  return from + any;
}

function indexOrEnd(src: string, text: string, from: number) {
  const at = src.indexOf(text, from);
  return at === -1 ? src.length : at;
}

export function lexHost(src: string, out: Lexed, host: Host): void {
  const n = src.length;
  let i = 0;
  if (host === "astro") i = frontmatter(src);
  // Markup is skipped by jumping to the next `<` (and `{` in Svelte).
  let nextTag = -1;
  let nextBrace = host === "svelte" ? -1 : n;
  while (i < n) {
    if (nextTag < i) nextTag = indexOrEnd(src, "<", i);
    if (nextBrace < i) nextBrace = indexOrEnd(src, "{", i);
    i = Math.min(nextTag, nextBrace);
    if (i >= n) break;
    const c = src.charCodeAt(i);
    if (c === 123) {
      // `{#if …}`, `{:else}`, `{/if}`, `{@html …}`: the sigil isn't code.
      let j = i + 1;
      const sigil = src.charCodeAt(j);
      if (
        sigil === 35 ||
        sigil === 58 ||
        sigil === 64 ||
        (sigil === 47 && LOWERCASE.test(src[j + 1] ?? ""))
      ) {
        j++;
      }
      i = lexExpression(j, n);
      continue;
    }
    if (src.startsWith("<!--", i)) {
      const e = src.indexOf("-->", i + 4);
      if (e === -1) throw new LexError(`unterminated comment at ${i}`);
      i = e + 3;
    } else if (isTag(src, i, "script")) {
      const open = tagEnd(src, i);
      const tag = src.slice(i, open);
      if (host === "html" || host === "vue") ref(tag, out);
      const generics = tag.match(GENERICS);
      if (generics?.index !== undefined) {
        // `<script lang="ts" generics="T extends Item">`: type parameters.
        const start = i + generics.index + generics[0].length;
        const stop = src.indexOf(generics[1], start);
        if (stop !== -1 && stop < open) lexRange(start, stop, TS);
      }
      const close = closeTag(src, open, "script");
      const dialect: Dialect = LANG_JSX.test(tag) ? TSX : TS;
      lexRange(open, close, dialect);
      i = close + 8;
    } else if (isTag(src, i, "style")) {
      i = closeTag(src, tagEnd(src, i), "style") + 7;
    } else if (
      host === "html" &&
      (isTag(src, i, "link") || isTag(src, i, "iframe"))
    ) {
      const open = tagEnd(src, i);
      ref(src.slice(i, open), out);
      i = open;
    } else {
      i++;
    }
  }
}

// A tag's `src`/`href`, unless it's a URL.
function ref(tag: string, out: Lexed) {
  const match = TAG_REF.exec(tag);
  const value = match && (match[1] ?? match[2] ?? match[3]);
  if (value && !URL_REF.test(value)) {
    out.imports.push({
      specifier: value.startsWith(".") ? value : `./${value}`,
    });
  }
}

// Lexes Astro's leading `---` fence; returns where markup starts.
function frontmatter(src: string) {
  const start = FENCE_OPEN.exec(src);
  if (!start) return 0;
  const from = start[0].length;
  const close = src.slice(from).search(FENCE_CLOSE);
  if (close === -1) throw new LexError("unterminated frontmatter");
  lexRange(from, from + close, TS);
  return from + close + 3;
}
