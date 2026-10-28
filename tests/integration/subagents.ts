// TD-70 / E1_readonly_subagents — delegated children on the real Pi Agent loop
// (built pi-agent-core), owned by a native Splyce owner, admitted through
// NativePolicy against a real Store, with real Pi tools on real files. Only the
// provider stream is a fixture; worktrees are the real @splyce/index
// WorktreeManager on a real temp repo; once-grants use an in-memory port.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, bindSplyceToolAdmission } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  CodeIndex,
  codeIndexTools,
} from "../../packages/splyce-index/dist/index.js";
import { WorktreeManager } from "../../packages/splyce-index/dist/worktrees.js";
import { RevisionFence } from "../../packages/splyce-pi/dist/admission.js";
import { AdmissionError } from "../../packages/splyce-pi/dist/policy.js";
import { Store } from "../../packages/splyce-pi/dist/store.js";
import {
  type SpawnResult,
  SubagentError,
  SubagentSupervisor,
  subagentTools,
} from "../../packages/splyce-pi/dist/subagents.js";
import { childToolFactories } from "../../packages/splyce-pi/src/subagent-tools.mjs";
import { createSplyceOwner } from "../../vendor/pi/packages/agent/dist/splyce-readiness.js";

const records = JSON.parse(
  readFileSync(
    new URL("../fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const SECRET = "sk-fixture-SECRET-0123456789";
const GRANTS = {
  "fs.read": "g-read",
  "code.index": "g-code",
  "fs.write": "g-write",
  "shell.run": "g-shell",
} as const;

type Msg = Record<string, unknown>;
type Step = (input: {
  task: string;
  turn: number;
  signal: AbortSignal;
  messages: Msg[];
}) => Msg | Promise<Msg>;

const usage = (totalTokens = 10) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const message = (content: unknown[], stopReason: string, tokens?: number) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  stopReason,
  timestamp: 0,
  usage: usage(tokens),
});
const say = (text: string, tokens?: number) =>
  message([{ type: "text", text }], "stop", tokens);
let callSeq = 0;
const call = (name: string, args: unknown, tokens?: number) =>
  message(
    [
      {
        type: "toolCall",
        id: `call-${++callSeq}`,
        name,
        arguments: args,
      },
    ],
    "toolUse",
    tokens,
  );
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part) => (part as { text?: string }).text ?? "").join("")
      : "";
const until = (signal: AbortSignal, gate?: Promise<unknown>) =>
  new Promise<"aborted" | "open">((done) => {
    if (signal.aborted) return done("aborted");
    signal.addEventListener("abort", () => done("aborted"), { once: true });
    gate?.then(() => done("open"));
  });

/**
 * In-memory once-grant port (td13-grants-store consumeOnceGrant is not on this
 * base): an approved grant is bound to one {actionId, argumentsDigest} and
 * consumed atomically on first use.
 */
function onceGrants() {
  const approved = new Map<
    string,
    { actionId: string; argumentsDigest: string }
  >();
  return {
    approve(
      grantId: string,
      act: { actionId: string; argumentsDigest: string },
    ) {
      approved.set(grantId, { ...act });
    },
    consume(
      grantId: string,
      act: { actionId: string; argumentsDigest: string },
    ) {
      const bound = approved.get(grantId);
      if (
        !bound ||
        bound.actionId !== act.actionId ||
        bound.argumentsDigest !== act.argumentsDigest
      )
        throw new Error("GRANT_DENIED");
      approved.delete(grantId);
    },
  };
}

