// Agent workspace tools: every rule is a negative test against the real filesystem
// and real child processes; each must fail when its guard is removed.

import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import test from "node:test";
import {
  createWorkspaceTools,
  type Capability,
  type GrantPort,
  type ReceiptPort,
  type WorkspacePort,
} from "../../packages/splyce-pi/dist/workspace-tools.js";

const win = process.platform === "win32";
const base = mkdtempSync(join(tmpdir(), "splyce-wt-"));
test.after(() => rmSync(base, { recursive: true, force: true }));

interface Grant {
  id: string;
  cap: Capability;
  scope: "session" | "once";
  target?: string;
  consumed?: boolean;
  revoked?: boolean;
}

function harness(
  limits?: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    compactBytes?: number;
  },
  redact?: (text: string) => string,
) {
  const dir = mkdtempSync(join(base, "case-"));
  const root = join(dir, "root");
  const outside = join(dir, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const ws = {
    workspaceId: "w1",
    canonicalPath: realpathSync.native(root),
    revision: 1,
  };
  const workspaces: WorkspacePort = {
    workspace: (id) => (id === "w1" ? ws : undefined),
  };
  const all: Grant[] = [{ id: "g-read", cap: "fs.read", scope: "session" }];
  let n = 0;
  const grants: GrantPort & {
    approve(cap: Capability, target: string): string;
    all: Grant[];
  } = {
    all,
    approve(cap, target) {
      const id = `g${String((n += 1))}`;
      all.push({ id, cap, scope: "once", target });
      return id;
    },
    check(req) {
      const mine = all.filter(
        (g) =>
          g.cap === req.capability &&
          (g.scope === "session" || g.target === req.target),
      );
      const live = mine.find((g) => !g.consumed && !g.revoked);
      if (live) return { ok: true, grantId: live.id, scope: live.scope };
      if (mine.some((g) => g.revoked))
        return { ok: false, reason: "GRANT_REVOKED" };
      if (mine.some((g) => g.consumed))
        return { ok: false, reason: "GRANT_CONSUMED" };
      return { ok: false, reason: "GRANT_REQUIRED" };
    },
    consume(id) {
      const g = all.find((x) => x.id === id);
      if (!g || g.consumed || g.revoked) throw new Error("grant unusable");
      g.consumed = true;
    },
  };
  const log: Parameters<ReceiptPort["record"]>[0][] = [];
  const receipts: ReceiptPort = {
    record(effect) {
      log.push(effect);
      return `r${String(log.length)}`;
    },
  };
  const tools = createWorkspaceTools({
    workspaces,
    grants,
    receipts,
    sessionId: "s1",
    workspaceId: "w1",
    ...(redact ? { redact } : {}),
    ...(limits
      ? { limits: { timeoutMs: 20000, maxOutputBytes: 1 << 20, ...limits } }
      : {}),
  });
  return { root, outside, ws, grants, log, tools, receipts, workspaces };
}
type H = ReturnType<typeof harness>;
const run = (h: H, name: string, args: object) =>
  (
    h.tools[name] as { execute(a: object, s?: AbortSignal): Promise<unknown> }
  ).execute(args);
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? `no-code:${String(e)}`;
  }
  return "NO_ERROR";
};
const link = (h: H, name: string, target: string, kind: "dir" | "file") => {
  try {
    symlinkSync(
      target,
      join(h.root, name),
      kind === "dir" ? "junction" : "file",
    );
    return true;
  } catch {
    return false;
  }
};

test("read inside the workspace is allowed, including a case-variant root", async () => {
  const h = harness();
  writeFileSync(join(h.root, "a.txt"), "one\ntwo\nthree");
  assert.match(String(await run(h, "read", { path: "a.txt" })), /two/);
  assert.match(
    String(await run(h, "read", { path: "a.txt", offset: 2, limit: 1 })),
    /^two/,
  );
  if (win) {
    const upper = join(h.ws.canonicalPath.toUpperCase(), "a.txt");
    assert.match(String(await run(h, "read", { path: upper })), /one/);
  }
});

test("read outside the root is denied without leaking the root", async () => {
  const h = harness();
  writeFileSync(join(h.outside, "s.txt"), "secret");
  const bad = ["..", "../x", "..\\x", h.outside, join(h.outside, "s.txt")];
  if (win)
    bad.push(
      "\\\\server\\share\\x",
      "\\\\.\\C:\\Windows\\win.ini",
      "\\\\?\\C:\\Windows\\win.ini",
      "C:win.ini",
      "CON",
      "a.txt:stream",
      ".. \\x",
    );
  for (const path of bad) {
    const p = run(h, "read", { path });
    const err = await p.then(
      () => undefined,
      (e: { code?: string; message: string }) => e,
    );
    assert.equal(err?.code, "WORKSPACE_ESCAPE", path);
    assert.ok(
      !err.message.toLowerCase().includes(h.ws.canonicalPath.toLowerCase()),
      path,
    );
  }
});

test("symlink and junction escapes are denied for read, ls and write", async (t) => {
  const h = harness();
  writeFileSync(join(h.outside, "s.txt"), "secret");
  assert.ok(link(h, "jn", h.outside, "dir"), "junction creation must work");
  assert.equal(
    await codeOf(run(h, "read", { path: "jn/s.txt" })),
    "WORKSPACE_ESCAPE",
  );
  assert.equal(await codeOf(run(h, "ls", { path: "jn" })), "WORKSPACE_ESCAPE");
  h.grants.approve("fs.write", "jn/new.txt");
  assert.equal(
    await codeOf(run(h, "write", { path: "jn/new.txt", content: "x" })),
    "WORKSPACE_ESCAPE",
  );
  assert.equal(existsSync(join(h.outside, "new.txt")), false);
  if (link(h, "fl", join(h.outside, "s.txt"), "file"))
    assert.equal(
      await codeOf(run(h, "read", { path: "fl" })),
      "WORKSPACE_ESCAPE",
    );
  else t.diagnostic("file symlink not creatable on this host; skipped");
  assert.ok(link(h, "dj", join(h.outside, "nodir"), "dir"));
  h.grants.approve("fs.write", "dj/new.txt");
  assert.equal(
    await codeOf(run(h, "write", { path: "dj/new.txt", content: "x" })),
    "WORKSPACE_ESCAPE",
  );
  assert.equal(existsSync(join(h.outside, "nodir")), false);
  if (link(h, "dangling", join(h.outside, "nope.txt"), "file")) {
    h.grants.approve("fs.write", "dangling");
    assert.equal(
      await codeOf(run(h, "write", { path: "dangling", content: "x" })),
      "WORKSPACE_ESCAPE",
    );
    assert.equal(existsSync(join(h.outside, "nope.txt")), false);
  }
});

