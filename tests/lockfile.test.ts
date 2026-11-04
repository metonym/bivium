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
  bin?: Record<string, string>;
}

const PACKAGES: Record<string, Pkg> = {
  "lib-a": { version: "1.0.0", dependencies: { "dep-x": "^1.0.0" } },
  "lib-b": { version: "2.0.0" },
  "dep-x": { version: "1.0.0" },
  runner: {
    version: "3.0.0",
    dependencies: { "dep-y": "^1.0.0" },
    bin: { runner: "cli.js" },
  },
  "test-env": { version: "5.0.0" },
  "dep-y": { version: "1.0.0" },
  linter: { version: "4.0.0", dependencies: { "lint-core": "^1.0.0" } },
  "lint-core": { version: "1.0.0" },
};

const DECLARED = {
  dependencies: { "lib-a": "^1.0.0", "lib-b": "^2.0.0" },
  devDependencies: {
    linter: "^4.0.0",
    runner: "^3.0.0",
    "test-env": "^5.0.0",
  },
};

// Bun's text lockfile: JSON with trailing commas.
function bunLock(
  packages: Record<string, Pkg>,
  declared: typeof DECLARED = DECLARED,
  extra = "",
) {
  const entry = ([name, pkg]: [string, Pkg]) => {
    const info = JSON.stringify({
      ...(pkg.dependencies && { dependencies: pkg.dependencies }),
      ...(pkg.bin && { bin: pkg.bin }),
    });
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

// pnpm's v9 lockfile: importers with each declared range and the version
// it resolved, `packages` metadata, and `snapshots` with dependencies.
function pnpmLock(
  packages: Record<string, Pkg>,
  declared: typeof DECLARED = DECLARED,
  extra = "",
) {
  const importer = Object.entries(declared)
    .map(
      ([field, deps]) =>
        `    ${field}:\n${Object.entries(deps)
          .map(
            ([name, range]) =>
              `      ${name}:\n        specifier: ${range}\n        version: ${packages[name]?.version}`,
          )
          .join("\n")}`,
    )
    .join("\n");
  const entries = Object.entries(packages);
  const metadata = entries.map(
    ([name, pkg]) =>
      `  ${name}@${pkg.version}:\n    resolution: {integrity: sha512-${name}${pkg.version}}\n`,
  );
  const snapshots = entries.map(([name, pkg]) => {
    const deps = Object.keys(pkg.dependencies ?? {});
    if (deps.length === 0) return `  ${name}@${pkg.version}: {}\n`;
    const lines = deps.map((dep) => `      ${dep}: ${packages[dep]?.version}`);
    return `  ${name}@${pkg.version}:\n    dependencies:\n${lines.join("\n")}\n`;
  });
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
${extra}
importers:

  .:
${importer}

packages:

${metadata.join("\n")}
snapshots:

${snapshots.join("\n")}`;
}

const CONFIG: Config = {
  suites: { unit: { tests: "test/**/*.test.js", root: "test" } },
  roots: ["src", "test"],
  inert: ["linter"],
};

// src/a.js imports lib-a, which depends on dep-x; src/b.js imports lib-b.
// runner and linter are declared, and nothing imports them.
const LOCKFILES = {
  "bun.lock": bunLock,
  "package-lock.json": packageLock,
  "pnpm-lock.yaml": pnpmLock,
};

function repo(lockfile: keyof typeof LOCKFILES = "bun.lock") {
  const dir = mkdtempSync(join(tmpdir(), "bivium-lockfile-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, {
    "package.json": JSON.stringify({ name: "app", ...DECLARED }, null, 2),
    [lockfile]: LOCKFILES[lockfile](PACKAGES),
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
    const { causes } = await plan({ cwd: dir, base: "HEAD", config: CONFIG });
    expect(causes).toEqual([
      {
        kind: "package",
        suites: ["unit"],
        package: "runner",
        file: "bun.lock",
        message: "bun.lock: runner 3.0.0 → 3.1.0, and no test imports it",
      },
    ]);
    // Through a dependency, too.
    write(dir, { "bun.lock": bunLock(bump("dep-y", "1.0.1")) });
    expect((await planOf(dir)).reasons).toEqual([
      "bun.lock: dep-y 1.0.0 → 1.0.1, which runner depends on, and no test imports runner",
    ]);
  });

  it("runs nothing for a change to bivium, which no test runs", async () => {
    const dir = repo();
    const declared = {
      ...DECLARED,
      devDependencies: { ...DECLARED.devDependencies, bivium: "^0.4.0" },
    };
    write(dir, {
      "package.json": JSON.stringify({ name: "app", ...declared }, null, 2),
      "bun.lock": bunLock(
        {
          ...PACKAGES,
          bivium: { version: "0.4.0", bin: { bivium: "cli.js" } },
        },
        declared,
      ),
    });
    expect(await planOf(dir)).toEqual({
      unit: { mode: "none" },
      reasons: [],
      packages: ["bun.lock: bivium 0.4.0 added, inert"],
    });
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

  it("with loadedByName, selects nothing for a package only imports load", async () => {
    const dir = repo();
    write(dir, {
      "src/tool.js": `import t from "test-env";\nexport default t;`,
    });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "tool");
    write(dir, { "bun.lock": bunLock(bump("test-env", "5.1.0")) });
    // Without it, the package could be a test environment the runner loads.
    expect(await planOf(dir)).toMatchObject({
      unit: { mode: "all" },
      reasons: ["bun.lock: test-env 5.0.0 → 5.1.0, and no test imports it"],
    });
    expect(await planOf(dir, { ...CONFIG, loadedByName: [] })).toEqual({
      unit: { mode: "none" },
      reasons: [],
      packages: ["bun.lock: test-env 5.0.0 → 5.1.0"],
    });
    // Listed: a runner config names it.
    expect(
      (await planOf(dir, { ...CONFIG, loadedByName: ["test-env"] })).unit,
    ).toEqual({ mode: "all" });
  });

  it("with loadedByName, still runs everything for a package with a bin", async () => {
    const dir = repo();
    write(dir, { "bun.lock": bunLock(bump("dep-y", "1.0.1")) });
    expect(
      (await planOf(dir, { ...CONFIG, loadedByName: [] })).reasons,
    ).toEqual([
      "bun.lock: dep-y 1.0.0 → 1.0.1, which runner depends on, and no test imports runner",
    ]);
    // Nothing imports it, and no test can run it.
    write(dir, { "bun.lock": bunLock(bump("test-env", "5.1.0")) });
    expect(
      (await planOf(dir, { ...CONFIG, loadedByName: [] })).packages,
    ).toEqual(["bun.lock: test-env 5.0.0 → 5.1.0, imported by no test"]);
  });

  it("doesn't count a type import as a test importing a package, in a suite that runs code", async () => {
    const dir = repo();
    write(dir, { "test/env.test.js": `import type { Env } from "test-env";` });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "env");
    write(dir, { "bun.lock": bunLock(bump("test-env", "5.1.0")) });
    const runtime: Config = {
      ...CONFIG,
      suites: { unit: { ...CONFIG.suites.unit, types: false } },
    };
    expect((await planOf(dir, runtime)).reasons).toEqual([
      "bun.lock: test-env 5.0.0 → 5.1.0, and no test imports it",
    ]);
    // A suite that reads types does import it.
    expect((await planOf(dir)).unit).toEqual({
      mode: "some",
      files: ["test/env.test.js"],
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

  it("reads pnpm-lock.yaml the same way", async () => {
    const dir = repo("pnpm-lock.yaml");
    write(dir, { "pnpm-lock.yaml": pnpmLock(bump("lib-b", "2.1.0")) });
    expect(await planOf(dir)).toEqual({
      unit: { mode: "some", files: ["test/b.test.js"] },
      reasons: [],
      packages: ["pnpm-lock.yaml: lib-b 2.0.0 → 2.1.0"],
    });
    write(dir, { "pnpm-lock.yaml": pnpmLock(bump("dep-x", "1.0.1")) });
    expect(await planOf(dir)).toEqual({
      unit: { mode: "some", files: ["test/a.test.js"] },
      reasons: [],
      // A snapshot records the versions its dependencies resolved to.
      packages: [
        "pnpm-lock.yaml: dep-x 1.0.0 → 1.0.1, through lib-a",
        "pnpm-lock.yaml: lib-a 1.0.0, entry changed",
      ],
    });
    write(dir, { "pnpm-lock.yaml": pnpmLock(bump("dep-y", "1.0.1")) });
    expect((await planOf(dir)).reasons).toEqual([
      "pnpm-lock.yaml: runner 3.0.0, entry changed (and 1 more package runner depends on), and no test imports it",
    ]);
  });

  it("reads a package.json bump that pnpm-lock.yaml records", async () => {
    const dir = repo("pnpm-lock.yaml");
    const declared = {
      ...DECLARED,
      dependencies: { ...DECLARED.dependencies, "lib-a": "^1.1.0" },
    };
    write(dir, {
      "pnpm-lock.yaml": pnpmLock(bump("lib-a", "1.1.0"), declared),
      "package.json": JSON.stringify({ name: "app", ...declared }, null, 2),
    });
    expect(await planOf(dir)).toEqual({
      unit: { mode: "some", files: ["test/a.test.js"] },
      reasons: [],
      packages: ["pnpm-lock.yaml: lib-a 1.0.0 → 1.1.0"],
    });
  });

  it("sees a workspace switch to a version pnpm-lock.yaml already has", async () => {
    const both = { ...PACKAGES, "lib-b@3": { version: "3.0.0" } };
    const dir = repo("pnpm-lock.yaml");
    write(dir, { "pnpm-lock.yaml": pnpmLock(both) });
    git(dir, "commit", "-q", "-am", "two versions");
    // Only the importer's resolved version moves.
    const switched = pnpmLock(both).replace(
      "specifier: ^2.0.0\n        version: 2.0.0",
      "specifier: ^2.0.0\n        version: 3.0.0",
    );
    write(dir, { "pnpm-lock.yaml": switched });
    expect((await planOf(dir)).unit).toEqual({
      mode: "some",
      files: ["test/b.test.js"],
    });
  });

  it("runs everything for a pnpm setting, or a pnpm-lock.yaml it can't read", async () => {
    const dir = repo("pnpm-lock.yaml");
    write(dir, {
      "pnpm-lock.yaml": pnpmLock(
        PACKAGES,
        DECLARED,
        "\noverrides:\n  dep-x: 1.0.1\n",
      ),
    });
    expect((await planOf(dir)).reasons).toEqual([
      "pnpm-lock.yaml: a setting other than the packages changed",
    ]);
    write(dir, {
      "pnpm-lock.yaml": `lockfileVersion: '9.0'\nfoo: &anchor x\n`,
    });
    expect((await planOf(dir)).reasons).toEqual([
      "pnpm-lock.yaml: can't parse it",
    ]);
  });

  it("runs everything for a lockfile format it doesn't read", async () => {
    const dir = repo();
    write(dir, { "yarn.lock": "# yarn lockfile v1\n" });
    expect((await planOf(dir)).reasons).toEqual([
      "yarn.lock: outside the dependency graph",
    ]);
  });
});