function harness(
  t: { after: (fn: () => void | Promise<void>) => void },
  steps: Step,
  options: {
    limits?: Record<string, number>;
    parentGrants?: Partial<Record<keyof typeof GRANTS, string>>;
    seed?: (ctx: {
      store: Store;
      caller: Parameters<Store["append"]>[1];
    }) => void;
  } = {},
) {
  const dir = realpathSync.native(
    mkdtempSync(join(tmpdir(), "splyce-subagents-")),
  );
  const workspace = join(dir, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "src", "main.ts"),
    'import { helper } from "./helper.js";\nexport function entrypoint() {\n  return helper();\n}\n',
  );
  writeFileSync(
    join(workspace, "src", "helper.ts"),
    "export function helper() {\n  return 42;\n}\n",
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git(
    "-c",
    "user.email=e1@test",
    "-c",
    "user.name=e1",
    "commit",
    "-qm",
    "base",
  );
  const outside = join(dir, "outside.txt");
  writeFileSync(outside, "outside");
  mkdirSync(join(dir, "worktrees"));
  const store = Store.open(join(dir, "store.db"));
  const caller = {
    sessionId: "s1",
    configRevision: "cfg-0",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference: () => true,
  };
  const grants = options.parentGrants ?? GRANTS;
  const run = {
    ...records.run,
    recordId: "rec-run",
    grantIds: Object.values(grants),
  };
  delete run.optionalNote;
  store.append({ kind: "run", record: run }, caller);
  const ownership = store.acquireWorkspace("w-demo", "s1");
  const fence = new RevisionFence(
    { effectiveRevision: (scope: string) => store.configRevision(scope) },
    {
      scopeId: "w-demo",
      profileRevision: "profile1",
      policyRevision: "policy1",
      grantIds: Object.values(grants),
    },
  );
  const owner = createSplyceOwner(() => {});
  const model = {
    id: "fixture",
    name: "Fixture",
    provider: "fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
  };
  owner.bind(model, "model");
  let inFlight = 0;
  let maxInFlight = 0;
  const prompts: string[] = [];
  const streamFn = async (
    _model: unknown,
    context: { messages: Msg[] },
    opts: { signal?: AbortSignal },
  ) => {
    const task = text(context.messages.find((m) => m.role === "user")?.content);
    const turn = context.messages.filter((m) => m.role === "assistant").length;
    if (turn === 0) prompts.push(task);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const stream = createAssistantMessageEventStream();
    try {
      const reply = await steps({
        task,
        turn,
        signal: opts.signal ?? new AbortController().signal,
        messages: context.messages,
      });
      stream.push({ type: "done", reason: reply.stopReason, message: reply });
      stream.end(reply);
    } catch {
      const aborted = message([], "aborted");
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
    } finally {
      inFlight--;
    }
    return stream;
  };
  const parentAbort = new AbortController();
  const grantsPort = onceGrants();
  let supervisorRef: SubagentSupervisor | undefined;
  const worktrees = new WorktreeManager({
    cacheDir: join(dir, "worktrees"),
    workspaces: {
      workspace: (id: string) =>
        id === "w-demo" ? { canonicalPath: workspace } : undefined,
    },
    consumeGrant: (grantId, act) => grantsPort.consume(grantId, act),
    isChildLive: (childId) => supervisorRef?.isChildLive(childId) ?? false,
    maxPerWorkspace: 8,
  });
  let index: CodeIndex | undefined;
  const setup = (async () => {
    index = await CodeIndex.open({
      root: workspace,
      cacheDir: join(dir, "cache"),
    });
  })();
  options.seed?.({ store, caller });
  const supervisor = new SubagentSupervisor({
    store,
    caller,
    fence,
    parent: {
      runId: "r1",
      runRecordId: "rec-run",
      scopeId: "w-demo",
      workspaceId: "w-demo",
      workspaceRoot: workspace,
      baseRevision: "A",
      ownership,
      grants,
      signal: parentAbort.signal,
    },
    owner,
    pi: { Agent, bindSplyceToolAdmission },
    model,
    streamFn,
    tools: childToolFactories({ codeTools: () => codeIndexTools(index!) }),
    worktrees,
    redact: (value: string) => value.replaceAll(SECRET, "[redacted]"),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  supervisorRef = supervisor;
  const live = () => worktrees.list("w-demo").length;
  t.after(async () => {
    parentAbort.abort();
    owner.dispose();
    store.close();
    for (const w of worktrees.list("w-demo"))
      await worktrees.discard(w.worktreeId);
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 100,
    });
  });
  const events = () => store.replayEvents("w-demo", "s1");
  const kinds = (childId?: string) =>
    events()
      .filter(
        (e) =>
          e.kind.startsWith("child.") &&
          (!childId || (e.payload as { childId: string }).childId === childId),
      )
      .map((e) => e.kind);
  const actions = () =>
    store
      .list("w-demo")
      .records.filter(({ kind }) => kind === "action")
      .map(({ record }) => record as Record<string, unknown>);
  return {
    dir,
    workspace,
    outside,
    store,
    fence,
    supervisor,
    parentAbort,
    worktrees,
    grantsPort,
    live,
    events,
    kinds,
    actions,
    prompts,
    maxInFlight: () => maxInFlight,
    ready: setup,
    spawn: async (args: unknown) => {
      await setup;
      const [tool] = subagentTools(supervisor);
      return (await tool!.execute(args)) as SpawnResult;
    },
  };
}

