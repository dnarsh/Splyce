// TD-24 / C5_dirty_snapshot — failing-first stale-verification tests.
// Immutable candidate/input manifest from dirty tracked/untracked fixture;
// unchanged HEAD with changed relevant bytes invalidates prior verifier;
// excluded output cannot hide verifier input.
//
// (Originally failing-first; the implementation now exists and these cases gate it.)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../../packages/splyce-pi/dist/store.js";
import {
  Snapshot,
  SnapshotError,
  createSnapshot,
  verifyStale,
} from "../../src/snapshots.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "td24-snapshots-"));
let counter = 0;
const freshDir = () => {
  counter += 1;
  const dir = join(tmpRoot, `t${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("createSnapshot builds an immutable manifest from dirty tracked+untracked files", () => {
  const dir = freshDir();
  // init git repo
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  // tracked file (committed)
  writeFileSync(join(dir, "tracked.ts"), "export const x = 1;");
  execSync("git add tracked.ts", { cwd: dir });
  execSync("git commit -q -m init", { cwd: dir });
  // modify tracked file (dirty)
  writeFileSync(join(dir, "tracked.ts"), "export const x = 2;");
  // untracked file
  writeFileSync(join(dir, "untracked.ts"), "export const y = 2;");

  const snap = createSnapshot(dir);
  assert.ok(snap instanceof Snapshot);
  // Manifest is frozen/immutable.
  assert.throws(() => {
    (snap as unknown as Record<string, unknown>).head = "tampered";
  });
  // Contains both tracked and untracked entries.
  assert.ok(snap.manifest.tracked.length >= 1);
  assert.ok(snap.manifest.untracked.length >= 1);
  // Each entry carries path + content hash.
  for (const entry of [...snap.manifest.tracked, ...snap.manifest.untracked]) {
    assert.equal(typeof entry.path, "string");
    assert.equal(typeof entry.sha256, "string");
    assert.equal(entry.sha256.length, 64);
  }
});

test("verifyStale: unchanged HEAD with changed relevant bytes invalidates prior verifier", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "relevant.ts"), "export const v = 1;");
  const snap = createSnapshot(dir);

  // Simulate: HEAD unchanged but relevant bytes changed.
  writeFileSync(join(dir, "relevant.ts"), "export const v = 2;");

  assert.throws(
    () => verifyStale(snap, dir),
    (err: unknown) =>
      err instanceof SnapshotError && err.code === "STALE_RELEVANT_BYTES",
  );
});

test("verifyStale: matching bytes pass verification", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "relevant.ts"), "export const v = 1;");
  const snap = createSnapshot(dir);

  // No changes -> not stale.
  assert.doesNotThrow(() => verifyStale(snap, dir));
});

test("verifyStale: excluded output cannot hide verifier input", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "input.ts"), "export const i = 1;");
  writeFileSync(join(dir, "output.log"), "generated noise");
  const snap = createSnapshot(dir, { exclude: ["*.log"] });

  // Mutate an excluded output file -> should NOT affect staleness.
  writeFileSync(join(dir, "output.log"), "different noise");
  assert.doesNotThrow(() => verifyStale(snap, dir));

  // Mutate a non-excluded input file -> stale.
  writeFileSync(join(dir, "input.ts"), "export const i = 2;");
  assert.throws(
    () => verifyStale(snap, dir),
    (err: unknown) =>
      err instanceof SnapshotError && err.code === "STALE_RELEVANT_BYTES",
  );
});

test("snapshot persists to store and round-trips", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "tracked.ts"), "export const x = 1;");
  const store = Store.open(join(dir, "store.db"));
  const snap = createSnapshot(dir);
  const persisted = snap.persist(store);
  assert.equal(typeof persisted.seq, "number");

  const loaded = Snapshot.load(store, persisted.seq);
  assert.deepEqual(loaded.manifest, snap.manifest);
  store.close();
});

test("createSnapshot rejects empty directory", () => {
  const dir = freshDir();
  assert.throws(
    () => createSnapshot(dir),
    (err: unknown) =>
      err instanceof SnapshotError && err.code === "EMPTY_SNAPSHOT",
  );
});

// ---- Ported from dnarsh/td24-snapshots (issue #69): real git workspaces for the gaps found in review of PR #80. ----
import { symlinkSync, unlinkSync } from "node:fs";

const sh = (dir: string, command: string) =>
  execSync(command, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

function gitRepo(files: Record<string, string>): string {
  const dir = freshDir();
  sh(dir, "git init -q");
  sh(dir, "git config user.email t@example.invalid");
  sh(dir, "git config user.name t");
  put(dir, files);
  sh(dir, "git add -A");
  sh(dir, "git commit -q -m base");
  return dir;
}

function put(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
}

const paths = (snap: Snapshot) =>
  [...snap.manifest.tracked, ...snap.manifest.untracked].map((e) => e.path);
const staleCode = (error: unknown) =>
  error instanceof SnapshotError ? error.code : undefined;

test("manifest records HEAD and classifies tracked versus untracked files", () => {
  const dir = gitRepo({ "src/a.ts": "a" });
  put(dir, { "src/a.ts": "a-dirty", "src/new.ts": "new" });
  const snap = createSnapshot(dir);
  assert.equal(snap.manifest.head, sh(dir, "git rev-parse HEAD"));
  assert.deepEqual(
    snap.manifest.tracked.map((e) => e.path),
    ["src/a.ts"],
  );
  assert.deepEqual(
    snap.manifest.untracked.map((e) => e.path),
    ["src/new.ts"],
  );
});

test("a new commit is stale even when the bytes are identical", () => {
  const dir = gitRepo({ "src/a.ts": "a" });
  const snap = createSnapshot(dir);
  sh(dir, "git commit -q --allow-empty -m empty");
  assert.throws(
    () => verifyStale(snap, dir),
    (error) => staleCode(error) === "STALE_HEAD",
  );
});

test("an untracked file added after verification, or a tracked file removed, invalidates it", () => {
  const dir = gitRepo({ "src/a.ts": "a", "src/b.ts": "b" });
  const snap = createSnapshot(dir);
  put(dir, { "src/extra.ts": "x" });
  assert.throws(
    () => verifyStale(snap, dir),
    (error) => staleCode(error) === "STALE_RELEVANT_BYTES",
  );
  unlinkSync(join(dir, "src/extra.ts"));
  unlinkSync(join(dir, "src/b.ts"));
  assert.throws(
    () => verifyStale(snap, dir),
    (error) => staleCode(error) === "STALE_RELEVANT_BYTES",
  );
});

test("gitignored build output is not part of the snapshot and cannot make it stale", () => {
  const dir = gitRepo({ ".gitignore": "dist/\n", "src/a.ts": "a" });
  put(dir, { "dist/out.js": "built1" });
  const snap = createSnapshot(dir);
  assert.ok(!paths(snap).some((p) => p.startsWith("dist/")));
  put(dir, { "dist/out.js": "built2" });
  assert.doesNotThrow(() => verifyStale(snap, dir));
});

test("directory and suffix exclusions work and are recorded", () => {
  const dir = gitRepo({ "src/a.ts": "a" });
  put(dir, { "out/x.js": "1", "run.log": "1" });
  const snap = createSnapshot(dir, { exclude: ["out/", "*.log"] });
  assert.deepEqual(paths(snap), ["src/a.ts"]);
  assert.deepEqual([...snap.manifest.excluded], ["out/", "*.log"]);
  put(dir, { "out/x.js": "2", "run.log": "2" });
  assert.doesNotThrow(() => verifyStale(snap, dir));
});

test("an exclusion can never hide a declared verifier input", () => {
  const dir = gitRepo({ "src/a.ts": "a" });
  put(dir, { "out/golden.json": "v1", "out/other.js": "1" });
  const options = { exclude: ["out/"], verifierInputs: ["out/golden.json"] };
  const snap = createSnapshot(dir, options);
  assert.ok(paths(snap).includes("out/golden.json"));
  assert.ok(!paths(snap).includes("out/other.js"));
  put(dir, { "out/other.js": "2" });
  assert.doesNotThrow(() => verifyStale(snap, dir));
  put(dir, { "out/golden.json": "v2" });
  assert.throws(
    () => verifyStale(snap, dir),
    (error) => staleCode(error) === "STALE_RELEVANT_BYTES",
  );
});

test("excluding a path that is also a verifier input still captures it", () => {
  const dir = gitRepo({ "src/a.ts": "a" });
  const snap = createSnapshot(dir, {
    exclude: ["src/a.ts"],
    verifierInputs: ["src/a.ts"],
  });
  assert.ok(paths(snap).includes("src/a.ts"));
});

test("a gitignored verifier input is captured and a missing one is recorded as absent", () => {
  const dir = gitRepo({ ".gitignore": "fixture.txt\n", "src/a.ts": "a" });
  put(dir, { "fixture.txt": "one" });
  const options = { verifierInputs: ["fixture.txt", "never.txt"] };
  const snap = createSnapshot(dir, options);
  const digests = new Map(
    [...snap.manifest.tracked, ...snap.manifest.untracked].map((e) => [
      e.path,
      e.sha256,
    ]),
  );
  assert.notEqual(digests.get("fixture.txt"), "absent");
  assert.equal(digests.get("never.txt"), "absent");
  put(dir, { "never.txt": "now present" });
  assert.throws(
    () => verifyStale(snap, dir),
    (error) => staleCode(error) === "STALE_RELEVANT_BYTES",
  );
});

test("verifier-input paths that escape the workspace are rejected", () => {
  const dir = gitRepo({ "src/a.ts": "a" });
  assert.throws(
    () => createSnapshot(dir, { verifierInputs: ["../outside.txt"] }),
    (error) => staleCode(error) === "PATH_ESCAPE",
  );
});

test("a symlink is bound by its link text, never by its target's bytes", (t) => {
  const dir = gitRepo({ "src/a.ts": "a" });
  const outside = freshDir();
  writeFileSync(join(outside, "secret.txt"), "one");
  try {
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
  } catch {
    t.skip("symlink creation not permitted on this host");
    return;
  }
  const snap = createSnapshot(dir);
  writeFileSync(join(outside, "secret.txt"), "two");
  assert.doesNotThrow(() => verifyStale(snap, dir));
});

test("outside git the head is none and file changes still invalidate", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "a.ts"), "a");
  const snap = createSnapshot(dir);
  assert.equal(snap.manifest.head, "none");
  writeFileSync(join(dir, "a.ts"), "b");
  assert.throws(
    () => verifyStale(snap, dir),
    (error) => staleCode(error) === "STALE_RELEVANT_BYTES",
  );
});

test("the whole manifest is deeply immutable", () => {
  const dir = gitRepo({ "src/a.ts": "a" });
  const snap = createSnapshot(dir);
  assert.throws(() => {
    (snap.manifest.tracked as unknown as { path: string }[])[0]!.path = "x";
  }, TypeError);
  assert.throws(() => {
    (snap.manifest as unknown as { head: string }).head = "x";
  }, TypeError);
  assert.throws(() => {
    (snap.manifest.untracked as unknown as unknown[]).push({});
  }, TypeError);
});
