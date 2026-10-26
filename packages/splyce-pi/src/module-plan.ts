// TD-27 / I1 install planner: a selected catalog closure becomes an explicit, recoverable install or remove plan.
//
// Pure functions over plain data. Planning performs no network access, runs no package code and never reads a
// field it does not list, so an inspected package cannot execute anything. Catalog verification, acquisition and
// the installed-record store belong to TD-28; configuration transitions to TD-26; this module only decides what
// would be installed or removed and gives that decision a stable identity.
import { createHash } from "node:crypto";

export interface CatalogEntry {
  readonly id: string;
  /** Full immutable Git commit (40 hex). A branch or tag name is never an accepted pin. */
  readonly commit: string;
  readonly path: string;
  /** `sha256:<64 hex>` of the packed artifact. */
  readonly digest: string;
  readonly license: string;
  /** Installed bytes, or absent when the catalog does not know them. Absent is never treated as zero. */
  readonly sizeBytes?: number | null | undefined;
  /** Ids of required dependencies; optional modules are never listed here. */
  readonly requires: readonly string[];
  /** Present only to be reported: the package asks to run setup code. Planning never runs or reads it. */
  readonly setup?: { readonly executes?: boolean } | undefined;
}

export interface PlanEntry {
  readonly id: string;
  readonly commit: string;
  readonly path: string;
  readonly digest: string;
  readonly license: string;
  readonly sizeBytes: number | null;
  readonly sizeUnknownReason: string | null;
  /** True for a module the user selected, false for a required dependency pulled in by one. */
  readonly selected: boolean;
}

export interface InstallPlan {
  readonly planId: string;
  readonly roots: readonly string[];
  readonly closure: readonly PlanEntry[];
  readonly totals: {
    readonly knownBytes: number;
    /** null as soon as any entry's size is unknown. */
    readonly totalBytes: number | null;
    readonly unknownCount: number;
  };
  /** Ids whose package requests setup execution. Installing never grants it; each needs its own admitted operation. */
  readonly setupExecution: readonly string[];
  readonly grantsImplied: false;
  readonly enableRequested: false;
}

export type ModulePlanErrorCode =
  | "ERR_PLAN_PIN"
  | "ERR_PLAN_UNKNOWN_PACKAGE"
  | "ERR_PLAN_MISSING_DEPENDENCY"
  | "ERR_PLAN_CYCLE"
  | "ERR_PLAN_SHARED_IN_USE";

export class ModulePlanError extends Error {
  readonly code: ModulePlanErrorCode;
  constructor(code: ModulePlanErrorCode, message: string) {
    super(message);
    this.name = "ModulePlanError";
    this.code = code;
  }
}

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function indexCatalog(
  catalog: readonly CatalogEntry[],
): Map<string, CatalogEntry> {
  const byId = new Map<string, CatalogEntry>();
  for (const entry of catalog) byId.set(entry.id, entry);
  return byId;
}

function assertPinned(entry: CatalogEntry): void {
  if (!COMMIT.test(entry.commit)) {
    throw new ModulePlanError(
      "ERR_PLAN_PIN",
      `package ${entry.id} is not pinned to a full immutable commit`,
    );
  }
  if (!DIGEST.test(entry.digest)) {
    throw new ModulePlanError(
      "ERR_PLAN_PIN",
      `package ${entry.id} has no sha256 artifact digest`,
    );
  }
}

function sizeOf(entry: CatalogEntry): {
  bytes: number | null;
  reason: string | null;
} {
  const size = entry.sizeBytes;
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) {
    return { bytes: size, reason: null };
  }
  return { bytes: null, reason: "catalog does not report a size" };
}

/** Required closure of `roots`, with a dependency cycle or a missing dependency reported by id. */
function closureOf(
  byId: Map<string, CatalogEntry>,
  roots: readonly string[],
): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const active: string[] = [];
  const visit = (id: string, from: string | null): void => {
    const entry = byId.get(id);
    if (!entry) {
      throw from === null
        ? new ModulePlanError(
            "ERR_PLAN_UNKNOWN_PACKAGE",
            `unknown package ${id}`,
          )
        : new ModulePlanError(
            "ERR_PLAN_MISSING_DEPENDENCY",
            `package ${from} requires ${id}, which the catalog does not list`,
          );
    }
    if (active.includes(id)) {
      throw new ModulePlanError(
        "ERR_PLAN_CYCLE",
        `dependency cycle: ${[...active.slice(active.indexOf(id)), id].join(" -> ")}`,
      );
    }
    if (done.has(id)) return;
    active.push(id);
    for (const dependency of entry.requires) visit(dependency, id);
    active.pop();
    done.add(id);
    order.push(id);
  };
  for (const root of roots) visit(root, null);
  return order;
}

function canonicalPlanInput(
  entries: readonly PlanEntry[],
  setup: readonly string[],
): string {
  return JSON.stringify({
    entries: entries.map((e) => [
      e.id,
      e.commit,
      e.path,
      e.digest,
      e.license,
      e.sizeBytes,
      e.selected,
    ]),
    setup,
  });
}

