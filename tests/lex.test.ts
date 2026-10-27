import { scan } from "../src/scan.ts";
import { scanRegex } from "../src/scan-regex.ts";
import type { Scan } from "../src/syntax.ts";

const specifiers = (path: string, source: string) =>
  scan(path, source).imports.map((ref) => ref.specifier);

/** A scan that must have lexed cleanly. */
function lexed(path: string, source: string, gotos = false): Scan {
  const result = scan(path, source, { gotos });
  if (result.fallback !== undefined) throw new Error(result.fallback);
  return result;
}

describe("regex literals and division", () => {
  it.each([
    ["division", `const a = b / c; import x from "./real";`],
    [
      "a regex holding import text",
      `const r = /import x from "fake"/;\nimport "./real";`,
    ],
    ["a regex holding a quote", `if (ok) /"/.test(s);\nimport "./real";`],
    [
      "a regex after return",
      `function f() { return /'/.test(s); }\nimport "./real";`,
    ],
    [
      "a regex after a block",
      `function f() {}\n/'/.test(s);\nimport "./real";`,
    ],
    ["chained division", `const a = b / 2 / c;\nimport "./real";`],
    ["division after a postfix ++", `let n = i++ / 2;\nimport "./real";`],
    [
      "division after a non-null assertion",
      `const n = a! / b;\nimport "./real";`,
    ],
    ["division after a call", `const n = f(x) / 2;\nimport "./real";`],
    ["a regex with a class holding /", `const r = /[/'"]/g;\nimport "./real";`],
    ["a regex after an arrow", `const f = () => /'/;\nimport "./real";`],
    [
      "division after a property named like a keyword",
      `const n = x.return / 2 / y;\nimport "./real";`,
    ],
  ])("%s", (_name, source) => {
    expect(lexed("a.ts", source).imports.map((ref) => ref.specifier)).toEqual([
      "./real",
    ]);
  });
});

describe("templates", () => {
  it("skips text and reads code in nested substitutions", () => {
    const source = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text
      'const t = `import("./fake") ${`b ${"c"} import("./fake2")`} ${{ a: 1 }.a}`;',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text
      'const u = `${await import("./real")}`;',
    ].join("\n");
    expect(specifiers("a.ts", source)).toEqual(["./real"]);
  });

  it("reads a no-substitution template path and flags a templated one", () => {
    expect(lexed("a.ts", "await import(`./real.js`);").imports).toEqual([
      { specifier: "./real.js" },
    ]);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text
      lexed("a.ts", "await import(`./x/${name}.js`);").unknown,
    ).toEqual(["non-literal dynamic import"]);
  });
});

describe("comments and strings", () => {
  it("doesn't count imports spelled in comments", () => {
    const source = [
      `// import x from "./fake1"`,
      `/* import("./fake2"); require("./fake3") */`,
      `/** Call import("./fake4") to load it. */`,
      `// vi.mock("./fake5")`,
      `import "./real";`,
    ].join("\n");
    expect(lexed("a.ts", source).imports).toEqual([{ specifier: "./real" }]);
  });

  it("doesn't count imports or disk reads spelled in strings", () => {
    const source = [
      `const a = "import x from './fake1'";`,
      `const b = 'require("./fake2") vi.mock("./fake3")';`,
      `const c = "import.meta.glob('./fake/*')";`,
      `const d = 'import { readFileSync } from "node:fs"; Bun.file("x")';`,
    ].join("\n");
    expect(lexed("a.ts", source)).toMatchObject({
      imports: [],
      globs: [],
      unknown: [],
    });
  });

  it("reads JSDoc type imports, but not JSDoc prose or examples", () => {
    const source = [
      `/** @type {import("./types").T} */`,
      `/** @import { A, B as C } from "./barrel" */`,
      "/** Dynamic imports `import('./prose')` are ignored. */",
      "/**\n * @example\n * vi.mock('./x', () => { import('./example') })\n */",
    ].join("\n");
    expect(lexed("a.js", source).imports).toEqual([
      { specifier: "./types" },
      { specifier: "./barrel", names: ["A", "B"] },
    ]);
  });

  it("ignores goto() in comments and strings", () => {
    const source = `// page.goto(url)\nconst s = "page.goto(other)";\nawait page.goto("/a.html");`;
    expect(lexed("e2e/a.test.ts", source, true).gotos).toEqual([`"/a.html"`]);
  });

  it("reads annotations only in comments", () => {
    const source = [
      `import { readFileSync } from "node:fs";`,
      "// @depends-on css/**",
      "const s = `\n// @depends-on fake/**\n`;",
    ].join("\n");
    expect(lexed("a.ts", source)).toMatchObject({
      dependsOn: ["css/**"],
      unknown: [],
    });
  });
});

