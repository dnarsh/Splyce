// TD-45 / E1 scheduler core, written failing-first against packages/splyce-pi/src/jobs.ts.
// Pure planning: the caller passes `now` and persisted state, gets back what to run and the next state. Nothing here
// starts a timer, reads a clock or runs an effect, so every case is deterministic.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createJobState,
  occurrencesBetween,
  planTick,
  recordOutcome,
  resolveBlocked,
} from "@splyce/pi/jobs";

const HOUR = 3_600_000;
const at = (iso) => Date.parse(iso);
const interval = (over = {}) => ({
  jobId: "job-a",
  schedule: { kind: "interval", everyMs: HOUR, anchor: "2026-01-01T00:00:00Z" },
  catchUp: "skip",
  overlap: "skip",
  ...over,
});
const tick = (def, state, iso, extra = {}) =>
  planTick({
    def,
    state,
    now: at(iso),
    enabled: true,
    granted: true,
    ...extra,
  });
const start = (def, iso = "2026-01-01T00:00:00Z") =>
  createJobState(def, at(iso));

test("an interval job yields each scheduled occurrence once, in order", () => {
  const def = interval();
  const found = occurrencesBetween(
    def,
    at("2026-01-01T00:00:00Z"),
    at("2026-01-01T03:00:00Z"),
  );
  assert.deepEqual(
    found.map((o) => new Date(o.scheduledFor).toISOString()),
    [
      "2026-01-01T01:00:00.000Z",
      "2026-01-01T02:00:00.000Z",
      "2026-01-01T03:00:00.000Z",
    ],
  );
  assert.deepEqual(
    found.map((o) => o.occurrenceId),
    [
      "job-a@2026-01-01T01:00:00.000Z",
      "job-a@2026-01-01T02:00:00.000Z",
      "job-a@2026-01-01T03:00:00.000Z",
    ],
  );
});

test("a due occurrence runs once; ticking again with the same state never repeats it", () => {
  const def = interval();
  const first = tick(def, start(def), "2026-01-01T01:00:30Z");
  assert.deepEqual(
    first.run.map((o) => o.occurrenceId),
    ["job-a@2026-01-01T01:00:00.000Z"],
  );
  const again = tick(def, first.state, "2026-01-01T01:00:45Z");
  assert.deepEqual(again.run, []);
  const replayed = tick(def, start(def), "2026-01-01T01:00:30Z");
  assert.equal(replayed.run[0].occurrenceId, first.run[0].occurrenceId);
});

test("nothing runs before the first occurrence and the next run is reported", () => {
  const def = interval();
  const r = tick(def, start(def), "2026-01-01T00:30:00Z");
  assert.deepEqual(r.run, []);
  assert.equal(new Date(r.nextRun).toISOString(), "2026-01-01T01:00:00.000Z");
});

test("catch-up skip: missed occurrences are reported, none run", () => {
  const def = interval({ catchUp: "skip" });
  const r = tick(def, start(def), "2026-01-01T05:30:00Z");
  assert.deepEqual(r.run, []);
  assert.equal(r.missed.length, 5);
  assert.equal(tick(def, r.state, "2026-01-01T05:31:00Z").missed.length, 0);
});

test("catch-up latest: only the most recent missed occurrence runs, never a burst", () => {
  const def = interval({ catchUp: "latest" });
  const r = tick(def, start(def), "2026-01-04T00:10:00Z");
  assert.equal(r.run.length, 1);
  assert.equal(
    new Date(r.run[0].scheduledFor).toISOString(),
    "2026-01-04T00:00:00.000Z",
  );
  assert.equal(r.missed.length, 72 - 1 + 0);
});

test("a disabled scheduler runs nothing but reports what it missed; re-enable does not burst", () => {
  const def = interval({ catchUp: "latest" });
  let r = tick(def, start(def), "2026-01-01T10:30:00Z", { enabled: false });
  assert.deepEqual(r.run, []);
  assert.equal(r.missed.length, 10);
  r = tick(def, r.state, "2026-01-01T10:31:00Z");
  assert.deepEqual(r.run, []);
  r = tick(def, r.state, "2026-01-01T11:00:00Z");
  assert.equal(r.run.length, 1);
});

