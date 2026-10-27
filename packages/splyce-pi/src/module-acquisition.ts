// TD-28 / I1 acquisition and installed records (interface-first prep, builds on the TD-27 planner).
//
// A reviewed InstallPlan becomes staged, verified bytes and one installed record per module. Everything that touches
// the outside world is a port: the byte source (network or local) and the store (files). The module itself decides
// only the order and the refusals, so the guarantees are testable without a network:
//   - the plan is re-checked against the catalog first; a stale plan acquires nothing;
//   - every artifact is verified against the plan's commit, size and sha256 digest BEFORE it is promoted;
//   - nothing is promoted or recorded until every entry in the closure verified (a partial closure never lands);
//   - an interrupt, a fetch error or a verification failure leaves no record and no staged bytes;
//   - a record is never enabled here and a package's setup request is only reported, never run;
//   - reading installed state is read-only: no download, repair or activation happens at startup.
// Trust-root catalog verification is here too (verifyCatalog); configuration transitions belong to TD-26 and the
// module lifecycle to TD-37, which consume these records.
import { createHash, createPublicKey, verify } from "node:crypto";
import type { CatalogEntry, InstallPlan, PlanEntry } from "./module-plan.js";
import { checkPlan, planInstall } from "./module-plan.js";

export type ModuleAcquisitionErrorCode =
  | "ERR_ACQ_STALE_PLAN"
  | "ERR_ACQ_BAD_ID"
  | "ERR_ACQ_CUSTOM_UNACKNOWLEDGED"
  | "ERR_ACQ_OFFLINE"
  | "ERR_ACQ_FETCH"
  | "ERR_ACQ_COMMIT_MISMATCH"
  | "ERR_ACQ_SIZE_MISMATCH"
  | "ERR_ACQ_DIGEST_MISMATCH"
  | "ERR_ACQ_CONFLICT"
  | "ERR_ACQ_INTERRUPTED"
  | "ERR_ACQ_STORE"
  | "ERR_ACQ_CATALOG_UNTRUSTED";

export class ModuleAcquisitionError extends Error {
  readonly code: ModuleAcquisitionErrorCode;
  constructor(code: ModuleAcquisitionErrorCode, message: string) {
    super(message);
    this.name = "ModuleAcquisitionError";
    this.code = code;
  }
}

export interface ArtifactBytes {
  /** The commit the source says these bytes were built from; it must equal the plan's pin. */
  readonly commit: string;
  readonly bytes: Uint8Array;
}

/** Where artifact bytes come from. A source that cannot reach its origin rejects with `{ offline: true }`. */
export interface ArtifactSource {
  fetch(
    entry: PlanEntry,
    signal: AbortSignal | undefined,
  ): Promise<ArtifactBytes>;
}

/**
 * File access the acquisition needs. `saveRecords` must replace the record file atomically AND only when the stored
 * text still equals `expectedPrevious` (compare-and-swap); otherwise it rejects with `{ conflict: true }` so a
 * concurrent acquisition can never be silently overwritten.
 */
