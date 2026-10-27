import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computePlan } from "../src/compute.ts";
import { resolveConfig } from "../src/config.ts";
import { type Config, plan } from "../src/index.ts";
import { explain } from "../src/why.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

interface Pkg {
  version: string;
  dependencies?: Record<string, string>;
}

const PACKAGES: Record<string, Pkg> = {
  "lib-a": { version: "1.0.0", dependencies: { "dep-x": "^1.0.0" } },
  "lib-b": { version: "2.0.0" },
  "dep-x": { version: "1.0.0" },
  runner: { version: "3.0.0", dependencies: { "dep-y": "^1.0.0" } },
  "dep-y": { version: "1.0.0" },
  linter: { version: "4.0.0", dependencies: { "lint-core": "^1.0.0" } },
  "lint-core": { version: "1.0.0" },
};

const DECLARED = {
  dependencies: { "lib-a": "^1.0.0", "lib-b": "^2.0.0" },
  devDependencies: { linter: "^4.0.0", runner: "^3.0.0" },
};

// Bun's text lockfile: JSON with trailing commas.
function bunLock(
  packages: Record<string, Pkg>,
  declared: typeof DECLARED = DECLARED,
  extra = "",
) {
  const entry = ([name, pkg]: [string, Pkg]) => {
    const info = pkg.dependencies
      ? JSON.stringify({ dependencies: pkg.dependencies })
      : "{}";
    return `    "${name}": ["${name}@${pkg.version}", "", ${info}, "sha512-${name}${pkg.version}"],\n`;
  };
  return `{
  "lockfileVersion": 1,${extra}
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": ${JSON.stringify(declared.dependencies)},
      "devDependencies": ${JSON.stringify(declared.devDependencies)},
    },
  },
  "packages": {
${Object.entries(packages).map(entry).join("\n")}  },
}
`;
}

