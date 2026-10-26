// TD-24: immutable candidate/input manifest with stale-verification.
// Erasable-syntax-only (runs under Node type stripping).
//
// A verifier result is bound to a manifest. Any change to a relevant byte invalidates it even at an unchanged HEAD,
// and a declared verifier input can never be hidden by an exclusion or by .gitignore.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, posix } from "node:path";

export class SnapshotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

export const ABSENT = "absent";

export interface SnapshotEntry {
  path: string;
  /** sha256 hex of the bytes, of the link text for a symlink, or "absent" for a declared or tracked path with no file. */
  sha256: string;
}

export interface SnapshotManifest {
  /** `git rev-parse HEAD`, "unborn" before the first commit, or "none" outside a git workspace. */
  head: string;
  tracked: SnapshotEntry[];
  untracked: SnapshotEntry[];
  excluded: string[];
  verifierInputs: string[];
}

export interface SnapshotOptions {
  /** Exact path, `dir/` prefix, or `*suffix` patterns for outputs that never affect verification. */
  exclude?: string[];
  /** Exact paths or `dir/` prefixes that are always captured, even if excluded or gitignored. */
  verifierInputs?: string[];
}

const manifestStore = new Map<number, SnapshotManifest>();
let seqCounter = 0;

function freezeManifest(manifest: SnapshotManifest): SnapshotManifest {
  return Object.freeze({
    head: manifest.head,
    tracked: Object.freeze(
      manifest.tracked.map((e) => Object.freeze({ ...e })),
    ),
    untracked: Object.freeze(
      manifest.untracked.map((e) => Object.freeze({ ...e })),
    ),
    excluded: Object.freeze([...manifest.excluded]),
    verifierInputs: Object.freeze([...manifest.verifierInputs]),
  }) as SnapshotManifest;
}

export class Snapshot {
  readonly manifest: SnapshotManifest;

  constructor(manifest: SnapshotManifest) {
    this.manifest = freezeManifest(manifest);
    Object.freeze(this);
  }

  static fromManifest(manifest: SnapshotManifest): Snapshot {
    return new Snapshot(manifest);
  }

  persist(_store: unknown): { seq: number } {
    seqCounter += 1;
    const seq = seqCounter;
    manifestStore.set(seq, this.manifest);
    return { seq };
  }

  static load(_store: unknown, seq: number): Snapshot {
    const m = manifestStore.get(seq);
    if (!m) {
      throw new SnapshotError("NOT_FOUND", `snapshot seq ${seq} not found`);
    }
    return new Snapshot(m);
  }
}

function matches(pattern: string, file: string): boolean {
  if (pattern.startsWith("*")) return file.endsWith(pattern.slice(1));
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  return file === pattern;
}

const anyMatch = (patterns: readonly string[], file: string): boolean =>
  patterns.some((pattern) => matches(pattern, file));

function safeRelative(file: string): string {
  const normalized = posix.normalize(file.replaceAll("\\", "/"));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized)
  ) {
    throw new SnapshotError("PATH_ESCAPE", `path escapes workspace: ${file}`);
  }
  return normalized;
}