test("a clock that goes backwards neither re-fires nor moves the watermark back", () => {
  const def = interval();
  const ran = tick(
    def,
    start(def, "2026-01-01T01:30:00Z"),
    "2026-01-01T02:00:10Z",
  );
  assert.equal(ran.run.length, 1);
  const back = tick(def, ran.state, "2026-01-01T00:10:00Z");
  assert.deepEqual(back.run, []);
  assert.equal(back.state.watermark, ran.state.watermark);
  const forward = tick(def, back.state, "2026-01-01T02:00:20Z");
  assert.deepEqual(forward.run, []);
});

test("a huge forward clock jump applies catch-up once and stays bounded", () => {
  const def = interval({ catchUp: "latest" });
  const r = tick(def, start(def), "2036-01-01T00:00:30Z");
  assert.equal(r.run.length, 1);
  assert.ok(r.missed.length <= 10_000);
  assert.equal(r.missedTruncated, true);
});

test("overlap skip: a new occurrence is not started while the previous one is still running", () => {
  const def = interval({ overlap: "skip" });
  const first = tick(def, start(def), "2026-01-01T01:00:05Z");
  const second = tick(def, first.state, "2026-01-01T02:00:05Z");
  assert.deepEqual(second.run, []);
  assert.deepEqual(
    second.skippedOverlap.map((o) => o.occurrenceId),
    ["job-a@2026-01-01T02:00:00.000Z"],
  );
  const done = recordOutcome(
    second.state,
    first.run[0].occurrenceId,
    "succeeded",
  );
  const third = tick(def, done, "2026-01-01T03:00:05Z");
  assert.equal(third.run.length, 1);
});

test("a run left open by a crash blocks that job until its outcome is reconciled", () => {
  const def = interval();
  const first = tick(def, start(def), "2026-01-01T01:00:05Z");
  const restarted = JSON.parse(JSON.stringify(first.state));
  const next = tick(def, restarted, "2026-01-01T02:00:05Z");
  assert.deepEqual(next.run, []);
  assert.equal(next.needsReconcile.length, 1);
  assert.equal(next.needsReconcile[0].occurrenceId, first.run[0].occurrenceId);
  const reconciled = recordOutcome(
    JSON.parse(JSON.stringify(next.state)),
    first.run[0].occurrenceId,
    "uncertain",
  );
  assert.equal(tick(def, reconciled, "2026-01-01T03:00:05Z").run.length, 1);
});

test("without a current grant nothing runs and the blocked occurrence is kept, not dropped or replayed", () => {
  const def = interval({ catchUp: "latest" });
  const blocked = tick(def, start(def), "2026-01-01T01:00:05Z", {
    granted: false,
  });
  assert.deepEqual(blocked.run, []);
  assert.equal(blocked.blocked.length, 1);
  assert.equal(blocked.state.blocked.length, 1);
  const granted = tick(def, blocked.state, "2026-01-01T01:30:00Z");
  assert.deepEqual(granted.run, []);
  assert.equal(granted.state.blocked.length, 1);
});

test("a daily job fires at local wall time in its IANA time zone", () => {
  const def = {
    jobId: "daily",
    schedule: { kind: "daily", at: "09:00", timeZone: "America/New_York" },
    catchUp: "skip",
    overlap: "skip",
  };
  const found = occurrencesBetween(
    def,
    at("2026-01-10T00:00:00Z"),
    at("2026-01-11T23:59:00Z"),
  );
  assert.deepEqual(
    found.map((o) => new Date(o.scheduledFor).toISOString()),
    ["2026-01-10T14:00:00.000Z", "2026-01-11T14:00:00.000Z"],
  );
});

test("spring-forward: a nonexistent local time fires once, at the first valid moment", () => {
  const def = {
    jobId: "daily",
    schedule: { kind: "daily", at: "02:30", timeZone: "America/New_York" },
    catchUp: "skip",
    overlap: "skip",
  };
  const found = occurrencesBetween(
    def,
    at("2026-03-07T12:00:00Z"),
    at("2026-03-09T12:00:00Z"),
  );
  assert.equal(found.length, 2);
  assert.equal(
    new Date(found[0].scheduledFor).toISOString(),
    "2026-03-08T07:30:00.000Z",
  );
});

