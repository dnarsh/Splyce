// TD-26 provider profile persistence. Selection does not grant native authority.
//
// Goal: a chat can bind a provider. The Store keeps append-only, revisioned records; this module only decides how
// they are written and read, always through the existing authorities:
//   - connections and profiles are immutable per revision (`providerConnection`, `profileSnapshot` records);
//   - a profile revision pins the EXACT connection revisions it uses (no floating "latest" binding);
//   - connection allocation and profile CAS use Store's compare-and-append transaction;
//   - selecting a profile is a ConfigAuthority change (request, then apply with the expected config revision), so
//     requested vs effective stays one CAS and a stale selection can never dispatch;
//   - secrets never appear here: `credentialRef` is a reference the credential resolver (TD-16) resolves at request time.
import type { ConfigAuthority, ConfigCommit } from "./config.js";
import {
  CONTRACT_VERSION,
  type ProviderConnectionRecord,
  type ProfileSnapshotRecord,
  type RecordByKind,
} from "./contracts.js";
import {
  INITIAL_CONFIG_REVISION,
  StoreError,
  type AppendInput,
  type CallerContext,
  type Store,
} from "./store.js";

export type ProviderProfilesErrorCode =
  | "PROFILE_STALE_REVISION"
  | "PROFILE_UNKNOWN_CONNECTION"
  | "PROFILE_UNKNOWN_PROFILE"
  | "PROFILE_CONNECTION_REVISION_MISMATCH"
  | "PROFILE_INVALID";

export class ProviderProfilesError extends Error {
  readonly code: ProviderProfilesErrorCode;
  constructor(code: ProviderProfilesErrorCode, message: string) {
    super(message);
    this.name = "ProviderProfilesError";
    this.code = code;
  }
}

export interface ConnectionInput {
  readonly scopeId: string;
  readonly providerConnectionId: string;
  readonly apiFamily: string;
  readonly apiVersion: string;
  /** Reference to the admitted endpoint (TD-13 admits the base URL; never a raw URL with credentials). */
  readonly endpointRef: string;
  /** Reference resolved by the native credential resolver at request time. Never the secret. */
  readonly credentialRef: string;
  readonly adapterRevision: string;
  readonly accountScopeRef: string;
  readonly locality: ProviderConnectionRecord["locality"];
}

export interface ConnectionRevision {
  readonly providerConnectionId: string;
  /** Monotonic per connection: "c1", "c2", ... Each revision is immutable. */
  readonly revision: string;
  readonly seq: number;
}

export interface ProfileBinding {
  /** The role this connection serves (for example "chat"). */
  readonly role: string;
  readonly providerConnectionId: string;
  /** The exact connection revision, never "latest". */
  readonly connectionRevision: string;
}

export interface ProfileInput {
  readonly scopeId: string;
  readonly profileId: string;
  readonly bindings: readonly ProfileBinding[];
  readonly egressPolicyRefs: readonly string[];
  readonly limitsArtifactId: string;
  /** Latest profile revision the caller saw, or null for the first revision. A mismatch writes nothing. */
  readonly expectedProfileRevision: string | null;
}

export interface ProfileRevision {
  readonly profileId: string;
  /** Monotonic per profile: "p1", "p2", ... */
  readonly profileRevision: string;
  readonly seq: number;
}

export interface EffectiveProfile {
  readonly profileId: string;
  readonly profileRevision: string;
  readonly configRevision: string;
  readonly bindings: readonly ProfileBinding[];
}

export interface SelectInput {
  readonly scopeId: string;
  readonly profileId: string;
  readonly profileRevision: string;
  /** The effective config revision the caller saw; a mismatch applies nothing. */
  readonly expectedConfigRevision: string;
  readonly acceptedConfigRevision: string;
  readonly transitionId: string;
  readonly intentRef: string;
  readonly changedValuesArtifactId: string;
}

export interface ProviderProfiles {
  /** Appends the next immutable revision of a connection. */
  writeConnection(
    input: ConnectionInput,
    caller: CallerContext,
  ): ConnectionRevision;
  /** Appends the next profile revision if `expectedProfileRevision` is still the latest (compare-and-set). */
  writeProfile(input: ProfileInput, caller: CallerContext): ProfileRevision;
  /** Request then apply through ConfigAuthority; the selected profile becomes effective only on apply. */
  select(input: SelectInput, caller: CallerContext): ConfigCommit;
  /** The profile that is effective now (the latest APPLIED selection), or null when none was ever applied. */
  effective(
    scopeId: string,
    observation?: ReturnType<Store["readAuthority"]>,
  ): EffectiveProfile | null;
}

export interface ProviderProfilesDeps {
  readonly store: Store;
  readonly config: ConfigAuthority;
}

function invalid(): never {
  throw new ProviderProfilesError(
    "PROFILE_INVALID",
    "invalid provider profile input or persisted state",
  );
}

function object(
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    invalid();
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      invalid();
  }
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) invalid();
}

function id(value: unknown): asserts value is string {
  text(value);
  if (/\s|[\\/]/u.test(value)) invalid();
}

