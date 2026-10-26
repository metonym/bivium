import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const src = join(root, "src");
const dist = join(root, "dist");
const ENTRIES = ["index", "cli"];
const DIST_PREFIX = /"\.\/dist\//;
const TS_SUFFIX = /\.ts$/;
const PACKAGE_JSON = /[\\/]package\.json$/;
const STRIP_FIELDS = ["devDependencies", "scripts"];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// src/ reads only the version from package.json; without this, the bundle
// would carry the whole manifest.
const versionOnly: BunPlugin = {
  name: "bivium-version-only",
  setup(build) {
    build.onLoad({ filter: PACKAGE_JSON }, async ({ path }) => {
      const { version }: { version: string } = await Bun.file(path).json();
      return { contents: JSON.stringify({ version }), loader: "json" };
    });
  },
};

async function bundle() {
  const result = await Bun.build({
    entrypoints: ENTRIES.map((entry) => join(src, `${entry}.ts`)),
    root: src,
    outdir: dist,
    naming: { entry: "[name].[ext]", chunk: "shared-[hash].[ext]" },
    target: "node",
    format: "esm",
    splitting: true,
    // Names stay readable in a stack trace from a user's CI log.
    minify: { whitespace: true, syntax: true, identifiers: false },
    plugins: [versionOnly],
  });
  if (!result.success) {
    fail(`build failed:\n${result.logs.map(String).join("\n")}`);
  }
  await chmod(join(dist, "cli.js"), 0o755);
}

function emitDeclarations(): Map<string, string> {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    declaration: true,
    emitDeclarationOnly: true,
    types: ["bun-types"],
  };
  const emitted = new Map<string, string>();
  const host = ts.createCompilerHost(options);
  host.writeFile = (file, text) => {
    emitted.set(resolve(file), text);
  };
  const program = ts.createProgram([join(src, "index.ts")], options, host);
  const result = program.emit(undefined, undefined, undefined, true);
  const errors = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics]
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  if (errors.length > 0 || result.emitSkipped) {
    fail(`declaration emit failed:\n${errors.join("\n")}`);
  }
  return emitted;
}

function parse(file: string, text: string) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
}

// The public types live in src/types.ts, which imports nothing, and the
// public functions are declared over them. So index.d.ts is that module's
// declarations plus each function's, with no import to follow: a consumer
// sees only the public API.
function bundleDeclarations(emitted: Map<string, string>): string {
  const declarationOf = (module: string) => {
    const file = join(src, module.replace(TS_SUFFIX, ".d.ts"));
    const text = emitted.get(file);
    if (text === undefined) fail(`no declarations for ${module}`);
    return parse(file, text);
  };
  const types = declarationOf("./types.ts");
  if (types.statements.some(ts.isImportDeclaration)) {
    fail("src/types.ts must import nothing");
  }
  const parts = [types.getFullText().replace("export {};\n", "").trim()];
  const entry = parse("index.ts", ts.sys.readFile(join(src, "index.ts")) ?? "");
  for (const statement of entry.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    const module = declarationOf(statement.moduleSpecifier.text);
    for (const name of statement.exportClause.elements) {
      const found = module.statements.filter(
        (node) =>
          ts.isFunctionDeclaration(node) && node.name?.text === name.name.text,
      );
      if (found.length === 0) fail(`${name.name.text} isn't a function`);
      parts.push(...found.map((node) => node.getFullText().trim()));
    }
  }
  const text = `${parts.join("\n\n")}\n`;
  if (parse("index.d.ts", text).statements.some(ts.isImportDeclaration)) {
    fail("index.d.ts imports another module");
  }
  return text;
}

async function writeManifest() {
  const manifest: Record<string, unknown> = await Bun.file(
    join(root, "package.json"),
  ).json();
  for (const field of STRIP_FIELDS) delete manifest[field];
  const text = JSON.stringify(manifest, null, 2).replaceAll('"./dist/', '"./');
  if (DIST_PREFIX.test(text)) fail("package.json still points into dist/");
  await writeFile(join(dist, "package.json"), `${text}\n`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await bundle();
const declarations = bundleDeclarations(emitDeclarations());
await mkdir(dirname(join(dist, "index.d.ts")), { recursive: true });
await writeFile(join(dist, "index.d.ts"), declarations);
await writeManifest();
await Promise.all(
  ["README.md", "LICENSE", "CHANGELOG.md"].map((file) =>
    cp(join(root, file), join(dist, file)),
  ),
);
console.log("✓ Build completed");
