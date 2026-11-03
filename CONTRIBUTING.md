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
4. **Packages.** When a root lockfile or a `package.json` changed, `readPackageDiff` (`src/lockfile.ts`) reads it in both trees and lists the packages whose entries or declared ranges changed, with the lockfiles' dependency tree. It runs alongside extraction. `settingChanges` (`src/settings.ts`) compares any other changed `tsconfig.json`, file one extends, or `package.json` in both trees, and seeds the files each governs.
5. **Narrowers.** Each narrower whose files changed runs (`runNarrowers`), with the graph and both trees.
6. **Selection.** `planTests` (`src/plan.ts`) classifies the changes (ignored, the selector's own, wiring, a lockfile or dependency change, outside the roots, or seeds), seeds the `pkg:` nodes of changed packages and their dependents (`packageSeeds`), walks the graph backwards from the seeds (`affectedBy`), applies the orphan rule and the narrowers, and picks each suite's tests.

`graph` (`src/fanin.ts`) counts each node's test fan-in by walking forward from every test. `why` (`src/why.ts`) walks again, recording how it reached each node, and `check` (`src/check.ts`) lists the unknown nodes (against `knownUnknowns`), the files under a suite's `root` no test reaches (by `orphanOf`, the orphan rule `plan` applies), and the dead globs (declared globs no change can select through, from the extractions and the whole-repo listing); both find lines by searching the source (`src/locate.ts`). `src/main.ts` is the CLI, `src/cli.ts` its bin.

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
| `tests/cache.test.ts` | The cache's format, bounds and corruption handling, which files git vouches for, what `readRevision` reads at the merge base, and the scanner fingerprint |
| `tests/config.test.ts` | Loading, checking and resolving configs |
| `tests/settings.test.ts` | Changed `tsconfig.json`, extended and `package.json` files through `computePlan`: what each governs, nested configs and packages, deletion, formatting and metadata-only changes, the orphan rule, and `why` |
| `tests/lockfile.test.ts` | Lockfile and `package.json` dependency changes through `plan()`: direct and transitive bumps, `inert`, `loadedByName`, unreadable lockfiles, `package-lock.json`, `pnpm-lock.yaml` |
| `tests/main.test.ts` | `plan` and `run`, their outputs and options, and `plan()` from code |
| `tests/why.test.ts` | `why`, its edge kinds and formats, and `check`, dead globs, hints and `knownUnknowns` included |
| `tests/fanin.test.ts` | `bivium graph`'s fan-in, against a walk per node |
| `tests/yaml.test.ts` | The YAML subset `pnpm-lock.yaml` is read with |
| `scripts/test-package.ts` | `bun run test:package`: the packed tarball installs, imports only builtins, plans a repository from Node and Bun, and type-checks for a consumer |

A behavior fix needs a test that fails before the fix and passes after.

## Benchmarks

```sh
bun run bench                     # ostia, on bench/fixture.ts
bun run bench --peak-mem          # plus each task's RSS rise
bun bench/phases.ts <repo> [base] # one plan's phases on a real repository
bun bench/phases.ts <repo> --cold # the same without the extraction cache
```

The fixture is a generated, carbon-shaped repository with a fixed seed, so runs compare. The suite covers each stage a plan pays for, and the commands built on it:

| Group | Times |
| --- | --- |
| `scan` | The lexer and the regex extractor over every file |
| `graph` | Extraction and resolution, and resolution alone |
| `walk` | `affectedBy` from a narrow and a wide seed, with the reverse index rebuilt, and for a suite with `types: false` |
| `walk: an edges input every test shares` | The walk when one `edges` key gives every test the same inputs, a literal and a glob |
| `graph: fan-in` | `bivium graph`'s fan-in for every suite |
| `git` | `readRevision` on a checkout, with and without blob OIDs |
| `plan` | Cold and warm plans for one changed component, and a warm one for a change that reaches most tests through a util and the barrel |
| `plan at scale` | Cold and warm plans of 350 changes in a 5,900-file repository, under a `root` the orphan rule checks each change in; `--peak-mem` shows what a cold plan holds |
| `lockfile` | Parsing and diffing an 800-package bump, as `bun.lock` and as `pnpm-lock.yaml` |
| `inspect` | `check`, and `why --all` across four changes |

On a real repository git is most of a warm plan (carbon-components-svelte: about 50 of 90 ms), which the fixture's small history understates, so check a change that touches git or resolution with `bench/phases.ts` too. On a shared machine, report the load average with any number, compare `Instr/call` (it holds steady under load where times don't), and prefer `ostia ab` to compare a change with `HEAD`.

Two traps when reading where the time goes:

