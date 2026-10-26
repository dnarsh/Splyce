// TD-24 / C5_dirty_snapshot: real git workspaces, no mocks. Each case fails if the
// matching guard in src/snapshots.ts is removed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ABSENT,
  SnapshotError,
  captureSnapshot,
  compareSnapshots,
} from "../../packages/splyce-pi/dist/snapshots.js";

const git = (root: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "splyce-snap-"));
  git(root, "init", "-q");
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

function write(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

const withRoot = (
  files: Record<string, string>,
  body: (root: string) => void,
) => {
  const root = workspace(files);
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("a clean workspace lists tracked files at HEAD with a stable id", () => {
  withRoot({ "src/a.ts": "a", "src/b.ts": "b" }, (root) => {
    const one = captureSnapshot(root);
    const two = captureSnapshot(root);
    assert.equal(one.head, git(root, "rev-parse", "HEAD"));
    assert.deepEqual(
      one.entries.map((e) => [e.path, e.tracked]),
      [
        ["src/a.ts", true],
        ["src/b.ts", true],
      ],
    );
    assert.equal(one.snapshotId, two.snapshotId);
    assert.equal(compareSnapshots(one, two).stale, false);
  });
});

test("dirty tracked and untracked files are part of the manifest", () => {
  withRoot({ "src/a.ts": "a" }, (root) => {
    const clean = captureSnapshot(root);
    write(root, { "src/a.ts": "a-dirty", "src/new.ts": "new" });
    const dirty = captureSnapshot(root);
    assert.equal(dirty.head, clean.head);
    assert.notEqual(dirty.snapshotId, clean.snapshotId);
    assert.deepEqual(
      dirty.entries.map((e) => [e.path, e.tracked]),
      [
        ["src/a.ts", true],
        ["src/new.ts", false],
      ],
    );
  });
});

test("changed relevant bytes at an unchanged HEAD invalidate the prior verifier", () => {
  withRoot({ "src/a.ts": "a", "src/b.ts": "b" }, (root) => {
    const verified = captureSnapshot(root);
    write(root, { "src/b.ts": "b-edited-after-verify" });
    const now = captureSnapshot(root);
    assert.equal(now.head, verified.head);
    const result = compareSnapshots(verified, now);
    assert.equal(result.stale, true);
    assert.equal(result.headChanged, false);
    assert.deepEqual(result.changes, [{ path: "src/b.ts", change: "changed" }]);
  });
});

test("an untracked file added after verification invalidates it", () => {
  withRoot({ "src/a.ts": "a" }, (root) => {
    const verified = captureSnapshot(root);
    write(root, { "src/extra.ts": "x" });
    const result = compareSnapshots(verified, captureSnapshot(root));
    assert.deepEqual(result.changes, [
      { path: "src/extra.ts", change: "added" },
    ]);
  });
});

test("deleting a tracked file after verification invalidates it", () => {
  withRoot({ "src/a.ts": "a", "src/b.ts": "b" }, (root) => {
    const verified = captureSnapshot(root);
    unlinkSync(join(root, "src/b.ts"));
    const now = captureSnapshot(root);
    assert.equal(
      now.entries.find((e) => e.path === "src/b.ts")?.digest,
      ABSENT,
    );
    assert.deepEqual(compareSnapshots(verified, now).changes, [
      { path: "src/b.ts", change: "changed" },
    ]);
  });
});

test("a new commit is stale even when file bytes are identical", () => {
  withRoot({ "src/a.ts": "a" }, (root) => {
    const verified = captureSnapshot(root);
    git(root, "commit", "-q", "--allow-empty", "-m", "empty");
    const result = compareSnapshots(verified, captureSnapshot(root));
    assert.equal(result.stale, true);
    assert.equal(result.headChanged, true);
    assert.deepEqual(result.changes, []);
  });
});

test("excluded output does not affect the snapshot", () => {
  withRoot({ "src/a.ts": "a" }, (root) => {
    const options = { exclude: ["dist/", "*.log"] };
    write(root, { "dist/out.js": "1", "run.log": "1" });
    const verified = captureSnapshot(root, options);
    write(root, { "dist/out.js": "2", "run.log": "2" });
    const now = captureSnapshot(root, options);
    assert.equal(compareSnapshots(verified, now).stale, false);
    assert.deepEqual(now.excluded, ["dist/out.js", "run.log"]);
    assert.ok(!now.entries.some((e) => e.path.startsWith("dist/")));
  });
});

test("excluded output cannot hide a declared verifier input", () => {
  withRoot({ "src/a.ts": "a" }, (root) => {
    const options = {
      exclude: ["dist/"],
      verifierInputs: ["dist/golden.json"],
    };
    write(root, { "dist/golden.json": "v1", "dist/other.js": "1" });
    const verified = captureSnapshot(root, options);
    const input = verified.entries.find((e) => e.path === "dist/golden.json");
    assert.equal(input?.verifierInput, true);
    assert.ok(!verified.entries.some((e) => e.path === "dist/other.js"));

    write(root, { "dist/golden.json": "v2" });
    const result = compareSnapshots(verified, captureSnapshot(root, options));
    assert.deepEqual(result.changes, [
      { path: "dist/golden.json", change: "changed" },
    ]);
  });
});

test("a gitignored verifier input is still captured, and a missing one is absent", () => {
  withRoot(
    { ".gitignore": "secret-fixture.txt\n", "src/a.ts": "a" },
    (root) => {
      write(root, { "secret-fixture.txt": "one" });
      const options = { verifierInputs: ["secret-fixture.txt", "never.txt"] };
      const verified = captureSnapshot(root, options);
      const byPath = new Map(verified.entries.map((e) => [e.path, e.digest]));
      assert.notEqual(byPath.get("secret-fixture.txt"), ABSENT);
      assert.equal(byPath.get("never.txt"), ABSENT);

      write(root, { "secret-fixture.txt": "two" });
      assert.equal(
        compareSnapshots(verified, captureSnapshot(root, options)).stale,
        true,
      );
      const ignoredOnly = captureSnapshot(root);
      assert.ok(
        !ignoredOnly.entries.some((e) => e.path === "secret-fixture.txt"),
      );
    },
  );
});

test("verifier-input paths that escape the workspace are rejected", () => {
  withRoot({ "src/a.ts": "a" }, (root) => {
    assert.throws(
      () => captureSnapshot(root, { verifierInputs: ["../outside.txt"] }),
      (error) =>
        error instanceof SnapshotError && error.code === "ERR_SNAPSHOT_PATH",
    );
  });
});

test("a symlink is bound by its link text, never by the target's bytes", (t) => {
  withRoot({ "src/a.ts": "a" }, (root) => {
    const outside = mkdtempSync(join(tmpdir(), "splyce-out-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "one");
      try {
        symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
      } catch {
        t.skip("symlink creation not permitted on this host");
        return;
      }
      const first = captureSnapshot(root);
      writeFileSync(join(outside, "secret.txt"), "two");
      const second = captureSnapshot(root);
      assert.equal(first.snapshotId, second.snapshotId);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("the manifest is immutable", () => {
  withRoot({ "src/a.ts": "a" }, (root) => {
    const manifest = captureSnapshot(root);
    assert.throws(() => {
      (manifest.entries as unknown as { path: string }[])[0]!.path = "x";
    }, TypeError);
    assert.throws(() => {
      (manifest as unknown as { head: string }).head = "x";
    }, TypeError);
    assert.throws(() => {
      (manifest.entries as unknown as unknown[]).push({});
    }, TypeError);
  });
});

test("a non-git directory fails closed instead of returning an empty snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "splyce-nogit-"));
  try {
    assert.throws(
      () => captureSnapshot(root),
      (error) =>
        error instanceof SnapshotError && error.code === "ERR_SNAPSHOT_GIT",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
