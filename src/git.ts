import { spawn } from "node:child_process";
import { inRoot } from "./config.ts";
import { sorted } from "./sorted.ts";

interface GitResult {
  status: number;
  stdout: string;
}

// Runs git without blocking, so independent calls overlap.
function git(cwd: string, ...args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status: status ?? 1,
        stdout: Buffer.concat(chunks).toString("utf-8"),
      });
    });
  });
}

async function gitOrThrow(cwd: string, ...args: string[]): Promise<string> {
  const result = await git(cwd, ...args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout;
}

function lines(output: string): string[] {
  return output.split("\n").filter(Boolean);
}

export interface Revision {
  // Tracked and untracked files under the roots.
  files: string[];
  // Every path the listing names, under the roots or not: what a declared
  // glob can match. Unsorted.
  listed: string[];
  // Changed against the merge base, plus untracked files.
  changed: string[];
  mergeBase: string;
  // Blob OIDs of the tracked files whose working-tree content is known
  // without reading it: unchanged since the merge base in the index and in
  // the working tree, a regular file, and not skip-worktree or
  // assume-unchanged. Any other file must be read to be known (or, for a
  // file the scanner doesn't read, checked to exist). Empty unless
  // `blobs` was asked for.
  blobs: Map<string, string>;
  // Tracked files the working tree has, unread: `blobs` plus leaves.
  present: Set<string>;
}

// `ls-files -s -v -o`: `<tag> <mode> <oid> <stage>\t<path>` per index
// entry, `? <path>` per untracked file. Tag `H` is a plain cached file;
// lowercase marks assume-unchanged, `S` skip-worktree.
const INDEX_ENTRY = /^(\S) (\d{6}) ([0-9a-f]+) (\d)\t(.*)$/;

// The files under `roots` and the files changed since the merge base of
// `base` and HEAD, from concurrent git calls. `--merge-base` diffs the
// working tree without waiting for the merge base. `blobs` adds a diff of
// the index, so that a staged change the working tree reverted can't pass
// a stale OID off as the file's content.
export async function readRevision(
  cwd: string,
  base: string,
  roots: string[],
  { blobs = false }: { blobs?: boolean } = {},
): Promise<Revision> {
  const diffArgs = ["--name-only", "--no-renames", "--merge-base", base];
  // One listing of the whole repo: the index, and untracked files, which
  // count as changed anywhere (outside the roots, they run everything).
  const [listing, mergeBase, diff, staged] = await Promise.all([
    gitOrThrow(cwd, "ls-files", "-s", "-v", "-o", "--exclude-standard"),
    gitOrThrow(cwd, "merge-base", base, "HEAD").then((out) => out.trim()),
    gitOrThrow(cwd, "diff", ...diffArgs),
    blobs ? gitOrThrow(cwd, "diff", "--cached", ...diffArgs) : "",
  ]);
  const entries = lines(listing);
  const untracked: string[] = [];
  for (const line of entries) {
    if (line.startsWith("? ")) untracked.push(line.slice(2));
  }
  const changed = [...new Set([...lines(diff), ...untracked])];
  const dirty = new Set([...changed, ...lines(staged)]);
  const underRoots = (path: string) => roots.some((root) => inRoot(path, root));
  const files = new Set<string>();
  // A conflicted path has an entry per stage.
  const tracked = new Set<string>();
  const present = new Set<string>();
  const oids = new Map<string, string>();
  for (const line of entries) {
    const entry = INDEX_ENTRY.exec(line);
    if (!entry) {
      if (line.startsWith("? ") && underRoots(line.slice(2))) {
        files.add(line.slice(2));
      }
      continue;
    }
    const [, tag, mode, oid, stage, path] = entry;
    tracked.add(path);
    // A submodule is a directory, never a file the graph reads.
    if (mode === "160000" || !underRoots(path)) continue;
    files.add(path);
    if (dirty.has(path) || stage !== "0" || tag !== "H") continue;
    if (mode !== "100644" && mode !== "100755") continue;
    present.add(path);
    if (blobs) oids.set(path, oid);
  }
  return {
    // Untracked files come out of order.
    files: sorted(files),
    listed: [...tracked, ...untracked],
    changed,
    mergeBase,
    blobs: oids,
    present,
  };
}

// A file's content at `ref`, or `undefined` if it didn't exist there.
export async function showAt(
  cwd: string,
  ref: string,
  path: string,
): Promise<string | undefined> {
  const result = await git(cwd, "show", `${ref}:${path}`);
  return result.status === 0 ? result.stdout : undefined;
}

export async function defaultBase(cwd: string): Promise<string> {
  const head = await git(
    cwd,
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  );
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  const refs = ["origin/main", "origin/master", "main", "master"];
  const found = await Promise.all(
    refs.map((ref) => git(cwd, "rev-parse", "--verify", "--quiet", ref)),
  );
  const branch = refs.find((_, i) => found[i].status === 0);
  if (branch) return branch;
  throw new Error("bivium: no base given and no default branch found");
}
