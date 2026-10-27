# Contributing

This guide covers how bivium is built, the rules every change must keep, and how to verify a change before it merges. The choices behind the design, and the measurements that settled them, are in [docs/decisions.md](docs/decisions.md).

## Setup

[Bun](https://bun.sh/) is the package manager, test runner and bundler.

```sh
bun ci
bun run test          # unit tests
bun run typecheck     # bun check: tsc's errors, on every core
bun run lint          # biome; `bun run lint:fix` formats and applies fixes
bun run knip          # unused files, exports and dependencies
bun run build         # dist/: the library and the bin as ESM for Node, one index.d.ts
bun run test:package  # build, pack, install, and use it as a consumer would
bun src/cli.ts plan   # the CLI from source
```

## How it works

`plan` (`src/compute.ts`) runs these steps:

1. **Git.** `readRevision` (`src/git.ts`) lists the files under the roots and the changed files, with one `ls-files` call and two diffs against the merge base, and each unchanged file's blob OID.
2. **Extraction.** For each file the scanner reads, `extract` (`src/scan.ts`) returns its raw specifiers, globs, `goto()` arguments and annotations, from the one-pass lexer (`src/lex.ts`, with `src/host.ts` for files that embed scripts), or from the regex extractor (`src/scan-regex.ts`) when the lexer can't read the file. The cache (`src/cache.ts`) stores extractions by blob OID, so only files git can't vouch for are read. Leaves are never read.
3. **Resolution.** `graphFrom` (`src/graph.ts`) resolves every specifier (`src/resolve.ts`) to the files it can load, a `pkg:` node, or unknown, binds named imports to barrel names, and applies `edges` and `reads`. Resolution runs every time: it depends on which files exist, and on the `package.json` and `tsconfig.json` files (`src/tsconfig.ts`), which are read on every run.
4. **Narrowers.** Each narrower whose files changed runs (`runNarrowers`), with the graph and both trees.
5. **Selection.** `planTests` (`src/plan.ts`) classifies the changes (ignored, the selector's own, wiring, outside the roots, or seeds), walks the graph backwards from the seeds (`affectedBy`), applies the orphan rule and the narrowers, and picks each suite's tests.

`why` (`src/why.ts`) walks again, recording how it reached each node, and `check` (`src/check.ts`) lists the unknown nodes and the dead globs (declared globs no change can select through, from the extractions and the whole-repo listing); both find lines by searching the source (`src/locate.ts`). `src/main.ts` is the CLI, `src/cli.ts` its bin.

## Rules every change must keep

- **Fail closed.** Anything the graph can't read is unknown, never dropped: a file with unknown dependencies runs on every change, and a change the graph can't place runs everything. A precision gain that can drop a test that a change affects is a bug.
- **A narrower can only narrow.** Its selection is cut to what the walk without it selects.
- **Zero runtime dependencies.** `src/` imports only `node:` builtins and runs on Node ≥ 22 and Bun. It never reads `node_modules`.
- **Keep the public API small.** `src/index.ts` is the public API, and `src/types.ts`, which imports nothing, holds its types: the build emits them as one `index.d.ts`.
- **Bump `SCANNER_VERSION`** (`src/cache.ts`) when `extract` returns something different for some input. `tests/cache.test.ts` hashes the scanner's sources and fails on any change to them; update its fingerprint, and bump the version too unless the change can't alter an extraction.
- **Types, not casts.** No `any`, `as`, non-null `!` or `@ts-ignore`: narrow with guards. Biome and `bun check` enforce most of it.
- **Comments say why.** JSDoc is for the public API; elsewhere a comment states a reason or a constraint the code can't.

## Tests

| File | Covers |
|:---|:---|
| `tests/lex.test.ts` | The lexer: regexes and division, strings, templates, comments, JSX, host formats, and the fallback, against the regex extractor |
| `tests/resolve.test.ts` | Relative specifiers, aliases, tsconfig `paths`, `exports`, packages, builtins |
| `tests/barrel.test.ts` | Barrel names, `sideEffects`, and `barrels` |
| `tests/graph.test.ts` | Graph edges and the walk |
| `tests/plan.test.ts` | Selection on a carbon-like fixture (`tests/fixture.ts`): the orphan rule, wiring, pages, ignore, narrowed seeds |
| `tests/narrow.test.ts` | The narrower API through `plan()`, with a fake narrower in a git repository |
| `tests/css-narrower.test.ts` | Carbon's CSS narrower (`eval/carbon/css-narrower.ts`) with fake tools |
| `tests/cache.test.ts` | The cache's format, bounds and corruption handling, which files git vouches for, and the scanner fingerprint |
| `tests/config.test.ts` | Loading, checking and resolving configs |
| `tests/main.test.ts` | `plan` and `run`, their outputs and options, and `plan()` from code |
| `tests/why.test.ts` | `why` and `check`, dead globs included |
| `scripts/test-package.ts` | `bun run test:package`: the packed tarball installs, imports only builtins, plans a repository from Node and Bun, and type-checks for a consumer |

A behavior fix needs a test that fails before the fix and passes after.

## Benchmarks

```sh
bun run bench    # ostia: scan, graph build, cold and warm plans, on bench/fixture.ts
```

The fixture is a generated, carbon-shaped repository with a fixed seed, so runs compare. On a shared machine, report the load average with any number, and prefer `ostia ab` to compare a change with `HEAD`.

## Golden check on carbon-components-svelte

`eval/` holds the harnesses that check bivium against carbon's own selector. They aren't packaged. They need a carbon checkout with `.context/test-graph-package/phase0` (the PR groups and recorded plans from Phase 0) and a scratch clone to check out commits in:

```sh
git clone <carbon checkout> /tmp/bivium-carbon

# Re-plan the 40 newest PR groups and 20 older ones; compare with carbon's
# selector and the recorded plans, with the cache cold, partly warm and warm.
bun eval/carbon/replay.ts --carbon <checkout> /tmp/bivium-carbon /tmp/replay.jsonl --subset --cache /tmp/bivium-cache
bun eval/carbon/summarize.ts /tmp/replay.jsonl --drop tests/scripts/test-graph.test.ts

# Cached graphs equal cold ones, node by node, on a few bases.
bun eval/carbon/cache-equal.ts /tmp/bivium-carbon /tmp/bivium-cache <base>…

bun eval/carbon/scan-diff.ts /tmp/bivium-carbon   # the lexer against the regex
bun eval/corpus.ts <checkout>                     # the lexer against TypeScript
```

`eval/carbon/bivium.config.ts` is carbon's selector as a config, without the CSS narrowing (`narrowed.config.ts` adds it; it needs an installed checkout). A change that alters a replayed plan needs a reason in `docs/decisions.md`.

## Releasing

1. Move the `## Unreleased` entries in `CHANGELOG.md` under the new version.
2. Bump `version` in `package.json` and commit as `vX.Y.Z`.
3. Tag the commit (`git tag -s vX.Y.Z`) and push the tag. `release.yml` tests the packed package and publishes `dist/` to npm with provenance.

## Before you finish

- [ ] `bun run lint`, `bun run typecheck`, `bun run knip`, `bun run test` and `bun run test:package` pass.
- [ ] Scanner, resolver or selection changes: the golden replay finds no unexplained difference.
- [ ] The README and this guide still describe what the code does.