describe("module syntax", () => {
  it("reads every import and re-export form", () => {
    const source = [
      `import a from "./a";`,
      `import type { B } from "./b";`,
      `import { "c-d" as c } from "./c";`,
      `export * from "./d";`,
      `export * as e from "./e";`,
      `export type { F } from "./f";`,
      `import g = require("./g");`,
      `const h = require("./h");`,
      `const i = module.require("./i");`,
      `vi.mock("./j");`,
      `const k = await vi.importActual<typeof import("./k")>("./k");`,
      `type L = typeof import("./l");`,
    ].join("\n");
    expect(specifiers("a.ts", source)).toEqual([
      "./a",
      "./b",
      "./c",
      "./d",
      "./e",
      "./f",
      "./g",
      "./h",
      "./i",
      "./j",
      "./k",
      "./k",
      "./l",
    ]);
  });

  it("flags a dynamic path built at runtime", () => {
    expect(lexed("a.ts", `await import("./a" + b);`).unknown).toEqual([
      "non-literal dynamic import",
    ]);
  });

  it("doesn't take a method named import for a call", () => {
    const source =
      "class A {\n  import(node) {\n    return node;\n  }\n}\ninterface B { import(id: string): void }";
    expect(lexed("a.ts", source).unknown).toEqual([]);
  });

  it("reads import.meta.glob with nested generics and arrays", () => {
    const result = lexed(
      "tests/a.test.ts",
      [
        `const a = import.meta.glob<Record<string, () => Promise<unknown>>>("./a/*.ts");`,
        `const b = import.meta.glob(["./b/*.svelte", "!./b/skip.svelte"], { eager: true });`,
      ].join("\n"),
    );
    expect(result.globs).toEqual(["tests/a/*.ts", "tests/b/*.svelte"]);
    expect(result.unknown).toEqual([]);
  });

  it("flags a glob it can't read", () => {
    expect(
      lexed("a.ts", `const g = import.meta.glob(["./a/*", base + "/b"]);`)
        .unknown,
    ).toEqual(["non-literal glob import"]);
  });
});

describe("JSX", () => {
  it("lexes text with quotes as text and expressions as code", () => {
    const source = `const A = () => <p title="it's">Don't import "./fake" {import("./real")}</p>;\nimport "./also";`;
    expect(lexed("a.jsx", source).imports.map((ref) => ref.specifier)).toEqual([
      "./real",
      "./also",
    ]);
  });

  it("reads `<T,>` as type parameters in .tsx", () => {
    expect(
      specifiers("a.tsx", `const f = <T,>(x: T) => x;\nimport "./real";`),
    ).toEqual(["./real"]);
  });

  it("doesn't take a shift for an element", () => {
    expect(lexed("a.js", `const a = 1<<b;\nimport "./real";`).imports).toEqual([
      { specifier: "./real" },
    ]);
  });
});

describe("host formats", () => {
  it("reads a one-line <script>", () => {
    expect(
      lexed("A.svelte", `<script>import { a } from "./a";</script><p>x</p>`)
        .imports,
    ).toEqual([{ specifier: "./a", names: ["a"] }]);
  });

  it("reads Svelte script blocks and markup expressions, not markup text", () => {
    const source = [
      `<script lang="ts" generics="T extends import('./t').Item">`,
      `  import B from "./B.svelte";`,
      "</script>",
      `<p>Don't import x from "./fake"</p>`,
      `<!-- <script>import "./commented";</script> -->`,
      `{#await import("./Lazy.svelte") then M}<M.default />{/await}`,
      "<style>a::after { content: \"import './css'\"; }</style>",
    ].join("\n");
    expect(specifiers("A.svelte", source)).toEqual([
      "./t",
      "./B.svelte",
      "./Lazy.svelte",
    ]);
  });

  it("reads Vue scripts and Astro frontmatter", () => {
    expect(
      specifiers(
        "A.vue",
        `<template><p>{{ "import './fake'" }}</p></template>\n<script setup>import B from "./B.vue";</script>`,
      ),
    ).toEqual(["./B.vue"]);
    expect(
      specifiers(
        "a.astro",
        `---\nimport Layout from "./Layout.astro";\n---\n<Layout><p>Don't</p></Layout>\n<script>import "./client";</script>`,
      ),
    ).toEqual(["./Layout.astro", "./client"]);
  });

  it("reads HTML script, link and iframe refs, and inline scripts", () => {
    const source = [
      `<link rel="stylesheet" href="./a.css">`,
      `<link rel="preconnect" href="https://example.com">`,
      "<script type=module src=b.ts></script>",
      `<iframe title="c" src="./c.html"></iframe>`,
      `<!-- <script src="./commented.ts"></script> -->`,
      `<script type="module">import "./d"; const s = "<iframe src='./e.html'>";</script>`,
    ].join("\n");
    expect(specifiers("e2e/fixtures/a.html", source)).toEqual([
      "./a.css",
      "./b.ts",
      "./c.html",
      "./d",
    ]);
  });

  it("reads SvelteKit's %sveltekit.assets% refs, and no other placeholder", () => {
    const source = [
      `<link rel="icon" href="%sveltekit.assets%/favicon.png" />`,
      `<script nonce="%sveltekit.nonce%">window.x = 1;</script>`,
      "%sveltekit.head%",
      `<div style="display: contents">%sveltekit.body%</div>`,
    ].join("\n");
    const expected = {
      imports: [{ specifier: "./%sveltekit.assets%/favicon.png" }],
      unknown: [],
    };
    expect(lexed("src/app.html", source)).toMatchObject(expected);
    expect(scanRegex("src/app.html", source)).toMatchObject(expected);
  });
});

describe("fallback", () => {
  it.each([
    ["an unterminated template", "const t = `abc;\nimport './a';"],
    ["an unclosed comment", `import "./a";\n/* never closed`],
    ["an unterminated string", `import "./a";\nconst s = "abc\n;`],
    ["a regex at the end", `import "./a";\nconst r = /abc`],
    ["an extra brace", `import "./a";\n}`],
    ["a missing brace", `import "./a";\nfunction f() {`],
    ["an unterminated script", `<script>import "./a";`],
  ])("uses the regex extractor for %s", (_name, source) => {
    const path = source.startsWith("<") ? "A.svelte" : "a.ts";
    const result = scan(path, source);
    expect(result.fallback).toBeString();
    const { fallback: _, ...rest } = result;
    expect(rest).toEqual(scanRegex(path, source));
    expect(result.imports).toContainEqual({ specifier: "./a" });
  });
});
