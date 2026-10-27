// TD-45 / E1 scheduler core: pure planning for durable jobs.
//
// The caller owns the clock, the persisted state and every effect: `planTick` takes `now` and a state and returns
// what may start, what was missed or blocked, and the next state. Nothing here starts a timer, reads a clock or
// runs anything, so duplicate triggers, missed intervals, clock or time-zone changes, crashes and overlap are all
// decided from data and can be tested deterministically. Policy source: capability-map.md `scheduling.enabled`.
// A disabled or ungranted scheduler never runs a job, and re-enabling never launches a burst: at most one
// occurrence (the latest) runs per tick, and only when the job's catch-up policy allows it.

export type Schedule =
  | {
      readonly kind: "interval";
      readonly everyMs: number;
      readonly anchor: string;
    }
  | { readonly kind: "daily"; readonly at: string; readonly timeZone: string };

export interface JobDefinition {
  readonly jobId: string;
  readonly schedule: Schedule;
  /** `skip`: run only an occurrence that is the single one due; `latest`: run the latest, report the rest as missed. */
  readonly catchUp: "skip" | "latest";
  readonly overlap: "skip";
}

export interface Occurrence {
  readonly occurrenceId: string;
  readonly jobId: string;
  /** Scheduled time, ms since the epoch (UTC). */
  readonly scheduledFor: number;
}

export interface RunningRun {
  readonly occurrenceId: string;
  readonly scheduledFor: number;
  readonly startedAt: number;
}

export interface BlockedOccurrence {
  readonly occurrenceId: string;
  readonly scheduledFor: number;
  readonly reason: "no-current-grant";
}

/** Plain JSON, so it can be persisted and reloaded as-is. */
export interface JobState {
  /** Latest scheduled time already accounted for. Never decreases, whatever the clock does. */
  readonly watermark: number;
  readonly running: readonly RunningRun[];
  readonly blocked: readonly BlockedOccurrence[];
}

export interface TickInput {
  readonly def: JobDefinition;
  readonly state: JobState;
  readonly now: number;
  /** The scheduler is explicitly enabled. */
  readonly enabled: boolean;
  /** Current grants cover this job's effects right now. */
  readonly granted: boolean;
}

export interface TickResult {
  readonly run: readonly Occurrence[];
  /** Due occurrences that were not run under the catch-up policy or because the scheduler was disabled. */
  readonly missed: readonly Occurrence[];
  /** True when `missed` holds only the most recent entries because there were more than the report limit. */
  readonly missedTruncated: boolean;
  readonly skippedOverlap: readonly Occurrence[];
  /** Runs still marked open when a new occurrence became due; the caller must reconcile them (outcome unknown). */
  readonly needsReconcile: readonly RunningRun[];
  readonly blocked: readonly BlockedOccurrence[];
  readonly nextRun: number | null;
  readonly state: JobState;
}

export type RunOutcome = "succeeded" | "failed" | "canceled" | "uncertain";

export const MISSED_REPORT_LIMIT = 10_000;
const SCAN_LIMIT = 100_000;
const DAY_MS = 86_400_000;

function fail(message: string): never {
  throw new Error(`invalid job: ${message}`);
}

const ANCHOR =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function validateJob(def: JobDefinition): void {
  if (typeof def.jobId !== "string" || def.jobId === "")
    fail("jobId is required");
  if (def.catchUp !== "skip" && def.catchUp !== "latest")
    fail("catchUp must be skip or latest");
  if (def.overlap !== "skip") fail("overlap must be skip");
  const { schedule } = def;
  if (schedule.kind === "interval") {
    if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs <= 0)
      fail("everyMs must be a positive integer");
    // An anchor without an offset is parsed in the host's zone: the same stored job would fire at different instants
    // on different machines. Require an explicit UTC offset.
    if (
      !ANCHOR.test(schedule.anchor) ||
      Number.isNaN(Date.parse(schedule.anchor))
    )
      fail(
        "anchor must be an ISO date-time with an explicit UTC offset (Z or +hh:mm)",
      );
    return;
  }
  if (schedule.kind === "daily") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.at))
      fail("at must be HH:MM");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone });
    } catch {
      fail(`unknown time zone ${schedule.timeZone}`);
    }
    return;
  }
  fail("unknown schedule kind");
}

