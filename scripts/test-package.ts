import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const dir = mkdtempSync(join(tmpdir(), "bivium-package-"));
const IMPORT = /\bimport\b[^;]*?from\s*["']([^"']+)["']/g;
const BUILTIN = /^node:/;

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function write(at: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(at, name)), { recursive: true });
    writeFileSync(join(at, name), text);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  run("bun", ["run", "build"], root);

  // Zero dependencies and nothing Bun-only: the bundle imports only Node
  // builtins and its own chunks.
  for (const file of await readdir(dist)) {
    if (!file.endsWith(".js")) continue;
    const code = readFileSync(join(dist, file), "utf-8");
    for (const [, specifier] of code.matchAll(IMPORT)) {
      assert(
        BUILTIN.test(specifier) || specifier.startsWith("./"),
        `dist/${file} imports ${specifier}`,
      );
    }
  }
  const manifest = JSON.parse(
    readFileSync(join(dist, "package.json"), "utf-8"),
  );
  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    assert(manifest[field] === undefined, `dist/package.json has ${field}`);
  }

  const tarball = run(
    "npm",
    ["pack", "--pack-destination", dir, "--silent"],
    dist,
  ).trim();
  const consumer = join(dir, "consumer");
  write(consumer, {
    "package.json": JSON.stringify({
      name: "consumer",
      private: true,
      type: "module",
    }),
  });
  run(
    "npm",
    ["install", join(dir, tarball), "--no-audit", "--no-fund", "--silent"],
    consumer,
  );

  // A repository to plan: a test that imports one of two modules.
  const repo = join(dir, "repo");
  write(repo, {
    "package.json": JSON.stringify({ name: "lib", type: "module" }),
    ".gitignore": "node_modules\n",
    "src/a.js": "export const a = 1;",
    "src/b.js": "export const b = 1;",
    "test/a.test.js": `import { a } from "../src/a.js";`,
    "test/b.test.js": `import { b } from "../src/b.js";`,
    "bivium.config.ts": `import { defineConfig } from "bivium";

export default defineConfig({
  suites: { unit: { tests: "test/**/*.test.js", root: "test" } },
  roots: ["src", "test"],
});
`,
  });
  run("git", ["init", "-q", "-b", "main"], repo);
  run("git", ["add", "-A"], repo);
  run(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "base",
    ],
    repo,
  );
  write(repo, { "src/a.js": "export const a = 2;" });
  // The config imports bivium from the consumer's install.
  symlinkSync(join(consumer, "node_modules"), join(repo, "node_modules"));

  const bin = join(consumer, "node_modules/.bin/bivium");
  const want = { mode: "some", files: ["test/a.test.js"] };
  for (const runtime of ["node", "bun"]) {
    const output = run(
      runtime,
      [bin, "plan", "HEAD", "--json", "--no-cache"],
      repo,
    );
    const planned = JSON.parse(output);
    assert(
      JSON.stringify(planned.suites.unit) === JSON.stringify(want),
      `${runtime} bivium plan: ${output}`,
    );
  }

  write(consumer, {
    "smoke.js": `import assert from "node:assert/strict";
import { defineConfig, plan } from "bivium";

const config = defineConfig({
  suites: { unit: { tests: "test/**/*.test.js", root: "test" } },
  roots: ["src", "test"],
});
assert.equal(defineConfig(config), config);
const result = await plan({ cwd: ${JSON.stringify(repo)}, base: "HEAD", config, cache: false });
assert.deepEqual(result.suites, { unit: ${JSON.stringify(want)} });
assert.deepEqual(result.changed, ["src/a.js"]);
await assert.rejects(import("bivium/dist/compute.js"));
`,
    "consumer.ts": `import { type Config, defineConfig, plan, type PlanResult, type Selection } from "bivium";

const config = defineConfig({
  suites: { unit: { tests: "test/**", run: "vitest run {files}" }, e2e: { tests: ["e2e/**"] } },
  ignore: "**/*.md",
});
const typed: Config<"unit" | "e2e"> = config;
export async function main(): Promise<Selection> {
  const result: PlanResult<"unit" | "e2e"> = await plan({ config: typed, base: "origin/main" });
  const loaded: PlanResult = await plan();
  void loaded.suites["any-name"];
  return result.suites.e2e;
}
`,
  });
  run("node", ["smoke.js"], consumer);
  run(
    join(root, "node_modules/.bin/tsc"),
    [
      "--noEmit",
      "--strict",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      "--skipLibCheck",
      "false",
      "consumer.ts",
    ],
    consumer,
  );

  // A suite the config doesn't name is a type error, not a silent `undefined`.
  write(consumer, {
    "misuse.ts": `import { defineConfig, plan } from "bivium";

const result = await plan({ config: defineConfig({ suites: { unit: { tests: "t/**" } } }) });
export const selection = result.suites.e2e;
`,
  });
  const misuse = spawnSync(
    join(root, "node_modules/.bin/tsc"),
    [
      "--noEmit",
      "--strict",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      "misuse.ts",
    ],
    { cwd: consumer, encoding: "utf-8" },
  );
  assert(
    misuse.status !== 0 &&
      misuse.stdout.includes("Property 'e2e' does not exist"),
    `tsc accepted a suite the config doesn't name:\n${misuse.stdout}`,
  );

  console.log(
    "✓ The packed package installs, runs on Node and Bun, and type-checks for consumers",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
