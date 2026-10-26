// TD-27 failing-first tests for packages/splyce-pi/src/module-plan.ts.
// Prep only: the module does not exist yet, so this suite must fail until TD-27 lands.
// Names (planInstall, checkPlan, planRemove) are proposals pending TD-01/TD-26/TD-28 contracts.
import assert from "node:assert/strict";
import test from "node:test";
import { planInstall, checkPlan, planRemove } from "@splyce/pi/module-plan";

const sha = (c) => c.repeat(40);
const dig = (c) => `sha256:${c.repeat(64)}`;
const entry = (id, over = {}) => ({
  id,
  commit: sha("a"),
  path: `packages/${id}`,
  digest: dig("b"),
  license: "AGPL-3.0-only",
  sizeBytes: 1000,
  requires: [],
  ...over,
});
const catalog = () => [
  entry("lsp", { requires: ["ls-ts"] }),
  entry("ls-ts", { sizeBytes: 5000 }),
  entry("memory", { requires: ["store-lex"] }),
  entry("store-lex"),
  entry("embedder", { sizeBytes: 900000 }),
  entry("shared", { sizeBytes: 300 }),
  entry("a", { requires: ["shared"] }),
  entry("b", { requires: ["shared"] }),
];

test("plan contains only selected roots and their required closure", () => {
  const plan = planInstall({ catalog: catalog(), selected: ["lsp"] });
  assert.deepEqual(plan.closure.map((p) => p.id).sort(), ["ls-ts", "lsp"]);
  assert.equal(plan.closure.find((p) => p.id === "lsp").selected, true);
  assert.equal(plan.closure.find((p) => p.id === "ls-ts").selected, false);
});

test("nothing is planned for an empty selection (base-only)", () => {
  const plan = planInstall({ catalog: catalog(), selected: [] });
  assert.deepEqual(plan.closure, []);
});

test("an unselected optional module is never pulled in", () => {
  const plan = planInstall({ catalog: catalog(), selected: ["memory"] });
  assert.ok(!plan.closure.some((p) => p.id === "embedder"));
});

test("missing size stays unknown, never zero, and the total is unknown", () => {
  const cat = catalog().map((e) =>
    e.id === "ls-ts" ? { ...e, sizeBytes: undefined } : e,
  );
  const plan = planInstall({ catalog: cat, selected: ["lsp"] });
  const dep = plan.closure.find((p) => p.id === "ls-ts");
  assert.equal(dep.sizeBytes, null);
  assert.ok(dep.sizeUnknownReason);
  assert.equal(plan.totals.knownBytes, 1000);
  assert.equal(plan.totals.totalBytes, null);
  assert.equal(plan.totals.unknownCount, 1);
});

test("a moving branch name is not an accepted pin", () => {
  const cat = catalog().map((e) =>
    e.id === "lsp" ? { ...e, commit: "main" } : e,
  );
  assert.throws(() => planInstall({ catalog: cat, selected: ["lsp"] }), {
    code: "ERR_PLAN_PIN",
  });
});

test("unknown selection, missing dependency and cycles are rejected", () => {
  assert.throws(() => planInstall({ catalog: catalog(), selected: ["nope"] }), {
    code: "ERR_PLAN_UNKNOWN_PACKAGE",
  });
  const missing = [entry("x", { requires: ["ghost"] })];
  assert.throws(() => planInstall({ catalog: missing, selected: ["x"] }), {
    code: "ERR_PLAN_MISSING_DEPENDENCY",
  });
  const cycle = [
    entry("x", { requires: ["y"] }),
    entry("y", { requires: ["x"] }),
  ];
  assert.throws(() => planInstall({ catalog: cycle, selected: ["x"] }), {
    code: "ERR_PLAN_CYCLE",
  });
});

test("a changed closure or pin after review makes the plan not current", () => {
  const cat = catalog();
  const plan = planInstall({ catalog: cat, selected: ["lsp"] });
  assert.equal(checkPlan(plan, cat).current, true);

  const newDep = cat.map((e) =>
    e.id === "lsp" ? { ...e, requires: ["ls-ts", "embedder"] } : e,
  );
  assert.equal(checkPlan(plan, newDep).current, false);

  const newPin = cat.map((e) =>
    e.id === "ls-ts" ? { ...e, commit: sha("c") } : e,
  );
  assert.equal(checkPlan(plan, newPin).current, false);

  const newDigest = cat.map((e) =>
    e.id === "ls-ts" ? { ...e, digest: dig("d") } : e,
  );
  assert.equal(checkPlan(plan, newDigest).current, false);
});

test("plan identity is stable for equal input and differs for a different closure", () => {
  const a = planInstall({ catalog: catalog(), selected: ["lsp"] });
  const b = planInstall({ catalog: catalog(), selected: ["lsp"] });
  const c = planInstall({ catalog: catalog(), selected: ["memory"] });
  assert.equal(a.planId, b.planId);
  assert.notEqual(a.planId, c.planId);
});

test("planning performs no network and no setup execution", () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error("network during inspect");
  };
  try {
    let executed = 0;
    const hostile = catalog().map((e) =>
      e.id === "lsp"
        ? {
            ...e,
            setup: {
              executes: true,
              get run() {
                executed += 1;
                return () => {};
              },
            },
          }
        : e,
    );
    const plan = planInstall({ catalog: hostile, selected: ["lsp"] });
    assert.equal(calls, 0);
    assert.equal(executed, 0);
    assert.deepEqual(plan.setupExecution, ["lsp"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("setup execution is listed separately and never implied by install", () => {
  const cat = catalog().map((e) =>
    e.id === "ls-ts" ? { ...e, setup: { executes: true } } : e,
  );
  const plan = planInstall({ catalog: cat, selected: ["lsp"] });
  assert.deepEqual(plan.setupExecution, ["ls-ts"]);
  assert.equal(plan.grantsImplied, false);
  assert.equal(plan.enableRequested, false);
});

test("planning does not mutate its input", () => {
  const cat = Object.freeze(catalog().map((e) => Object.freeze({ ...e })));
  assert.doesNotThrow(() => planInstall({ catalog: cat, selected: ["lsp"] }));
});

test("removal keeps a dependency another installed root still needs", () => {
  const installed = [
    { id: "a", ownerRefs: [] },
    { id: "b", ownerRefs: [] },
    { id: "shared", ownerRefs: ["a", "b"] },
  ];
  const plan = planRemove({ installed, remove: ["a"] });
  assert.deepEqual(plan.removeCode, ["a"]);
  assert.deepEqual(
    plan.retained.map((r) => r.id),
    ["shared"],
  );
  const last = planRemove({
    installed: [
      { id: "b", ownerRefs: [] },
      { id: "shared", ownerRefs: ["b"] },
    ],
    remove: ["b"],
  });
  assert.deepEqual(last.removeCode.sort(), ["b", "shared"]);
});

test("removal never deletes retained user data", () => {
  const plan = planRemove({
    installed: [
      { id: "memory", ownerRefs: [], retainedArtifactRefs: ["art1"] },
    ],
    remove: ["memory"],
  });
  assert.deepEqual(plan.retainedArtifactRefs, ["art1"]);
  assert.equal(plan.deletesData, false);
});
