# CI

Plan in a job of its own, before any install,
and skip the test jobs whose selection is `none`.

Plan in a job of its own, before any install,
and feed each suite's job its selection:

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
    steps:
      # …install, then run all tests or the selected files:
      - run: bunx vitest run ${{ needs.plan.outputs.unit != 'all' && needs.plan.outputs.unit || '' }}
```

## The checkout

A plan compares the branch with its merge base:
the commit where it forked from the base branch.
So the job needs the history back to that commit,
not only the commit under test.
`actions/checkout` fetches one commit by default (`fetch-depth: 1`),
with no base branch, and the plan stops with what's missing:

```text
bivium: origin/main and HEAD share no commit here, so there's no merge base to diff against. The clone is shallow: fetch the history (actions/checkout: `fetch-depth: 0`).
```

`fetch-depth: 0` fetches every commit.
Only a job that plans needs it; one that runs every test anyway,
such as a push to the default branch, can keep the default:
`fetch-depth: ${{ github.event_name == 'pull_request' && '0' || '1' }}`.

The history git fetches is three kinds of object: commits;
trees, each directory's file names with the ID of each one's content;
and blobs, the contents.
A plan needs the commits, to find the merge base, and the trees,
to list what changed.
Of the blobs it needs the working tree's, which the checkout has,
and the merge base's version of a few changed files only:
a lockfile, a `package.json`, a `tsconfig.json`, a barrel,
and what a narrower reads.
So pick the clone by how big the history is:

| History | Checkout | What a plan pays |
| :--- | :--- | :--- |
| Small: a full clone takes a second or two | `fetch-depth: 0` | Nothing more: every old version is already on disk |
| Large: years of commits, big files | `fetch-depth: 0` and `filter: blob:none` | A fetch from the remote for the old versions it reads, when a change needs any: about a second, sometimes several |

`filter: blob:none` makes a partial clone: every commit and tree,
and only the blobs the checkout needs.
Git fetches any other blob when something reads it,
and fetches for reads made at once run in parallel.
Without the filter, a large history's old contents are most of the
download; with it, a small repository pays a round trip to the remote
for contents it could have had for free.

## The cache

The cache holds what bivium extracted from each file, keyed by git blob,
so a warm plan reads only the files a branch changed.
Key it on the merge base: a pull request can restore caches from the
default branch, whose run at that commit is the one to hit.
Without `node_modules`, the cache lives in `.bivium/cache`;
it writes a `.gitignore` so it never shows up as a change.

## What a plan costs

Measured on an Apple M-series laptop under load
(median of five, wall time):

| Repository | Files | Bun, no cache | Bun, warm | Node 24, no cache | Node 24, warm | Cache |
|:---|---:|---:|---:|---:|---:|---:|
| carbon-components-svelte | 4,680 | 0.15 s | 0.09 s | 0.27 s | 0.13 s | 452 KB |
| generated TypeScript, 23 MB | 7,000 | 0.14 s | 0.08 s | 0.30 s | 0.12 s | 896 KB |

So the cache is optional at this size, `bunx --bun` is worth it,
and planning inside a test job (no extra job, no install) costs well
under a second.
A cold plan of the generated repository peaks at 88 MB of RSS on Bun
and 124 MB on Node.

## Related

- [CLI](cli.md): `plan --github` and the other commands
- [How it works](how-it-works.md): what a plan reads