export interface AcquisitionStore {
  stage(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * Moves staged bytes to their content-addressed destination. When the destination already exists (another
   * acquisition committed the same pin) the staged copy is discarded and "exists" is returned: those bytes are not
   * ours and must never be removed by our cleanup.
   */
  promote(from: string, to: string): Promise<void | "exists">;
  remove(path: string): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  loadRecords(): Promise<string | null>;
  saveRecords(json: string, expectedPrevious: string | null): Promise<void>;
}

export type ModuleOrigin = "official" | "custom";

export interface InstalledRecord {
  readonly id: string;
  readonly commit: string;
  readonly digest: string;
  readonly path: string;
  readonly planId: string;
  readonly origin: ModuleOrigin;
  /** Where the verified bytes live, relative to the store root. */
  readonly installDir: string;
  /** Installed modules that require this one (TD-27 `ownerRefs`): removal planning keeps it while any remain. */
  readonly ownerRefs: readonly string[];
  /** Always false from acquisition: enabling is a separate, user-confirmed configuration transition (TD-26). */
  readonly enabled: false;
  /** The package asked to run setup code. It is reported only; acquisition never runs it. */
  readonly setupRequested: boolean;
  readonly setupExecuted: false;
}

export interface AcquireInput {
  readonly plan: InstallPlan;
  readonly catalog: readonly CatalogEntry[];
  readonly source: ArtifactSource;
  readonly store: AcquisitionStore;
  readonly origin?: ModuleOrigin;
  /** Required for `custom`: the user was shown that a custom source is not covered by the official catalog. */
  readonly customAcknowledged?: boolean;
  readonly signal?: AbortSignal;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const verifiedCatalogs = new WeakSet<object>();

/** True only for a list returned by `verifyCatalog`: an unsigned array is never an official catalog. */
export function isVerifiedCatalog(catalog: readonly CatalogEntry[]): boolean {
  return verifiedCatalogs.has(catalog);
}

/** Acquisitions on one store run one at a time in this process; across processes `saveRecords` compares-and-swaps. */
const queues = new WeakMap<object, Promise<unknown>>();

/** Lowercase letters, digits, `.`, `_`, `-`; no leading dot, so no `..`, separators or drive prefixes. */
const MODULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const installDirOf = (entry: PlanEntry): string =>
  `modules/${entry.id}/${entry.digest.slice("sha256:".length)}`;

function parseRecords(json: string | null): InstalledRecord[] {
  if (json === null) return [];
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_STORE",
      "installed records are not a list",
    );
  }
  return parsed as InstalledRecord[];
}

function interrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_INTERRUPTED",
      "acquisition was interrupted before it completed",
    );
  }
}

async function fetchVerified(
  source: ArtifactSource,
  entry: PlanEntry,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  let artifact: ArtifactBytes;
  try {
    artifact = await source.fetch(entry, signal);
  } catch (error) {
    interrupted(signal);
    const offline = (error as { offline?: unknown } | null)?.offline === true;
    throw new ModuleAcquisitionError(
      offline ? "ERR_ACQ_OFFLINE" : "ERR_ACQ_FETCH",
      offline
        ? `${entry.id} cannot be fetched: no network access`
        : `${entry.id} could not be fetched`,
    );
  }
  if (artifact.commit !== entry.commit) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_COMMIT_MISMATCH",
      `${entry.id} was built from a different commit than the plan pins`,
    );
  }
  if (entry.sizeBytes !== null && artifact.bytes.length !== entry.sizeBytes) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_SIZE_MISMATCH",
      `${entry.id} is ${artifact.bytes.length} bytes, the plan says ${entry.sizeBytes}`,
    );
  }
  if (sha256(artifact.bytes) !== entry.digest) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_DIGEST_MISMATCH",
      `${entry.id} does not match its pinned digest`,
    );
  }
  return artifact.bytes;
}

const closureKey = (entries: readonly PlanEntry[]): string =>
  JSON.stringify(
    entries.map((e) => [
      e.id,
      e.commit,
      e.path,
      e.digest,
      e.license,
      e.sizeBytes,
      e.selected,
    ]),
  );

const union = (a: readonly string[], b: readonly string[]): string[] =>
  [...new Set([...a, ...b])].sort();

export interface AcquireResult {
  readonly added: readonly InstalledRecord[];
  readonly reused: readonly string[];
  /** Paths that could not be removed after success (staging); harmless to activation, listed for cleanup. */
  readonly leftover: readonly string[];
}

/**
 * Acquires and records the closure of a reviewed plan. The closure is re-derived from the catalog and the reviewed
 * roots, never taken from the caller's plan object. Already-installed entries with the same pin are reused (and gain
 * the new owners). Official acquisition needs a catalog that came from `verifyCatalog`. On any failure nothing is
 * recorded; leftover unrecorded bytes that could not be removed are reported, never hidden.
 */
export function acquire(input: AcquireInput): Promise<AcquireResult> {
  const previous = queues.get(input.store) ?? Promise.resolve();
  const run = previous.then(
    () => acquireNow(input),
    () => acquireNow(input),
  );
  queues.set(
    input.store,
    run.catch(() => undefined),
  );
  return run;
}