function bindings(value: unknown): ProfileBinding[] {
  if (!Array.isArray(value)) invalid();
  const roles = new Set<string>();
  const result: ProfileBinding[] = [];
  for (const binding of value) {
    object(binding, ["role", "providerConnectionId", "connectionRevision"]);
    id(binding.role);
    id(binding.providerConnectionId);
    id(binding.connectionRevision);
    if (roles.has(binding.role)) invalid();
    roles.add(binding.role);
    result.push({
      role: binding.role,
      providerConnectionId: binding.providerConnectionId,
      connectionRevision: binding.connectionRevision,
    });
  }
  if (!roles.has("chat")) invalid();
  return result;
}

function nextRevision(current: string | null, prefix: "c" | "p"): string {
  if (current === null) return `${prefix}1`;
  if (!new RegExp(`^${prefix}[1-9][0-9]*$`, "u").test(current)) invalid();
  const next = Number(current.slice(1)) + 1;
  if (!Number.isSafeInteger(next)) invalid();
  return `${prefix}${String(next)}`;
}

/** Uses immutable records and the existing Store/ConfigAuthority write owners. */
export function createProviderProfiles({
  store,
  config,
}: ProviderProfilesDeps): ProviderProfiles {
  function rows<
    K extends
      "providerConnection" | "profileSnapshot" | "configurationTransition",
  >(
    scopeId: string,
    kind: K,
    observation?: ReturnType<Store["readAuthority"]>,
  ): Array<{ seq: number; record: RecordByKind[K] }> {
    id(scopeId);
    const listed = observation
      ? {
          records: observation.records.filter(
            ({ record }) =>
              record.scopeId === scopeId &&
              !observation.deletedRecordIds.includes(record.recordId),
          ),
          skippedUnknownSchema: 0,
        }
      : store.list(scopeId);
    if (listed.skippedUnknownSchema !== 0)
      throw new StoreError(
        "UNKNOWN_SCHEMA",
        "provider state contains an unreadable record",
      );
    return listed.records
      .filter((row) => row.kind === kind)
      .map((row) => ({ seq: row.seq, record: row.record as RecordByKind[K] }));
  }
  function connection(
    scopeId: string,
    connectionId: string,
    revision: string,
    observation?: ReturnType<Store["readAuthority"]>,
  ): ProviderConnectionRecord {
    const candidates = rows(scopeId, "providerConnection", observation).filter(
      ({ record }) => record.providerConnectionId === connectionId,
    );
    if (candidates.length === 0)
      throw new ProviderProfilesError(
        "PROFILE_UNKNOWN_CONNECTION",
        "connection does not exist in this scope",
      );
    const exact = candidates.filter(
      ({ record }) => record.revision === revision,
    );
    if (exact.length !== 1)
      throw new ProviderProfilesError(
        "PROFILE_CONNECTION_REVISION_MISMATCH",
        "connection revision does not identify one immutable record",
      );
    return exact[0]!.record;
  }
  function snapshot(
    scopeId: string,
    profileId: string,
    revision: string,
    observation?: ReturnType<Store["readAuthority"]>,
  ): ProfileSnapshotRecord {
    const exact = rows(scopeId, "profileSnapshot", observation).filter(
      ({ record }) =>
        record.profileId === profileId && record.profileRevision === revision,
    );
    if (exact.length !== 1)
      throw new ProviderProfilesError(
        "PROFILE_UNKNOWN_PROFILE",
        "profile revision does not identify one immutable snapshot",
      );
    return exact[0]!.record;
  }
  function checkBindings(
    scopeId: string,
    value: unknown,
    observation?: ReturnType<Store["readAuthority"]>,
  ): ProfileBinding[] {
    const checked = bindings(value);
    for (const binding of checked)
      connection(
        scopeId,
        binding.providerConnectionId,
        binding.connectionRevision,
        observation,
      );
    return checked;
  }
  function commit(
    input: AppendInput,
    caller: CallerContext,
    entityId: string,
    expectedRevision: string | null,
  ): number {
    if (input.kind !== "providerConnection" && input.kind !== "profileSnapshot")
      invalid();
    try {
      return store.compareAndAppend(input, caller, {
        kind: input.kind,
        scopeId: (input.record as { scopeId: string }).scopeId,
        entityId,
        expectedRevision,
      }).seq;
    } catch (error) {
      if (error instanceof StoreError && error.code === "ENTITY_STALE_REVISION")
        throw new ProviderProfilesError(
          "PROFILE_STALE_REVISION",
          "provider revision changed before commit",
        );
      throw error;
    }
  }
  function metadata(scopeId: string) {
    return {
      schemaVersion: CONTRACT_VERSION,
      recordId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      scopeId,
      sourceIds: [],
    };
  }
  return {
    writeConnection(input, caller) {
      object(input, [
        "scopeId",
        "providerConnectionId",
        "apiFamily",
        "apiVersion",
        "endpointRef",
        "credentialRef",
        "adapterRevision",
        "accountScopeRef",
        "locality",
      ]);
      for (const field of [
        "scopeId",
        "providerConnectionId",
        "endpointRef",
        "credentialRef",
        "accountScopeRef",
      ] as const)
        id(input[field]);
      for (const field of [
        "apiFamily",
        "apiVersion",
        "adapterRevision",
      ] as const)
        text(input[field]);
      if (input.locality !== "local" && input.locality !== "hosted") invalid();
      const latest = rows(input.scopeId, "providerConnection")
        .filter(
          ({ record }) =>
            record.providerConnectionId === input.providerConnectionId,
        )
        .at(-1)?.record;
      const expected = latest?.revision ?? null;
      const revision = nextRevision(expected, "c");
      const record = {
        ...metadata(input.scopeId),
        providerConnectionId: input.providerConnectionId,
        revision,
        apiFamily: input.apiFamily,
        apiVersion: input.apiVersion,
        endpointRef: input.endpointRef,
        credentialRef: input.credentialRef,
        adapterRevision: input.adapterRevision,
        accountScopeRef: input.accountScopeRef,
        locality: input.locality,
      };
      const seq = commit(
        { kind: "providerConnection", record },
        caller,
        input.providerConnectionId,
        expected,
      );
      return {
        providerConnectionId: input.providerConnectionId,
        revision,
        seq,
      };
    },
    writeProfile(input, caller) {
      object(input, [
        "scopeId",
        "profileId",
        "bindings",
        "egressPolicyRefs",
        "limitsArtifactId",
        "expectedProfileRevision",
      ]);
      id(input.scopeId);
      id(input.profileId);
      id(input.limitsArtifactId);
      if (input.expectedProfileRevision !== null)
        id(input.expectedProfileRevision);
      if (!Array.isArray(input.egressPolicyRefs)) invalid();
      for (const reference of input.egressPolicyRefs) id(reference);
      const pinned = checkBindings(input.scopeId, input.bindings);
      const latest = rows(input.scopeId, "profileSnapshot")
        .filter(({ record }) => record.profileId === input.profileId)
        .at(-1)?.record;
      if ((latest?.profileRevision ?? null) !== input.expectedProfileRevision)
        throw new ProviderProfilesError(
          "PROFILE_STALE_REVISION",
          "profile revision is stale",
        );
      const profileRevision = nextRevision(input.expectedProfileRevision, "p");
      const record = {
        ...metadata(input.scopeId),
        profileId: input.profileId,
        profileRevision,
        configRevision: config.effectiveRevision(input.scopeId),
        roleBindingRefs: [],
        installedModuleRefs: [],
        bindings: pinned,
        egressPolicyRefs: [...input.egressPolicyRefs],
        limitsArtifactId: input.limitsArtifactId,
      };
      const seq = commit(
        { kind: "profileSnapshot", record },
        caller,
        input.profileId,
        input.expectedProfileRevision,
      );
      return { profileId: input.profileId, profileRevision, seq };
    },
    select(input, caller) {
      object(input, [
        "scopeId",
        "profileId",
        "profileRevision",
        "expectedConfigRevision",
        "acceptedConfigRevision",
        "transitionId",
        "intentRef",
        "changedValuesArtifactId",
      ]);
      for (const value of Object.values(input)) id(value);
      const selected = snapshot(
        input.scopeId,
        input.profileId,
        input.profileRevision,
      );
      checkBindings(input.scopeId, selected.bindings);
      const change = { ...input };
      config.request(change, caller);
      return config.apply(change, caller);
    },
    effective(scopeId, observation = store.readAuthority(scopeId)) {
      id(scopeId);
      const records = observation.records.filter(
        ({ record }) => record.scopeId === scopeId,
      );
      const applied = records
        .filter(
          (
            row,
          ): row is {
            seq: number;
            kind: "configurationTransition";
            record: RecordByKind["configurationTransition"];
          } => row.kind === "configurationTransition",
        )
        .filter(({ record }) => record.state === "applied");
      // One SQLite read binds selection and config to the same observation.
      const configRevision =
        applied.at(-1)?.record.acceptedConfigRevision ??
        INITIAL_CONFIG_REVISION;
      for (const { record } of applied) {
        if (
          (record.profileId === undefined) !==
          (record.profileRevision === undefined)
        )
          invalid();
      }
      const selected = applied
        .filter(
          ({ record }) =>
            record.profileId !== undefined &&
            record.profileRevision !== undefined,
        )
        .at(-1)?.record;
      if (!selected) return null;
      id(selected.profileId);
      id(selected.profileRevision);
      if (
        observation.deletedRecordIds.includes(selected.recordId) ||
        observation.deletedRecordIds.includes(applied.at(-1)!.record.recordId)
      )
        invalid();
      const value = snapshot(
        scopeId,
        selected.profileId,
        selected.profileRevision,
        observation,
      );
      const pinned = checkBindings(scopeId, value.bindings, observation);
      return {
        profileId: selected.profileId,
        profileRevision: selected.profileRevision,
        configRevision,
        bindings: pinned,
      };
    },
  };
}
