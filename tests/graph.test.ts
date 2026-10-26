import { globToRegExp } from "../src/glob.ts";
import { affectedBy, changedBarrelNames } from "../src/graph.ts";
import { sorted } from "../src/sorted.ts";
import { BARREL, deps, graphOf, REPO } from "./fixture.ts";

const graph = graphOf();

describe("globToRegExp", () => {
  it("matches `**` across directories and `*` within one", () => {
    expect(globToRegExp("css/**").test("css/vendor/a/_b.scss")).toBe(true);
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("src/*.js").test("src/a/b.js")).toBe(false);
    expect(globToRegExp("src/*.{js,ts}").test("src/a.ts")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("changedBarrelNames", () => {
  it("reports names added, removed, or retargeted", () => {
    const before = new Map([
      ["A", ["src/a.js"]],
      ["B", ["src/b.js"]],
      ["C", ["src/c.js"]],
    ]);
    const after = new Map([
      ["A", ["src/a.js"]],
      ["B", ["src/b2.js"]],
      ["D", ["src/d.js"]],
    ]);
    expect(sorted(changedBarrelNames(before, after))).toEqual(["B", "C", "D"]);
  });
});

describe("dependencies", () => {
  it("resolves relative imports by extension and index file", () => {
    expect(
      deps(
        "src/Modal/Modal.svelte",
        `<script>\n  import Button from "../Button/Button.svelte";\n  import { uid } from "../utils/uid";\n</script>`,
      ).files,
    ).toEqual(["src/Button/Button.svelte", "src/utils/uid.js"]);
  });

  it("resolves a JSDoc type import to a declaration file", () => {
    expect(
      deps(
        "src/Modal/Modal.svelte",
        `<script>\n  /** @typedef {import("../types").Type} Type */\n</script>`,
      ).files,
    ).toEqual(["src/types.d.ts"]);
  });

  it("resolves named barrel imports to the re-exported file", () => {
    expect(
      deps(
        "tests/x.test.ts",
        `import {\n  Accordion,\n  Header as H,\n  type Button,\n} from "carbon-components-svelte";`,
      ).files,
    ).toEqual([`${BARREL}#Accordion`, `${BARREL}#Button`, `${BARREL}#Header`]);
  });

  it("falls back to the whole barrel for a name it doesn't export", () => {
    expect(
      deps(
        "tests/x.test.ts",
        `import { Accordion, Unknown } from "carbon-components-svelte";`,
      ).files,
    ).toEqual([BARREL, `${BARREL}#Accordion`]);
  });

  it("treats default and namespace barrel imports as the whole barrel", () => {
    expect(
      deps(
        "tests/x.test.ts",
        `import * as All from "carbon-components-svelte";`,
      ).files,
    ).toEqual([BARREL]);
    expect(
      deps(
        "tests/x.test.ts",
        `import All, { Button } from "carbon-components-svelte";`,
      ).files,
    ).toEqual([BARREL]);
  });

  it("resolves the package alias and package-exports subpaths", () => {
    expect(
      deps(
        "tests/x.test-d.ts",
        `import A from "carbon-components-svelte/Button/Button.svelte";\nimport B from "carbon-components-svelte/src/Modal/Modal.svelte";`,
      ).files,
    ).toEqual(["src/Button/Button.svelte", "src/Modal/Modal.svelte"]);
  });

  it("reads side-effect imports, query suffixes, mocks, and literal dynamic imports", () => {
    expect(
      deps(
        "tests/x.test.ts",
        [
          `import "./user";`,
          `import raw from "../src/index.js?raw";`,
          `vi.mock("../src/utils/uid.js", async () => ({}));`,
          "const m = await import(`../src/Button/Button.svelte`);",
          `/** @type {import("svelte").Component} */`,
        ].join("\n"),
      ),
    ).toEqual({
      files: [
        "src/Button/Button.svelte",
        BARREL,
        "src/utils/uid.js",
        "tests/user.ts",
      ],
      packages: ["pkg:svelte"],
      patterns: [],
      unknown: [],
    });
  });

  it('ignores `from "…"` in prose and comments', () => {
    expect(
      deps(
        "tests/x.test.ts",
        `it('changes from "multiple" to "single"', () => {});\n// switching from "top" to "bottom"`,
      ),
    ).toEqual({ files: [], packages: [], patterns: [], unknown: [] });
  });

  it("turns import.meta.glob into a pattern relative to the file", () => {
    expect(
      deps(
        "tests/ssr.test.ts",
        `const m = import.meta.glob<string>("../src/**/*.svelte", { query: "?raw" });`,
      ).patterns,
    ).toEqual([String(globToRegExp("src/**/*.svelte"))]);
  });

  it("flags what it can't read as depending on everything", () => {
    expect(
      deps(
        "tests/x.test.ts",
        [
          `import missing from "./missing";`,
          `import alias from "$lib/thing";`,
          "const m = await import(name);",
          "const g = import.meta.glob(patterns);",
        ].join("\n"),
      ).unknown,
    ).toEqual([
      `unresolved "./missing"`,
      `unresolved "$lib/thing"`,
      "non-literal dynamic import",
      "non-literal glob import",
    ]);
  });

  it.each([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text
    "const m = await import(`./x/${name}.svelte`);",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text
    "const m = require(`./${name}`);",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text
    "vi.mock(`./${name}`);",
  ])("flags a templated module path as unreadable: %s", (source) => {
    expect(deps("tests/x.test.ts", source).unknown).toEqual([
      "non-literal dynamic import",
    ]);
  });

  it("reads a glob whose type argument nests generics", () => {
    expect(
      deps(
        "tests/ssr.test.ts",
        `const m = import.meta.glob<Record<string, string>>("../src/**/*.svelte");`,
      ).patterns,
    ).toEqual([String(globToRegExp("src/**/*.svelte"))]);
  });

  it("reads an import on the same line as <script>", () => {
    expect(
      deps(
        "e2e/fixtures/ModalFixture.svelte",
        `<script>import { user } from "../../tests/user";</script>`,
      ).files,
    ).toEqual(["tests/user.ts"]);
  });

  it.each([
    [
      "a literal path with a hash, ignoring another goto",
      `await page.goto("/accordion.html#top");\nawait other.goto("about:blank");`,
      { files: ["e2e/fixtures/accordion.html"], unknown: [] },
    ],
    [
      "a template literal with an interpolated query",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text
      "await page.goto(`/accordion.html?v=${v}`);",
      { files: ["e2e/fixtures/accordion.html"], unknown: [] },
    ],
    [
      "a variable it can't read",
      "await page.goto(url);",
      { unknown: ["non-literal goto(url)"] },
    ],
    [
      "an interpolated page name",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text
      "await page.goto(`/${name}.html?v=1`);",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text
      { unknown: ["non-literal goto(`/${name}.html?v=1`)"] },
    ],
    [
      "a page with no fixture",
      `await page.goto("/gone.html");`,
      { unknown: [`missing fixture "/gone.html"`] },
    ],
    [
      "a URL no pattern maps",
      `await page.goto("https://example.com");`,
      { unknown: [`goto("https://example.com")`] },
    ],
  ])(
    "maps page.goto() through the suite's urls: %s",
    (_name, source, expected) => {
      expect(deps("e2e/x.test.ts", source)).toMatchObject(expected);
    },
  );

  it("reads goto() only under a suite with urls", () => {
    expect(deps("tests/x.test.ts", "await page.goto(url);").unknown).toEqual(
      [],
    );
  });

  it("reads fixture HTML script and iframe sources", () => {
    expect(
      deps(
        "e2e/fixtures/accordion.html",
        `<script type="module" src="./accordion.ts"></script>`,
      ).files,
    ).toEqual(["e2e/fixtures/accordion.ts"]);
    expect(
      deps(
        "e2e/fixtures/accordion-framed.html",
        `<iframe title="demo" src="./accordion.html"></iframe>`,
      ).files,
    ).toEqual(["e2e/fixtures/accordion.html"]);
  });

  it("requires a @depends-on declaration to read the disk", () => {
    expect(
      deps("tests/x.test.ts", `import { readFileSync } from "node:fs";`)
        .unknown,
    ).toEqual(["reads the disk without @depends-on"]);
    expect(
      deps(
        "tests/x.test.ts",
        `// @depends-on css/** src/*.js\nimport { readFileSync } from "node:fs";`,
      ),
    ).toEqual({
      files: [],
      packages: ["pkg:node:fs"],
      patterns: [
        String(globToRegExp("css/**")),
        String(globToRegExp("src/*.js")),
      ],
      unknown: [],
    });
  });

  it.each([
    ["child_process", `import { spawnSync } from "node:child_process";`],
    ["Bun.Glob", `const files = new Bun.Glob("*.ts").scanSync(".");`],
  ])("treats %s as reading the disk", (_, source) => {
    expect(deps("tests/x.test.ts", source).unknown).toEqual([
      "reads the disk without @depends-on",
    ]);
  });

  it("keeps a brace list in @depends-on as one glob", () => {
    expect(
      deps(
        "tests/x.test.ts",
        `// @depends-on src/*.{js,ts} css/**\nimport { readFileSync } from "node:fs";`,
      ).patterns,
    ).toEqual([
      String(globToRegExp("src/*.{js,ts}")),
      String(globToRegExp("css/**")),
    ]);
  });

  it("builds a generated file from its configured inputs", () => {
    const node = graph.get("css/all.css");
    expect(node?.patterns.map(String)).toEqual([
      String(globToRegExp("css/**")),
      String(globToRegExp("scripts/build-css.ts")),
    ]);
    expect(affectedBy(graph, ["scripts/build-css.ts"])).toContain(
      "e2e/modal.test.ts",
    );
  });
});

describe("affectedBy", () => {
  it("walks dependents transitively", () => {
    const affected = affectedBy(graph, ["src/utils/uid.js"]);
    expect(affected.has("src/Modal/Modal.svelte")).toBe(true);
    expect(affected.has("tests/Modal/Modal.test.ts")).toBe(true);
  });

  it("can leave out files with unknown dependencies", () => {
    expect(
      affectedBy(graph, ["src/types.d.ts"]).has("tests/css/unknown.test.ts"),
    ).toBe(true);
    expect(
      affectedBy(graph, ["src/types.d.ts"], { includeUnknown: false }).has(
        "tests/css/unknown.test.ts",
      ),
    ).toBe(false);
  });
});

describe("directives", () => {
  // A host page globs every fixture but each test names its own, and its
  // helper reads entries as text: neither may widen a fixture change.
  const files = {
    ...REPO,
    "e2e/fixtures/host.ts": `// @glob-registry\nconst fixtures = import.meta.glob("./*Fixture.svelte");`,
    "e2e/fixtures/host.html": `<script type="module" src="./host.ts"></script>`,
    "e2e/helpers/host.ts": `import { readFileSync } from "node:fs";\n// @reads e2e/fixtures/*.ts\nawait page.goto("/host.html");`,
    "e2e/hosted.test.ts": `import { test } from "./helpers/host";\nawait page.goto("/accordion.html");`,
  };
  const hosted = graphOf(files);

  it("@glob-registry adds no edges from the glob", () => {
    expect(hosted.get("e2e/fixtures/host.ts")?.patterns).toEqual([]);
    expect(affectedBy(hosted, ["src/Modal/Modal.svelte"])).not.toContain(
      "e2e/hosted.test.ts",
    );
  });

  it("@reads counts only a direct change to a read file", () => {
    expect(hosted.get("e2e/helpers/host.ts")?.unknown).toEqual([]);
    expect(affectedBy(hosted, ["e2e/fixtures/modal.ts"])).toContain(
      "e2e/hosted.test.ts",
    );
    // modal.ts imports ModalFixture, but the helper only reads modal.ts.
    expect(
      affectedBy(hosted, ["e2e/fixtures/ModalFixture.svelte"]),
    ).not.toContain("e2e/hosted.test.ts");
  });
});