test("write without a grant is denied and nothing is written or recorded", async () => {
  const h = harness();
  assert.equal(
    await codeOf(run(h, "write", { path: "w.txt", content: "x" })),
    "GRANT_REQUIRED",
  );
  assert.equal(existsSync(join(h.root, "w.txt")), false);
  assert.equal(h.log.length, 0);
});

test("a once-grant bound to X cannot write Y, and still writes X", async () => {
  const h = harness();
  h.grants.approve("fs.write", "x.txt");
  assert.equal(
    await codeOf(run(h, "write", { path: "y.txt", content: "y" })),
    "GRANT_REQUIRED",
  );
  assert.equal(existsSync(join(h.root, "y.txt")), false);
  assert.equal(h.log.length, 0);
  await run(h, "write", { path: "sub/../x.txt", content: "x" });
  assert.equal(readFileSync(join(h.root, "x.txt"), "utf8"), "x");
});

test("a consumed grant cannot be reused", async () => {
  const h = harness();
  h.grants.approve("fs.write", "x.txt");
  await run(h, "write", { path: "x.txt", content: "one" });
  assert.equal(
    await codeOf(run(h, "write", { path: "x.txt", content: "two" })),
    "GRANT_CONSUMED",
  );
  assert.equal(readFileSync(join(h.root, "x.txt"), "utf8"), "one");
});

test("a revoked grant is denied", async () => {
  const h = harness();
  const id = h.grants.approve("fs.write", "x.txt");
  h.grants.all.find((g) => g.id === id)!.revoked = true;
  assert.equal(
    await codeOf(run(h, "write", { path: "x.txt", content: "x" })),
    "GRANT_REVOKED",
  );
  assert.equal(existsSync(join(h.root, "x.txt")), false);
});

test("a grant consumed concurrently by another caller blocks the effect", async () => {
  const h = harness();
  h.grants.approve("fs.write", "x.txt");
  const consume = h.grants.consume.bind(h.grants);
  h.grants.consume = (id, r) => {
    consume(id, r);
    throw new Error("already consumed");
  };
  assert.equal(
    await codeOf(run(h, "write", { path: "x.txt", content: "x" })),
    "GRANT_CONSUMED",
  );
  assert.equal(existsSync(join(h.root, "x.txt")), false);
  assert.equal(h.log.length, 0);
});

test("edit obeys the same grant rules and applies a unique replacement", async () => {
  const h = harness();
  const file = join(h.root, "e.txt");
  writeFileSync(file, "alpha beta");
  const edits = [{ oldText: "beta", newText: "gamma" }];
  assert.equal(
    await codeOf(run(h, "edit", { path: "e.txt", edits })),
    "GRANT_REQUIRED",
  );
  assert.equal(readFileSync(file, "utf8"), "alpha beta");
  h.grants.approve("fs.write", "other.txt");
  assert.equal(
    await codeOf(run(h, "edit", { path: "e.txt", edits })),
    "GRANT_REQUIRED",
  );
  const id = h.grants.approve("fs.write", "e.txt");
  assert.equal(
    await codeOf(
      run(h, "edit", {
        path: "e.txt",
        edits: [{ oldText: "zzz", newText: "q" }],
      }),
    ),
    "EDIT_NOT_FOUND",
  );
  assert.equal(h.grants.all.find((g) => g.id === id)?.consumed, undefined);
  await run(h, "edit", { path: "e.txt", edits });
  assert.equal(readFileSync(file, "utf8"), "alpha gamma");
  assert.equal(
    await codeOf(
      run(h, "edit", {
        path: "e.txt",
        edits: [{ oldText: "alpha", newText: "a" }],
      }),
    ),
    "GRANT_CONSUMED",
  );
  const rid = h.grants.approve("fs.write", "e.txt");
  h.grants.all.find((g) => g.id === rid)!.revoked = true;
  assert.equal(
    await codeOf(run(h, "edit", { path: "e.txt", edits })),
    "GRANT_REVOKED",
  );
  assert.equal(
    await codeOf(run(h, "edit", { path: "../e.txt", edits })),
    "WORKSPACE_ESCAPE",
  );
  assert.equal(h.log.length, 1);
});

test("ls, find and grep never return or follow paths outside the root", async () => {
  const h = harness();
  writeFileSync(join(h.root, "in.txt"), "needle inside");
  mkdirSync(join(h.root, "d"));
  writeFileSync(join(h.root, "d", "deep.txt"), "needle deep");
  writeFileSync(join(h.outside, "s.txt"), "needle outside");
  assert.ok(link(h, "jn", h.outside, "dir"), "junction creation must work");
  const outputs = [
    String(await run(h, "ls", {})),
    String(await run(h, "find", { pattern: "**/*.txt" })),
    String(await run(h, "grep", { pattern: "needle" })),
  ];
  assert.match(outputs[1]!, /d\/deep\.txt/);
  assert.match(outputs[2]!, /in\.txt:1:needle inside/);
  for (const out of outputs) {
    assert.ok(!out.includes("outside"), out);
    assert.ok(!out.includes("s.txt"), out);
    assert.ok(
      !out.toLowerCase().includes(h.ws.canonicalPath.toLowerCase()),
      out,
    );
  }
  assert.equal(
    await codeOf(run(h, "grep", { pattern: "needle", path: "jn" })),
    "WORKSPACE_ESCAPE",
  );
  assert.equal(
    await codeOf(run(h, "find", { pattern: "*", path: ".." })),
    "WORKSPACE_ESCAPE",
  );
});

const sh = win ? "powershell" : "bash";
const pidCmd = win
  ? "$PID | Out-File pid.txt; Start-Sleep 60"
  : "echo $$ > pid.txt; sleep 60";

test("shell without a grant is denied and nothing runs", async () => {
  const h = harness();
  assert.equal(
    await codeOf(run(h, sh, { command: "echo hi > m.txt" })),
    "GRANT_REQUIRED",
  );
  assert.equal(existsSync(join(h.root, "m.txt")), false);
  assert.equal(h.log.length, 0);
});

