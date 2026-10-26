// TD-24 / C5 snapshots: dirty tracked + untracked workspace -> immutable input manifest.
// A verifier result is bound to a manifest; any relevant byte change invalidates it even at an unchanged HEAD.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

export const ABSENT = "absent" as const;

export interface SnapshotEntry {
  readonly path: string;
  /** sha256 hex of the bytes, of the link text for a symlink, or "absent" for a tracked or declared path with no file. */
  readonly digest: string;
  readonly tracked: boolean;
  readonly verifierInput: boolean;
}

export interface SnapshotManifest {
  readonly head: string;
  readonly entries: readonly SnapshotEntry[];
  /** Paths matched by an exclusion that are not verifier inputs; they cannot affect the snapshot id. */
  readonly excluded: readonly string[];
  readonly snapshotId: string;
}

export interface CaptureOptions {
  /** Exact path, `dir/` prefix, or `*suffix` patterns for outputs that never affect verification. */
  exclude?: readonly string[];
  /** Exact paths or `dir/` prefixes. Always included, even if excluded or gitignored. */
  verifierInputs?: readonly string[];
}

export type SnapshotChange = "added" | "removed" | "changed";

export interface StaleResult {
  readonly stale: boolean;
  readonly headChanged: boolean;
  readonly changes: readonly { path: string; change: SnapshotChange }[];
}

export class SnapshotError extends Error {
  readonly code: "ERR_SNAPSHOT_GIT" | "ERR_SNAPSHOT_PATH";
  constructor(code: SnapshotError["code"], message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

function matches(pattern: string, file: string): boolean {
  if (pattern.startsWith("*")) return file.endsWith(pattern.slice(1));
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  return file === pattern;
}

const anyMatch = (patterns: readonly string[], file: string) =>
  patterns.some((pattern) => matches(pattern, file));

function git(root: string, ...args: string[]): string {
  try {
    return execFileSync(
      "git",
      ["-c", "core.quotepath=off", "-C", root, ...args],
      {
        encoding: "utf8",
        maxBuffer: 1 << 28,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    throw new SnapshotError(
      "ERR_SNAPSHOT_GIT",
      `git ${args[0] ?? ""} failed: ${(error as Error).message}`,
    );
  }
}

function listZ(root: string, ...args: string[]): string[] {
  return git(root, ...args)
    .split("\0")
    .filter((item) => item.length > 0);
}

function safeRelative(file: string): string {
  const normalized = path.posix.normalize(file.replaceAll("\\", "/"));
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.posix.isAbsolute(normalized)
  )
    throw new SnapshotError(
      "ERR_SNAPSHOT_PATH",
      `path escapes workspace: ${file}`,
    );
  return normalized;
}

function digestOf(root: string, file: string): string {
  const full = path.join(root, file);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return ABSENT;
  }
  if (stat.isSymbolicLink()) return sha256(`symlink:${readlinkSync(full)}`);
  if (!stat.isFile()) return ABSENT;
  return sha256(readFileSync(full));
}

function deepFreeze<T extends object>(value: T): T {
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") deepFreeze(item as object);
  }
  return Object.freeze(value);
}

export function manifestId(
  head: string,
  entries: readonly SnapshotEntry[],
  excluded: readonly string[],
): string {
  return sha256(
    JSON.stringify({
      head,
      entries: entries.map((e) => [
        e.path,
        e.digest,
        e.tracked,
        e.verifierInput,
      ]),
      excluded,
    }),
  );
}

export function captureSnapshot(
  root: string,
  options: CaptureOptions = {},
): SnapshotManifest {
  const exclude = options.exclude ?? [];
  const inputs = (options.verifierInputs ?? []).map(safeRelative);
  let head: string;
  try {
    head = git(root, "rev-parse", "HEAD").trim();
  } catch {
    head = "unborn";
  }

  const tracked = new Set(listZ(root, "ls-files", "-z").map(safeRelative));
  const untracked = new Set(
    listZ(root, "ls-files", "-z", "--others", "--exclude-standard").map(
      safeRelative,
    ),
  );
  const isInput = (file: string) => anyMatch(inputs, file);

  const candidates = new Set<string>([...tracked, ...untracked]);
  for (const input of inputs) {
    if (!input.endsWith("/")) candidates.add(input); // an ignored or excluded exact input must still count
  }

  const entries: SnapshotEntry[] = [];
  const excluded: string[] = [];
  for (const file of [...candidates].sort()) {
    const verifierInput = isInput(file);
    if (!verifierInput && anyMatch(exclude, file)) {
      excluded.push(file);
      continue;
    }
    entries.push({
      path: file,
      digest: digestOf(root, file),
      tracked: tracked.has(file),
      verifierInput,
    });
  }

  return deepFreeze({
    head,
    entries,
    excluded,
    snapshotId: manifestId(head, entries, excluded),
  });
}

export function compareSnapshots(
  verified: SnapshotManifest,
  current: SnapshotManifest,
): StaleResult {
  const before = new Map(verified.entries.map((e) => [e.path, e.digest]));
  const after = new Map(current.entries.map((e) => [e.path, e.digest]));
  const changes: { path: string; change: SnapshotChange }[] = [];
  for (const [file, digest] of after) {
    const old = before.get(file);
    if (old === undefined) changes.push({ path: file, change: "added" });
    else if (old !== digest) changes.push({ path: file, change: "changed" });
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changes.push({ path: file, change: "removed" });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  const headChanged = verified.head !== current.head;
  return deepFreeze({
    stale: headChanged || changes.length > 0,
    headChanged,
    changes,
  });
}
