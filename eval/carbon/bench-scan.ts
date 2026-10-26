/**
 * The extraction stage alone on a carbon checkout: the regex extractor and
 * the lexer over the files a plan scans, interleaved round by round, with a
 * bare `charCodeAt` loop over the same text as the floor.
 *
 *   bun eval/carbon/bench-scan.ts <clone> [rounds=30]
 */
import { loadavg } from "node:os";
import { readSources } from "../../src/compute.ts";
import { loadConfig } from "../../src/config.ts";
import { readRevision } from "../../src/git.ts";
import { SCANNED, scan } from "../../src/scan.ts";
import { scanRegex } from "../../src/scan-regex.ts";

const [clone, roundsArg] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 30);
const { config } = await loadConfig(
  clone,
  `${import.meta.dir}/bivium.config.ts`,
);
const revision = await readRevision(clone, "HEAD", config.roots);
const sources = await readSources(clone, revision.files);
// As the graph scans them, minus file types the regex never read.
const OLD_SCANNED = /\.(?:svelte|[cm]?[jt]s|html)$/;
const files = [...sources].filter(
  ([path]) => SCANNED.test(path) && OLD_SCANNED.test(path),
);
const bytes = files.reduce((sum, [, text]) => sum + text.length, 0);
const gotos = (path: string) => path.startsWith("e2e/");

let sink = 0;
const runs = {
  regex: () => {
    for (const [path, text] of files) {
      sink += scanRegex(path, text, { gotos: gotos(path) }).imports.length;
    }
  },
  lexer: () => {
    for (const [path, text] of files) {
      sink += scan(path, text, { gotos: gotos(path) }).imports.length;
    }
  },
  charCodeAt: () => {
    let sum = 0;
    for (const [, text] of files) {
      for (let i = 0; i < text.length; i++) sum += text.charCodeAt(i);
    }
    sink += sum;
  },
};
type Name = keyof typeof runs;
const samples: Record<Name, number[]> = {
  regex: [],
  lexer: [],
  charCodeAt: [],
};
const names: Name[] = ["regex", "lexer", "charCodeAt"];
// Warm up the JIT on every path first.
for (let i = 0; i < 3; i++) for (const name of names) runs[name]();
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? names : [...names].reverse();
  for (const name of order) {
    const start = performance.now();
    runs[name]();
    samples[name].push(performance.now() - start);
  }
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
console.log(
  `${files.length} files, ${(bytes / 1e6).toFixed(1)} MB, ${rounds} rounds interleaved, load ${loadavg()[0].toFixed(1)}`,
);
for (const name of names) {
  const values = samples[name];
  console.log(
    `${name.padEnd(11)} median ${quantile(values, 0.5).toFixed(1)} ms  p90 ${quantile(values, 0.9).toFixed(1)} ms  min ${Math.min(...values).toFixed(1)} ms`,
  );
}
if (sink === 0.5) console.log(sink);