test("shell with a grant for the exact command runs in the root; one char off is denied", async () => {
  const h = harness();
  const cmd = win ? "(Get-Location).Path" : "pwd";
  h.grants.approve("shell.run", `${sh}:${cmd}`);
  const out = String(await run(h, sh, { command: cmd }));
  assert.equal(out.trim().toLowerCase(), h.ws.canonicalPath.toLowerCase());
  h.grants.approve("shell.run", `${sh}:${"echo hi > m.txt"}`);
  assert.equal(
    await codeOf(run(h, sh, { command: "echo hi > m.txt " })),
    "GRANT_REQUIRED",
  );
  assert.equal(
    await codeOf(run(h, sh, { command: "echo hi > m.tx" })),
    "GRANT_REQUIRED",
  );
  assert.equal(existsSync(join(h.root, "m.txt")), false);
  assert.equal(h.log.length, 1);
});

test("shell timeout kills the process tree and reports SHELL_TIMEOUT", async () => {
  const h = harness({ timeoutMs: 12000 });
  h.grants.approve("shell.run", `${sh}:${pidCmd}`);
  const started = Date.now();
  assert.equal(await codeOf(run(h, sh, { command: pidCmd })), "SHELL_TIMEOUT");
  assert.ok(Date.now() - started < 30000);
  const pid = Number(
    readFileSync(join(h.root, "pid.txt"), "utf16le")
      .replace(/\0/g, "")
      .trim() || readFileSync(join(h.root, "pid.txt"), "utf8").trim(),
  );
  assert.ok(pid > 0);
  const dead = () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  for (let i = 0; i < 50 && !dead(); i++)
    await new Promise((r) => setTimeout(r, 200));
  assert.ok(dead(), "process tree must be gone");
  assert.equal(h.log.length, 1);
  assert.equal(h.log[0]?.ok, false);
});

const nodeCmd = (js: string) => `node -e "${js}"`;

test("shell output is capped with a truncation marker", async () => {
  const h = harness({ maxOutputBytes: 100 });
  const cmd = nodeCmd("console.log('a'.repeat(5000))");
  h.grants.approve("shell.run", `${sh}:${cmd}`);
  const out = String(await run(h, sh, { command: cmd }));
  assert.match(out, /\[output truncated\]/);
  assert.ok(out.length < 300, String(out.length));
});

test("secret-looking env vars never reach the child", async () => {
  const h = harness();
  process.env.SPLYCE_TEST_API_KEY = "sekret";
  process.env.SPLYCE_TEST_DB_PASSWORD = "sekret";
  const cmd = nodeCmd(
    "console.log([process.env.SPLYCE_TEST_API_KEY, process.env.SPLYCE_TEST_DB_PASSWORD, typeof process.env.PATH].join(','))",
  );
  h.grants.approve("shell.run", `${sh}:${cmd}`);
  try {
    assert.equal(String(await run(h, sh, { command: cmd })).trim(), ",,string");
  } finally {
    delete process.env.SPLYCE_TEST_API_KEY;
    delete process.env.SPLYCE_TEST_DB_PASSWORD;
  }
});

test("exactly one receipt per effect and none on denial", async () => {
  const h = harness();
  h.grants.approve("fs.write", "a.txt");
  await run(h, "write", { path: "a.txt", content: "x" });
  await codeOf(run(h, "write", { path: "a.txt", content: "y" }));
  await codeOf(run(h, "read", { path: "../a.txt" }));
  await run(h, "read", { path: "a.txt" });
  assert.deepEqual(
    h.log.map((r) => [
      r.capability,
      r.workspaceId,
      r.sessionId,
      r.target,
      r.ok,
    ]),
    [["fs.write", "w1", "s1", "a.txt", true]],
  );
  const cmd = "echo hi";
  h.grants.approve("shell.run", `${sh}:${cmd}`);
  await run(h, sh, { command: cmd });
  assert.equal(h.log.length, 2);
  assert.equal(h.log[1]?.capability, "shell.run");
});

test("a changed workspace revision or an unknown workspace is refused", async () => {
  const h = harness();
  writeFileSync(join(h.root, "a.txt"), "x");
  h.ws.revision = 2;
  assert.equal(
    await codeOf(run(h, "read", { path: "a.txt" })),
    "STALE_REVISION",
  );
  const gone = harness();
  assert.throws(
    () =>
      createWorkspaceTools({
        workspaces: { workspace: () => undefined },
        grants: gone.grants,
        receipts: { record: () => "r" },
        sessionId: "s1",
        workspaceId: "nope",
      }),
    { code: "WORKSPACE_UNKNOWN" },
  );
});

test("grant checks and receipts carry the action id and a canonical argument digest; session write grants are refused", async () => {
  const h = harness();
  const seen: { actionId: string; argumentsDigest: string }[] = [];
  const check = h.grants.check.bind(h.grants);
  h.grants.check = (r) => (seen.push(r), check(r));
  h.grants.approve("fs.write", "a.txt");
  const exec = (
    h.tools.write as {
      execute(a: object, s?: AbortSignal, id?: string): Promise<unknown>;
    }
  ).execute;
  await exec({ path: "a.txt", content: "x" }, undefined, "call-1");
  await codeOf(exec({ path: "b.txt", content: "x" }, undefined, "call-2"));
  await codeOf(exec({ content: "x", path: "b.txt" }, undefined, "call-3"));
  assert.equal(h.log[0]?.actionId, "call-1");
  assert.match(h.log[0]!.argumentsDigest, /^[0-9a-f]{64}$/);
  const d = (id: string) =>
    seen.find((x) => x.actionId === id)?.argumentsDigest;
  assert.equal(d("call-2"), d("call-3"));
  assert.notEqual(d("call-1"), d("call-2"));
  h.grants.all.push({ id: "gs", cap: "fs.write", scope: "session" });
  assert.equal(
    await codeOf(run(h, "write", { path: "c.txt", content: "x" })),
    "GRANT_REQUIRED",
  );
  assert.equal(existsSync(join(h.root, "c.txt")), false);
});

test("a capped shell run writes no raw output spill file", async () => {
  const h = harness({ maxOutputBytes: 100 });
  const cmd = nodeCmd("console.log('SPILLMARK'.repeat(20000))");
  h.grants.approve("shell.run", `${sh}:${cmd}`);
  const started = Date.now() - 1000;
  await run(h, sh, { command: cmd });
  assert.deepEqual(readdirSync(h.root), []);
  for (const f of readdirSync(tmpdir())) {
    try {
      const p = join(tmpdir(), f);
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs >= started && st.size > 4000)
        assert.ok(!readFileSync(p, "utf8").includes("SPILLMARK"), f);
    } catch (e) {
      if ((e as Error).name === "AssertionError") throw e;
    }
  }
});