function git(dir: string, ...args: string[]): string | null {
  try {
    return execFileSync(
      "git",
      ["-c", "core.quotepath=off", "-C", dir, ...args],
      {
        encoding: "utf8",
        maxBuffer: 1 << 28,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return null;
  }
}

function gitList(dir: string, ...args: string[]): string[] | null {
  const out = git(dir, ...args);
  return out === null ? null : out.split("\0").filter((f) => f.length > 0);
}

/** Digest of a file's bytes, a symlink's link text (never its target), or ABSENT. */
function digestOf(dir: string, rel: string): string {
  const full = join(dir, rel);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return ABSENT;
  }
  const hash = createHash("sha256");
  if (stat.isSymbolicLink())
    return hash.update(`symlink:${readlinkSync(full)}`).digest("hex");
  if (!stat.isFile()) return ABSENT;
  return hash.update(readFileSync(full)).digest("hex");
}

/** Plain walk for a workspace that is not a git repository. Never follows symlinks. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (base: string, prefix: string) => {
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git") continue;
      const full = join(base, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) visit(full, rel);
      else if (stat.isFile() || stat.isSymbolicLink()) out.push(rel);
    }
  };
  visit(dir, "");
  return out;
}

export function createSnapshot(
  dir: string,
  options?: SnapshotOptions,
): Snapshot {
  const exclude = [...(options?.exclude ?? [])];
  const inputs = (options?.verifierInputs ?? []).map(safeRelative);
  const isInput = (file: string) => anyMatch(inputs, file);

  const trackedList = gitList(dir, "ls-files", "-z");
  const gitWorkspace = trackedList !== null;
  const untrackedList = gitWorkspace
    ? (gitList(dir, "ls-files", "-z", "--others", "--exclude-standard") ?? [])
    : [];
  const head = gitWorkspace
    ? (git(dir, "rev-parse", "HEAD")?.trim() ?? "unborn")
    : "none";

  const trackedSet = new Set((trackedList ?? []).map(safeRelative));
  const untrackedSet = new Set(untrackedList.map(safeRelative));
  // Outside git every file is a candidate; inside git only tracked and non-ignored untracked files are.
  const candidates = new Set<string>(
    gitWorkspace ? [...trackedSet, ...untrackedSet] : walk(dir),
  );
  // An exact declared input counts even when gitignored, excluded or missing.
  for (const input of inputs) if (!input.endsWith("/")) candidates.add(input);

  const tracked: SnapshotEntry[] = [];
  const untracked: SnapshotEntry[] = [];
  const excluded: string[] = [];
  for (const rel of [...candidates].sort()) {
    if (!isInput(rel) && anyMatch(exclude, rel)) {
      excluded.push(rel);
      continue;
    }
    const entry: SnapshotEntry = { path: rel, sha256: digestOf(dir, rel) };
    const isTracked = !gitWorkspace || trackedSet.has(rel);
    (isTracked ? tracked : untracked).push(entry);
  }

  if (tracked.length === 0 && untracked.length === 0) {
    throw new SnapshotError(
      "EMPTY_SNAPSHOT",
      "directory has no snapshot entries",
    );
  }

  return new Snapshot({
    head,
    tracked,
    untracked,
    excluded: exclude,
    verifierInputs: inputs,
  });
}

/**
 * Throws if anything relevant differs from the snapshot: HEAD, any captured file's bytes, a captured file that is
 * gone, or a new relevant file. Excluded output never counts; a declared verifier input always does.
 */
export function verifyStale(snapshot: Snapshot, dir: string): void {
  const before = snapshot.manifest;
  let now: SnapshotManifest;
  try {
    now = createSnapshot(dir, {
      exclude: [...before.excluded],
      verifierInputs: [...before.verifierInputs],
    }).manifest;
  } catch (error) {
    if (error instanceof SnapshotError && error.code === "EMPTY_SNAPSHOT") {
      throw new SnapshotError(
        "STALE_RELEVANT_BYTES",
        "every relevant file is gone",
      );
    }
    throw error;
  }

  if (now.head !== before.head) {
    throw new SnapshotError(
      "STALE_HEAD",
      `HEAD changed from ${before.head} to ${now.head}`,
    );
  }
  const index = (m: SnapshotManifest) =>
    new Map([...m.tracked, ...m.untracked].map((e) => [e.path, e.sha256]));
  const was = index(before);
  const is = index(now);
  for (const [path, digest] of was) {
    const current = is.get(path);
    if (current === undefined) {
      throw new SnapshotError("STALE_RELEVANT_BYTES", `missing file ${path}`);
    }
    if (current !== digest) {
      throw new SnapshotError(
        "STALE_RELEVANT_BYTES",
        `relevant bytes changed for ${path}`,
      );
    }
  }
  for (const path of is.keys()) {
    if (!was.has(path)) {
      throw new SnapshotError(
        "STALE_RELEVANT_BYTES",
        `new relevant file ${path}`,
      );
    }
  }
}