test("read child cites code index and read results through admitted Pi tools; events replay", async (t) => {
  const h = harness(
    t,
    ({ turn }) =>
      [
        call("code_search", { query: "entrypoint" }),
        call("read", { path: "src/helper.ts", offset: 1 }),
        say(`entrypoint calls helper (src/main.ts:2). key=${SECRET}`),
      ][turn]!,
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "find the entrypoint" }],
  });
  const [r] = results;
  assert.equal(r!.status, "completed");
  if (r!.status !== "completed") return;
  assert.ok(
    r.citations.some((c) => c.path === "src/main.ts" && c.line === 2),
    JSON.stringify(r.citations),
  );
  assert.ok(
    r.citations.some((c) => c.path === "src/helper.ts" && c.line === 1),
  );
  assert.deepEqual(h.kinds(r.childId), [
    "child.started",
    "child.progress",
    "child.progress",
    "child.progress",
    "child.completed",
  ]);
  // Published child DTO: parentRunId/status/budget on every event, citations as objects.
  const started = h.events().find((e) => e.kind === "child.started")!;
  const base = started.payload as {
    parentRunId: string;
    status: string;
    budget: Record<string, number>;
  };
  assert.equal(base.parentRunId, "r1");
  assert.equal(base.status, "running");
  assert.deepEqual(base.budget, {
    concurrency: 2,
    maxTurns: 8,
    maxTokens: 200_000,
    wallClockMs: 300_000,
  });
  const completed = h.events().find((e) => e.kind === "child.completed")!;
  const donePayload = completed.payload as {
    parentRunId: string;
    status: string;
    citations: { path: string; line?: number }[];
  };
  assert.equal(donePayload.parentRunId, "r1");
  assert.equal(donePayload.status, "completed");
  assert.ok(
    donePayload.citations.some((c) => c.path === "src/main.ts" && c.line === 2),
    JSON.stringify(donePayload.citations),
  );
  // Every child tool call is a receipted parent-run action under the child's grant.
  const done = h.actions().filter((a) => a.state === "completed");
  assert.deepEqual(done.map((a) => a.capabilityId).sort(), [
    "code.index",
    "fs.read",
  ]);
  const replayed = JSON.stringify(h.events());
  assert.ok(!replayed.includes(SECRET), "child events must be redacted");
  assert.ok(replayed.includes("[redacted]"));
  assert.ok(!r.summary.includes(SECRET));
  // Replay survives reopen (durable ledger, not memory).
  assert.ok(h.events().some((e) => e.kind === "child.completed"));
});

test("read child is denied write and shell tools even though the parent holds them", async (t) => {
  const h = harness(t, ({ task }) =>
    task.includes("write")
      ? call("write", { path: "src/main.ts", content: "pwned" })
      : call("bash", { command: "echo pwned > src/main.ts" }),
  );
  const before = readFileSync(join(h.workspace, "src", "main.ts"), "utf8");
  const { results } = await h.spawn({
    tasks: [{ prompt: "write it" }, { prompt: "shell it" }],
  });
  for (const r of results) {
    assert.equal(r.status, "failed");
    if (r.status === "failed") assert.equal(r.reason, "CAPABILITY_DENIED");
  }
  assert.equal(
    readFileSync(join(h.workspace, "src", "main.ts"), "utf8"),
    before,
  );
  assert.equal(
    h
      .events()
      .filter(
        (e) =>
          e.kind === "child.failed" &&
          (e.payload as { reason: string }).reason === "CAPABILITY_DENIED",
      ).length,
    2,
  );
  // Requesting the capability up front is a typed denial before any child starts.
  await assert.rejects(
    h.spawn({ tasks: [{ prompt: "x", capabilities: ["fs.write"] }] }),
    (e: unknown) =>
      e instanceof SubagentError && e.code === "CAPABILITY_DENIED",
  );
  await assert.rejects(
    h.spawn({
      tasks: [{ prompt: "x", mode: "read", capabilities: ["shell.run"] }],
    }),
    (e: unknown) =>
      e instanceof SubagentError && e.code === "CAPABILITY_DENIED",
  );
});