const occurrenceOf = (jobId: string, scheduledFor: number): Occurrence => ({
  occurrenceId: `${jobId}@${new Date(scheduledFor).toISOString()}`,
  jobId,
  scheduledFor,
});

function localParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  };
}

/** Offset of `timeZone` from UTC at an instant, in ms (local minus UTC). */
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return (
    Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000
  );
}

/**
 * The UTC instant of a local wall time. An ambiguous time (clocks go back) is the first occurrence; a nonexistent
 * time (clocks go forward) uses the offset from before the gap, so it fires at the first valid moment after it.
 */
function localToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): number {
  const local = Date.UTC(y, m - 1, d, h, mi);
  const before = offsetAt(local - DAY_MS, timeZone);
  const after = offsetAt(local + DAY_MS, timeZone);
  const valid = [local - before, local - after].filter(
    (candidate) => offsetAt(candidate, timeZone) === local - candidate,
  );
  return valid.length > 0 ? Math.min(...valid) : local - before;
}

interface Scan {
  readonly count: number;
  readonly latest: Occurrence | null;
  /** Earliest first; at most `limit` entries, taken from the most recent end. */
  readonly list: Occurrence[];
  readonly truncated: boolean;
}

function scan(
  def: JobDefinition,
  after: number,
  upTo: number,
  limit: number,
): Scan {
  const { schedule, jobId } = def;
  if (upTo <= after)
    return { count: 0, latest: null, list: [], truncated: false };
  if (schedule.kind === "interval") {
    const anchor = Date.parse(schedule.anchor);
    const lo = Math.floor((after - anchor) / schedule.everyMs) + 1;
    const hi = Math.floor((upTo - anchor) / schedule.everyMs);
    const count = Math.max(0, hi - lo + 1);
    if (count === 0)
      return { count: 0, latest: null, list: [], truncated: false };
    const first = Math.max(lo, hi - limit + 1);
    const list: Occurrence[] = [];
    for (let k = first; k <= hi; k += 1)
      list.push(occurrenceOf(jobId, anchor + k * schedule.everyMs));
    return {
      count,
      latest: list[list.length - 1] ?? null,
      list,
      truncated: count > list.length,
    };
  }
  const [hh, mm] = schedule.at.split(":").map(Number) as [number, number];
  const startDay = localParts(after, schedule.timeZone);
  const endDay = localParts(upTo, schedule.timeZone);
  const first = Date.UTC(startDay.y, startDay.m - 1, startDay.d) - DAY_MS;
  const last = Date.UTC(endDay.y, endDay.m - 1, endDay.d) + DAY_MS;
  const all: Occurrence[] = [];
  let days = 0;
  for (
    let day = first;
    day <= last && days < SCAN_LIMIT;
    day += DAY_MS, days += 1
  ) {
    const date = new Date(day);
    const at = localToUtc(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hh,
      mm,
      schedule.timeZone,
    );
    // A skipped local date (e.g. Pacific/Apia) maps two days to one instant: one physical occurrence, one entry.
    if (at > after && at <= upTo && all[all.length - 1]?.scheduledFor !== at)
      all.push(occurrenceOf(jobId, at));
  }
  const list = all.slice(Math.max(0, all.length - limit));
  return {
    count: all.length,
    latest: all[all.length - 1] ?? null,
    list,
    truncated: all.length > list.length,
  };
}

/** The first scheduled time strictly after `after`; null when a daily job has none in the next three days. */
function nextAfter(def: JobDefinition, after: number): number | null {
  const { schedule } = def;
  if (schedule.kind === "interval") {
    const anchor = Date.parse(schedule.anchor);
    return (
      anchor +
      (Math.floor((after - anchor) / schedule.everyMs) + 1) * schedule.everyMs
    );
  }
  return (
    scan(def, after, after + 3 * DAY_MS, SCAN_LIMIT).list[0]?.scheduledFor ??
    null
  );
}

/** Every scheduled occurrence in (after, upTo], earliest first (bounded at 100,000). */
export function occurrencesBetween(
  def: JobDefinition,
  after: number,
  upTo: number,
): Occurrence[] {
  validateJob(def);
  return scan(def, after, upTo, SCAN_LIMIT).list;
}