async function acquireNow(input: AcquireInput): Promise<AcquireResult> {
  const { plan, catalog, source, store, signal } = input;
  const origin = input.origin ?? "official";
  if (origin === "custom" && input.customAcknowledged !== true) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_CUSTOM_UNACKNOWLEDGED",
      "a custom source needs the user to acknowledge it before anything is fetched",
    );
  }
  if (origin === "official" && !isVerifiedCatalog(catalog)) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_CATALOG_UNTRUSTED",
      "official acquisition needs a catalog verified against the trust root",
    );
  }
  const check = checkPlan(plan, catalog);
  if (!check.current) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_STALE_PLAN",
      `the reviewed plan is stale: ${check.reasons.join("; ")}`,
    );
  }
  // The caller's plan object only names the reviewed roots and identity; what gets installed is re-derived.
  let fresh: InstallPlan;
  try {
    fresh = planInstall({ catalog, selected: plan.roots });
  } catch {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_STALE_PLAN",
      "the reviewed roots no longer resolve",
    );
  }
  if (
    fresh.planId !== plan.planId ||
    closureKey(fresh.closure) !== closureKey(plan.closure)
  ) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_STALE_PLAN",
      "the supplied closure differs from the reviewed roots",
    );
  }
  // Module ids become path segments: refuse anything that could leave `modules/` or `staging/` before touching a store.
  for (const entry of fresh.closure) {
    if (!MODULE_ID.test(entry.id)) {
      throw new ModuleAcquisitionError(
        "ERR_ACQ_BAD_ID",
        `module id ${JSON.stringify(entry.id)} is not a safe path segment`,
      );
    }
  }
  interrupted(signal);

  const requires = new Map(catalog.map((e) => [e.id, e.requires]));
  const ownersOf = (id: string): string[] =>
    fresh.closure
      .filter((e) => requires.get(e.id)?.includes(id))
      .map((e) => e.id)
      .sort();

  const loaded = await store.loadRecords();
  const existing = parseRecords(loaded);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const reused: string[] = [];
  const todo: PlanEntry[] = [];
  const updates = new Map<string, InstalledRecord>();
  for (const entry of fresh.closure) {
    const have = byId.get(entry.id);
    if (!have) todo.push(entry);
    else if (have.digest === entry.digest && have.commit === entry.commit) {
      reused.push(entry.id);
      const owners = union(have.ownerRefs ?? [], ownersOf(entry.id));
      if (owners.join() !== (have.ownerRefs ?? []).join()) {
        updates.set(entry.id, { ...have, ownerRefs: owners });
      }
    } else
      throw new ModuleAcquisitionError(
        "ERR_ACQ_CONFLICT",
        `${entry.id} is installed at a different pin; updates are a separate reviewed operation`,
      );
  }

  const stagingRoot = `staging/${plan.planId.replace(/[^a-z0-9]/gi, "_")}`;
  const staged: { entry: PlanEntry; path: string }[] = [];
  const promoted: string[] = [];
  const cleanup = async (): Promise<string[]> => {
    const leftover: string[] = [];
    // Bytes are content-addressed and may have been recorded by a concurrent acquisition that promoted
    // "exists" over ours: never remove a directory the current records reference.
    const referenced = new Set<string>();
    try {
      for (const r of parseRecords(await store.loadRecords())) {
        referenced.add(r.installDir);
      }
    } catch {
      // unreadable records: err on the side of keeping bytes
      for (const dir of promoted) referenced.add(dir);
    }
    for (const dir of promoted) {
      if (referenced.has(dir)) continue;
      await store.remove(dir).catch(() => leftover.push(dir));
    }
    await store.remove(stagingRoot).catch(() => leftover.push(stagingRoot));
    return leftover;
  };
  try {
    for (const entry of todo) {
      interrupted(signal);
      const bytes = await fetchVerified(source, entry, signal);
      const path = `${stagingRoot}/${entry.id}`;
      await store.stage(path, bytes);
      staged.push({ entry, path });
    }
    for (const { entry, path } of staged) {
      interrupted(signal);
      const dir = installDirOf(entry);
      if ((await store.promote(path, dir)) !== "exists") promoted.push(dir);
    }
    interrupted(signal);
    const added = staged.map(({ entry }): InstalledRecord => ({
      id: entry.id,
      commit: entry.commit,
      digest: entry.digest,
      path: entry.path,
      planId: fresh.planId,
      origin,
      installDir: installDirOf(entry),
      ownerRefs: ownersOf(entry.id),
      enabled: false,
      setupRequested: fresh.setupExecution.includes(entry.id),
      setupExecuted: false,
    }));
    if (added.length > 0 || updates.size > 0) {
      const next = [...existing.map((r) => updates.get(r.id) ?? r), ...added];
      await store.saveRecords(JSON.stringify(next), loaded);
    }
    const leftover: string[] = [];
    await store.remove(stagingRoot).catch(() => leftover.push(stagingRoot));
    return { added, reused, leftover };
  } catch (error) {
    const leftover = await cleanup();
    const note =
      leftover.length > 0
        ? `; cleanup incomplete, unrecorded bytes may remain at ${leftover.join(", ")} (nothing was activated or recorded)`
        : "";
    if (error instanceof ModuleAcquisitionError) {
      if (note) error.message += note;
      throw error;
    }
    const conflict =
      (error as { conflict?: unknown } | null)?.conflict === true;
    throw new ModuleAcquisitionError(
      conflict ? "ERR_ACQ_CONFLICT" : "ERR_ACQ_STORE",
      conflict
        ? `another acquisition changed the records first; nothing was recorded${note}`
        : `the store failed; nothing was recorded${note}`,
    );
  }
}

