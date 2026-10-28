import { resolveConfig } from "../src/config.ts";
import {
  createResolver,
  exportTargets,
  type PackageJson,
  type Packages,
  toPackageJson,
} from "../src/resolve.ts";
import { parseJsonc, readTsconfigs, type TsConfigs } from "../src/tsconfig.ts";
import type { Config } from "../src/types.ts";

const BASE: Config = { suites: { unit: { tests: "**/*.test.ts" } } };

function resolver(
  files: string[],
  options: {
    config?: Partial<Config>;
    packages?: Record<string, PackageJson>;
    tsconfigs?: TsConfigs;
  } = {},
) {
  const packages: Packages = new Map(
    Object.entries(options.packages ?? { ".": {} }),
  );
  return createResolver({
    files: new Set(files),
    config: resolveConfig({ ...BASE, ...options.config }),
    packages,
    tsconfigs: options.tsconfigs,
  });
}

describe("relative specifiers", () => {
  it("tries each extension, then a directory index", () => {
    const resolve = resolver(["src/a.ts", "src/b/index.js", "src/c.svelte"]);
    expect(resolve("src/x.ts", "./a")).toEqual({ files: ["src/a.ts"] });
    expect(resolve("src/x.ts", "./b")).toEqual({ files: ["src/b/index.js"] });
    expect(resolve("src/x.ts", "./c.svelte")).toEqual({
      files: ["src/c.svelte"],
    });
    expect(resolve("src/deep/x.ts", "../a")).toEqual({ files: ["src/a.ts"] });
  });

  it("keeps every file a specifier could mean", () => {
    const resolve = resolver(["src/a.js", "src/a.d.ts"]);
    expect(resolve("src/x.ts", "./a")).toEqual({
      files: ["src/a.js", "src/a.d.ts"],
    });
  });

  it("rewrites .js to .ts only when the .js file is missing", () => {
    const resolve = resolver(["src/a.ts", "src/b.mts", "src/c.js", "src/c.ts"]);
    expect(resolve("src/x.ts", "./a.js")).toEqual({ files: ["src/a.ts"] });
    expect(resolve("src/x.ts", "./b.mjs")).toEqual({ files: ["src/b.mts"] });
    expect(resolve("src/x.ts", "./c.js")).toEqual({ files: ["src/c.js"] });
  });

  it("drops a query or hash, and fails on a missing file", () => {
    const resolve = resolver(["src/a.ts"]);
    expect(resolve("src/x.ts", "./a?raw")).toEqual({ files: ["src/a.ts"] });
    expect(resolve("src/x.ts", "./a#x")).toEqual({ files: ["src/a.ts"] });
    expect(resolve("src/x.ts", "./missing")).toBeUndefined();
  });

  it("honors a configured extension list", () => {
    const resolve = resolver(["src/a.ts", "src/a.vue"], {
      config: { extensions: [".vue"] },
    });
    expect(resolve("src/x.ts", "./a")).toEqual({ files: ["src/a.vue"] });
  });

  it("accepts a generated file that doesn't exist yet", () => {
    const resolve = resolver([], {
      config: { edges: { "css/*.css": ["css/**"] } },
    });
    expect(resolve("src/x.ts", "../css/all.css")).toEqual({
      files: ["css/all.css"],
    });
  });
});