test("a directory swapped for a link after the grant is consumed cannot redirect write or edit", async () => {
  for (const tool of ["write", "edit"]) {
    const h = harness();
    mkdirSync(join(h.root, "sub"));
    writeFileSync(join(h.root, "sub", "f.txt"), "old");
    h.grants.approve("fs.write", "sub/f.txt");
    const consume = h.grants.consume.bind(h.grants);
    h.grants.consume = (id, r) => {
      consume(id, r);
      rmSync(join(h.root, "sub"), { recursive: true });
      symlinkSync(h.outside, join(h.root, "sub"), "junction");
    };
    const args =
      tool === "write"
        ? { path: "sub/f.txt", content: "new" }
        : { path: "sub/f.txt", edits: [{ oldText: "old", newText: "new" }] };
    assert.equal(await codeOf(run(h, tool, args)), "WORKSPACE_ESCAPE", tool);
    assert.deepEqual(readdirSync(h.outside), [], tool);
    assert.equal(h.log.length, 1);
    assert.equal(h.log[0]?.ok, false);
  }
});

test("a shell grant is bound to the interpreter as well as the command", async () => {
  const h = harness();
  h.grants.approve("shell.run", `${sh}:echo hi > m.txt`);
  const other = win ? "bash" : "powershell";
  assert.equal(
    await codeOf(run(h, other, { command: "echo hi > m.txt" })),
    "GRANT_REQUIRED",
  );
  assert.equal(existsSync(join(h.root, "m.txt")), false);
  const bare = harness();
  bare.grants.approve("shell.run", "echo hi > m.txt");
  assert.equal(
    await codeOf(run(bare, sh, { command: "echo hi > m.txt" })),
    "GRANT_REQUIRED",
  );
  assert.equal(existsSync(join(bare.root, "m.txt")), false);
  assert.equal(h.log.length, 0);
});

test("grep rejects over-long patterns and nested unbounded quantifiers", async () => {
  const h = harness();
  writeFileSync(join(h.root, "a.txt"), `${"a".repeat(40)}!`);
  for (const pattern of [
    "a".repeat(257),
    "(a+)+$",
    "(.*)*x",
    "(\\w+\\s*)*z",
    "(a{1,})+b",
  ])
    assert.equal(
      await codeOf(run(h, "grep", { pattern })),
      "PATTERN_REJECTED",
      pattern.slice(0, 12),
    );
  assert.match(String(await run(h, "grep", { pattern: "(a)+!" })), /a\.txt:1:/);
  assert.match(
    String(await run(h, "grep", { pattern: "(a+)+", literal: true })),
    /^$/,
  );
});

test("grep stops at a scanned-bytes budget and at a time budget", async () => {
  const h = harness();
  const chunk = "x".repeat(900_000);
  for (let i = 0; i < 12; i++)
    writeFileSync(join(h.root, `big${String(i)}.txt`), chunk);
  assert.equal(
    await codeOf(run(h, "grep", { pattern: "needle" })),
    "GREP_BUDGET",
  );
  const t = harness({ timeoutMs: 1, maxOutputBytes: 1 << 20 });
  writeFileSync(join(t.root, "many.txt"), "line\n".repeat(150_000));
  assert.equal(
    await codeOf(run(t, "grep", { pattern: "needle" })),
    "GREP_BUDGET",
  );
});

// Windows confine regressions: each name is one guard in confine().
const denied = async (h: H, paths: string[], tool = "read") => {
  for (const path of paths)
    assert.equal(
      await codeOf(run(h, tool, { path })),
      "WORKSPACE_ESCAPE",
      JSON.stringify(path),
    );
};
const winOnly = { skip: win ? false : "Windows path semantics only" };

test(
  "windows device names are denied, also with an extension or in a subdirectory",
  winOnly,
  async () => {
    const h = harness();
    mkdirSync(join(h.root, "sub"));
    const names = ["CON", "NUL", "PRN", "AUX", "COM1", "LPT1", "nul", "Com9"];
    await denied(h, [
      ...names,
      ...names.map((n) => `${n}.txt`),
      ...names.map((n) => `sub/${n}.log`),
    ]);
    await denied(h, ["NUL.txt", "CON"], "ls");
    h.grants.approve("fs.write", "NUL.txt");
    assert.equal(
      await codeOf(run(h, "write", { path: "NUL.txt", content: "x" })),
      "WORKSPACE_ESCAPE",
    );
    assert.equal(h.log.length, 0);
  },
);

test("windows alternate data streams are denied", winOnly, async () => {
  const h = harness();
  writeFileSync(join(h.root, "foo.txt"), "plain");
  await denied(h, ["foo.txt:stream", "foo.txt:stream:$DATA", "foo.txt::$DATA"]);
  h.grants.approve("fs.write", "foo.txt:stream");
  assert.equal(
    await codeOf(run(h, "write", { path: "foo.txt:stream", content: "x" })),
    "WORKSPACE_ESCAPE",
  );
  assert.equal(readFileSync(join(h.root, "foo.txt"), "utf8"), "plain");
});

test(
  "windows extended-length, device-namespace and UNC prefixes are denied, even when they name the root",
  winOnly,
  async () => {
    const h = harness();
    const inside = join(h.ws.canonicalPath, "a.txt");
    writeFileSync(inside, "x");
    await denied(h, [
      `\\\\?\\${inside}`,
      `\\\\.\\${inside}`,
      "\\\\?\\C:\\Windows\\win.ini",
      "\\\\.\\C:\\Windows\\win.ini",
      "\\\\?\\UNC\\server\\share\\x",
      "\\\\server\\share",
      "\\\\server\\share\\x",
      "//server/share/x",
      "C:a.txt",
    ]);
  },
);

test("windows trailing dot and space names are denied", winOnly, async () => {
  const h = harness();
  writeFileSync(join(h.root, "a.txt"), "x");
  mkdirSync(join(h.root, "d"));
  await denied(h, ["a.txt.", "a.txt ", "d.", "d /x", "d\\x. ", "d/a. "]);
  h.grants.approve("fs.write", "a.txt.");
  assert.equal(
    await codeOf(run(h, "write", { path: "a.txt.", content: "y" })),
    "WORKSPACE_ESCAPE",
  );
  assert.equal(readFileSync(join(h.root, "a.txt"), "utf8"), "x");
});