function packageLock(packages: Record<string, Pkg>) {
  const entries: Record<string, unknown> = {
    "": { name: "app", ...DECLARED },
  };
  for (const [name, pkg] of Object.entries(packages)) {
    entries[`node_modules/${name}`] = {
      ...pkg,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${pkg.version}.tgz`,
      integrity: `sha512-${name}${pkg.version}`,
    };
  }
  return JSON.stringify(
    { name: "app", lockfileVersion: 3, requires: true, packages: entries },
    null,
    2,
  );
}

const CONFIG: Config = {
  suites: { unit: { tests: "test/**/*.test.js", root: "test" } },
  roots: ["src", "test"],
  inert: ["linter"],
};

// src/a.js imports lib-a, which depends on dep-x; src/b.js imports lib-b.
// runner and linter are declared, and nothing imports them.
function repo(lockfile: "bun.lock" | "package-lock.json" = "bun.lock") {
  const dir = mkdtempSync(join(tmpdir(), "bivium-lockfile-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  write(dir, {
    "package.json": JSON.stringify({ name: "app", ...DECLARED }, null, 2),
    [lockfile]:
      lockfile === "bun.lock" ? bunLock(PACKAGES) : packageLock(PACKAGES),
    "src/a.js": `import a from "lib-a";\nexport default a;`,
    "src/b.js": `import b from "lib-b";\nexport default b;`,
    "test/a.test.js": `import "../src/a.js";`,
    "test/b.test.js": `import "../src/b.js";`,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

function bump(name: string, version: string, packages = PACKAGES) {
  return { ...packages, [name]: { ...packages[name], version } };
}

async function planOf(dir: string, config: Config = CONFIG) {
  const { suites, reasons, packages } = await plan({
    cwd: dir,
    base: "HEAD",
    config,
    cache: false,
  });
  return { unit: suites.unit, reasons, packages };
}

describe("a lockfile change", () => {
  it("selects the importers of a bumped direct dependency", async () => {
    const dir = repo();
    write(dir, {
      "bun.lock": bunLock(bump("lib-a", "1.1.0"), {
        ...DECLARED,
        dependencies: { ...DECLARED.dependencies, "lib-a": "^1.1.0" },
      }),
      "package.json": JSON.stringify(
        {
          name: "app",
          ...DECLARED,
          dependencies: { ...DECLARED.dependencies, "lib-a": "^1.1.0" },
        },
        null,
        2,
      ),
    });
    expect(await planOf(dir)).toEqual({
      unit: { mode: "some", files: ["test/a.test.js"] },
      reasons: [],
      packages: ["bun.lock: lib-a 1.0.0 → 1.1.0"],
    });
  });

  it("selects the importers of what depends on a bumped transitive one", async () => {
    const dir = repo();
    write(dir, { "bun.lock": bunLock(bump("dep-x", "1.0.1")) });
    expect(await planOf(dir)).toEqual({
      unit: { mode: "some", files: ["test/a.test.js"] },
      reasons: [],
      packages: ["bun.lock: dep-x 1.0.0 → 1.0.1, through lib-a"],
    });
  });

  it("explains the selection with the package change", async () => {
    const dir = repo();
    write(dir, { "bun.lock": bunLock(bump("dep-x", "1.0.1")) });
    const config = resolveConfig(CONFIG);
    const computed = await computePlan(dir, "HEAD", config, { cache: false });
    expect(
      await explain(dir, config, computed, "test/a.test.js"),
    ).toMatchObject({
      kind: "chain",
      root: "pkg:lib-a",
      cause: "bun.lock: dep-x 1.0.0 → 1.0.1, which lib-a depends on",
    });
  });

  it("runs everything for a package no test imports", async () => {
    const dir = repo();
    write(dir, { "bun.lock": bunLock(bump("runner", "3.1.0")) });
    expect(await planOf(dir)).toMatchObject({
      unit: { mode: "all" },
      reasons: ["bun.lock: runner 3.0.0 → 3.1.0, and no test imports it"],
    });
    // Through a dependency, too.
    write(dir, { "bun.lock": bunLock(bump("dep-y", "1.0.1")) });
    expect((await planOf(dir)).reasons).toEqual([
      "bun.lock: dep-y 1.0.0 → 1.0.1, which runner depends on, and no test imports runner",
    ]);
  });

  it("selects nothing for an inert package or what only it depends on", async () => {
    const dir = repo();
    write(dir, {
      "bun.lock": bunLock(bump("lint-core", "1.1.0", bump("linter", "4.1.0"))),
    });
    expect(await planOf(dir)).toEqual({
      unit: { mode: "none" },
      reasons: [],
      packages: [
        "bun.lock: lint-core 1.0.0 → 1.1.0, inert",
        "bun.lock: linter 4.0.0 → 4.1.0, inert",
      ],
    });
    // Without `inert`, the linter could be something a test runs.
    expect((await planOf(dir, { ...CONFIG, inert: undefined })).unit).toEqual({
      mode: "all",
    });
  });

  it("still runs the tests that depend on every change", async () => {
    const dir = repo();
    write(dir, {
      "test/fs.test.js": `import { readFileSync } from "node:fs";`,
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fs");
    write(dir, { "bun.lock": bunLock(bump("linter", "4.1.0")) });
    expect((await planOf(dir)).unit).toEqual({
      mode: "some",
      files: ["test/fs.test.js"],
    });
  });

  it("runs everything when it can't read the lockfile", async () => {
    const dir = repo();
    write(dir, { "bun.lock": "{ not json" });
    expect(await planOf(dir)).toMatchObject({
      unit: { mode: "all" },
      reasons: ["bun.lock: can't parse it"],
    });
    write(dir, {
      "bun.lock": bunLock(
        PACKAGES,
        DECLARED,
        `\n  "overrides": { "dep-x": "1.0.1" },`,
      ),
    });
    expect((await planOf(dir)).reasons).toEqual([
      "bun.lock: a setting other than the packages changed",
    ]);
  });

  it("runs everything for a package.json the lockfile doesn't match", async () => {
    const dir = repo();
    write(dir, {
      "package.json": JSON.stringify({
        name: "app",
        ...DECLARED,
        dependencies: { ...DECLARED.dependencies, "lib-a": "^1.1.0" },
      }),
    });
    expect(await planOf(dir)).toMatchObject({
      unit: { mode: "all" },
      reasons: ["package.json: outside the dependency graph"],
    });
  });

  it("reads package-lock.json the same way", async () => {
    const dir = repo("package-lock.json");
    write(dir, { "package-lock.json": packageLock(bump("lib-b", "2.1.0")) });
    expect(await planOf(dir)).toEqual({
      unit: { mode: "some", files: ["test/b.test.js"] },
      reasons: [],
      packages: ["package-lock.json: lib-b 2.0.0 → 2.1.0"],
    });
  });

  it("runs everything for a lockfile format it doesn't read", async () => {
    const dir = repo();
    write(dir, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    expect((await planOf(dir)).reasons).toEqual([
      "pnpm-lock.yaml: outside the dependency graph",
    ]);
  });
});