export function planInstall(input: {
  catalog: readonly CatalogEntry[];
  selected: readonly string[];
}): InstallPlan {
  const byId = indexCatalog(input.catalog);
  const roots = [...new Set(input.selected)].sort();
  const chosen = new Set(roots);
  const ids = closureOf(byId, roots).sort();

  const closure: PlanEntry[] = ids.map((id) => {
    const entry = byId.get(id)!;
    assertPinned(entry);
    const size = sizeOf(entry);
    return {
      id,
      commit: entry.commit,
      path: entry.path,
      digest: entry.digest,
      license: entry.license,
      sizeBytes: size.bytes,
      sizeUnknownReason: size.reason,
      selected: chosen.has(id),
    };
  });
  // Only the declared flag is read: nothing else on `setup` is touched, so a package cannot run code while inspected.
  const setupExecution = ids.filter(
    (id) => byId.get(id)!.setup?.executes === true,
  );

  let knownBytes = 0;
  let unknownCount = 0;
  for (const entry of closure) {
    if (entry.sizeBytes === null) unknownCount += 1;
    else knownBytes += entry.sizeBytes;
  }
  return Object.freeze({
    planId: `plan:${createHash("sha256").update(canonicalPlanInput(closure, setupExecution)).digest("hex")}`,
    roots: Object.freeze(roots),
    closure: Object.freeze(closure.map((e) => Object.freeze(e))),
    totals: Object.freeze({
      knownBytes,
      totalBytes: unknownCount === 0 ? knownBytes : null,
      unknownCount,
    }),
    setupExecution: Object.freeze(setupExecution),
    grantsImplied: false,
    enableRequested: false,
  });
}

export interface PlanCheck {
  readonly current: boolean;
  /** Why the reviewed plan no longer matches the catalog; empty when it is current. */
  readonly reasons: readonly string[];
}

/**
 * Re-resolves the reviewed roots against the catalog as it is now. Any change to the closure, a pin, a digest, a size
 * or a setup request makes the reviewed plan stale: the user must review a revised plan before anything is installed.
 */
export function checkPlan(
  plan: InstallPlan,
  catalog: readonly CatalogEntry[],
): PlanCheck {
  let now: InstallPlan;
  try {
    now = planInstall({ catalog, selected: plan.roots });
  } catch (error) {
    return {
      current: false,
      reasons: [
        error instanceof Error
          ? error.message
          : "plan can no longer be resolved",
      ],
    };
  }
  if (now.planId === plan.planId) return { current: true, reasons: [] };
  const before = new Map(plan.closure.map((e) => [e.id, e]));
  const reasons: string[] = [];
  for (const entry of now.closure) {
    const old = before.get(entry.id);
    if (!old) reasons.push(`${entry.id} was added to the closure`);
    else if (old.commit !== entry.commit)
      reasons.push(`${entry.id} moved to another commit`);
    else if (old.digest !== entry.digest)
      reasons.push(`${entry.id} has a different artifact digest`);
    else if (old.sizeBytes !== entry.sizeBytes)
      reasons.push(`${entry.id} changed size`);
  }
  for (const id of before.keys()) {
    if (!now.closure.some((e) => e.id === id))
      reasons.push(`${id} left the closure`);
  }
  if (now.setupExecution.join() !== plan.setupExecution.join()) {
    reasons.push("the set of packages requesting setup execution changed");
  }
  return {
    current: false,
    reasons: reasons.length ? reasons : ["the plan changed"],
  };
}

export interface InstalledModule {
  readonly id: string;
  /** Ids of installed modules that depend on this one. Empty for a module the user installed directly. */
  readonly ownerRefs: readonly string[];
  /** Data the module retained, by artifact reference; removing code never deletes it. */
  readonly retainedArtifactRefs?: readonly string[] | undefined;
}

export interface RemovePlan {
  readonly removeCode: readonly string[];
  /** Dependencies that lost an owner but still have another, so their code stays. */
  readonly retained: readonly {
    readonly id: string;
    readonly ownerRefs: readonly string[];
  }[];
  readonly retainedArtifactRefs: readonly string[];
  readonly deletesData: false;
}

export function planRemove(input: {
  installed: readonly InstalledModule[];
  remove: readonly string[];
}): RemovePlan {
  const byId = new Map(input.installed.map((m) => [m.id, m]));
  for (const id of input.remove) {
    if (!byId.has(id)) {
      throw new ModulePlanError(
        "ERR_PLAN_UNKNOWN_PACKAGE",
        `${id} is not installed`,
      );
    }
  }
  const removed = new Set(input.remove);
  // A dependency goes only when every module that owned it goes too; repeat until nothing else changes.
  for (let changed = true; changed;) {
    changed = false;
    for (const module of input.installed) {
      if (removed.has(module.id) || module.ownerRefs.length === 0) continue;
      if (module.ownerRefs.every((owner) => removed.has(owner))) {
        removed.add(module.id);
        changed = true;
      }
    }
  }
  // A shared dependency still owned by a module that stays cannot be removed, even when asked for by name.
  for (const id of input.remove) {
    const stays = byId
      .get(id)!
      .ownerRefs.filter((owner) => !removed.has(owner));
    if (stays.length > 0) {
      throw new ModulePlanError(
        "ERR_PLAN_SHARED_IN_USE",
        `${id} is still required by ${stays.sort().join(", ")}`,
      );
    }
  }
  const retained = input.installed
    .filter(
      (m) =>
        !removed.has(m.id) &&
        m.ownerRefs.length > 0 &&
        m.ownerRefs.some((owner) => removed.has(owner)),
    )
    .map((m) => ({
      id: m.id,
      ownerRefs: m.ownerRefs.filter((o) => !removed.has(o)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const retainedArtifactRefs = [
    ...new Set(
      input.installed
        .filter((m) => removed.has(m.id))
        .flatMap((m) => [...(m.retainedArtifactRefs ?? [])]),
    ),
  ].sort();
  return Object.freeze({
    removeCode: Object.freeze([...removed].sort()),
    retained: Object.freeze(retained.map((r) => Object.freeze(r))),
    retainedArtifactRefs: Object.freeze(retainedArtifactRefs),
    deletesData: false,
  });
}