test("a NUL byte in a path is denied for every path tool", async () => {
  const h = harness();
  writeFileSync(join(h.root, "a.txt"), "x");
  for (const tool of ["read", "ls", "find", "grep"])
    assert.equal(
      await codeOf(run(h, tool, { path: "a.txt\0.png", pattern: "x" })),
      "WORKSPACE_ESCAPE",
      tool,
    );
  h.grants.approve("fs.write", "a.txt");
  assert.equal(
    await codeOf(run(h, "write", { path: "a.txt\0.png", content: "y" })),
    "WORKSPACE_ESCAPE",
  );
  assert.equal(readFileSync(join(h.root, "a.txt"), "utf8"), "x");
});

// 8.3 alias of `full` inside dir, read from `cmd /c dir /x`; undefined if the volume has none.
const shortName = (dir: string, full: string): string | undefined => {
  const r = spawnSync("cmd", ["/c", "dir", "/x", "/a"], {
    cwd: dir,
    encoding: "utf8",
  });
  for (const line of r.stdout.split(/\r?\n/)) {
    const at = line.indexOf(` ${full}`);
    const short =
      at < 0 ? "" : (line.slice(0, at).trim().split(/\s+/).pop() ?? "");
    if (short.includes("~")) return short;
  }
  return undefined;
};

test("a windows 8.3 alias is judged by where it points", winOnly, async (t) => {
  const h = harness();
  mkdirSync(join(h.root, "long_inside_directory"));
  writeFileSync(join(h.root, "long_inside_directory", "in.txt"), "inside");
  writeFileSync(join(h.outside, "long_secret_file.txt"), "secret");
  assert.ok(link(h, "long_escape_junction", h.outside, "dir"));
  const ok = shortName(h.root, "long_inside_directory");
  const bad = shortName(h.root, "long_escape_junction");
  if (!ok || !bad) return t.skip("8.3 short names are disabled on this volume");
  assert.match(
    String(await run(h, "read", { path: `${ok}/in.txt` })),
    /inside/,
  );
  assert.equal(
    await codeOf(run(h, "read", { path: `${bad}/long_secret_file.txt` })),
    "WORKSPACE_ESCAPE",
  );
  assert.equal(await codeOf(run(h, "ls", { path: bad })), "WORKSPACE_ESCAPE");
});

type Summary = {
  exitCode?: number | null;
  durationMs: number;
  bytes: number;
  truncated: boolean;
  preview?: string;
};
const result = (h: H, name: string, args: object) =>
  (
    h.tools[name] as {
      result(a: object): Promise<{ text: string; summary: Summary }>;
    }
  ).result(args);
const approveSh = (h: H, cmd: string) =>
  h.grants.approve("shell.run", `${sh}:${cmd}`);

test("shell summary reports exit code, raw bytes, duration and preview", async () => {
  const h = harness();
  const ok = nodeCmd("process.stdout.write('hello')");
  approveSh(h, ok);
  const r = await result(h, sh, { command: ok });
  assert.deepEqual(
    { ...r.summary, durationMs: 0 },
    {
      exitCode: 0,
      durationMs: 0,
      bytes: 5,
      truncated: false,
      preview: "hello",
    },
  );
  assert.ok(
    Number.isInteger(r.summary.durationMs) && r.summary.durationMs >= 0,
  );
  assert.equal(r.text, "hello");
  const bad = `${nodeCmd("process.stdout.write('x'),process.exitCode=3")}${win ? "; exit $LASTEXITCODE" : ""}`;
  approveSh(h, bad);
  const f = await result(h, sh, { command: bad });
  assert.equal(f.summary.exitCode, 3);
  assert.match(f.text, /\[exit code 3\]/);
  assert.equal(f.summary.bytes, 1);
  assert.equal(h.log[1]?.ok, false);
});

test("shell summary: capped output keeps the raw size and truncated true; preview is at most 2048 chars", async () => {
  const h = harness({ maxOutputBytes: 5000 });
  const big = nodeCmd(
    "process.stdout.write(Array.from({length:900},(_,i)=>'line '+i).join('\\n')),setTimeout(process.stdout.write.bind(process.stdout,'\\n'+'b'.repeat(500)),300)",
  );
  approveSh(h, big);
  const r = await result(h, sh, { command: big });
  const first = Array.from({ length: 900 }, (_, i) => `line ${String(i)}`);
  assert.equal(r.summary.bytes, Buffer.byteLength(first.join("\n")) + 501);
  assert.equal(r.summary.truncated, true);
  assert.equal(r.summary.preview.length, 2048);
  assert.ok(r.text.length < 5100);
});

test("a killed shell command reports exitCode null on the error", async () => {
  const h = harness();
  const cmd = win
    ? "Write-Output started; Start-Sleep 30"
    : "echo started; sleep 30";
  approveSh(h, cmd);
  const err = await (h.tools[sh] as { execute(a: object): Promise<unknown> })
    .execute({ command: cmd, timeout: 3 })
    .then(
      () => undefined,
      (e: { code: string; summary?: Summary }) => e,
    );
  assert.equal(err?.code, "SHELL_TIMEOUT");
  assert.equal(err.summary?.exitCode, null);
  assert.equal(err.summary.truncated, false);
  assert.ok(err.summary.durationMs >= 2500, String(err.summary.durationMs));
  await new Promise((r) => setTimeout(r, 1000));
});

test("read, ls, find, grep, write and edit carry a summary without an exit code", async () => {
  const h = harness({ maxOutputBytes: 30 });
  writeFileSync(join(h.root, "a.txt"), "one\ntwo\nthree");
  writeFileSync(join(h.root, "long.txt"), `${"x".repeat(100)}\nneedle`);
  const read = await result(h, "read", { path: "a.txt" });
  assert.deepEqual(
    { ...read.summary, durationMs: 0 },
    { durationMs: 0, bytes: 13, truncated: false, preview: "one\ntwo\nthree" },
  );
  const cut = await result(h, "read", { path: "long.txt" });
  assert.equal(cut.summary.bytes, 107);
  assert.equal(cut.summary.truncated, true);
  assert.match(cut.text, /\[output truncated\]/);
  const ls = await result(h, "ls", {});
  assert.deepEqual([ls.summary.bytes, ls.summary.truncated], [14, false]);
  const find = await result(h, "find", { pattern: "a.*" });
  assert.deepEqual([find.summary.bytes, find.summary.truncated], [5, false]);
  const grep = await result(h, "grep", { pattern: "two" });
  assert.deepEqual([grep.summary.bytes, grep.summary.truncated], [11, false]);
  h.grants.approve("fs.write", "w.txt");
  const w = await result(h, "write", { path: "w.txt", content: "héllo" });
  assert.deepEqual([w.summary.bytes, w.summary.truncated], [6, false]);
  h.grants.approve("fs.write", "w.txt");
  const e = await result(h, "edit", {
    path: "w.txt",
    edits: [{ oldText: "llo", newText: "llo!" }],
  });
  assert.deepEqual([e.summary.bytes, e.summary.truncated], [7, false]);
  for (const r of [read, cut, ls, find, grep, w, e])
    assert.equal("exitCode" in r.summary, false);
  assert.equal(await run(h, "read", { path: "a.txt" }), "one\ntwo\nthree");
});

