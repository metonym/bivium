/**
 * Compares the lexer with the regex extractor it replaces, file by file, on
 * a checkout: specifiers, globs, `goto()` arguments, annotations, unknown
 * causes, and which files fell back to the regex.
 *
 *   bun eval/carbon/scan-diff.ts <clone> [--all]
 *
 * Without `--all`, only the files under the roots of `bivium.config.ts`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inRoot, loadConfig } from "../../src/config.ts";
import { SCANNED, scan } from "../../src/scan.ts";
import { scanRegex } from "../../src/scan-regex.ts";
import { sorted } from "../../src/sorted.ts";
import type { Scan } from "../../src/syntax.ts";
import { parseArgs, usage } from "../args.ts";

const args = parseArgs(process.argv.slice(2), []);
const [clone] = args.positional;
if (!clone) usage("scan-diff.ts <clone> [--all]");
const { roots } = (
  await loadConfig(clone, join(import.meta.dir, "bivium.config.ts"))
).config;
const files = spawnSync("git", ["-C", clone, "ls-files"], { encoding: "utf-8" })
  .stdout.split("\n")
  .filter(
    (file) =>
      SCANNED.test(file) &&
      (args.flag("--all") || roots.some((root) => inRoot(file, root))),
  );

const key = (found: Scan) => ({
  imports: sorted(
    new Set(
      found.imports.map(
        (ref) => ref.specifier + (ref.names ? `{${sorted(ref.names)}}` : ""),
      ),
    ),
  ),
  globs: sorted(new Set(found.globs)),
  gotos: found.gotos,
  dependsOn: found.dependsOn,
  reads: found.reads,
  unknown: sorted(new Set(found.unknown)),
});

let differing = 0;
const fallbacks: string[] = [];
for (const file of files) {
  const source = readFileSync(join(clone, file), "utf-8");
  const gotos = file.startsWith("e2e/");
  const lexed = scan(file, source, { gotos });
  if (lexed.fallback) fallbacks.push(`${file}: ${lexed.fallback}`);
  const a = key(scanRegex(file, source, { gotos }));
  const b = key(lexed);
  const parts: string[] = [];
  const other = new Map(Object.entries(b));
  for (const [field, before] of Object.entries(a)) {
    const after = other.get(field) ?? [];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const lost = before.filter((x) => !after.includes(x));
    const gained = after.filter((x) => !before.includes(x));
    parts.push(
      `${field}${lost.length > 0 ? ` −${JSON.stringify(lost)}` : ""}${gained.length > 0 ? ` +${JSON.stringify(gained)}` : ""}` +
        (lost.length + gained.length === 0 ? " (order)" : ""),
    );
  }
  if (parts.length > 0) {
    differing++;
    console.log(`${file}\n  ${parts.join("\n  ")}`);
  }
}
console.log(
  `\n${files.length} files, ${differing} differ, ${fallbacks.length} fell back`,
);
for (const line of fallbacks) console.log(`  fallback ${line}`);