describe("exportTargets", () => {
  const exports = {
    ".": { types: "./index.d.ts", import: "./index.js" },
    "./utils": "./src/utils.js",
    "./css/*.css": { default: "./css/*.css" },
    "./src/*": "./lib/*",
    "./src/*.js": { types: "./src/*.d.ts", import: "./src/*.js" },
    "./nested": { node: { import: "./a.mjs", require: "./a.cjs" } },
    "./list": ["./first.js", "./second.js"],
    "./private/*": null,
  };

  it("takes the union of every condition of an exact key", () => {
    expect(exportTargets(exports, ".")).toEqual(["./index.d.ts", "./index.js"]);
    expect(exportTargets(exports, "./nested")).toEqual(["./a.mjs", "./a.cjs"]);
    expect(exportTargets(exports, "./list")).toEqual([
      "./first.js",
      "./second.js",
    ]);
  });

  it("substitutes the longest-prefix pattern", () => {
    expect(exportTargets(exports, "./css/all.css")).toEqual(["./css/all.css"]);
    // Both `./src/*` keys match; with equal prefixes the longer key wins.
    expect(exportTargets(exports, "./src/a/b.js")).toEqual([
      "./src/a/b.d.ts",
      "./src/a/b.js",
    ]);
    expect(exportTargets(exports, "./src/a")).toEqual(["./lib/a"]);
  });

  it("has nothing for an unexported or null subpath", () => {
    expect(exportTargets(exports, "./missing")).toBeUndefined();
    expect(exportTargets(exports, "./private/x")).toEqual([]);
  });

  it("reads string and condition-only sugar as the `.` entry", () => {
    expect(exportTargets("./main.js", ".")).toEqual(["./main.js"]);
    expect(
      exportTargets({ import: "./a.js", require: "./a.cjs" }, "."),
    ).toEqual(["./a.js", "./a.cjs"]);
    expect(exportTargets("./main.js", "./x")).toBeUndefined();
  });
});

describe("package specifiers", () => {
  const pkg: PackageJson = {
    name: "lib",
    exports: {
      ".": { types: "./src/index.d.ts", import: "./src/index.js" },
      "./css/*.css": "./css/*.css",
      "./src/*.js": { types: "./src/*.d.ts", import: "./src/*.js" },
    },
    dependencies: { svelte: "5", "@scope/tool": "1" },
  };
  const files = ["src/index.js", "src/a.js", "src/a.d.ts", "src/b.js"];

  it("resolves the package's own name through its exports", () => {
    const resolve = resolver(files, { packages: { ".": pkg } });
    expect(resolve("tests/x.test.ts", "lib")).toEqual({
      files: ["src/index.js"],
    });
    expect(resolve("tests/x.test.ts", "lib/src/a.js")).toEqual({
      files: ["src/a.d.ts", "src/a.js"],
    });
    expect(resolve("tests/x.test.ts", "lib/src/zzz.js")).toBeUndefined();
    expect(resolve("tests/x.test.ts", "lib/package.json")).toBeUndefined();
  });

  it("resolves a package without exports through main and subpaths", () => {
    const resolve = resolver(["lib/main.js", "lib/util.ts"], {
      packages: { ".": {}, lib: { name: "legacy", main: "./main.js" } },
    });
    expect(resolve("x.ts", "legacy")).toEqual({ files: ["lib/main.js"] });
    expect(resolve("x.ts", "legacy/util")).toEqual({ files: ["lib/util.ts"] });
  });

  it("tries an alias first, longest key first, then the package's exports", () => {
    const resolve = resolver([...files, "src/Button/Button.svelte"], {
      config: { alias: { lib: "src", "lib/css": "styles" } },
      packages: { ".": pkg },
    });
    expect(resolve("tests/x.test.ts", "lib/Button/Button.svelte")).toEqual({
      files: ["src/Button/Button.svelte"],
    });
    expect(resolve("tests/x.test.ts", "lib")).toEqual({
      files: ["src/index.js"],
    });
    // `src/src/b.js` doesn't exist, so the exports map is next.
    expect(resolve("tests/x.test.ts", "lib/src/b.js")).toEqual({
      files: ["src/b.js"],
    });
  });

  it("makes builtins pkg: nodes", () => {
    const resolve = resolver([]);
    expect(resolve("x.ts", "fs")).toEqual({ pkg: "node:fs" });
    expect(resolve("x.ts", "node:fs/promises")).toEqual({ pkg: "node:fs" });
    expect(resolve("x.ts", "path/posix")).toEqual({ pkg: "node:path" });
    expect(resolve("x.ts", "bun:test")).toEqual({ pkg: "bun:test" });
    expect(resolve("x.ts", "bun")).toEqual({ pkg: "bun" });
  });

  it("makes declared dependencies pkg: nodes by package name", () => {
    const resolve = resolver([], { packages: { ".": pkg } });
    expect(resolve("x.ts", "svelte/store")).toEqual({ pkg: "svelte" });
    expect(resolve("x.ts", "@scope/tool/sub")).toEqual({ pkg: "@scope/tool" });
    expect(resolve("x.ts", "undeclared")).toBeUndefined();
    expect(resolve("x.ts", "$lib/thing")).toBeUndefined();
  });

  it("reads a nested package's dependencies for its own files only", () => {
    const resolve = resolver([], {
      packages: { ".": pkg, app: { dependencies: { react: "19" } } },
    });
    expect(resolve("app/x.ts", "react")).toEqual({ pkg: "react" });
    expect(resolve("app/x.ts", "svelte")).toEqual({ pkg: "svelte" });
    expect(resolve("src/x.ts", "react")).toBeUndefined();
  });

  it("accepts configured externals without a declaration", () => {
    const resolve = resolver([], { config: { external: ["axe-core"] } });
    expect(resolve("x.ts", "axe-core")).toEqual({ pkg: "axe-core" });
  });
});

