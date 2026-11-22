// The one module that reads the clock and the environment. Everything else
// asks here, so what a run depends on from outside is in one place.

export function githubOutputPath(): string | undefined {
  // eslint-disable-next-line no-restricted-properties -- the one env reader
  return process.env.GITHUB_OUTPUT;
}

export function nowMs(): number {
  // eslint-disable-next-line no-restricted-properties -- the one clock reader
  return Date.now();
}