/** State for a job that starts being scheduled at `now`: nothing before it counts as missed. */
export function createJobState(def: JobDefinition, now: number): JobState {
  validateJob(def);
  return { watermark: now, running: [], blocked: [] };
}

export function planTick(input: TickInput): TickResult {
  const { def, state, now, enabled, granted } = input;
  validateJob(def);
  const horizon = Math.max(now, state.watermark);
  const due = scan(def, state.watermark, now, MISSED_REPORT_LIMIT + 1);
  const watermark = due.latest
    ? Math.max(state.watermark, due.latest.scheduledFor)
    : state.watermark;
  const nextRun = nextAfter(def, horizon);

  const base = {
    skippedOverlap: [] as Occurrence[],
    needsReconcile: [] as RunningRun[],
    blocked: [] as BlockedOccurrence[],
    nextRun,
  };
  const finish = (
    run: Occurrence[],
    reported: Occurrence[],
    nextState: JobState,
    extra: Partial<typeof base> = {},
  ): TickResult => {
    const missed = reported.slice(
      Math.max(0, reported.length - MISSED_REPORT_LIMIT),
    );
    return {
      run,
      missed,
      missedTruncated: due.truncated || reported.length > missed.length,
      ...base,
      ...extra,
      state: nextState,
    };
  };

  if (!due.latest) return finish([], [], { ...state, watermark });
  // A disabled scheduler reports everything it skipped and runs nothing; re-enabling starts clean from here.
  if (!enabled) return finish([], due.list, { ...state, watermark });

  // Catch-up decides which single occurrence, if any, is eligible to run.
  const latest = due.latest;
  const candidate = def.catchUp === "latest" || due.count === 1 ? latest : null;
  const notRun = due.list.filter(
    (o) => o.occurrenceId !== candidate?.occurrenceId,
  );
  if (!candidate) return finish([], notRun, { ...state, watermark });

  if (!granted) {
    const entry: BlockedOccurrence = {
      occurrenceId: candidate.occurrenceId,
      scheduledFor: candidate.scheduledFor,
      reason: "no-current-grant",
    };
    const kept = state.blocked.some(
      (b) => b.occurrenceId === entry.occurrenceId,
    )
      ? state.blocked
      : [...state.blocked, entry];
    return finish(
      [],
      notRun,
      { ...state, watermark, blocked: kept },
      { blocked: [entry] },
    );
  }
  if (state.running.length > 0) {
    return finish(
      [],
      notRun,
      { ...state, watermark },
      {
        skippedOverlap: [candidate],
        needsReconcile: [...state.running],
      },
    );
  }
  const started: RunningRun = {
    occurrenceId: candidate.occurrenceId,
    scheduledFor: candidate.scheduledFor,
    startedAt: now,
  };
  return finish([candidate], notRun, {
    ...state,
    watermark,
    running: [started],
  });
}

/** Records how a run ended (or that its effect is uncertain) and frees the job for its next occurrence. */
export function recordOutcome(
  state: JobState,
  occurrenceId: string,
  outcome: RunOutcome,
): JobState {
  void outcome;
  if (!state.running.some((r) => r.occurrenceId === occurrenceId)) {
    throw new Error(`no open run for ${occurrenceId}`);
  }
  return {
    ...state,
    running: state.running.filter((r) => r.occurrenceId !== occurrenceId),
  };
}

/** The explicit choice for an occurrence held for lack of a grant: drop it, or run it now as a single occurrence. */
export function resolveBlocked(
  state: JobState,
  occurrenceId: string,
  choice: "drop" | "run",
  now: number,
): { readonly state: JobState; readonly run: Occurrence | null } {
  const entry = state.blocked.find((b) => b.occurrenceId === occurrenceId);
  if (!entry) throw new Error(`${occurrenceId} is not blocked`);
  const blocked = state.blocked.filter((b) => b.occurrenceId !== occurrenceId);
  if (choice === "drop") return { state: { ...state, blocked }, run: null };
  if (state.running.length > 0) throw new Error("another run is still open");
  const jobId = occurrenceId.slice(0, occurrenceId.lastIndexOf("@"));
  const run = { occurrenceId, jobId, scheduledFor: entry.scheduledFor };
  return {
    state: {
      ...state,
      blocked,
      running: [
        { occurrenceId, scheduledFor: entry.scheduledFor, startedAt: now },
      ],
    },
    run,
  };
}
