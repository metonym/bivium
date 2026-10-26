import { parseBarrel } from "../src/barrel.ts";
import { affectedBy, baseBarrelNames } from "../src/graph.ts";
import {
  BARREL,
  BARREL_SOURCE,
  CONFIG,
  config,
  deps,
  graphOf,
  PACKAGE,
  packages,
  REPO,
} from "./fixture.ts";

describe("parseBarrel", () => {
  it("maps every exported name, including multi-line and renamed ones", () => {
    expect(
      Object.fromEntries(parseBarrel(BARREL, BARREL_SOURCE)?.names ?? []),
    ).toEqual({
      Accordion: "./Accordion/Accordion.svelte",
      Button: "./Button/Button.svelte",
      Modal: "./Modal/Modal.svelte",
      Header: "./Modal/Modal.svelte",
    });
  });

  it("reads star, namespace and type re-exports", () => {
    const barrel = parseBarrel(
      "src/index.ts",
      `// Public API\nexport * from "./a";\nexport * as b from "./b";\nexport type { C } from "./c";\n/* done */`,
    );
    expect(barrel?.stars).toEqual(["./a"]);
    expect(Object.fromEntries(barrel?.names ?? [])).toEqual({
      b: "./b",
      C: "./c",
    });
  });

  it.each([
    ["has its own code", `export { a } from "./a";\nexport const b = 1;`],
    ["imports", `import "./setup";\nexport { a } from "./a";`],
    ["exports nothing", "// empty"],
  ])("isn't a barrel when it %s", (_, source) => {
    expect(parseBarrel("src/index.js", source)).toBeUndefined();
  });

  it("isn't a barrel outside a script module", () => {
    expect(parseBarrel("src/A.svelte", `export { a } from "./a";`)).toBe(
      undefined,
    );
  });
});

describe("barrel names", () => {
  const files = {
    ...REPO,
    "src/List/index.js": `export { default as List } from "./List.svelte";\nexport { default as ListItem } from "./ListItem.svelte";`,
    "src/List/List.svelte": "<script></script>",
    "src/List/ListItem.svelte": "<script></script>",
    "src/Dropdown/Dropdown.svelte": `<script>\n  import { List } from "../List";\n</script>`,
  };

  it("binds named imports of any barrel, including by relative path", () => {
    const graph = graphOf(files);
    expect([
      ...(graph.get("src/Dropdown/Dropdown.svelte")?.files ?? []),
    ]).toEqual(["src/List/index.js#List"]);
    expect(affectedBy(graph, ["src/List/ListItem.svelte"])).not.toContain(
      "src/Dropdown/Dropdown.svelte",
    );
    expect(affectedBy(graph, ["src/List/List.svelte"])).toContain(
      "src/Dropdown/Dropdown.svelte",
    );
  });

  it("uses the whole barrel when the package doesn't declare sideEffects", () => {
    const { sideEffects: _, ...effectful } = PACKAGE;
    const graph = graphOf(files, { packages: packages(effectful) });
    expect([
      ...(graph.get("src/Dropdown/Dropdown.svelte")?.files ?? []),
    ]).toEqual(["src/List/index.js"]);
    expect(graph.has("src/List/index.js#List")).toBe(false);
    expect(
      deps(
        "tests/x.test.ts",
        `import { Modal } from "carbon-components-svelte";`,
        {},
        {
          packages: packages(effectful),
        },
      ).files,
    ).toEqual([BARREL]);
  });

  it("binds names when sideEffects is false", () => {
    const graph = graphOf(files, {
      packages: packages({ ...PACKAGE, sideEffects: false }),
    });
    expect(graph.get("src/List/index.js#List")?.files).toEqual(
      new Set(["src/List/List.svelte"]),
    );
  });

  it("keeps a re-exported module with side effects behind every name", () => {
    const graph = graphOf(files, {
      packages: packages({ ...PACKAGE, sideEffects: ["ListItem.svelte"] }),
    });
    expect(graph.get("src/List/index.js#List")?.files).toEqual(
      new Set(["src/List/List.svelte", "src/List/ListItem.svelte"]),
    );
    expect(affectedBy(graph, ["src/List/ListItem.svelte"])).toContain(
      "src/Dropdown/Dropdown.svelte",
    );
  });

  it("reads a ./-prefixed sideEffects glob as relative to the package", () => {
    const graph = graphOf(
      {
        "lib/index.js": `export { a } from "./a.js";\nexport { e } from "../effects.js";`,
        "lib/a.js": "export const a = 1;",
        "effects.js": "globalThis.x = 1;\nexport const e = 1;",
      },
      { packages: packages({ ...PACKAGE, sideEffects: ["./effects.js"] }) },
    );
    expect(graph.get("lib/index.js#a")?.files).toEqual(
      new Set(["lib/a.js", "effects.js"]),
    );
  });

  it("reads a sideEffects path relative to its own package", () => {
    const graph = graphOf(
      {
        "packages/ui/index.js": `export { a } from "./a.js";\nexport { e } from "./effects.js";`,
        "packages/ui/a.js": "export const a = 1;",
        "packages/ui/effects.js": "globalThis.x = 1;\nexport const e = 1;",
      },
      {
        packages: new Map([
          [".", PACKAGE],
          ["packages/ui", { name: "ui", sideEffects: ["./effects.js"] }],
        ]),
      },
    );
    expect(graph.get("packages/ui/index.js#a")?.files).toEqual(
      new Set(["packages/ui/a.js", "packages/ui/effects.js"]),
    );
  });

  it("binds names only for the modules `barrels` allows", () => {
    const graph = graphOf(files, {
      config: { ...CONFIG, barrels: ["src/index.js"] },
    });
    expect([
      ...(graph.get("src/Dropdown/Dropdown.svelte")?.files ?? []),
    ]).toEqual(["src/List/index.js"]);
    expect(graph.has(`${BARREL}#Modal`)).toBe(true);
  });

  it("marks a name whose target doesn't resolve as unknown", () => {
    const graph = graphOf({
      ...files,
      "src/List/index.js": `export { default as List } from "./Gone.svelte";`,
    });
    expect(graph.get("src/List/index.js#List")?.unknown).toEqual([
      `unresolved "./Gone.svelte"`,
    ]);
  });

  it("resolves a barrel's base version against the head graph", () => {
    const graph = graphOf();
    const options = { config, packages: packages() };
    expect(
      Object.fromEntries(
        baseBarrelNames(
          BARREL,
          `export { default as Button } from "./Modal/Modal.svelte";`,
          options,
          graph,
        ) ?? [],
      ),
    ).toEqual({ Button: ["src/Modal/Modal.svelte"] });
    expect(baseBarrelNames(BARREL, undefined, options, graph)).toBeUndefined();
    expect(baseBarrelNames(BARREL, "export const x = 1;", options, graph)).toBe(
      undefined,
    );
  });
});