describe("subpath imports", () => {
  const app: PackageJson = {
    name: "app",
    imports: {
      "#config": "./src/config.js",
      "#lib/*": "./src/lib/*",
      "#lib/internal/*": null,
      "#env": {
        types: "./src/env.d.ts",
        node: "./src/env-node.js",
        default: "./src/env-browser.js",
      },
      "#dep": { node: "dep-native", default: "./src/dep-polyfill.js" },
      "#native": "dep-native",
      "#unknown": { node: "undeclared", default: "./src/dep-polyfill.js" },
    },
    dependencies: { "dep-native": "1" },
  };
  const files = [
    "src/config.js",
    "src/lib/ActionButton.svelte",
    "src/lib/internal/x.js",
    "src/env.d.ts",
    "src/env-node.js",
    "src/dep-polyfill.js",
    "examples/kit/src/lib/Button.svelte",
  ];
  const resolve = resolver(files, {
    packages: {
      ".": app,
      "examples/kit": { imports: { "#lib/*": "./src/lib/*" } },
    },
  });

  it("resolves an exact key and a pattern in the owning package", () => {
    expect(resolve("src/x.ts", "#config")).toEqual({
      files: ["src/config.js"],
    });
    expect(resolve("tests/x.test.ts", "#lib/ActionButton.svelte")).toEqual({
      files: ["src/lib/ActionButton.svelte"],
    });
    expect(resolve("tests/x.test.ts", "#lib/ActionButton.svelte?raw")).toEqual({
      files: ["src/lib/ActionButton.svelte"],
    });
    expect(
      resolve("examples/kit/src/routes/+page.svelte", "#lib/Button.svelte"),
    ).toEqual({ files: ["examples/kit/src/lib/Button.svelte"] });
  });

  it("takes every condition's target that exists", () => {
    expect(resolve("src/x.ts", "#env")).toEqual({
      files: ["src/env.d.ts", "src/env-node.js"],
    });
    expect(resolve("src/x.ts", "#dep")).toEqual({
      files: ["src/dep-polyfill.js"],
    });
    expect(resolve("src/x.ts", "#native")).toEqual({ pkg: "dep-native" });
  });

  it("leaves an unmatched, null, missing or unknown target unresolved", () => {
    expect(resolve("src/x.ts", "#nope")).toBeUndefined();
    expect(resolve("src/x.ts", "#lib/missing.svelte")).toBeUndefined();
    expect(resolve("src/x.ts", "#lib/internal/x.js")).toBeUndefined();
    expect(resolve("src/x.ts", "#unknown")).toBeUndefined();
    // Another package's `imports` don't apply.
    expect(
      resolve("examples/kit/src/x.ts", "#lib/ActionButton.svelte"),
    ).toBeUndefined();
    expect(resolver(files)("src/x.ts", "#config")).toBeUndefined();
  });

  it("reads `imports` from package.json only when it's an object", () => {
    expect(toPackageJson({ imports: { "#a": "./a.js" } }).imports).toEqual({
      "#a": "./a.js",
    });
    expect(toPackageJson({ imports: "./a.js" }).imports).toBeUndefined();
  });
});

