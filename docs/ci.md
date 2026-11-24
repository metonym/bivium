# CI

In CI, bivium plans in a job of its own, before any install,
and hands each test job its suite's selection.
A job whose selection is `none` doesn't run.

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      unit: ${{ steps.plan.outputs.unit-tests }}
      e2e: ${{ steps.plan.outputs.e2e-tests }}
    steps:
      - uses: actions/checkout@v7
        with:
          # History back to the merge base; see "The checkout" below.
          fetch-depth: 0
          filter: blob:none
      - uses: oven-sh/setup-bun@v2
      - id: merge-base
        run: echo "sha=$(git merge-base origin/main HEAD)" >> "$GITHUB_OUTPUT"
      - uses: actions/cache@v6
        with:
          path: .bivium/cache
          key: bivium-${{ steps.merge-base.outputs.sha }}
          restore-keys: bivium-
      - id: plan
        # --bun: run on Bun, which loads a TypeScript config whatever Node
        # the runner has.
        run: bunx --bun bivium plan origin/main --github
  unit:
    needs: plan
    if: needs.plan.outputs.unit != 'none'
    runs-on: ubuntu-latest
    steps:
      # …install, then run all tests or the selected files:
      - run: bunx vitest run ${{ needs.plan.outputs.unit != 'all' && needs.plan.outputs.unit || '' }}
```

`--github` writes each suite's selection to a step output named
`<suite>-tests`, such as `unit-tests`;
a suite's `output` key renames it.
The value is `all`, `none`, or the selected files, separated by spaces.
The `unit` job skips on `none`, runs every test on `all`,
and otherwise passes the files to Vitest.

Three decisions shape the workflow: the checkout, the cache,
and the cost of a plan.

## The checkout

A plan compares the branch with its merge base:
the commit where the branch forked from the base branch.
So the job needs the history back to that commit,
not only the commit under test.

`actions/checkout` fetches one commit by default (`fetch-depth: 1`),
with no base branch.
The plan then stops and names what's missing.
Without the base, it prints the first line;
with the base but not the history back to the fork, the second:

```text
bivium: no commit origin/main here to diff against: fetch it. The clone is shallow: fetch the history (actions/checkout: `fetch-depth: 0`).
bivium: origin/main and HEAD share no commit here, so there's no merge base to diff against. The clone is shallow: fetch the history (actions/checkout: `fetch-depth: 0`).
```

`fetch-depth: 0` fetches every commit.
Only a job that plans needs it.
A job that runs every test anyway, such as a push to the default branch,
can keep one commit:

```yaml
fetch-depth: ${{ github.event_name == 'pull_request' && '0' || '1' }}
```

Git stores history as three kinds of object:

- **commits**;
- **trees**: each directory's file names,
  with the ID of each file's content;
- **blobs**: the contents.

A plan needs the commits, to find the merge base, and the trees,
to list what changed.
It needs few blobs: the working tree's, which the checkout has,
and the merge base's version of a few changed files.
Those are a lockfile, a `package.json`, a `tsconfig.json`,
a barrel (a module made only of re-exports),
and what a [narrower](api.md#narrowers) reads.
So pick the clone by how big the history is:

| History | Checkout | What a plan pays |
| :--- | :--- | :--- |
| Small: a full clone takes a second or two | `fetch-depth: 0` | Nothing more: every old version is already on disk |
| Large: years of commits, big files | `fetch-depth: 0` and `filter: blob:none` | A fetch from the remote for the old versions it reads, when a change needs any: about a second, sometimes several |

`filter: blob:none` makes a partial clone: every commit and tree,
and only the blobs the checkout needs.
Git fetches any other blob when something reads it,
and fetches for reads made at once run in parallel.
On a large history, the old contents are most of the download,
and the filter skips them.
On a small one, the filter costs a round trip to the remote for contents
a full clone has for free.

## The cache

The cache holds what bivium extracted from each file,
its imports and annotations, keyed by the file's git blob.
A warm plan reads only the files a branch changed.

Key the cache on the merge base.
A pull request can restore caches from the default branch,
and the default branch's run at the merge base is the one to hit.
`restore-keys: bivium-` falls back to the newest cache
when no key matches exactly.

The cache lives in `node_modules/.cache/bivium`
when `node_modules` exists, and in `.bivium/cache` otherwise.
The plan job runs before any install, so its cache is `.bivium/cache`.
bivium writes a `.gitignore` there, so the cache never shows up as
a change.

## What a plan costs

Measured on an Apple M-series laptop under load
(median of five, wall time):

| Repository | Files | Bun, no cache | Bun, warm | Node 24, no cache | Node 24, warm | Cache |
|:---|---:|---:|---:|---:|---:|---:|
| carbon-components-svelte | 4,680 | 0.15 s | 0.09 s | 0.27 s | 0.13 s | 452 KB |
| generated TypeScript, 23 MB | 7,000 | 0.14 s | 0.08 s | 0.30 s | 0.12 s | 896 KB |

At this size the cache saves under 0.2 s, so it's optional.
Bun plans a cold repository in about half the time Node 24 takes,
so `bunx --bun` pays for itself.
Planning inside a test job, with no extra job and no install,
costs well under a second.
A cold plan of the generated repository peaks at 88 MB of RSS on Bun
and 124 MB on Node.

## Related

- [CLI](cli.md): `plan --github` and the other commands
- [Config](config.md): a suite's `output`, and `cache`
- [How it works](how-it-works.md): what a plan reads
- [Not supported](how-it-works.md#not-supported): what bivium leaves to
  other tools
