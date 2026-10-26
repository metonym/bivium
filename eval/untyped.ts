// Code the eval scripts load at run time from another checkout (carbon's
// selector, an earlier bivium) is untyped: what it exports and returns is
// checked before it's used.
import type { FileDeps, Graph } from "../src/graph.ts";

export type Call = (...args: unknown[]) => unknown;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function exported(module: unknown, name: string): Call {
  const value = isRecord(module) ? module[name] : undefined;
  if (typeof value !== "function") throw new Error(`no ${name}() exported`);
  return (...args) => Reflect.apply(value, undefined, args);
}

export async function importModule(path: string): Promise<unknown> {
  const module: unknown = await import(path);
  return module;
}

function isRegExps(value: unknown): value is RegExp[] {
  return Array.isArray(value) && value.every((item) => item instanceof RegExp);
}

function isFileDeps(value: unknown): value is FileDeps {
  return (
    isRecord(value) &&
    value.files instanceof Set &&
    [...value.files].every((file) => typeof file === "string") &&
    isRegExps(value.patterns) &&
    isRegExps(value.reads) &&
    isStrings(value.unknown)
  );
}

export function isGraph(value: unknown): value is Graph {
  return (
    value instanceof Map &&
    [...value].every(
      ([key, deps]) => typeof key === "string" && isFileDeps(deps),
    )
  );
}

/** Reads a `.json` array, or a `.jsonl` file, keeping the items `is` accepts. */
export function readItems<T>(
  text: string,
  jsonLines: boolean,
  is: (value: unknown) => value is T,
): T[] {
  const parsed: unknown = jsonLines
    ? text
        .split("\n")
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line))
    : JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(is)) {
    throw new Error("unexpected data");
  }
  return parsed;
}
