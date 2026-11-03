// "1 test", "2 tests": a count with its noun, for the CLI's sentences.
export function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