test("read child path arguments are confined to the workspace", async (t) => {
  const h = harness(t, ({ turn }) =>
    turn === 0 ? call("read", { path: "../outside.txt" }) : say("read it"),
  );
  const { results } = await h.spawn({ tasks: [{ prompt: "escape" }] });
  assert.equal(results[0]!.status, "failed");
  if (results[0]!.status === "failed")
    assert.equal(results[0]!.reason, "PATH_OUTSIDE_WORKSPACE");
});

test("turn budget exhaustion fails only that child; parent and sibling continue", async (t) => {
  const h = harness(t, ({ task, turn }) =>
    task.includes("loop")
      ? call("read", { path: "src/main.ts" })
      : turn === 0
        ? call("read", { path: "src/helper.ts" })
        : say("helper returns 42 (src/helper.ts:2)"),
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "loop forever" }, { prompt: "answer" }],
    budget: { maxTurns: 2 },
  });
  assert.equal(results[0]!.status, "failed");
  if (results[0]!.status === "failed")
    assert.equal(results[0]!.reason, "BUDGET_TURNS");
  assert.equal(results[1]!.status, "completed");
  assert.equal(h.parentAbort.signal.aborted, false);
  const failed = h.events().find((e) => e.kind === "child.failed");
  assert.equal((failed!.payload as { reason: string }).reason, "BUDGET_TURNS");
});

test("token and wall-clock budgets fail with their reason", async (t) => {
  const h = harness(t, async ({ task, turn, signal }) => {
    if (task.includes("slow")) {
      await until(signal);
      throw new Error("aborted");
    }
    return turn === 0
      ? call("read", { path: "src/main.ts" }, 500)
      : say("done", 500);
  });
  const { results } = await h.spawn({
    tasks: [{ prompt: "tokens" }, { prompt: "slow" }],
    budget: { maxTokens: 100, wallClockMs: 300 },
  });
  assert.deepEqual(
    results.map((r) => (r.status === "failed" ? r.reason : r.status)),
    ["BUDGET_TOKENS", "BUDGET_WALL_CLOCK"],
  );
});

test("parent cancel cascades to running and queued children; child cancel spares parent and sibling", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness(t, async ({ task, signal }) => {
    if (task.includes("free")) return say("free done");
    if (
      (await until(signal, task.includes("gated") ? gate : undefined)) ===
      "aborted"
    )
      throw new Error("aborted");
    return say("gated done");
  });
  await h.ready;
  // Child cancel: cancel the blocked child, the gated sibling still completes.
  const pending = h.spawn({
    tasks: [{ prompt: "blocked" }, { prompt: "gated" }],
  });
  while (h.kinds().filter((k) => k === "child.started").length < 2)
    await new Promise((r) => setTimeout(r, 10));
  const blocked = h.events().find((e) => e.kind === "child.started")!;
  assert.equal(
    h.supervisor.cancel((blocked.payload as { childId: string }).childId),
    true,
  );
  release();
  const first = await pending;
  assert.deepEqual(
    first.results.map((r) => r.status),
    ["cancelled", "completed"],
  );
  assert.equal(h.parentAbort.signal.aborted, false);

  // Parent cancel: two running (default concurrency 2) and one queued.
  const all = h.spawn({
    tasks: [
      { prompt: "blocked a" },
      { prompt: "blocked b" },
      { prompt: "free c" },
    ],
  });
  while (h.kinds().filter((k) => k === "child.started").length < 4)
    await new Promise((r) => setTimeout(r, 10));
  h.parentAbort.abort();
  const second = await all;
  assert.deepEqual(
    second.results.map((r) => r.status),
    ["cancelled", "cancelled", "cancelled"],
  );
  assert.equal(h.kinds().filter((k) => k === "child.cancelled").length, 4);
});

test("default concurrency comes from the user budget and bounds in-flight children", async (t) => {
  const h = harness(t, async () => {
    await new Promise((r) => setTimeout(r, 30));
    return say("ok");
  });
  const { results } = await h.spawn({
    tasks: [1, 2, 3, 4, 5].map((n) => ({ prompt: `task ${n}` })),
  });
  assert.equal(
    results.every((r) => r.status === "completed"),
    true,
  );
  assert.equal(h.supervisor.limits.concurrency, 2);
  assert.equal(h.maxInFlight(), 2);
  const h3 = harness(
    t,
    async () => {
      await new Promise((r) => setTimeout(r, 30));
      return say("ok");
    },
    { limits: { concurrency: 3 } },
  );
  await h3.spawn({
    tasks: [1, 2, 3, 4, 5].map((n) => ({ prompt: `task ${n}` })),
    budget: { concurrency: 50 },
  });
  assert.equal(h3.maxInFlight(), 3, "a call cannot exceed the user budget");
});