// Tier-1 review of #155 (b1a157a): each case failed on that revision.
const GREP_STOPPED = ["GREP_BUDGET", "PATTERN_REJECTED"];

test("grep stops catastrophic patterns that pass the nested-quantifier filter within a second", async () => {
  const h = harness();
  writeFileSync(join(h.root, "a.txt"), `${"a".repeat(40)}!`);
  for (const pattern of ["((a+))+$", "(a|aa)+$", "((a)+)+$", "(a+){1,99}$"]) {
    const started = Date.now();
    const code = await codeOf(run(h, "grep", { pattern }));
    assert.ok(GREP_STOPPED.includes(code), `${pattern}: ${code}`);
    assert.ok(
      Date.now() - started < 1500,
      `${pattern}: ${String(Date.now() - started)}ms`,
    );
  }
  assert.match(String(await run(h, "grep", { pattern: "a+!" })), /a\.txt:1:/);
});

test("grep and find honour an abort signal, including in the middle of a stuck match", async () => {
  const h = harness();
  writeFileSync(join(h.root, "a.txt"), `${"a".repeat(40)}!`);
  const exec = (name: string, args: object, s: AbortSignal) =>
    (
      h.tools[name] as {
        execute(a: object, s: AbortSignal): Promise<unknown>;
      }
    ).execute(args, s);
  const done = AbortSignal.abort();
  assert.equal(await codeOf(exec("grep", { pattern: "a" }, done)), "ABORTED");
  assert.equal(await codeOf(exec("find", { pattern: "*" }, done)), "ABORTED");
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  const started = Date.now();
  assert.equal(
    await codeOf(exec("grep", { pattern: "(a|aa)+$" }, ctl.signal)),
    "ABORTED",
  );
  assert.ok(Date.now() - started < 1000);
});

test("a granted write never modifies a file outside the root that is hard-linked into it", async () => {
  for (const tool of ["write", "edit"]) {
    const h = harness();
    writeFileSync(join(h.outside, "victim.txt"), "orig");
    linkSync(join(h.outside, "victim.txt"), join(h.root, "hl.txt"));
    h.grants.approve("fs.write", "hl.txt");
    await run(
      h,
      tool,
      tool === "write"
        ? { path: "hl.txt", content: "PWNED" }
        : { path: "hl.txt", edits: [{ oldText: "orig", newText: "PWNED" }] },
    );
    assert.equal(
      readFileSync(join(h.outside, "victim.txt"), "utf8"),
      "orig",
      tool,
    );
    assert.equal(readFileSync(join(h.root, "hl.txt"), "utf8"), "PWNED", tool);
    assert.deepEqual(
      readdirSync(h.root),
      ["hl.txt"],
      `${tool}: no temp file left`,
    );
  }
});

test("a directory swapped for a junction before mkdir cannot make a directory outside the root", async () => {
  const h = harness();
  mkdirSync(join(h.root, "sub"));
  h.grants.approve("fs.write", "sub/newdir/f.txt");
  const consume = h.grants.consume.bind(h.grants);
  h.grants.consume = (id, r) => {
    consume(id, r);
    rmSync(join(h.root, "sub"), { recursive: true });
    symlinkSync(h.outside, join(h.root, "sub"), "junction");
  };
  assert.equal(
    await codeOf(run(h, "write", { path: "sub/newdir/f.txt", content: "x" })),
    "WORKSPACE_ESCAPE",
  );
  assert.deepEqual(readdirSync(h.outside), []);
});

test("a receipt store failure after a real write is RECEIPT_FAILED, not a false failed receipt or a raw error", async () => {
  const h = harness();
  const seen: boolean[] = [];
  h.receipts.record = (e) => {
    seen.push(e.ok);
    throw new Error("store down");
  };
  h.grants.approve("fs.write", "f.txt");
  const err = await run(h, "write", { path: "f.txt", content: "x" }).then(
    () => undefined,
    (e: { code?: string; message: string }) => e,
  );
  assert.equal(err?.code, "RECEIPT_FAILED");
  assert.match(err.message, /may have happened/);
  assert.equal(readFileSync(join(h.root, "f.txt"), "utf8"), "x");
  assert.deepEqual(seen, [true]);
});

test("edit matches CRLF and BOM files with LF text and writes the original line endings back", async () => {
  const h = harness();
  writeFileSync(join(h.root, "c.txt"), "﻿line1\r\nline2\r\nline3\r\n");
  h.grants.approve("fs.write", "c.txt");
  await run(h, "edit", {
    path: "c.txt",
    edits: [{ oldText: "line1\nline2", newText: "X\nY" }],
  });
  assert.equal(
    readFileSync(join(h.root, "c.txt"), "utf8"),
    "﻿X\r\nY\r\nline3\r\n",
  );
  writeFileSync(join(h.root, "lf.txt"), "a\nb\n");
  h.grants.approve("fs.write", "lf.txt");
  await run(h, "edit", {
    path: "lf.txt",
    edits: [{ oldText: "a\nb", newText: "c" }],
  });
  assert.equal(readFileSync(join(h.root, "lf.txt"), "utf8"), "c\n");
});

