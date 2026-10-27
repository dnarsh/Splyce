// Shell output compaction: fixtures mimic real tool output; every error line must survive.

import assert from "node:assert/strict";
import test from "node:test";
import { compact } from "../../packages/splyce-pi/dist/shell-compaction.js";

const n = (count: number, f: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => f(i));
const size = (s: string) => new TextEncoder().encode(s).length;
const ESC = "\u001b";
const ERR = /error|fail|panic|exception|traceback|warning: |✖|FAILED/i;

const fixtures: Record<string, { text: string; ratio: boolean }> = {
  "cargo build with errors": {
    ratio: true,
    text: [
      ...n(
        400,
        (i) =>
          `   ${ESC}[1m${ESC}[32mCompiling${ESC}[0m crate-${String(i)} v0.${String(i)}.0`,
      ),
      "error[E0425]: cannot find value `x` in this scope",
      " --> src/main.rs:4:13",
      'error: could not compile `app` (bin "app") due to 1 previous error',
      "warning: unused variable: `y`",
    ].join("\n"),
  },
  "npm install": {
    ratio: true,
    text: [
      ...n(
        300,
        (i) =>
          `npm http fetch GET 200 https://registry.npmjs.org/pkg-${String(i)} ${String(i)}ms`,
      ),
      "npm warn deprecated inflight@1.0.6: not supported",
      "npm warn deprecated glob@7.2.3: old",
      "npm warn deprecated rimraf@3.0.2: old",
      "added 312 packages in 14s",
      "npm error code ERESOLVE",
      "npm error ERESOLVE could not resolve",
    ].join("\n"),
  },
  "npm test": {
    ratio: true,
    text: [
      ...n(500, (i) => `  ✓ handles case number ${String(i)} (2 ms)`),
      "  ✖ rejects a bad token",
      "    AssertionError: expected 401 to equal 200",
      "Tests: 1 failed, 500 passed",
    ].join("\n"),
  },
  "pytest failures": {
    ratio: true,
    text: [
      "============ test session starts ============",
      ...n(
        200,
        (i) =>
          `tests/test_mod${String(i)}.py ........................  [${String(i % 100)}%]`,
      ),
      "tests/test_bad.py F",
      "================= FAILURES =================",
      "_______________ test_bad _______________",
      "Traceback (most recent call last):",
      '  File "tests/test_bad.py", line 3, in test_bad',
      "AssertionError: assert 1 == 2",
      "FAILED tests/test_bad.py::test_bad - AssertionError",
      "======= 1 failed, 4800 passed in 12.31s =======",
    ].join("\n"),
  },
  "git push with progress": {
    ratio: true,
    text: [
      "Enumerating objects: 900, done.",
      ...n(
        250,
        (i) => `Counting objects:  ${String(i % 100)}% (${String(i)}/900)`,
      ),
      ...n(
        250,
        (i) => `Compressing objects:  ${String(i % 100)}% (${String(i)}/700)`,
      ),
      ...n(250, (i) => `remote: Resolving deltas ${String(i)}`),
      "error: failed to push some refs to 'origin'",
      "hint: Updates were rejected because the remote contains work",
    ].join("\n"),
  },
  "tsc errors": {
    ratio: false,
    text: [
      ...n(
        60,
        (i) =>
          `src/file${String(i)}.ts(${String(i + 1)},5): error TS2322: Type 'string' is not assignable to type 'number'.\n\n${String(i + 1)}   const v: number = "x";\n    ~~~~~~~~~~~~~~~~~~~~~~~\n`,
      ),
      "Found 60 errors in 60 files.",
    ].join("\n"),
  },
  "git status and log": {
    ratio: false,
    text: [
      "On branch main",
      "Changes not staged for commit:",
      ...n(120, (i) => `\tmodified:   packages/pkg${String(i)}/src/index.ts`),
      "error: pathspec 'nope' did not match any file(s) known to git",
      "Untracked files:",
      ...n(120, (i) => `\tscratch/file-${String(i)}.log`),
      ...n(
        80,
        (i) =>
          `commit ${String(i).padStart(40, "a")}\nAuthor: A <a@x.y>\nDate:   Mon\n\n    fix: change ${String(i)}\n`,
      ),
    ].join("\n"),
  },
};

for (const [name, { text, ratio }] of Object.entries(fixtures))
  test(`compaction of ${name} keeps every error line and fits the budget`, () => {
    const out = compact(text);
    const want = text
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .filter((l) => ERR.test(l));
    assert.ok(want.length > 0);
    for (const line of want)
      assert.ok(out.text.includes(line), `dropped: ${line}`);
    if (ratio) {
      assert.ok(
        size(text) >= 3 * size(out.text),
        `${String(size(text))} -> ${String(size(out.text))}`,
      );
      assert.ok(size(out.text) <= 8192);
      assert.equal(out.lossy, true);
    }
    assert.equal(compact(out.text).text, out.text, "idempotent");
  });

