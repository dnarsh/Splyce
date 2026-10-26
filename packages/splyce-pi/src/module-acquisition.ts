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
import { checkPlan } from "./module-plan.js";

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

/** File access the acquisition needs. `saveRecords` must replace the record file atomically. */
export interface AcquisitionStore {
  stage(path: string, bytes: Uint8Array): Promise<void>;
  promote(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  loadRecords(): Promise<string | null>;
  saveRecords(json: string): Promise<void>;
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

/**
 * Acquires and records the closure of a reviewed plan. Resolves with the records it added (already-installed entries
 * with the same digest are reused, not re-fetched). On any failure nothing is promoted, recorded or left staged.
 */
export async function acquire(input: AcquireInput): Promise<{
  readonly added: readonly InstalledRecord[];
  readonly reused: readonly string[];
}> {
  const { plan, catalog, source, store, signal } = input;
  const origin = input.origin ?? "official";
  if (origin === "custom" && input.customAcknowledged !== true) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_CUSTOM_UNACKNOWLEDGED",
      "a custom source needs the user to acknowledge it before anything is fetched",
    );
  }
  // Module ids become path segments: refuse anything that could leave `modules/` or `staging/` before touching a store.
  for (const entry of plan.closure) {
    if (!MODULE_ID.test(entry.id)) {
      throw new ModuleAcquisitionError(
        "ERR_ACQ_BAD_ID",
        `module id ${JSON.stringify(entry.id)} is not a safe path segment`,
      );
    }
  }
  const check = checkPlan(plan, catalog);
  if (!check.current) {
    throw new ModuleAcquisitionError(
      "ERR_ACQ_STALE_PLAN",
      `the reviewed plan is stale: ${check.reasons.join("; ")}`,
    );
  }
  interrupted(signal);

  const existing = parseRecords(await store.loadRecords());
  const byId = new Map(existing.map((r) => [r.id, r]));
  const reused: string[] = [];
  const todo: PlanEntry[] = [];
  for (const entry of plan.closure) {
    const have = byId.get(entry.id);
    if (!have) todo.push(entry);
    else if (have.digest === entry.digest && have.commit === entry.commit)
      reused.push(entry.id);
    else
      throw new ModuleAcquisitionError(
        "ERR_ACQ_CONFLICT",
        `${entry.id} is installed at a different pin; updates are a separate reviewed operation`,
      );
  }

  const stagingRoot = `staging/${plan.planId.replace(/[^a-z0-9]/gi, "_")}`;
  const staged: { entry: PlanEntry; path: string }[] = [];
  const promoted: string[] = [];
  const cleanup = async (): Promise<void> => {
    for (const dir of promoted) await store.remove(dir).catch(() => undefined);
    await store.remove(stagingRoot).catch(() => undefined);
  };
  try {
    for (const entry of todo) {
      interrupted(signal);
      const bytes = await fetchVerified(source, entry, signal);
      const path = `${stagingRoot}/${entry.id}`;
      await store.stage(path, bytes);
      staged.push({ entry, path });
    }
    interrupted(signal);
    for (const { entry, path } of staged) {
      const dir = installDirOf(entry);
      await store.promote(path, dir);
      promoted.push(dir);
    }
    const added = staged.map(({ entry }): InstalledRecord => ({
      id: entry.id,
      commit: entry.commit,
      digest: entry.digest,
      path: entry.path,
      planId: plan.planId,
      origin,
      installDir: installDirOf(entry),
      enabled: false,
      setupRequested: plan.setupExecution.includes(entry.id),
      setupExecuted: false,
    }));
    if (added.length > 0) {
      await store.saveRecords(JSON.stringify([...existing, ...added]));
    }
    await store.remove(stagingRoot).catch(() => undefined);
    return { added, reused };
  } catch (error) {
    await cleanup();
    if (error instanceof ModuleAcquisitionError) throw error;
    throw new ModuleAcquisitionError(
      "ERR_ACQ_STORE",
      "the store failed; nothing was installed",
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
  return parsed.entries as CatalogEntry[];
}
