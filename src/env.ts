// The one module that reads the clock and the environment. Everything else
// asks here, so what a run depends on from outside is in one place.

type Env = Readonly<Record<string, string | undefined>>;

export function githubOutputPath(): string | undefined {
  // eslint-disable-next-line no-restricted-properties -- the one env reader
  return process.env.GITHUB_OUTPUT;
}

export function nowMs(): number {
  // eslint-disable-next-line no-restricted-properties -- the one clock reader
  return Date.now();
}

export function environment(): Env {
  // eslint-disable-next-line no-restricted-properties -- the one env reader
  return process.env;
}

// The variables a coding agent sets. Each tool keeps its own copy of the
// list, since a package has no runtime dependencies.
const AGENT_ENV = [
  "AGENT",
  "AI_AGENT",
  "CLAUDECODE",
  "CODEX_CI",
  "CODEX_THREAD_ID",
] as const;

// Empty or `0` is a person saying "not an agent" without unsetting it.
export function agentVariable(env: Env): string | undefined {
  return AGENT_ENV.find((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "0";
  });
}