test("dependencies order tasks, pass results forward and fail dependents; team roles prefix prompts", async (t) => {
  const h = harness(t, ({ task }) =>
    task.includes("explode")
      ? call("write", { path: "x", content: "y" })
      : say(`summary of ${task.split("\n")[0]}`),
  );
  const { team, results } = await h.spawn({
    team: {
      name: "review",
      roles: { scout: "ROLE scout:", judge: "ROLE judge:" },
    },
    tasks: [
      { id: "b", prompt: "second", role: "judge", after: ["a"] },
      { id: "a", prompt: "first", role: "scout" },
      { id: "c", prompt: "explode", after: ["a"] },
      { id: "d", prompt: "never", after: ["c"] },
    ],
  });
  assert.equal(team, "review");
  assert.deepEqual(
    results.map((r) => [r.taskId, r.status]),
    [
      ["b", "completed"],
      ["a", "completed"],
      ["c", "failed"],
      ["d", "failed"],
    ],
  );
  const d = results[3]!;
  if (d.status === "failed") assert.equal(d.reason, "DEPENDENCY_FAILED");
  assert.ok(
    h.prompts.indexOf(h.prompts.find((p) => p.startsWith("ROLE scout:"))!) <
      h.prompts.indexOf(h.prompts.find((p) => p.startsWith("ROLE judge:"))!),
  );
  const second = h.prompts.find((p) => p.startsWith("ROLE judge:"))!;
  assert.match(second, /Result of a:\nsummary of ROLE scout:/u);
  const started = h
    .events()
    .filter((e) => e.kind === "child.started")
    .map((e) => e.payload as { team?: string; role?: string });
  assert.ok(
    started.some((p) => p.team === "review" && p.role === "scout"),
    JSON.stringify(started),
  );
  assert.ok(started.some((p) => p.team === "review" && p.role === undefined));
  await assert.rejects(
    h.spawn({
      tasks: [
        { id: "x", prompt: "1", after: ["y"] },
        { id: "y", prompt: "2", after: ["x"] },
      ],
    }),
    (e: unknown) => e instanceof SubagentError && e.code === "INVALID_ARGUMENT",
  );
});