test("fall-back: an ambiguous local time fires once, at its first occurrence", () => {
  const def = {
    jobId: "daily",
    schedule: { kind: "daily", at: "01:30", timeZone: "America/New_York" },
    catchUp: "skip",
    overlap: "skip",
  };
  const found = occurrencesBetween(
    def,
    at("2026-10-31T12:00:00Z"),
    at("2026-11-02T12:00:00Z"),
  );
  assert.equal(found.length, 2);
  assert.equal(
    new Date(found[0].scheduledFor).toISOString(),
    "2026-11-01T05:30:00.000Z",
  );
});

test("an invalid definition is rejected rather than scheduled", () => {
  assert.throws(() =>
    planTick({
      def: interval({
        schedule: {
          kind: "interval",
          everyMs: 0,
          anchor: "2026-01-01T00:00:00Z",
        },
      }),
      state: { watermark: 0, running: [], blocked: [] },
      now: 0,
      enabled: true,
      granted: true,
    }),
  );
  assert.throws(() =>
    occurrencesBetween(
      {
        jobId: "x",
        schedule: { kind: "daily", at: "25:99", timeZone: "UTC" },
        catchUp: "skip",
        overlap: "skip",
      },
      0,
      1,
    ),
  );
  assert.throws(() =>
    occurrencesBetween(
      {
        jobId: "x",
        schedule: { kind: "daily", at: "09:00", timeZone: "Not/AZone" },
        catchUp: "skip",
        overlap: "skip",
      },
      0,
      1,
    ),
  );
});

test("a blocked occurrence needs an explicit choice: drop it, or run it once", () => {
  const def = interval({ catchUp: "latest" });
  const held = tick(def, start(def), "2026-01-01T01:00:05Z", {
    granted: false,
  });
  const id = held.blocked[0].occurrenceId;
  const dropped = resolveBlocked(
    held.state,
    id,
    "drop",
    at("2026-01-01T01:10:00Z"),
  );
  assert.deepEqual(dropped.state.blocked, []);
  assert.equal(dropped.run, null);
  const ran = resolveBlocked(held.state, id, "run", at("2026-01-01T01:10:00Z"));
  assert.equal(ran.run.occurrenceId, id);
  assert.equal(ran.state.running.length, 1);
  assert.throws(() => resolveBlocked(ran.state, id, "drop", 0));
});

test("an outcome for a run that is not open is rejected", () => {
  const def = interval();
  assert.throws(() =>
    recordOutcome(start(def), "job-a@2026-01-01T01:00:00.000Z", "succeeded"),
  );
});

test("an interval anchor without an explicit UTC offset is rejected (host-zone dependent)", () => {
  for (const anchor of [
    "2026-01-01T09:00:00",
    "2026-01-01",
    "2026-01-01T09:00",
    "not a date",
  ]) {
    assert.throws(
      () =>
        planTick({
          def: {
            ...interval(),
            schedule: { kind: "interval", everyMs: HOUR, anchor },
          },
          state: createJobState(interval(), 0),
          now: HOUR,
          enabled: true,
          granted: true,
        }),
      /anchor/,
      anchor,
    );
  }
  for (const anchor of [
    "2026-01-01T09:00:00Z",
    "2026-01-01T14:30:00+05:30",
    "2026-01-01T09:00Z",
  ]) {
    assert.doesNotThrow(() =>
      occurrencesBetween(
        {
          ...interval(),
          schedule: { kind: "interval", everyMs: HOUR, anchor },
        },
        0,
        HOUR,
      ),
    );
  }
});

test("a daily schedule across a skipped local date (Pacific/Apia) yields each physical instant once", () => {
  const def = {
    jobId: "apia",
    schedule: { kind: "daily", at: "12:00", timeZone: "Pacific/Apia" },
    catchUp: "skip",
    overlap: "skip",
  };
  // Apia skipped 2011-12-30: the window covers the gap.
  const from = Date.UTC(2011, 11, 28);
  const to = Date.UTC(2012, 0, 2);
  const list = occurrencesBetween(def, from, to);
  const instants = list.map((o) => o.scheduledFor);
  assert.equal(new Set(instants).size, instants.length);
  assert.equal(new Set(list.map((o) => o.occurrenceId)).size, list.length);
});
