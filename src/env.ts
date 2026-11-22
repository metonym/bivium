// The one module that reads the clock and the environment. Everything else
// asks here, so what a run depends on from outside is in one place.

/** Returns the file a GitHub Actions step writes its outputs to, if set. */
export function githubOutputPath(): string | undefined {
  // eslint-disable-next-line no-restricted-properties -- the one env reader
  return process.env.GITHUB_OUTPUT;
}

/** Returns the current time in milliseconds since the epoch. */
export function nowMs(): number {
  // eslint-disable-next-line no-restricted-properties -- the one clock reader
  return Date.now();
}
