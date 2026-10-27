import { resolveConfig } from "../src/config.ts";
import {
  createResolver,
  exportTargets,
  type PackageJson,
  type Packages,
  toPackageJson,
} from "../src/resolve.ts";
import type { Config } from "../src/types.ts";

const BASE: Config = { suites: { unit: { tests: "**/*.test.ts" } } };

function resolver(
  files: string[],
  options: {
    config?: Partial<Config>;
    packages?: Record<string, PackageJson>;
  } = {},
) {
  const packages: Packages = new Map(
    Object.entries(options.packages ?? { ".": {} }),
  );
  return createResolver({
    files: new Set(files),
    config: resolveConfig({ ...BASE, ...options.config }),
    packages,
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
