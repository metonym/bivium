/**
 * Differential check: the lexer's specifiers against TypeScript's parser,
 * on carbon-components-svelte's tracked sources plus a deterministic sample
 * of the JS/TS files installed in its `node_modules`. Svelte files are
 * compared on their `<script>` contents.
 *
 *   bun eval/corpus.ts <carbon checkout> [--sample N] [--show N] [--json out]
 *
 * TypeScript is a devDependency for this check only. Mismatches are grouped
 * by category; the by-design ones are documented in docs/decisions.md.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { dialectOf, LexError, type Lexed, lexSource } from "../src/lex.ts";
import { byCodeUnit } from "../src/sorted.ts";
import { parseArgs, usage } from "./args.ts";

const args = parseArgs(process.argv.slice(2), ["--sample", "--show", "--json"]);
const [root] = args.positional;
if (!root) usage("corpus.ts <carbon checkout> [options]");
const sample = Number(args.option("--sample") ?? "3000");
const show = Number(args.option("--show") ?? "8");
const jsonOut = args.option("--json") ?? "";
const MAX_BYTES = 512 * 1024;
const CODE = /\.(?:[cm]?[jt]sx?|svelte)$/;

// --- Corpus -------------------------------------------------------------------

function fnv(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const tracked = spawnSync("git", ["-C", root, "ls-files"], {
  encoding: "utf-8",
})
  .stdout.split("\n")
  .filter((file) => CODE.test(file))
  .map((file) => join(root, file));

const installed: string[] = [];
const SKIP = new Set([".cache", ".vite-temp", ".vitest-cache", ".bin"]);
(function walk(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && CODE.test(entry.name)) installed.push(path);
  }
})(join(root, "node_modules"));
const sampled = installed
  .map((path) => [fnv(relative(root, path)), path] as const)
  .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1))
  .slice(0, sample)
  .map(([, path]) => path);

// --- TypeScript's view ------------------------------------------------------------

interface Found {
  specifiers: Map<string, string>; // specifier → syntax kind
  globs: Set<string>;
  nonLiteralImport: boolean;
  nonLiteralGlob: boolean;
  references: string[];
}

const VI = new Set(["mock", "doMock", "unmock", "importActual", "importMock"]);

function literal(node: ts.Node | undefined) {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

const JS_FILE = /\.[cm]?jsx?$/;

function scriptKind(path: string) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (JS_FILE.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function typescript(path: string, text: string, kind: ts.ScriptKind) {
  const file = ts.createSourceFile(
    path,
    text,
    {
      languageVersion: ts.ScriptTarget.Latest,
      jsDocParsingMode: ts.JSDocParsingMode.ParseAll,
    },
    false,
    kind,
  );
  const found: Found = {
    specifiers: new Map(),
    globs: new Set(),
    nonLiteralImport: false,
    nonLiteralGlob: false,
    references: [
      ...file.referencedFiles.map((ref) => `path=${ref.fileName}`),
      ...file.typeReferenceDirectives.map((ref) => `types=${ref.fileName}`),
    ],
  };
  const add = (specifier: string | undefined, how: string) => {
    if (specifier) found.specifiers.set(specifier, how);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isJSDocImportTag(node)) {
      add(
        literal(node.moduleSpecifier),
        ts.isJSDocImportTag(node) ? "jsdoc @import" : "import",
      );
    } else if (ts.isExportDeclaration(node)) {
      add(literal(node.moduleSpecifier), "export from");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(literal(node.moduleReference.expression), "import =");
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) {
        add(literal(argument.literal), "import type");
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      const value = literal(first);
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        if (value) add(value, "import()");
        else if (first && !(ts.isStringLiteral(first) && first.text === "")) {
          found.nonLiteralImport = true;
        }
      } else if (ts.isIdentifier(callee) && callee.text === "require") {
        if (value) add(value, "require");
        else if (first) found.nonLiteralImport = true;
      } else if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        const object = callee.expression;
        if (name === "require" && value) {
          add(value, "x.require");
        } else if (
          ts.isIdentifier(object) &&
          object.text === "vi" &&
          VI.has(name)
        ) {
          if (value) add(value, `vi.${name}`);
          else if (first) found.nonLiteralImport = true;
        } else if (
          (name === "glob" || name === "globEager") &&
          ts.isMetaProperty(object) &&
          object.keywordToken === ts.SyntaxKind.ImportKeyword
        ) {
          const patterns =
            first && ts.isArrayLiteralExpression(first)
              ? first.elements.map(literal)
              : [value];
          if (patterns.every((pattern) => pattern !== undefined)) {
            for (const pattern of patterns) found.globs.add(pattern);
          } else {
            found.nonLiteralGlob = true;
          }
        }
      }
    }
    for (const doc of ts.getJSDocCommentsAndTags(node)) visit(doc);
    ts.forEachChild(node, visit);
  };
  visit(file);
  // Parse errors are internal to a SourceFile; a program would type-check.
  const errors =
    "parseDiagnostics" in file && Array.isArray(file.parseDiagnostics)
      ? file.parseDiagnostics.length
      : 0;
  return { found, errors };
}

// --- The lexer's view -----------------------------------------------------------

function lexer(text: string, path: string): Lexed | LexError {
  try {
    return lexSource(text, dialectOf(path));
  } catch (error) {
    if (error instanceof LexError) return error;
    throw error;
  }
}

// Svelte `<script>` blocks, with attributes that may quote `>`.
const SCRIPT =
  /<script((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*>([\s\S]*?)<\/script\s*>/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

interface Unit {
  label: string;
  path: string;
  text: string;
  kind: ts.ScriptKind;
}

function units(path: string, text: string): Unit[] {
  if (!path.endsWith(".svelte")) {
    return [{ label: path, path, text, kind: scriptKind(path) }];
  }
  const blocks: Unit[] = [];
  const markup = text.replace(HTML_COMMENT, (comment) =>
    " ".repeat(comment.length),
  );
  for (const match of markup.matchAll(SCRIPT)) {
    const start = (match.index ?? 0) + match[0].indexOf(">") + 1;
    blocks.push({
      label: `${path}#script@${match.index}`,
      path,
      text: text.slice(start, start + match[2].length),
      kind: ts.ScriptKind.TS,
    });
  }
  return blocks;
}

// --- Compare ------------------------------------------------------------------

interface Example {
  file: string;
  detail: string;
}
const categories = new Map<string, Example[]>();
const note = (category: string, file: string, detail: string) => {
  const list = categories.get(category) ?? [];
  list.push({ file, detail });
  categories.set(category, list);
};

let files = 0;
let compared = 0;
const kinds = new Map<string, number>();
let lexerSpecifiers = 0;
let globCount = 0;
let bytes = 0;
const counts = { tracked: 0, installed: 0, svelte: 0, skippedLarge: 0 };
for (const [set, list] of [
  ["tracked", tracked],
  ["installed", sampled],
] as const) {
  for (const path of list) {
    if (statSync(path).size > MAX_BYTES) {
      counts.skippedLarge++;
      continue;
    }
    const text = readFileSync(path, "utf-8");
    files++;
    counts[set]++;
    if (path.endsWith(".svelte")) counts.svelte++;
    bytes += text.length;
    const name = relative(root, path);
    for (const unit of units(name, text)) {
      const { found, errors } = typescript(unit.path, unit.text, unit.kind);
      const lexed = lexer(unit.text, unit.path);
      if (lexed instanceof LexError) {
        note(
          errors > 0 ? "fallback, TS also errs" : "fallback, TS parses",
          unit.label,
          lexed.message,
        );
        continue;
      }
      // Where TypeScript can't parse the file, its view is only indicative.
      const tag = errors > 0 ? "TS parse errors, " : "";
      if (errors > 0) {
        note("TS parse errors", unit.label, `${errors} errors`);
      } else {
        compared++;
      }
      const mine = new Set(lexed.imports.map((ref) => ref.specifier));
      lexerSpecifiers += mine.size;
      globCount += found.globs.size;
      for (const kind of found.specifiers.values()) {
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      for (const [specifier, kind] of found.specifiers) {
        if (!mine.has(specifier)) {
          note(`${tag}TS only: ${kind}`, unit.label, specifier);
        }
      }
      for (const specifier of mine) {
        if (!found.specifiers.has(specifier)) {
          note(`${tag}lexer only`, unit.label, specifier);
        }
      }
      const myGlobs = new Set(lexed.globs);
      for (const glob of found.globs) {
        if (!myGlobs.has(glob)) note(`${tag}TS only: glob`, unit.label, glob);
      }
      for (const glob of myGlobs) {
        if (!found.globs.has(glob))
          note(`${tag}lexer only: glob`, unit.label, glob);
      }
      if (found.nonLiteralImport !== lexed.nonLiteralImport) {
        note(
          `${tag}${found.nonLiteralImport ? "TS" : "lexer"} only: non-literal import`,
          unit.label,
          "",
        );
      }
      if (found.nonLiteralGlob !== lexed.nonLiteralGlob) {
        note(
          `${tag}${found.nonLiteralGlob ? "TS" : "lexer"} only: non-literal glob`,
          unit.label,
          "",
        );
      }
      for (const reference of found.references) {
        note("triple-slash reference (not an edge)", unit.label, reference);
      }
    }
  }
}

console.log(
  `corpus: ${files} files (${counts.tracked} tracked, ${counts.installed} of ${installed.length} installed, ${counts.svelte} Svelte), ${(bytes / 1e6).toFixed(1)} MB, ${counts.skippedLarge} over ${MAX_BYTES / 1024} KB skipped; ${compared} units compared`,
);
console.log(
  `specifiers per unit: TS ${[...kinds.values()].reduce((a, b) => a + b, 0)} (${[...kinds].map(([kind, n]) => `${kind} ${n}`).join(", ")}), lexer ${lexerSpecifiers}; globs ${globCount}`,
);
for (const [category, examples] of [...categories].sort(([a], [b]) =>
  byCodeUnit(a, b),
)) {
  const fileCount = new Set(examples.map((e) => e.file)).size;
  console.log(`\n${category}: ${examples.length} (${fileCount} files)`);
  for (const { file, detail } of examples.slice(0, show)) {
    console.log(`  ${file}  ${detail}`);
  }
}
if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(Object.fromEntries(categories), null, 2),
  );
}