test("compaction keeps the head and tail of long output and counts what it cut", () => {
  const text = n(2000, (i) => `line ${String(i)} of ordinary output`).join(
    "\n",
  );
  const out = compact(text, 2048);
  assert.ok(size(out.text) <= 2048);
  assert.ok(out.text.startsWith("line 0 of"));
  assert.ok(out.text.endsWith("line 1999 of ordinary output"));
  assert.match(out.text, /\[… \d+ lines elided\]/);
  assert.equal(out.lossy, true);
  assert.equal(compact(out.text, 2048).text, out.text);
  const wide = compact(text, 64 * 1024);
  assert.equal(wide.text, text);
  assert.equal(wide.lossy, false);
});

test("a failure line in the middle of elided output survives, even past the budget", () => {
  const lines = n(3000, (i) => `step ${String(i)} ok`);
  lines[1500] = "thread 'main' panicked at src/lib.rs:9";
  lines[2500] = "  ✖ third case";
  const out = compact(lines.join("\n"), 1024);
  assert.ok(out.text.includes("panicked at src/lib.rs:9"));
  assert.ok(out.text.includes("✖ third case"));
  assert.ok(size(out.text) < 3000);
  assert.equal(compact(out.text, 1024).text, out.text, "idempotent");
  const many = n(500, (i) => `error: case ${String(i)} failed`);
  const kept = compact(many.join("\n"), 512).text.split("\n");
  assert.equal(kept.filter((l) => ERR.test(l)).length, 500);
  const mixed = n(600, (i) =>
    i % 2 ? `error: case ${String(i)} failed` : `step ${String(i)} ok`,
  ).join("\n");
  const once = compact(mixed, 512).text;
  assert.equal(compact(once, 512).text, once, "idempotent past the budget");
});

test("ANSI escapes are stripped and carriage-return progress keeps its last frame", () => {
  const colored = `${ESC}[31mred${ESC}[0m ${ESC}]8;;https://x.y${ESC}\\link${ESC}]8;;${ESC}\\`;
  assert.equal(compact(colored).text, "red link");
  const progress = "download 10%\rdownload 55%\rdownload 100%\ndone\r\nnext";
  assert.equal(compact(progress).text, "download 100%\ndone\nnext");
  const big = `${n(300, (i) => `frame ${String(i)}\r`).join("")}final\n${"x".repeat(2000)}`;
  assert.ok(compact(big).text.startsWith("final"));
});

test("consecutive repeated lines fold into one counted line", () => {
  const text = [
    ...n(400, () => "waiting for lock"),
    "acquired",
    ...n(300, () => "retrying: connection failed"),
  ].join("\n");
  const out = compact(text);
  assert.equal(
    out.text,
    "waiting for lock (x400)\nacquired\nretrying: connection failed (x300)",
  );
});

test("empty and short output is returned unchanged and not marked lossy", () => {
  for (const text of [
    "",
    "ok",
    "same\nsame\nsame\nsame\n",
    "Compiling a\nCompiling b\nCompiling c\nCompiling d\n",
    n(20, (i) => `line ${String(i)}`).join("\n"),
  ]) {
    const out = compact(text);
    assert.equal(out.text, text);
    assert.equal(out.lossy, false);
  }
});

test("a very long non-failure line is cut to its two ends, a long failure line is not", () => {
  const long = `start-${"y".repeat(5000)}-end`;
  const out = compact(
    `${long}\n${n(100, (i) => `pad ${String(i)}`).join("\n")}`,
  );
  assert.ok(out.text.startsWith("start-"));
  assert.ok(out.text.includes("-end"));
  assert.ok(size(out.text) < 2000);
  const bad = `error: ${"z".repeat(5000)}`;
  assert.ok(
    compact(
      `${bad}\n${n(100, (i) => `pad ${String(i)}`).join("\n")}`,
    ).text.includes(bad),
  );
});

test("a noisy-line summary counts like any other line against the cap", () => {
  const text = [
    ...n(1500, (i) => `ordinary line ${String(i)}`),
    ...n(40, (i) => `   Compiling crate-${String(i)} v1.0.0`),
    ...n(1500, (i) => `later line ${String(i)}`),
  ].join("\n");
  const out = compact(text, 1024);
  assert.ok(size(out.text) <= 1024);
  assert.equal(compact(out.text, 1024).text, out.text);
});

// Tier-2 review of the compaction branch: each case below failed at ae52152.
const pad = (count: number) => n(count, (i) => `ordinary line ${String(i)}`);