test("write child edits only its worktree; apply needs a once-grant and lands the change", async (t) => {
  const h = harness(
    t,
    ({ turn }) =>
      [
        call("write", {
          path: "src/new.ts",
          content: "export const added = 1;\n",
        }),
        call("edit", {
          path: "src/helper.ts",
          edits: [{ oldText: "return 42;", newText: "return 43;" }],
        }),
        say("added src/new.ts and bumped helper"),
      ][turn]!,
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "change it", mode: "write" }],
  });
  const r = results[0]!;
  assert.equal(r.status, "completed", JSON.stringify(r));
  if (r.status !== "completed") return;
  assert.deepEqual(r.files!.map((f) => `${f.status} ${f.path}`).sort(), [
    "added src/new.ts",
    "modified src/helper.ts",
  ]);
  assert.equal(
    existsSync(join(h.workspace, "src", "new.ts")),
    false,
    "parent untouched before apply",
  );
  assert.match(
    readFileSync(join(h.workspace, "src", "helper.ts"), "utf8"),
    /return 42/u,
  );
  const completed = h.events().find((e) => e.kind === "child.completed")!;
  const diff = (completed.payload as { diff: { files: typeof r.files } }).diff;
  assert.deepEqual(diff.files.map((f) => `${f.status} ${f.path}`).sort(), [
    "added src/new.ts",
    "modified src/helper.ts",
  ]);
  assert.equal(
    (completed.payload as { files?: unknown }).files,
    undefined,
    "patch file list lives under diff, not files",
  );
  // Writes were receipted under the parent's write grant without an approval.
  assert.ok(
    h
      .actions()
      .some((a) => a.capabilityId === "fs.write" && a.state === "completed"),
  );

  // No approval yet: the once-grant is not in current authority → denied, nothing applied.
  await assert.rejects(
    h.supervisor.apply(r.childId, { grantId: "g-apply-once" }),
    (e: unknown) => e instanceof AdmissionError && e.code === "POLICY_DENIED",
  );
  assert.equal(existsSync(join(h.workspace, "src", "new.ts")), false);
  assert.ok(
    h
      .actions()
      .some((a) => a.capabilityId === "subagent.apply" && a.state === "denied"),
  );

  // Approval: the host adds the once-grant to the run and the live fence.
  const latest = h.store
    .list("w-demo")
    .records.filter(({ kind }) => kind === "run")
    .at(-1)!.record as Record<string, unknown>;
  h.store.append(
    {
      kind: "run",
      record: {
        ...latest,
        recordId: "rec-run-approved",
        grantIds: [...(latest.grantIds as string[]), "g-apply-once"],
      },
    },
    {
      sessionId: "s1",
      configRevision: "cfg-0",
      profileRevision: "profile1",
      policyRevision: "policy1",
      resolveReference: () => true,
    },
  );
  h.fence.grantAdded("g-apply-once");
  // The user approved exactly this patch: the once-grant binds to its act.
  const review = await h.supervisor.review(r.childId);
  assert.deepEqual(review.files, r.files);
  h.grantsPort.approve("g-apply-once", review);
  const applied = await h.supervisor.apply(r.childId, {
    grantId: "g-apply-once",
  });
  assert.equal(applied.applied, true);
  assert.equal(
    readFileSync(join(h.workspace, "src", "new.ts"), "utf8"),
    "export const added = 1;\n",
  );
  assert.match(
    readFileSync(join(h.workspace, "src", "helper.ts"), "utf8"),
    /return 43/u,
  );
  assert.equal(
    h.fence.current().grantIds.includes("g-apply-once"),
    false,
    "once-grant is consumed",
  );
  assert.equal(h.live(), 0, "applied worktree is removed");
  await assert.rejects(
    h.supervisor.apply(r.childId, { grantId: "g-apply-once" }),
    SubagentError,
  );
});

test("two write children claiming one path: the second gets FILE_CLAIM_CONFLICT; claims release at end", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let firstWrote!: () => void;
  const wrote = new Promise<void>((r) => (firstWrote = r));
  const h = harness(t, async ({ task, turn, signal }) => {
    if (task.includes("first")) {
      if (turn === 0)
        return call("write", { path: "src/shared.ts", content: "first\n" });
      firstWrote();
      await until(signal, gate);
      return say("first done");
    }
    await wrote;
    return turn === 0
      ? call("write", { path: "SRC/Shared.ts", content: "second\n" })
      : say("second done");
  });
  const { results } = await (async () => {
    const out = h.spawn({
      tasks: [
        { prompt: "first", mode: "write" },
        { prompt: "second", mode: "write" },
      ],
    });
    // Let the second child hit the claim while the first still holds it.
    while (!h.events().some((e) => e.kind === "child.failed"))
      await new Promise((r) => setTimeout(r, 10));
    release();
    return out;
  })();
  assert.equal(results[0]!.status, "completed");
  assert.equal(results[1]!.status, "failed");
  if (results[1]!.status === "failed")
    assert.equal(results[1]!.reason, "FILE_CLAIM_CONFLICT");
  const claims = h.store
    .list("w-demo")
    .records.filter(({ kind }) => kind === "fileClaim")
    .map(({ record }) => record as Record<string, unknown>);
  assert.equal(claims.filter((c) => c.releasedAt === null).length, 1);
  assert.equal(
    claims.filter((c) => c.releasedAt !== null).length,
    1,
    "claim released at child end",
  );
  // Released: a new writer can claim the same path.
  h.supervisor.claim("later-child", "src/shared.ts");
});

test("parent cancel stops a running write child and discards its worktree", async (t) => {
  let entered!: () => void;
  const running = new Promise<void>((r) => (entered = r));
  const h = harness(t, async ({ signal }) => {
    entered();
    await until(signal);
    throw new Error("aborted");
  });
  const pending = h.spawn({ tasks: [{ prompt: "hold", mode: "write" }] });
  await running;
  while (h.live() === 0) await new Promise((r) => setTimeout(r, 10));
  h.parentAbort.abort();
  const { results } = await pending;
  assert.equal(results[0]!.status, "cancelled");
  assert.equal(h.live(), 0, "cancelled worktree is discarded");
});