describe("tsconfig paths", () => {
  // `tsconfig.json` files by path, read as `readTsconfigs` reads them.
  async function tsconfigs(texts: Record<string, string>) {
    const read = async (file: string) => texts[file];
    return readTsconfigs(
      Object.keys(texts).filter((file) => file.endsWith("tsconfig.json")),
      read,
    );
  }

  it("parses comments and trailing commas, and not inside strings", () => {
    expect(
      parseJsonc(`\uFEFF{
        // a comment
        "a": "x // not a comment", /* block */
        "b": ["/* kept */", "y,}",],
      }`),
    ).toEqual({ a: "x // not a comment", b: ["/* kept */", "y,}"] });
    expect(() => parseJsonc(`{ "a": 1 /* never closed }`)).toThrow();
  });

  it("maps a package name to the source, before the package's exports", async () => {
    const { tsconfigs: ts } = await tsconfigs({
      "tsconfig.json": `{
        "compilerOptions": {
          // The tests import the package by name.
          "paths": { "carbon-preprocess-svelte/*": ["./src/*"], "exact": ["./src/index.ts"] },
        },
      }`,
    });
    const resolve = resolver(["src/index.ts", "src/utils/a.ts", "dist/a.js"], {
      packages: {
        ".": {
          name: "carbon-preprocess-svelte",
          exports: { "./*": "./dist/*.js" },
        },
      },
      tsconfigs: ts,
    });
    expect(
      resolve("tests/x.test.ts", "carbon-preprocess-svelte/utils/a"),
    ).toEqual({ files: ["src/utils/a.ts"] });
    expect(resolve("tests/x.test.ts", "exact")).toEqual({
      files: ["src/index.ts"],
    });
    // No `src/a`: the exports map is next.
    expect(resolve("tests/x.test.ts", "carbon-preprocess-svelte/a")).toEqual({
      files: ["dist/a.js"],
    });
  });

  it("resolves targets against baseUrl, and bare specifiers under it", async () => {
    const { tsconfigs: ts } = await tsconfigs({
      "tsconfig.json": `{ "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["*"] } } }`,
    });
    const resolve = resolver(["src/lib/a.ts", "src/utils.ts"], {
      tsconfigs: ts,
    });
    expect(resolve("src/x.ts", "@/lib/a")).toEqual({ files: ["src/lib/a.ts"] });
    expect(resolve("src/x.ts", "utils")).toEqual({ files: ["src/utils.ts"] });
    expect(resolve("src/x.ts", "missing")).toBeUndefined();
  });

  it("takes every target that exists", async () => {
    const { tsconfigs: ts } = await tsconfigs({
      "tsconfig.json": `{ "compilerOptions": { "paths": { "~/*": ["./src/*", "./generated/*", "./missing/*"] } } }`,
    });
    const resolve = resolver(["src/a.ts", "generated/a.d.ts"], {
      tsconfigs: ts,
    });
    expect(resolve("x.ts", "~/a")).toEqual({
      files: ["src/a.ts", "generated/a.d.ts"],
    });
  });

  it("uses the nearest tsconfig.json, with its relative extends", async () => {
    const { tsconfigs: ts } = await tsconfigs({
      "tsconfig.base.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@ui/*": ["packages/ui/src/*"] } } }`,
      "tsconfig.json": `{ "extends": "./tsconfig.base", "compilerOptions": { "paths": { "@root/*": ["src/*"] } } }`,
      "packages/app/tsconfig.json": `{ "extends": ["@tsconfig/svelte/tsconfig.json", "../../tsconfig.base.json"] }`,
    });
    const resolve = resolver(["packages/ui/src/Button.ts", "src/a.ts"], {
      tsconfigs: ts,
    });
    expect(resolve("packages/app/src/x.ts", "@ui/Button")).toEqual({
      files: ["packages/ui/src/Button.ts"],
    });
    expect(resolve("packages/app/src/x.ts", "@root/a")).toBeUndefined();
    // The root's own `paths` replace the base's, relative to its baseUrl.
    expect(resolve("src/x.ts", "@root/a")).toEqual({ files: ["src/a.ts"] });
    expect(resolve("src/x.ts", "@ui/Button")).toBeUndefined();
  });

  it("ignores paths in a file that doesn't parse, or extends one that doesn't", async () => {
    const result = await tsconfigs({
      "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["src/*"] } }`,
      "app/tsconfig.json": `{ "extends": "./broken.json", "compilerOptions": { "paths": { "@/*": ["src/*"] } } }`,
      "app/broken.json": "{ nope }",
    });
    expect(result.unparsed.map(({ file }) => file)).toEqual([
      "app/broken.json",
      "tsconfig.json",
    ]);
    const resolve = resolver(["src/a.ts", "app/src/a.ts"], {
      tsconfigs: result.tsconfigs,
    });
    expect(resolve("src/x.ts", "@/a")).toBeUndefined();
    // Not the root's either: the nearest config is the one that applies.
    expect(resolve("app/src/x.ts", "@/a")).toBeUndefined();
  });

  it("ends a cycle of extends, with no paths", async () => {
    const result = await tsconfigs({
      "tsconfig.json": `{ "extends": "./b.json", "compilerOptions": { "paths": { "@/*": ["src/*"] } } }`,
      "b.json": `{ "extends": "./tsconfig.json" }`,
    });
    expect(result.tsconfigs.get(".")).toEqual({ paths: {} });
  });
});

