// Code-unit order, as `Array.prototype.sort` uses with no comparator: plans
// list files in it, and locale-aware comparison would reorder them.
export function byCodeUnit(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sorted(values: Iterable<string>): string[] {
  return [...values].sort(byCodeUnit);
}
