/**
 * What a caller does about an error: `usage`, bivium was called wrong;
 * `config`, the config can't be found, read, or is invalid; `git`, git
 * refused or the history is missing; `other`, a failure bivium didn't
 * name. Every kind exits 2.
 */
export type BiviumErrorKind = "usage" | "config" | "git" | "other";

/**
 * Which failure it is, stable across releases: a code is never reused for
 * another meaning, and `--json` prints it as `error.code`.
 */
export type BiviumErrorCode =
  /** No command, or `why` without a test. */
  | "BV_MISSING_ARGUMENT"
  | "BV_UNKNOWN_COMMAND"
  | "BV_UNKNOWN_OPTION"
  /** An option's value is missing or of the wrong form. */
  | "BV_BAD_OPTION_VALUE"
  | "BV_UNEXPECTED_ARGUMENT"
  | "BV_UNKNOWN_SUITE"
  /** A path that is no suite's test. */
  | "BV_UNKNOWN_TEST"
  /** A path that names no file of the graph. */
  | "BV_UNKNOWN_FILE"
  /** `run` for a suite with no `run` command. */
  | "BV_NO_RUN_COMMAND"
  /** `plan --github` outside a GitHub Actions step. */
  | "BV_NO_GITHUB_OUTPUT"
  /** No config file where bivium looked. */
  | "BV_CONFIG_NOT_FOUND"
  /** The config file failed to load: a syntax error, or one it throws. */
  | "BV_CONFIG_UNREADABLE"
  /** The config loaded, but a key is unknown or a value is invalid. */
  | "BV_CONFIG_INVALID"
  /** The base to diff against isn't here, or there's no default branch. */
  | "BV_GIT_NO_BASE"
  /** The base and HEAD share no commit here. */
  | "BV_GIT_NO_MERGE_BASE"
  /** A git command failed; the message carries git's own words. */
  | "BV_GIT_FAILED"
  /** A failure bivium didn't anticipate: a bug, or the environment. */
  | "BV_INTERNAL";

const KINDS: Record<BiviumErrorCode, BiviumErrorKind> = {
  BV_MISSING_ARGUMENT: "usage",
  BV_UNKNOWN_COMMAND: "usage",
  BV_UNKNOWN_OPTION: "usage",
  BV_BAD_OPTION_VALUE: "usage",
  BV_UNEXPECTED_ARGUMENT: "usage",
  BV_UNKNOWN_SUITE: "usage",
  BV_UNKNOWN_TEST: "usage",
  BV_UNKNOWN_FILE: "usage",
  BV_NO_RUN_COMMAND: "usage",
  BV_NO_GITHUB_OUTPUT: "usage",
  BV_CONFIG_NOT_FOUND: "config",
  BV_CONFIG_UNREADABLE: "config",
  BV_CONFIG_INVALID: "config",
  BV_GIT_NO_BASE: "git",
  BV_GIT_NO_MERGE_BASE: "git",
  BV_GIT_FAILED: "git",
  BV_INTERNAL: "other",
};

/**
 * An error bivium names: its `code` says which failure, its `kind` what to
 * do.
 */
export class BiviumError extends Error {
  readonly code: BiviumErrorCode;
  readonly kind: BiviumErrorKind;
  constructor(code: BiviumErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.kind = KINDS[code];
  }
}

// A swap of two neighbors counts as one edit (optimal string alignment),
// so "plna" is one edit from "plan".
function distance(a: string, b: string): number {
  // invariant: d(i, j) is the edits from a's first i characters to b's
  // first j.
  const width = b.length + 1;
  const cells = new Uint32Array((a.length + 1) * width);
  const d = (i: number, j: number) => cells[i * width + j] ?? 0;
  for (let i = 0; i <= a.length; i++) cells[i * width] = i;
  for (let j = 0; j <= b.length; j++) cells[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        d(i - 1, j) + 1,
        d(i, j - 1) + 1,
        d(i - 1, j - 1) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d(i - 2, j - 2) + 1);
      }
      cells[i * width + j] = best;
    }
  }
  return d(a.length, b.length);
}

function closest(
  input: string,
  candidates: Iterable<string>,
): string | undefined {
  const most = Math.max(1, Math.floor(input.length / 3));
  let best: string | undefined;
  let bestDistance = most + 1;
  for (const candidate of candidates) {
    const d = distance(input, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

export function didYouMean(
  input: string,
  candidates: Iterable<string>,
): string {
  const match = closest(input, candidates);
  return match === undefined ? "" : ` (did you mean ${match}?)`;
}