test("a failure frame that a carriage return overwrites is kept, and the dropped frames count as lossy", () => {
  const short = compact("error:E123\r progress 100%\ndone");
  assert.equal(short.text, "error:E123\n progress 100%\ndone");
  assert.equal(short.lossy, false, "nothing was dropped");
  assert.equal(compact("tick\rerror:E1\rprogress").lossy, true);
  const long = compact(
    `${pad(400).join("\n")}\nFAIL src/a.test.ts\r1/9\r9/9\n${pad(400).join("\n")}`,
    2048,
  );
  assert.ok(long.text.includes("FAIL src/a.test.ts"));
  assert.ok(!long.text.includes("1/9"));
  assert.equal(long.lossy, true);
});

test("every failure frame in a long carriage-return run survives, plain progress frames do not", () => {
  const frames = [
    "tick 1",
    "panic: boom",
    "tick 2",
    "Traceback (most recent call last):",
    "tick 3",
  ];
  const out = compact(`${frames.join("\r")}\nend`);
  assert.ok(out.text.includes("panic: boom"));
  assert.ok(out.text.includes("Traceback (most recent call last):"));
  assert.ok(out.text.includes("tick 3"));
  assert.ok(!out.text.includes("tick 1") && !out.text.includes("tick 2"));
  assert.equal(compact("a\rb\rc").lossy, true);
  assert.equal(compact("a").lossy, false);
});

test("a WARNING without a colon and TypeScript codes are signal lines", () => {
  const lines = pad(3000);
  lines[900] = "WARNING TS1234 something is deprecated";
  lines[1800] = "src/a.ts(3,1): TS2322 Type 'string' is not assignable";
  lines[2400] = "Warning: unused variable";
  const out = compact(lines.join("\n"), 1024);
  for (const line of [lines[900], lines[1800], lines[2400]])
    assert.ok(out.text.includes(line as string), `dropped: ${line}`);
});

test("signal detection is case-insensitive and finds the word inside a longer one", () => {
  const lines = pad(3000);
  lines[1000] = "build completed with Warnings: 3";
  lines[2000] = "tsc: TS6133 'x' is declared but never used";
  const out = compact(lines.join("\n"), 1024);
  assert.ok(out.text.includes("completed with Warnings: 3"));
  assert.ok(out.text.includes("TS6133"));
});

test("an explicit small budget is honoured on the short path too", () => {
  const text = pad(30).join("\n");
  assert.ok(size(text) > 128 && size(text) < 1024);
  const out = compact(text, 128);
  assert.ok(size(out.text) <= 128, String(size(out.text)));
  assert.match(out.text, /\[… \d+ lines elided\]/);
  assert.equal(out.lossy, true);
  assert.equal(compact(out.text, 128).text, out.text);
});

test("output under an explicit budget passes through, over it is cut", () => {
  const small = "line one\nline two\nline three";
  assert.deepEqual(compact(small, 128), { text: small, lossy: false });
  const cut = compact(small, 16);
  assert.ok(size(cut.text) <= 64);
  assert.equal(cut.lossy, true);
});

test("ordinary lines that look like elision markers do not bypass the cap", () => {
  const forged = n(2000, (i) => `[… ${String(i + 1)} lines elided]`).join("\n");
  const out = compact(forged);
  assert.ok(size(out.text) <= 8192, String(size(out.text)));
  assert.equal(out.lossy, true);
  const mid = pad(3000);
  mid[1500] = "[… 7 lines elided]";
  const cutMid = compact(mid.join("\n"), 1024);
  assert.ok(size(cutMid.text) <= 1024);
  assert.ok(!cutMid.text.split("\n").includes("[… 7 lines elided]"));
});

test("forged noisy-summary and truncation lines are capped too, and real markers still add up", () => {
  const forged = [
    ...n(3000, (i) =>
      i % 2 ? `[${String(i)} build lines: a … b]` : "[output truncated]",
    ),
  ].join("\n");
  assert.ok(size(compact(forged).text) <= 8192);
  const text = pad(5000).join("\n");
  const once = compact(text, 2048);
  const claimed = Number(/\[… (\d+) lines elided\]/.exec(once.text)?.[1]);
  const kept = once.text.split("\n").filter((l) => !l.startsWith("[…")).length;
  assert.equal(kept + claimed, 5000);
});

test("a second pass over a signal-heavy cut keeps each marker's line count", () => {
  const text = n(800, (i) =>
    i % 4 === 3 ? `error: case ${String(i)} failed` : `step ${String(i)} ok`,
  ).join("\n");
  const once = compact(text, 512).text;
  assert.match(once, /\[… 3 lines elided\]/);
  assert.equal(compact(once, 512).text, once);
});