test("edits match the original text, overlaps and empty edits are BAD_ARGS, and nothing is consumed on rejection", async () => {
  const h = harness();
  const file = join(h.root, "s.txt");
  writeFileSync(file, "foo bar");
  const id = h.grants.approve("fs.write", "s.txt");
  const edit = (edits: object[]) => run(h, "edit", { path: "s.txt", edits });
  assert.equal(
    await codeOf(
      edit([
        { oldText: "foo", newText: "baz" },
        { oldText: "baz bar", newText: "Z" },
      ]),
    ),
    "EDIT_NOT_FOUND",
  );
  assert.equal(
    await codeOf(
      edit([
        { oldText: "foo b", newText: "1" },
        { oldText: "o ba", newText: "2" },
      ]),
    ),
    "BAD_ARGS",
  );
  assert.equal(await codeOf(edit([])), "BAD_ARGS");
  assert.equal(await codeOf(edit([{ oldText: "", newText: "x" }])), "BAD_ARGS");
  assert.equal(readFileSync(file, "utf8"), "foo bar");
  assert.equal(h.grants.all.find((g) => g.id === id)?.consumed, undefined);
  await edit([
    { oldText: "bar", newText: "foo" },
    { oldText: "foo ", newText: "" },
  ]);
  assert.equal(readFileSync(file, "utf8"), "foo");
});

test("grep reports files it skipped for size instead of silently ignoring them", async () => {
  const h = harness();
  writeFileSync(join(h.root, "huge.txt"), `needle${"x".repeat(1 << 20)}`);
  writeFileSync(join(h.root, "small.txt"), "needle");
  const r = await (
    h.tools.grep as {
      result(a: object): Promise<{ text: string; skipped?: number }>;
    }
  ).result({ pattern: "needle" });
  assert.equal(r.skipped, 1);
  assert.match(r.text, /small\.txt:1:needle/);
  assert.match(r.text, /\[skipped 1 file\(s\) over 1 MiB\]/);
});

test("more windows device spellings are denied", winOnly, async () => {
  await denied(harness(), [
    "COM¹",
    "LPT².txt",
    "CONIN$",
    "CONOUT$",
    "sub/conin$.x",
  ]);
});

// Redaction: nothing that looks like a credential may reach summary.preview
// (ledger and renderer) or an error message, whatever tool produced it.
const PLANTED = [
  "OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234567890",
  "password=hunter2",
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
  "GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "AWS=AKIAABCDEFGHIJKLMNOP",
  "SLACK=xoxb-123456789012-abcdefghij",
  "JWT=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
  "harmless=value",
].join("\n");
const SECRETS = [
  "sk-proj-abcdefghijklmnop",
  "hunter2",
  "abcdefghijklmnopqrstuvwxyz0123",
  "ghp_abcdefgh",
  "AKIAABCDEFGHIJKLMNOP",
  "xoxb-123456789012",
  "eyJhbGciOiJIUzI1NiJ9",
  "MIIEvQIBADANBgkqhkiG9w0",
];
const clean = (s: string | undefined, what: string) => {
  assert.equal(typeof s, "string", what);
  for (const secret of SECRETS)
    assert.ok(!s?.includes(secret), `${what} leaked ${secret}`);
};
const dotenv = (h: H) => writeFileSync(join(h.root, ".env"), PLANTED);