- On macOS, `/usr/bin/git` is a shim that finds Xcode's git on every call, about 10 ms each; a git stage measured there is mostly process start. Linux CI doesn't pay it. `GIT_TRACE2_PERF=1` gives git's own time per call.
- A CPU profile (`bun --cpu-prof`) charges the time spent waiting on git to whatever runs next: it showed 15 ms in parsing a 61 KB `bun.lock` that takes 0.3 ms. Time a stage with `bench/phases.ts`, or the function alone, before optimizing it.

## Replay a repository's history

`eval/replay.ts` plans a repository's last N merged commits, each against its parent, with two bivium builds, and compares the selections. Each commit is planned with the config it had, and a commit from before the repository adopted bivium is skipped: today's config over older code reports gaps its annotations have since closed. To compare builds, `--config-at origin/HEAD` plans every commit with today's config instead: both builds get the same one, so every difference is the build's, and the history from before adoption counts too.

```sh
# The newest v* tag against this working tree, over carbon's last 60 merges.
bun eval/replay.ts <carbon checkout> --commits 60 --node-modules <carbon checkout>/node_modules
# Try a config change on the same history.
bun eval/replay.ts <sveld checkout> --old HEAD --new HEAD --config my.config.ts
# Two builds over history from before the repository adopted bivium.
bun eval/replay.ts <sveld checkout> --commits 100 --config-at origin/HEAD
bun eval/replay.ts --summary <rows.jsonl>
```

The report gives each build's share of test files selected, its full runs by cause, its median plan time, every commit where the new build selects a test the old one doesn't (a miss the old one had, or a regression), every commit where it drops one (a narrowing a change meant, or a new miss), and every commit a build failed to plan. Read each one. A selector change cites its replay in its pull request. `--node-modules` links an install into each checkout for a config whose narrower imports dependencies; without a matching install, the narrower can't run and its suites run in full on both sides.

## Differential checks

These compare one part of bivium against an independent one on a carbon-components-svelte checkout (any clone works; `eval/carbon/bivium.config.ts` is carbon's selector as a config, which gives them their roots):

```sh
bun eval/carbon/cache-equal.ts <clone> <cache dir> <base>…  # cached graphs and plans equal cold ones, node by node
bun eval/carbon/scan-diff.ts <clone>                        # the lexer against the regex extractor
bun eval/corpus.ts <checkout>                               # the lexer against TypeScript
bun eval/carbon/bench-scan.ts <clone>                       # extraction alone: the lexer, the regex extractor, a bare loop
```

A lexer change runs `scan-diff.ts` and `corpus.ts`, and `bench-scan.ts` if it claims speed; a change to the cache or to what it stores runs `cache-equal.ts`.

## Commits and pull requests

- One logical change per commit, with a subject in the repository's form: `type(scope): what it does`, imperative, lower case (`feat(check): list the files under a suite's root that no test reaches`). The body says why, and what was measured if it's a performance or precision change.
- A pull request lists, per change, what it does, how it was verified, and before/after numbers where they apply, and closes its issues (`Closes #N`). Pull requests are rebase-merged, so every commit lands on `master` as written.
- A user-visible change adds an entry under `## Unreleased` in `CHANGELOG.md`. A design choice the code alone doesn't explain, especially one settled by a measurement, adds an entry to `docs/decisions.md`.

## Releasing

1. Replay the repositories that use bivium (sveld, carbon-preprocess-svelte, carbon-components-svelte) against the newest tag (the default `--old`), with `--commits 100 --config-at origin/HEAD`. carbon's CSS narrower needs `--node-modules` from an install of carbon at `origin/HEAD`: with a stale one it can't load, and every CSS change runs e2e in full on both sides, as `narrower` full runs. Every commit where the release selects more or fewer tests matches a `CHANGELOG.md` entry, no commit fails to plan on the release, and the median plan time holds. One that doesn't is a regression, and blocks the release.
2. Move the `## Unreleased` entries in `CHANGELOG.md` under the new version.
3. Bump `version` in `package.json`, commit as `vX.Y.Z`, and push it to `master`.
4. Tag the commit with a signed tag (`git tag -s vX.Y.Z`, which needs a GPG key git and GitHub know) and push the tag. `release.yml` tests the packed package and publishes `dist/` to npm with provenance.
5. Create the GitHub release for the tag with the version's `CHANGELOG.md` section as its notes (`gh release create vX.Y.Z --notes-file <section>`); `release.yml` doesn't.

## Before you finish

- [ ] `bun run lint`, `bun run typecheck`, `bun run knip`, `bun run test` and `bun run test:package` pass.
- [ ] Scanner, resolver or selection changes: `eval/replay.ts` finds no unexplained difference.
- [ ] Scanner changes: `SCANNER_VERSION` bumped and the fingerprint in `tests/cache.test.ts` updated, or the fingerprint alone when no extraction can change.
- [ ] User-visible changes: an entry under `## Unreleased` in `CHANGELOG.md`. Design choices: an entry in `docs/decisions.md`.
- [ ] The README and this guide still describe what the code does.
