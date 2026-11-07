import { parseYaml } from "../src/yaml.ts";

describe("parseYaml", () => {
  it("reads what pnpm-lock.yaml is made of", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "",
      "# a comment",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      '@acme/ui':",
      "        specifier: workspace:*",
      "        version: link:packages/ui",
      "      react-dom:",
      "        specifier: 18.2.0",
      "        version: 18.2.0(react@18.2.0)  # resolved",
      "",
      "packages:",
      "",
      "  react@18.2.0:",
      "    resolution: {integrity: sha512-x==, tarball: 'https://a/b.tgz'}",
      "    engines: {node: '>=0.10.0'}",
      "    cpu: [x64, arm64]",
      "    hasBin: true",
      "",
      "snapshots:",
      "",
      "  react@18.2.0: {}",
      "  debug@4.3.4:",
      "    transitivePeerDependencies:",
      "      - supports-color",
      '      - "it\'s quoted"',
      "    list:",
      "      - name: a",
      "        value: b",
      "      -",
      "        nested: c",
    ].join("\n");
    expect(parseYaml(text)).toEqual({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: {
            "@acme/ui": {
              specifier: "workspace:*",
              version: "link:packages/ui",
            },
            "react-dom": {
              specifier: "18.2.0",
              version: "18.2.0(react@18.2.0)",
            },
          },
        },
      },
      packages: {
        "react@18.2.0": {
          resolution: "{integrity: sha512-x==, tarball: 'https://a/b.tgz'}",
          engines: "{node: '>=0.10.0'}",
          cpu: "[x64, arm64]",
          hasBin: "true",
        },
      },
      snapshots: {
        "react@18.2.0": {},
        "debug@4.3.4": {
          transitivePeerDependencies: ["supports-color", "it's quoted"],
          list: [{ name: "a", value: "b" }, { nested: "c" }],
        },
      },
    });
  });

  it.each([
    ["an anchor", "a: &x 1"],
    ["a flow collection over lines", "a: {b: 1,\n  c: 2}"],
    ["a tab in indentation", "a:\n\tb: 1"],
    ["a duplicate key", "a: 1\na: 2"],
    ["a line that isn't a key", "a: 1\njust text"],
    ["an unterminated string", "a: 'open"],
  ])("throws on %s", (_, text) => {
    expect(() => parseYaml(text)).toThrow();
  });

  it("reads block scalars, with their comments and blank lines", () => {
    const text = [
      "a: |",
      "  # a comment in the text",
      "  line",
      "",
      "    indented",
      "b: |-",
      "  stripped",
      "c: >",
      "  folded",
      "  text",
      "",
      "  paragraph",
      "d: |+",
      "  kept",
      "",
      "e:",
      "  - |",
      "    item",
      "  - run: |",
      "      echo\tx",
      "\tsame",
      "    name: after",
    ].join("\n");
    expect(() => parseYaml(text)).toThrow();
    expect(parseYaml(text.replace("\tsame", "      same"))).toEqual({
      a: "# a comment in the text\nline\n\n  indented\n",
      b: "stripped",
      c: "folded text\nparagraph\n",
      d: "kept\n\n",
      e: ["item\n", { run: "echo\tx\nsame\n", name: "after" }],
    });
  });

  it("reads a plain scalar over several lines, and a document marker", () => {
    expect(
      parseYaml(
        ["---", "if: a &&", "  b  # a comment", "list:", "  - c", "    d"].join(
          "\n",
        ),
      ),
    ).toEqual({ if: "a && b", list: ["c d"] });
  });
});
