# Compared with

Where bivium sits among the tools that select or skip tests.

| | Selects | Misses |
|:---|:---|:---|
| `vitest --changed`, `jest --changedSince` | Tests whose module graph reaches a changed file, from the runner's own resolver | Disk reads, fixtures, pages a test visits, config and setup wiring |
| Playwright `--only-changed` | Test files whose imports changed | The pages a test opens and what they load |
| Nx, Turborepo | Whole projects whose inputs changed | Nothing within a project's declared inputs, at project granularity |
| Bazel | Targets whose declared inputs changed | Nothing, if every input is declared |
| bivium | Test files, across runners and file types, from one graph | Nothing it can see; what it can't, it runs |

## Related

- [How it works](how-it-works.md): why it misses nothing it can see