describe("resolutions shared across files", () => {
  // Nested package and tsconfig boundaries, a sibling whose name starts
  // with a package's, and files directly in a package's directory.
  const files = [
    "src/a.ts",
    "src/lib/a.ts",
    "app/a.ts",
    "app/src/a.ts",
    "app/src/lib/Button.svelte",
    "app-other/a.ts",
    "kit/src/lib/Button.svelte",
    "kit/static/logo.svg",
    "kit/svelte.config.js",
    "types/a.ts",
  ];
  const packages: Record<string, PackageJson> = {
    ".": { dependencies: { svelte: "5" }, imports: { "#a": "./src/a.ts" } },
    app: {
      name: "app",
      dependencies: { react: "19" },
      imports: { "#a": "./a.ts", "#lib/*": "./src/lib/*" },
    },
    kit: { imports: { "#lib/*": "./src/lib/*", "#dep": "react" } },
  };
  const tsconfigs: TsConfigs = new Map([
    [".", { paths: { "@/*": ["src/*"] } }],
    ["app/src", { paths: { "@/*": ["app/src/*"] }, baseUrl: "types" }],
  ]);
  const froms = [
    "x.ts",
    "src/x.ts",
    "src/y.ts",
    "src/lib/x.ts",
    "app/x.ts",
    "app/src/x.ts",
    "app/src/lib/x.ts",
    "app-other/x.ts",
    "kit/x.ts",
    "kit/src/routes/x.svelte",
  ];
  const specifiers = [
    "./a",
    "../a",
    "../../a",
    "./%sveltekit.assets%/logo.svg",
    "#a",
    "#lib/Button.svelte",
    "#dep",
    "@/a",
    "@/lib/Button.svelte",
    "a",
    "svelte",
    "react",
    "app",
    "node:fs",
  ];
  const options = { packages, tsconfigs };

  it("resolves each import as a resolver of its own would, in any order", () => {
    const calls = froms.flatMap((from) =>
      specifiers.map((specifier): [string, string] => [from, specifier]),
    );
    for (const order of [calls, [...calls].reverse()]) {
      const shared = resolver(files, options);
      for (const [from, specifier] of order) {
        expect([from, specifier, shared(from, specifier)]).toEqual([
          from,
          specifier,
          resolver(files, options)(from, specifier),
        ]);
      }
    }
  });

  it("doesn't share across a package or tsconfig.json boundary", () => {
    const resolve = resolver(files, options);
    expect(resolve("src/x.ts", "#a")).toEqual({ files: ["src/a.ts"] });
    expect(resolve("app/x.ts", "#a")).toEqual({ files: ["app/a.ts"] });
    expect(resolve("app-other/x.ts", "#a")).toEqual({ files: ["src/a.ts"] });
    expect(resolve("app/x.ts", "react")).toEqual({ pkg: "react" });
    expect(resolve("kit/x.ts", "react")).toBeUndefined();
    expect(resolve("app/x.ts", "@/a")).toEqual({ files: ["src/a.ts"] });
    expect(resolve("app/src/x.ts", "@/a")).toEqual({ files: ["app/src/a.ts"] });
    expect(resolve("app/src/lib/x.ts", "a")).toEqual({ files: ["types/a.ts"] });
    expect(resolve("app/x.ts", "a")).toBeUndefined();
  });
});
