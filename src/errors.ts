// What went wrong, for a caller that acts on it: the CLI was called wrong
// (`usage`), the config can't be read or is invalid (`config`), or git
// refused (`git`); `other` is anything bivium didn't name. Every one exits
// 2; `--json` prints the kind.
export type ErrorKind = "usage" | "config" | "git" | "other";

export class BiviumError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
  }
}

// Edits from one to the other, a swap of two neighbors counting as one
// (optimal string alignment): "plna" is one edit from "plan".
function distance(a: string, b: string): number {
  // rows[i][j]: edits from a's first i characters to b's first j.
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(Array.from({ length: b.length + 1 }, (_, col) => col + i));
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = d;
    }
  }
  return rows[a.length][b.length];
}

// The candidate a typo most likely meant, if one is close: a third of the
// input's length in edits, at least one.
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
