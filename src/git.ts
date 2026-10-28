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
  // The merge base of `base` and HEAD, asked of git on the first call (or
  // up front, with `mergeBase: true`): only a narrower, or a caller that
  // reports the commit, needs it.
  mergeBase: () => Promise<string>;
  // A file's content at the merge base, or `undefined` if it didn't exist
  // there. A changed file's is read by the blob OID the diff names, without
  // the merge base.
  readBase: (path: string) => Promise<string | undefined>;
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

// `diff --raw`: `:<mode> <mode> <oid> <oid> <status>\t<path>`, the merge
// base's side first.
const RAW_ENTRY = /^:(\d{6}) \d{6} ([0-9a-f]+) [0-9a-f]+ ([A-Z])\d*\t(.*)$/;

// One `git merge-base` per revision, started on the first call. Any base
// `diff --merge-base` accepts has one merge base, so this can't fail where
// the diff passed; a failed call nobody awaits is still handled.
function mergeBaseOf(cwd: string, base: string): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    if (pending === undefined) {
      pending = gitOrThrow(cwd, "merge-base", base, "HEAD").then((out) =>
        out.trim(),
      );
      pending.catch(() => undefined);
    }
    return pending;
  };
}

// The files under `roots` and the files changed since the merge base of
// `base` and HEAD, from concurrent git calls. `--merge-base` diffs the
// working tree without waiting for the merge base, which is found only if
// asked for. A diff of the index runs too, cached or not: without it a
// staged change the working tree reverted could pass a stale OID off as
// the file's content, and a staged new file deleted from disk would look
// present. `blobs` only adds the OIDs.
export async function readRevision(
  cwd: string,
  base: string,
  roots: string[],
  {
    blobs = false,
    mergeBase: eager = false,
  }: { blobs?: boolean; mergeBase?: boolean } = {},
): Promise<Revision> {
  const mergeBase = mergeBaseOf(cwd, base);
  if (eager) mergeBase();
  const diffArgs = ["--no-renames", "--merge-base", base];
  // One listing of the whole repo: the index, and untracked files, which
  // count as changed anywhere (outside the roots, they run everything).
  const [listing, diff, staged] = await Promise.all([
    gitOrThrow(cwd, "ls-files", "-s", "-v", "-o", "--exclude-standard"),
    gitOrThrow(cwd, "diff", "--raw", "--no-abbrev", ...diffArgs),
    gitOrThrow(cwd, "diff", "--cached", "--name-only", ...diffArgs),
  ]);
  const entries = lines(listing);
  const untracked: string[] = [];
  for (const line of entries) {
    if (line.startsWith("? ")) untracked.push(line.slice(2));
  }
  // Each changed path's blob at the merge base, `undefined` for one added
  // since. A conflicted path's line (`U`) or a submodule's names no blob.
  const before = new Map<string, string | undefined>();
  const diffed: string[] = [];
  for (const line of lines(diff)) {
    const entry = RAW_ENTRY.exec(line);
    if (!entry) throw new Error(`git diff: unexpected line ${line}`);
    const [, mode, oid, status, path] = entry;
    diffed.push(path);
    if (status === "A") before.set(path, undefined);
    else if ("MTD".includes(status) && mode !== "160000") {
      before.set(path, oid);
    }
  }
  const readBase = (path: string) => {
    if (!before.has(path)) {
      return mergeBase().then((commit) => show(cwd, `${commit}:${path}`));
    }
    const oid = before.get(path);
    return oid === undefined ? Promise.resolve(undefined) : show(cwd, oid);
  };
  const changed = [...new Set([...diffed, ...untracked])];
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
    readBase,
    blobs: oids,
    present,
  };
}

// An object's content (a blob, or `<commit>:<path>`), or `undefined` if
// there's none.
async function show(cwd: string, object: string): Promise<string | undefined> {
  const result = await git(cwd, "show", object);
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