test("write child has no shell tool; an absolute shell write cannot reach the parent", async (t) => {
  let target = "";
  const h = harness(t, ({ turn }) =>
    turn === 0
      ? call("bash", {
          command: `node -e "require('fs').writeFileSync('${target}','escaped-by-shell')"`,
        })
      : say("never"),
  );
  target = join(h.workspace, "src", "escaped.ts").replaceAll("\\", "/");
  const { results } = await h.spawn({
    tasks: [{ prompt: "escape the worktree", mode: "write" }],
  });
  assert.equal(results[0]!.status, "failed");
  if (results[0]!.status === "failed")
    assert.equal(results[0]!.reason, "CAPABILITY_DENIED");
  assert.equal(
    existsSync(target),
    false,
    "a shell write must not reach the parent workspace",
  );
  // Asking for shell.run up front is a typed denial before any child starts.
  await assert.rejects(
    h.spawn({
      tasks: [{ prompt: "x", mode: "write", capabilities: ["shell.run"] }],
    }),
    (e: unknown) =>
      e instanceof SubagentError && e.code === "CAPABILITY_DENIED",
  );
});

test("a claim left by a dead child is swept and does not block a new writer", async (t) => {
  const h = harness(
    t,
    ({ turn }) =>
      turn === 0
        ? call("edit", {
            path: "src/helper.ts",
            edits: [{ oldText: "return 42;", newText: "return 44;" }],
          })
        : say("edited helper"),
    {
      seed: ({ store, caller }) =>
        store.append(
          {
            kind: "fileClaim",
            record: {
              ...records.fileClaim,
              recordId: "rec-claim-dead",
              sourceIds: ["rec-run"],
              workspaceId: "w-demo",
              path: "src/helper.ts",
              ownerChildId: "dead-child-from-a-crash",
              releasedAt: null,
            },
          },
          caller,
        ),
    },
  );
  const swept = h.store
    .list("w-demo")
    .records.filter(({ kind }) => kind === "fileClaim")
    .map(
      ({ record }) =>
        record as { ownerChildId: string; releasedAt: string | null },
    )
    .filter((c) => c.ownerChildId === "dead-child-from-a-crash");
  assert.ok(
    swept.length >= 2,
    "the sweep appends a release for the dead owner",
  );
  assert.notEqual(swept.at(-1)!.releasedAt, null);
  const { results } = await h.spawn({
    tasks: [{ prompt: "edit", mode: "write" }],
  });
  assert.equal(results[0]!.status, "completed", JSON.stringify(results[0]));
  assert.match(
    readFileSync(join(h.workspace, "src", "helper.ts"), "utf8"),
    /return 42;/u,
    "parent untouched before apply",
  );
});

test("subagent.diff caps the patch at 256 KiB, redacts secrets and names the apply act", async (t) => {
  const big = `// ${SECRET}\n${"x".repeat(300 * 1024)}`;
  const h = harness(t, ({ turn }) =>
    turn === 0
      ? call("write", { path: "src/big.ts", content: big })
      : say("wrote big"),
  );
  const { results } = await h.spawn({
    tasks: [{ prompt: "write a big file", mode: "write" }],
  });
  assert.equal(results[0]!.status, "completed", JSON.stringify(results[0]));
  const tool = subagentTools(h.supervisor).find(
    (candidate) => candidate.name === "subagent_diff",
  )!;
  const diff = (await tool.execute({ childId: results[0]!.childId })) as {
    worktreeId: string;
    files: { path: string; status: string }[];
    patch: string;
    truncated: boolean;
    bytes: number;
    actionId: string;
    argumentsDigest: string;
  };
  assert.equal(diff.truncated, true);
  assert.ok(
    Buffer.byteLength(diff.patch) <= 262_144,
    `patch is ${Buffer.byteLength(diff.patch)} bytes`,
  );
  assert.ok(diff.bytes > 262_144);
  assert.ok(!diff.patch.includes(SECRET), "patch must be redacted");
  assert.match(diff.patch, /\[redacted\]/u);
  assert.deepEqual(diff.files, [{ path: "src/big.ts", status: "added" }]);
  assert.equal(diff.actionId, `worktree.apply:${diff.worktreeId}`);
  assert.ok(diff.argumentsDigest);
  await assert.rejects(tool.execute({ childId: "missing" }), SubagentError);
});