test("a planted .env is redacted in the preview of read, grep and shell output", async () => {
  const h = harness();
  dotenv(h);
  const read = await result(h, "read", { path: ".env" });
  clean(read.summary.preview, "read preview");
  assert.match(read.summary.preview ?? "", /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(read.summary.preview ?? "", /harmless=value/);
  assert.match(
    read.text,
    /hunter2/,
    "the model's own read text is not rewritten",
  );
  const grep = await result(h, "grep", { pattern: "=" });
  clean(grep.summary.preview, "grep preview");
  assert.match(grep.summary.preview ?? "", /harmless=value/);
  const cmd = win ? "Get-Content .env" : "cat .env";
  approveSh(h, cmd);
  const shell = await result(h, sh, { command: cmd });
  clean(shell.summary.preview, "shell preview");
  assert.match(shell.summary.preview ?? "", /harmless=value/);
});

test("a secret that straddles the 2048-character preview edge is still redacted", async () => {
  const h = harness();
  writeFileSync(
    join(h.root, "edge.txt"),
    `${"x".repeat(2030)}\npassword=hunter2`,
  );
  const r = await result(h, "read", { path: "edge.txt" });
  assert.ok(!(r.summary.preview ?? "").includes("hunter"));
  assert.ok((r.summary.preview ?? "").length <= 2048);
});

test("the injected redactor runs after the built-in scrub and a redactor that throws omits the preview", async () => {
  const seen: string[] = [];
  const h = harness(undefined, (text) => {
    seen.push(text);
    return text.replace(/harmless/g, "[HIDDEN]");
  });
  dotenv(h);
  const r = await result(h, "read", { path: ".env" });
  assert.match(r.summary.preview ?? "", /\[HIDDEN\]=value/);
  clean(r.summary.preview, "preview");
  clean(seen.join("\n"), "text handed to the injected redactor");
  const bad = harness(undefined, () => {
    throw new Error("redactor down");
  });
  dotenv(bad);
  const out = await result(bad, "read", { path: ".env" });
  assert.equal("preview" in out.summary, false);
  assert.ok(!JSON.stringify(out.summary).includes("hunter2"));
  assert.equal(out.summary.bytes, Buffer.byteLength(PLANTED));
});

test("error messages never carry a secret from the command or path, even when the redactor throws", async () => {
  const cmd = `echo Bearer abcdefghijklmnopqrstuvwxyz0123 password=hunter2`;
  for (const redact of [
    undefined,
    () => {
      throw new Error("down");
    },
  ]) {
    const h = harness(undefined, redact);
    const err = await run(h, sh, { command: cmd }).then(
      () => undefined,
      (e: { code?: string; message: string }) => e,
    );
    assert.equal(err?.code, "GRANT_REQUIRED");
    clean(err.message, "error message");
  }
});

// Fix-forward on the #155 re-review.
test("the grep worker really exits after the budget: no CPU is burned once the call has failed", async () => {
  const h = harness();
  writeFileSync(join(h.root, "a.txt"), `${"a".repeat(40)}!`);
  assert.ok(
    GREP_STOPPED.includes(
      await codeOf(run(h, "grep", { pattern: "(a|aa)+$" })),
    ),
  );
  const before = process.cpuUsage();
  await new Promise((r) => setTimeout(r, 1200));
  const used = process.cpuUsage(before);
  assert.ok(
    (used.user + used.system) / 1000 < 500,
    `${String((used.user + used.system) / 1000)}ms of CPU in 1.2s idle`,
  );
});

test("a directory swapped for a junction after the first mkdir is caught before the next one", async () => {
  const h = harness();
  mkdirSync(join(h.root, "sub"));
  mkdirSync(join(h.outside, "a"));
  h.grants.approve("fs.write", "sub/a/b/f.txt");
  const workspace = h.workspaces.workspace.bind(h.workspaces);
  let swapped = false;
  h.workspaces.workspace = (id) => {
    if (!swapped && existsSync(join(h.root, "sub", "a"))) {
      swapped = true;
      rmSync(join(h.root, "sub"), { recursive: true });
      symlinkSync(h.outside, join(h.root, "sub"), "junction");
    }
    return workspace(id);
  };
  assert.equal(
    await codeOf(run(h, "write", { path: "sub/a/b/f.txt", content: "x" })),
    "WORKSPACE_ESCAPE",
  );
  assert.ok(swapped, "the swap must have happened after the first mkdir");
  assert.deepEqual(readdirSync(join(h.outside, "a")), []);
});

test("edit on a file with mixed line endings matches exactly and leaves the other lines alone", async () => {
  const h = harness();
  const file = join(h.root, "m.txt");
  writeFileSync(file, "a\r\nb\nc\r\n");
  h.grants.approve("fs.write", "m.txt");
  await run(h, "edit", {
    path: "m.txt",
    edits: [{ oldText: "b", newText: "B" }],
  });
  assert.equal(readFileSync(file, "utf8"), "a\r\nB\nc\r\n");
  h.grants.approve("fs.write", "m.txt");
  assert.equal(
    await codeOf(
      run(h, "edit", {
        path: "m.txt",
        edits: [{ oldText: "a\nB", newText: "x" }],
      }),
    ),
    "EDIT_NOT_FOUND",
  );
  assert.equal(readFileSync(file, "utf8"), "a\r\nB\nc\r\n");
});

test("worker start-up time does not count against the grep budget, even with every core busy", async () => {
  const h = harness();
  writeFileSync(join(h.root, "a.txt"), "needle");
  const burners = Array.from(
    { length: cpus().length * 2 },
    () => new Worker("while (true) {}", { eval: true }),
  );
  try {
    for (let i = 0; i < 4; i++)
      assert.match(
        String(await run(h, "grep", { pattern: "needle" })),
        /a\.txt:1:needle/,
      );
  } finally {
    await Promise.all(burners.map((b) => b.terminate()));
  }
});

const readOut = nodeCmd(
  "process.stdout.write(require('fs').readFileSync('out.txt','utf8'))",
);

test("shell returns compacted text to the model, the raw output beside it and the raw size in the summary", async () => {
  const h = harness();
  const noisy = [
    ...Array.from(
      { length: 400 },
      (_, i) => `   \u001b[32mCompiling\u001b[0m crate-${String(i)} v0.1.0`,
    ),
    "error[E0425]: cannot find value `x` in this scope",
    "progress 10%\rprogress 100%",
    "",
  ].join("\n");
  writeFileSync(join(h.root, "out.txt"), noisy);
  approveSh(h, readOut);
  const r = (await (
    h.tools[sh] as {
      result(
        a: object,
      ): Promise<{ text: string; raw: string; summary: Summary }>;
    }
  ).result({ command: readOut })) as {
    text: string;
    raw: string;
    summary: Summary;
  };
  assert.ok(r.raw.includes("crate-399") && r.raw.includes("\u001b[32m"));
  assert.ok(!r.text.includes("\u001b"));
  assert.match(r.text, /error\[E0425\]: cannot find value `x`/);
  assert.match(r.text, /progress 100%/);
  assert.ok(!r.text.includes("progress 10%"));
  assert.ok(
    r.text.length * 3 < r.raw.length,
    `${String(r.text.length)}/${String(r.raw.length)}`,
  );
  assert.equal(r.summary.bytes, Buffer.byteLength(noisy));
  assert.equal(r.summary.truncated, true);
  assert.equal(r.summary.exitCode, 0);
  assert.equal(r.summary.preview, r.text.slice(0, 2048));
});

test("the compaction budget is a per-call limit and short output passes through untouched", async () => {
  const h = harness({ compactBytes: 600 });
  const lines = Array.from({ length: 300 }, (_, i) => `row ${String(i)}`);
  writeFileSync(join(h.root, "out.txt"), lines.join("\n"));
  approveSh(h, readOut);
  const cut = await result(h, sh, { command: readOut });
  assert.ok(cut.text.length <= 600, String(cut.text.length));
  assert.match(cut.text, /\[… \d+ lines elided\]/);
  assert.equal(cut.summary.truncated, true);
  const cmd = nodeCmd("process.stdout.write('a'+String.fromCharCode(10)+'b')");
  approveSh(h, cmd);
  const short = await result(h, sh, { command: cmd });
  assert.equal(short.text, "a\nb");
  assert.equal(short.summary.truncated, false);
});

test("compaction does not change what the child can see: secret env never reaches raw or compacted text", async () => {
  const h = harness();
  process.env.SPLYCE_TEST_API_KEY = "sekret-value";
  const cmd = nodeCmd("process.stdout.write(JSON.stringify(process.env))");
  approveSh(h, cmd);
  try {
    const r = (await (
      h.tools[sh] as {
        result(a: object): Promise<{ text: string; raw: string }>;
      }
    ).result({ command: cmd })) as { text: string; raw: string };
    assert.ok(
      !r.raw.includes("sekret-value") && !r.text.includes("sekret-value"),
    );
    assert.match(r.raw, /PATH|Path/);
  } finally {
    delete process.env.SPLYCE_TEST_API_KEY;
  }
});

test("the compacted shell text is redacted too; raw stays the caller's, and a failing redactor withholds the text", async () => {
  const cmd = win ? "Get-Content .env" : "cat .env";
  const h = harness();
  dotenv(h);
  approveSh(h, cmd);
  const r = (await (
    h.tools[sh] as {
      result(
        a: object,
      ): Promise<{ text: string; raw: string; summary: Summary }>;
    }
  ).result({ command: cmd })) as {
    text: string;
    raw: string;
    summary: Summary;
  };
  clean(r.text, "shell text");
  clean(r.summary.preview, "shell preview");
  assert.match(r.text, /harmless=value/);
  assert.match(r.raw, /hunter2/);
  const bad = harness(undefined, () => {
    throw new Error("down");
  });
  dotenv(bad);
  approveSh(bad, cmd);
  const w = (await (
    bad.tools[sh] as {
      result(a: object): Promise<{ text: string; summary: Summary }>;
    }
  ).result({ command: cmd })) as { text: string; summary: Summary };
  assert.match(w.text, /withheld/);
  clean(w.text, "withheld text");
  assert.equal("preview" in w.summary, false);
});