export interface InstalledReport {
  readonly id: string;
  readonly ok: boolean;
  readonly problem: string | null;
}

/**
 * Read-only check of installed state against the records. It never downloads, repairs or enables anything: a module
 * whose bytes are missing or changed is reported, and stays inactive until a reviewed operation repairs it.
 */
export async function verifyInstalled(
  store: AcquisitionStore,
): Promise<readonly InstalledReport[]> {
  const reports: InstalledReport[] = [];
  for (const record of parseRecords(await store.loadRecords())) {
    const bytes = await store.read(record.installDir);
    if (bytes === null)
      reports.push({ id: record.id, ok: false, problem: "bytes are missing" });
    else if (sha256(bytes) !== record.digest)
      reports.push({
        id: record.id,
        ok: false,
        problem: "bytes do not match the recorded digest",
      });
    else reports.push({ id: record.id, ok: true, problem: null });
  }
  return reports;
}

export interface SignedCatalog {
  /** UTF-8 JSON: `{ "entries": CatalogEntry[] }`. */
  readonly bytes: Uint8Array;
  /** Detached Ed25519 signature over `bytes`. */
  readonly signature: Uint8Array;
}

/**
 * Official module digests are accepted only from a catalog signed by the trust root compiled into the app release.
 * A valid digest served beside a tampered catalog, or a catalog signed by another key, is rejected as a whole.
 */
export function verifyCatalog(
  catalog: SignedCatalog,
  trustRootPem: string,
): readonly CatalogEntry[] {
  let ok = false;
  try {
    ok = verify(
      null,
      catalog.bytes,
      createPublicKey(trustRootPem),
      catalog.signature,
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_CATALOG_UNTRUSTED",
      "the catalog is not signed by the trust root",
    );
  }
  const parsed = JSON.parse(new TextDecoder().decode(catalog.bytes)) as {
    entries?: unknown;
  };
  if (!Array.isArray(parsed.entries)) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_CATALOG_UNTRUSTED",
      "the catalog has no entries list",
    );
  }
  // Verified means unchangeable: a mutable entry after verification would let altered content keep official provenance.
  const entries = deepFreeze([...(parsed.entries as CatalogEntry[])]);
  verifiedCatalogs.add(entries);
  return entries;
}
