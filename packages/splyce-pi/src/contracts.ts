export const CONTRACT_VERSION = 1 as const;
export const PROTOCOL_VERSION = 2 as const;
// Proposed bounded defaults; performance qualification remains outstanding.
export const TRANSPORT_LIMITS = Object.freeze({
  maxInlineBytes: 65536,
  maxEncodedFrameBytes: 262144, // Includes the four-byte big-endian length header.
  pendingQueueMaxFrames: 1024,
  pendingQueueMaxBytes: 8388608,
  transientCoalesceWindowMs: 16,
  rendererMaxFrames: 256,
  rendererMaxBytes: 4194304,
} as const);
export const PI_REVISION = "d5b3de22d0e24a3e9c38a9410d3329b099717283" as const;
export const FOUNDATION = Object.freeze({
  entryMode: "sdk-host",
  disabledBuiltinExtensions: Object.freeze([
    "llama.cpp",
    "codemode",
    "tool-search",
    "mcp",
  ] as const),
} as const);

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export class ContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

export interface ContractContext {
  scopeId: string;
  sessionId: string;
  configRevision: string;
  profileRevision: string;
  policyRevision: string;
  lastDurableSeq: number;
  maxInlineBytes: number;
  resolveReference: (id: string, scopeId: string) => boolean;
}

export const RUN_STATES = [
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
  "uncertain",
] as const;
export const ACTION_STATES = [
  "proposed",
  "pending",
  "approved",
  "denied",
  "running",
  "completed",
  "failed",
  "canceled",
  "uncertain",
] as const;
export const EFFECT_STATES = [
  "observed-success",
  "observed-failure",
  "uncertain",
] as const;
export const CLEANUP_STATES = [
  "pending",
  "complete",
  "failed",
  "not-required",
  "uncertain",
] as const;
export const ERROR_CLASSES = [
  "none",
  "policy-denied",
  "validation",
  "execution",
  "canceled",
  "timeout",
  "unknown",
] as const;
export const RETENTION_CLASSES = [
  "session",
  "workspace",
  "persistent",
  "ephemeral",
] as const;
export const INDEX_STATES = [
  "building",
  "validated",
  "active",
  "retired",
] as const;
export const OPERATIONS = ["generate", "extract", "embed", "rerank"] as const;
export const LOCALITIES = ["local", "hosted"] as const;
export const USAGE_SEMANTICS = [
  "reported",
  "estimated",
  "unavailable",
] as const;
export const CANCEL_SEMANTICS = [
  "confirmed",
  "best-effort",
  "unsupported",
] as const;
export const SELECTION_DISPOSITIONS = [
  "next-turn",
  "cancel-and-switch",
] as const;
export const SELECTION_STATES = [
  "pending",
  "ready",
  "failed",
  "canceled",
] as const;
export const INSTALLATION_STATES = [
  "staging",
  "installed",
  "failed",
  "removing",
  "removed",
] as const;
export const CONFIGURATION_STATES = [
  "pending",
  "applied",
  "draining",
  "failed",
] as const;

export interface RecordMetadata {
  schemaVersion: typeof CONTRACT_VERSION;
  recordId: string;
  createdAt: string;
  scopeId: string;
  sourceIds: string[];
  [key: string]: JsonValue;
}

export interface RecordBodies {
  event: { envelope: SplyceEvent };
  run: {
    runId: string;
    piSessionId: string;
    branchAnchorId: string;
    workspaceId: string;
    baseRevision: string;
    baseSnapshotId: string;
    taskArtifactId: string;
    grantIds: string[];
    profileId: string;
    profileRevision: string;
    roleBindingRefs: string[];
    state: (typeof RUN_STATES)[number];
  };
  action: {
    actionId: string;
    runId: string;
    parentActionId: string | null;
    capabilityId: string;
    capabilityVersion: string;
    argumentsArtifactId: string;
    targetScopeId: string;
    idempotencyKey: string;
    state: (typeof ACTION_STATES)[number];
  };
  outcome: {
    actionId: string;
    effectState: (typeof EFFECT_STATES)[number];
    observedAt: string;
    resultArtifactId: string | null;
    cleanupState: (typeof CLEANUP_STATES)[number];
    errorClass: (typeof ERROR_CLASSES)[number];
  };
  artifact: {
    artifactId: string;
    digest: string;
    mediaType: string;
    byteLength: number;
    retentionClass: (typeof RETENTION_CLASSES)[number];
  };
  memoryObservation: {
    observationId: string;
    claimArtifactId: string;
    branchAnchorId: string;
    extractionRoleId: string;
    extractionRevision: string;
    validFrom: string;
    supersedesIds: string[];
  };
  indexGeneration: {
    generationId: string;
    route: string;
    sourceWatermark: string;
    modelContractId: string;
    state: (typeof INDEX_STATES)[number];
  };
  providerRole: {
    roleId: string;
    providerConnectionId: string;
    providerConnectionRevision: string;
    bindingRevision: string;
    modelContractId: string;
    operation: (typeof OPERATIONS)[number];
    locality: (typeof LOCALITIES)[number];
    endpointRef: string;
    modelRevision: string;
    runtimeRevision: string;
    capabilities: string[];
    limits: { [key: string]: number };
    usageSemantics: (typeof USAGE_SEMANTICS)[number];
    cancelSemantics: (typeof CANCEL_SEMANTICS)[number];
    qualificationRef: string | null;
  };
  providerConnection: {
    providerConnectionId: string;
    revision: string;
    apiFamily: string;
    apiVersion: string;
    endpointRef: string;
    credentialRef: string;
    adapterRevision: string;
    accountScopeRef: string;
    locality: (typeof LOCALITIES)[number];
  };
  profileSnapshot: {
    profileId: string;
    profileRevision: string;
    configRevision: string;
    roleBindingRefs: string[];
    installedModuleRefs: string[];
    egressPolicyRefs: string[];
    limitsArtifactId: string;
    /** Exact connection revisions; absent on historical snapshots. */
    bindings?: {
      role: string;
      providerConnectionId: string;
      connectionRevision: string;
    }[];
  };
  selectionTransition: {
    transitionId: string;
    runId: string;
    branchAnchorId: string;
    previousBindingRef: string;
    requestedBindingRef: string;
    profileRevision: string;
    configRevision: string;
    intentRef: string;
    disposition: (typeof SELECTION_DISPOSITIONS)[number];
    state: (typeof SELECTION_STATES)[number];
  };
  packageInstallation: {
    packageId: string;
    installationRevision: string;
    sourceRef: string;
    sourceRevisionOrSnapshot: string;
    contentDigest: string;
    configRevision: string;
    intentRef: string;
    dependencyOwnerRefs: string[];
    retainedArtifactRefs: string[];
    state: (typeof INSTALLATION_STATES)[number];
    outcomeRef: string | null;
  };
  configurationTransition: {
    transitionId: string;
    expectedConfigRevision: string;
    acceptedConfigRevision: string;
    intentRef: string;
    changedValuesArtifactId: string;
    state: (typeof CONFIGURATION_STATES)[number];
    outcomeRef: string | null;
    /** Present together only for an explicit provider-profile selection. */
    profileId?: string;
    profileRevision?: string;
  };
  sessionWriterLease: {
    piSessionId: string;
    writerId: string;
    leaseEpoch: string;
    configRevision: string;
    lastDurableCursor: string;
    expiresAt: string | null;
  };
  /** Pi-derived ancestry anchor (TD-10); Pi entry ids, never file paths. */
  branchAnchor: {
    branchAnchorId: string;
    piSessionId: string;
    parentAnchorId: string | null;
    forkPointEntryId: string | null;
    firstChildEntryId: string | null;
    activeLeafEntryId: string | null;
  };
  /** TD-70 write-child file ownership; a release is a later record with releasedAt. */
  fileClaim: {
    workspaceId: string;
    path: string;
    ownerChildId: string;
    revision: string;
    releasedAt: string | null;
  };
}
export type RecordKind = keyof RecordBodies;
export type RecordByKind = {
  [K in RecordKind]: RecordMetadata & RecordBodies[K];
};
export type DurableRecord = RecordByKind[RecordKind];
export type RunRecord = RecordByKind["run"];
export type ActionRecord = RecordByKind["action"];
export type OutcomeRecord = RecordByKind["outcome"];
export type ArtifactRecord = RecordByKind["artifact"];
export type MemoryObservationRecord = RecordByKind["memoryObservation"];
export type IndexGenerationRecord = RecordByKind["indexGeneration"];
export type ProviderRoleRecord = RecordByKind["providerRole"];
export type ProviderConnectionRecord = RecordByKind["providerConnection"];
export type ProfileSnapshotRecord = RecordByKind["profileSnapshot"];
export type SelectionTransitionRecord = RecordByKind["selectionTransition"];
export type PackageInstallationRecord = RecordByKind["packageInstallation"];
export type ConfigurationTransitionRecord =
  RecordByKind["configurationTransition"];
export type SessionWriterLeaseRecord = RecordByKind["sessionWriterLease"];
export type BranchAnchorRecord = RecordByKind["branchAnchor"];

type Rule =
  | "text"
  | "delta"
  | "id"
  | "ref"
  | "nullableRef"
  | "nullableId"
  | "refs"
  | "strings"
  | "utc"
  | "nullableUtc"
  | "uint"
  | "bool"
  | "limits"
  | "childBudget"
  | "citations"
  | "diffFiles"
  | "childDiff"
  | "portAvailability"
  | "eventEnvelope"
  | readonly string[];
type Shape = { readonly [key: string]: Rule };
export const RECORD_SCHEMAS = {
  event: { envelope: "eventEnvelope" },
  run: {
    runId: "id",
    piSessionId: "ref",
    branchAnchorId: "ref",
    workspaceId: "ref",
    baseRevision: "text",
    baseSnapshotId: "ref",
    taskArtifactId: "ref",
    grantIds: "refs",
    profileId: "ref",
    profileRevision: "text",
    roleBindingRefs: "refs",
    state: RUN_STATES,
  },
  action: {
    actionId: "id",
    runId: "ref",
    parentActionId: "nullableRef",
    capabilityId: "ref",
    capabilityVersion: "text",
    argumentsArtifactId: "ref",
    targetScopeId: "id",
    idempotencyKey: "text",
    state: ACTION_STATES,
  },
  outcome: {
    actionId: "ref",
    effectState: EFFECT_STATES,
    observedAt: "utc",
    resultArtifactId: "nullableRef",
    cleanupState: CLEANUP_STATES,
    errorClass: ERROR_CLASSES,
  },
  artifact: {
    artifactId: "id",
    digest: "text",
    mediaType: "text",
    byteLength: "uint",
    retentionClass: RETENTION_CLASSES,
  },
  memoryObservation: {
    observationId: "id",
    claimArtifactId: "ref",
    branchAnchorId: "ref",
    extractionRoleId: "ref",
    extractionRevision: "text",
    validFrom: "utc",
    supersedesIds: "refs",
  },
  indexGeneration: {
    generationId: "id",
    route: "text",
    sourceWatermark: "text",
    modelContractId: "ref",
    state: INDEX_STATES,
  },
  providerRole: {
    roleId: "id",
    providerConnectionId: "ref",
    providerConnectionRevision: "text",
    bindingRevision: "text",
    modelContractId: "ref",
    operation: OPERATIONS,
    locality: LOCALITIES,
    endpointRef: "ref",
    modelRevision: "text",
    runtimeRevision: "text",
    capabilities: "strings",
    limits: "limits",
    usageSemantics: USAGE_SEMANTICS,
    cancelSemantics: CANCEL_SEMANTICS,
    qualificationRef: "nullableRef",
  },
  providerConnection: {
    providerConnectionId: "id",
    revision: "text",
    apiFamily: "text",
    apiVersion: "text",
    endpointRef: "ref",
    credentialRef: "ref",
    adapterRevision: "text",
    accountScopeRef: "ref",
    locality: LOCALITIES,
  },
  profileSnapshot: {
    profileId: "id",
    profileRevision: "text",
    configRevision: "text",
    roleBindingRefs: "refs",
    installedModuleRefs: "refs",
    egressPolicyRefs: "refs",
    limitsArtifactId: "ref",
  },
  selectionTransition: {
    transitionId: "id",
    runId: "ref",
    branchAnchorId: "ref",
    previousBindingRef: "ref",
    requestedBindingRef: "ref",
    profileRevision: "text",
    configRevision: "text",
    intentRef: "ref",
    disposition: SELECTION_DISPOSITIONS,
    state: SELECTION_STATES,
  },
  packageInstallation: {
    packageId: "id",
    installationRevision: "text",
    sourceRef: "ref",
    sourceRevisionOrSnapshot: "text",
    contentDigest: "text",
    configRevision: "text",
    intentRef: "ref",
    dependencyOwnerRefs: "refs",
    retainedArtifactRefs: "refs",
    state: INSTALLATION_STATES,
    outcomeRef: "nullableRef",
  },
  configurationTransition: {
    transitionId: "id",
    expectedConfigRevision: "text",
    acceptedConfigRevision: "text",
    intentRef: "ref",
    changedValuesArtifactId: "ref",
    state: CONFIGURATION_STATES,
    outcomeRef: "nullableRef",
  },
  sessionWriterLease: {
    piSessionId: "ref",
    writerId: "ref",
    leaseEpoch: "text",
    configRevision: "text",
    lastDurableCursor: "text",
    expiresAt: "nullableUtc",
  },
  branchAnchor: {
    branchAnchorId: "id",
    piSessionId: "ref",
    parentAnchorId: "nullableRef",
    forkPointEntryId: "nullableId",
    firstChildEntryId: "nullableId",
    activeLeafEntryId: "nullableId",
  },
  fileClaim: {
    workspaceId: "ref",
    path: "text",
    ownerChildId: "id",
    revision: "text",
    releasedAt: "nullableUtc",
  },
} as const satisfies { [K in RecordKind]: Shape };

for (const schema of Object.values(RECORD_SCHEMAS)) {
  for (const spec of Object.values(schema))
    if (Array.isArray(spec)) Object.freeze(spec);
  Object.freeze(schema);
}
Object.freeze(RECORD_SCHEMAS);

export interface CommandPayloads {
  "session.start": {
    workspaceId: string;
    profileId: string;
    piSessionId?: string;
    initialPrompt?: string;
  };
  "session.prompt": { text: string; contextArtifactIds?: string[] };
  "session.steer": { actionId: string; instruction: string };
  "session.cancel": { reason?: string };
  "session.fork": { sourceSessionId: string; forkFromEntryId: string };
  "approval.respond": {
    approvalRequestId: string;
    runId: string;
    actionId: string;
    decision: "approve" | "deny";
  };
  "workspace.select": { selectionRef: string };
  "config.set_profile": { profileId: string };
  "lease.acquire": { workspaceId: string; reason: string };
  "lease.release": { leaseRef: string };
  "engine.restart": Record<string, never>;
  "session.subscribe": { afterSeq: number };
  "subagent.diff": { childId: string };
}
export type CommandOp = keyof CommandPayloads;
export type SplyceCommand = {
  [K in CommandOp]: {
    protocolVersion: typeof PROTOCOL_VERSION;
    correlationId: string;
    sessionId: string;
    scopeId: string;
    expectedConfigRevision: string;
    expectedProfileRevision: string;
    expectedPolicyRevision: string;
    op: K;
    payload: CommandPayloads[K];
  };
}[CommandOp];
const COMMAND_SCHEMAS = {
  "session.start": { workspaceId: "ref", profileId: "ref" },
  "session.prompt": { text: "text" },
  "session.steer": { actionId: "ref", instruction: "text" },
  "session.cancel": {},
  "session.fork": { sourceSessionId: "ref", forkFromEntryId: "ref" },
  "approval.respond": {
    approvalRequestId: "ref",
    runId: "ref",
    actionId: "ref",
    decision: ["approve", "deny"],
  },
  "workspace.select": { selectionRef: "ref" },
  "config.set_profile": { profileId: "ref" },
  "lease.acquire": { workspaceId: "ref", reason: "text" },
  "lease.release": { leaseRef: "ref" },
  "engine.restart": {},
  "session.subscribe": { afterSeq: "uint" },
  "subagent.diff": { childId: "id" },
} as const satisfies { [K in CommandOp]: Shape };
const COMMAND_OPTIONAL: Partial<Record<CommandOp, Shape>> = {
  "session.start": { piSessionId: "ref", initialPrompt: "text" },
  "session.prompt": { contextArtifactIds: "refs" },
  "session.cancel": { reason: "text" },
};
export const COMMAND_OPS = Object.freeze(
  Object.keys(COMMAND_SCHEMAS) as CommandOp[],
);
export const ERROR_CODES = [
  "POLICY_DENIED",
  "UNSUPPORTED_PROVIDER",
  "ENGINE_CRASH",
  "UNCERTAIN_EFFECT",
  "STALE_REVISION",
  "TIMEOUT",
] as const;
Object.freeze(ERROR_CODES);
export interface SplyceErrorPayload {
  code: (typeof ERROR_CODES)[number];
  message: string;
  correlationId: string;
  retryable: boolean;
  suggestedAction?:
    "RESTART_ENGINE" | "SWITCH_PROFILE" | "REVERT_HUNK" | "RETRY_SAFE";
}
export const CHILD_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export interface ChildBudget {
  concurrency: number;
  maxTurns: number;
  maxTokens: number;
  wallClockMs: number;
}
export interface ChildCitation {
  path: string;
  line?: number;
}
export interface ChildDiffFile {
  path: string;
  status: string;
}
/** Every child.* event carries the same identity, state and budget fields. */
export interface ChildEventBase {
  childId: string;
  parentRunId: string;
  team?: string;
  role?: string;
  status: (typeof CHILD_STATUSES)[number];
  budget: ChildBudget;
}
export interface EventPayloads {
  "turn.started": { runId: string; turnId: string };
  "turn.stream_delta": { runId: string; delta: string };
  "turn.thought_delta": { runId: string; delta: string };
  "turn.tool_intent": {
    runId: string;
    actionId: string;
    capabilityId: string;
    target: string;
    argsSummary: string;
  };
  "turn.tool_outcome": {
    runId: string;
    actionId: string;
    status: "success" | "error" | "uncertain";
    outcomeRef?: string;
    error?: string;
  };
  "turn.completed": {
    runId: string;
    candidateSnapshotId: string;
    finalRevision: string;
  };
  "turn.failed": { runId: string; error: SplyceErrorPayload };
  "turn.canceled": { runId: string; cleanedUp: boolean };
  "approval.requested": {
    approvalRequestId: string;
    runId: string;
    actionId: string;
    capabilityId: string;
    targetScope: string;
    normalizedTarget: string;
    riskRationale: string;
    timeoutMs?: number;
  };
  "session.tree_updated": {
    sessionId: string;
    branchAnchorId: string;
    leaves: string[];
  };
  "engine.status": {
    state: "ready" | "busy" | "stopping" | "stopped";
    activeWorkers: number;
    ports?: PortAvailability;
  };
  "stream.resync": { fromSeq: number };
  "run.reconnect_snapshot": {
    runId: string;
    lastDurableSeq: number;
    turnId?: string;
    activeActionIds: string[];
    state: "ready" | "busy" | "waiting_approval" | "stopped";
  };
  // TD-70 delegated children; parentRunId is the parent run.
  "child.started": ChildEventBase & {
    status: "running";
    mode: (typeof SUBAGENT_MODES)[number];
  };
  "child.progress": ChildEventBase & {
    status: "running";
    turns: number;
    tokens: number;
  };
  "child.completed": ChildEventBase & {
    status: "completed";
    summary: string;
    citations: ChildCitation[];
    diff?: { files: ChildDiffFile[] };
  };
  "child.failed": ChildEventBase & {
    status: "failed";
    reason: (typeof SUBAGENT_FAILURE_REASONS)[number];
    message?: string;
  };
  "child.cancelled": ChildEventBase & {
    status: "cancelled";
    cleanedUp: boolean;
  };
}
export const SUBAGENT_MODES = ["read", "write"] as const;
export const SUBAGENT_FAILURE_REASONS = [
  "BUDGET_TURNS",
  "BUDGET_TOKENS",
  "BUDGET_WALL_CLOCK",
  "CAPABILITY_DENIED",
  "PATH_OUTSIDE_WORKSPACE",
  "FILE_CLAIM_CONFLICT",
  "DEPENDENCY_FAILED",
  "POLICY_DENIED",
  "PROVIDER_ERROR",
  "ENGINE_ERROR",
] as const;
Object.freeze(SUBAGENT_MODES);
Object.freeze(SUBAGENT_FAILURE_REASONS);
export type EventKind = keyof EventPayloads;
export type SplyceEvent = {
  [K in EventKind]: {
    schemaVersion: typeof CONTRACT_VERSION;
    protocolVersion: typeof PROTOCOL_VERSION;
    recordId: string;
    eventId: string;
    createdAt: string;
    sourceIds: string[];
    scopeId: string;
    sessionId: string;
    seq: number;
    durable: boolean;
    kind: K;
  } & (
    | { payload: EventPayloads[K]; payloadArtifactId?: never }
    | { payloadArtifactId: string; payload?: never }
  );
}[EventKind];
export type SplyceEventEnvelope = SplyceEvent;
export type SplyceEventDraft = {
  [K in EventKind]: Omit<Extract<SplyceEvent, { kind: K }>, "seq">;
}[EventKind];
const EVENT_SCHEMAS = {
  "turn.started": { runId: "ref", turnId: "ref" },
  "turn.stream_delta": { runId: "ref", delta: "delta" },
  "turn.thought_delta": { runId: "ref", delta: "delta" },
  "turn.tool_intent": {
    runId: "ref",
    actionId: "ref",
    capabilityId: "ref",
    target: "ref",
    argsSummary: "text",
  },
  "turn.tool_outcome": {
    runId: "ref",
    actionId: "ref",
    status: ["success", "error", "uncertain"],
  },
  "turn.completed": {
    runId: "ref",
    candidateSnapshotId: "ref",
    finalRevision: "text",
  },
  "turn.failed": { runId: "ref" },
  "turn.canceled": { runId: "ref", cleanedUp: "bool" },
  "approval.requested": {
    approvalRequestId: "ref",
    runId: "ref",
    actionId: "ref",
    capabilityId: "ref",
    targetScope: "id",
    normalizedTarget: "ref",
    riskRationale: "text",
  },
  "session.tree_updated": {
    sessionId: "id",
    branchAnchorId: "ref",
    leaves: "refs",
  },
  "engine.status": {
    state: ["ready", "busy", "stopping", "stopped"],
    activeWorkers: "uint",
  },
  "stream.resync": { fromSeq: "uint" },
  "run.reconnect_snapshot": {
    runId: "ref",
    lastDurableSeq: "uint",
    activeActionIds: "refs",
    state: ["ready", "busy", "waiting_approval", "stopped"],
  },
  "child.started": {
    childId: "id",
    parentRunId: "ref",
    status: ["running"],
    budget: "childBudget",
    mode: SUBAGENT_MODES,
  },
  "child.progress": {
    childId: "id",
    parentRunId: "ref",
    status: ["running"],
    budget: "childBudget",
    turns: "uint",
    tokens: "uint",
  },
  "child.completed": {
    childId: "id",
    parentRunId: "ref",
    status: ["completed"],
    budget: "childBudget",
    summary: "text",
    citations: "citations",
  },
  "child.failed": {
    childId: "id",
    parentRunId: "ref",
    status: ["failed"],
    budget: "childBudget",
    reason: SUBAGENT_FAILURE_REASONS,
  },
  "child.cancelled": {
    childId: "id",
    parentRunId: "ref",
    status: ["cancelled"],
    budget: "childBudget",
    cleanedUp: "bool",
  },
} as const satisfies { [K in EventKind]: Shape };
const CHILD_OPTIONAL: Shape = { team: "text", role: "text" };
const EVENT_OPTIONAL: Partial<Record<EventKind, Shape>> = {
  "engine.status": { ports: "portAvailability" },
  "turn.tool_outcome": { outcomeRef: "ref", error: "text" },
  "approval.requested": { timeoutMs: "uint" },
  "turn.stream_delta": { turnId: "ref" },
  "turn.thought_delta": { turnId: "ref" },
  "run.reconnect_snapshot": { turnId: "ref" },
  "child.started": CHILD_OPTIONAL,
  "child.progress": CHILD_OPTIONAL,
  "child.completed": { ...CHILD_OPTIONAL, diff: "childDiff" },
  "child.failed": { ...CHILD_OPTIONAL, message: "text" },
  "child.cancelled": CHILD_OPTIONAL,
};
export const EVENT_KINDS = Object.freeze(
  Object.keys(EVENT_SCHEMAS) as EventKind[],
);
export const BRIDGE_PROTOCOL_JSON = JSON.stringify({
  schemaVersion: CONTRACT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  piRevision: PI_REVISION,
  foundation: FOUNDATION,
  transportLimits: TRANSPORT_LIMITS,
  commands: COMMAND_SCHEMAS,
  optional: COMMAND_OPTIONAL,
  eventKinds: EVENT_KINDS,
});

export interface PortAvailability {
  generation: boolean;
  provider: boolean;
  workspace: boolean;
  modules: boolean;
}

export interface Handshake {
  protocolVersion: typeof PROTOCOL_VERSION;
  schemaVersion: typeof CONTRACT_VERSION;
  engineProtocolVersion: typeof PROTOCOL_VERSION;
  bridgeProtocolVersion: typeof PROTOCOL_VERSION;
  piRevision: typeof PI_REVISION;
  entryMode: typeof FOUNDATION.entryMode;
  disabledBuiltinExtensions: typeof FOUNDATION.disabledBuiltinExtensions;
  readiness: {
    state: "unavailable" | "ready";
    policy: boolean;
    store: boolean;
    receipts: boolean;
    ports: PortAvailability;
  };
}

export interface NativeLifecycleEvent {
  protocolVersion: typeof PROTOCOL_VERSION;
  kind: "engine_exited";
  expected: boolean;
  exitCode: number | null;
  cleanupComplete: boolean;
}

function requireThat(
  condition: unknown,
  code: string,
  field: string,
): asserts condition {
  if (!condition)
    throw new ContractError(code, `Invalid contract field: ${field}`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  requireThat(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_SHAPE",
    field,
  );
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): asserts value is string {
  requireThat(
    typeof value === "string" && value.trim().length > 0,
    "INVALID_SHAPE",
    field,
  );
}
function opaque(value: unknown, field: string): asserts value is string {
  text(value, field);
  requireThat(!/\s|[\\/]/u.test(value), "INVALID_SHAPE", field);
}
function uint(value: unknown, field: string): asserts value is number {
  requireThat(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "INVALID_SHAPE",
    field,
  );
}
function utc(value: unknown, field: string): void {
  text(value, field);
  requireThat(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value),
    "INVALID_SHAPE",
    field,
  );
  const time = Date.parse(value);
  requireThat(
    Number.isFinite(time) &&
      new Date(time).toISOString() ===
        value.replace(/(?<!\.\d{3})Z$/u, ".000Z"),
    "INVALID_SHAPE",
    field,
  );
}

function json(
  value: unknown,
  persisted: boolean,
  ancestors = new Set<object>(),
  depth = 0,
): void {
  requireThat(depth <= 128, "INVALID_JSON", "nesting");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    requireThat(Number.isFinite(value), "INVALID_JSON", "number");
    return;
  }
  if (typeof value === "string") {
    if (persisted)
      requireThat(
        !/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|^(?:[\\/])|(?:^|[^A-Za-z0-9])file:\/\//iu.test(
          value,
        ),
        "FORBIDDEN_CONTENT",
        "path",
      );
    return;
  }
  requireThat(typeof value === "object", "INVALID_JSON", "value");
  requireThat(!ancestors.has(value), "INVALID_JSON", "cycle");
  const prototype: unknown = Object.getPrototypeOf(value);
  requireThat(
    Array.isArray(value)
      ? prototype === Array.prototype
      : prototype === Object.prototype || prototype === null,
    "INVALID_JSON",
    "prototype",
  );
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value))
    requireThat(keys.length === value.length + 1, "INVALID_JSON", "array");
  for (const key of keys) {
    requireThat(typeof key === "string", "INVALID_JSON", "key");
    if (Array.isArray(value) && key === "length") continue;
    if (Array.isArray(value))
      requireThat(
        /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < value.length,
        "INVALID_JSON",
        "array key",
      );
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireThat(
      descriptor && "value" in descriptor && descriptor.enumerable,
      "INVALID_JSON",
      "property",
    );
    if (persisted) {
      const normalized = key.replace(/[_-]/gu, "").toLowerCase();
      requireThat(
        ![
          "apikey",
          "secret",
          "password",
          "token",
          "accesstoken",
          "refreshtoken",
          "authorization",
          "credential",
          "credentials",
          "privatekey",
          "clientsecret",
          "xapikey",
          "proxyauthorization",
          "cookie",
          "setcookie",
        ].includes(normalized),
        "FORBIDDEN_CONTENT",
        "secret",
      );
    }
    json(descriptor.value, persisted, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

/** Preserve strict JSON admissibility before cloning, without reference callbacks. */
export function snapshotPersistedJson(value: unknown): unknown {
  json(value, true);
  return structuredClone(value);
}

function contextValid(context: ContractContext): void {
  requireThat(
    context !== null &&
      typeof context === "object" &&
      typeof context.resolveReference === "function",
    "INVALID_CONTEXT",
    "resolver",
  );
  for (const key of [
    "scopeId",
    "sessionId",
    "configRevision",
    "profileRevision",
    "policyRevision",
  ] as const)
    opaque(context[key], key);
  uint(context.lastDurableSeq, "lastDurableSeq");
  uint(context.maxInlineBytes, "maxInlineBytes");
  requireThat(context.maxInlineBytes > 0, "INVALID_CONTEXT", "maxInlineBytes");
}
function reference(
  value: unknown,
  field: string,
  context: ContractContext,
): void {
  opaque(value, field);
  let resolved = false;
  try {
    resolved = context.resolveReference(value, context.scopeId) === true;
  } catch {
    throw new ContractError(
      "UNRESOLVED_REFERENCE",
      "Reference resolution failed",
    );
  }
  requireThat(resolved, "UNRESOLVED_REFERENCE", field);
}
function rule(
  value: unknown,
  spec: Rule,
  field: string,
  context: ContractContext,
): void {
  if (typeof spec !== "string") {
    requireThat(
      typeof value === "string" && spec.includes(value),
      "INVALID_ENUM",
      field,
    );
    return;
  }
  switch (spec) {
    case "portAvailability":
      validatePortAvailability(value);
      break;
    case "eventEnvelope": {
      const event = validateEvent(value, context);
      requireThat(event.durable, "INVALID_SHAPE", "durable event");
      reference(event.recordId, "recordId", context);
      break;
    }
    case "delta":
      requireThat(typeof value === "string", "INVALID_SHAPE", field);
      break;
    case "text":
      text(value, field);
      break;
    case "id":
      opaque(value, field);
      break;
    case "ref":
      reference(value, field, context);
      break;
    case "nullableRef":
      if (value !== null) reference(value, field, context);
      break;
    case "nullableId":
      if (value !== null) opaque(value, field);
      break;
    case "utc":
      utc(value, field);
      break;
    case "nullableUtc":
      if (value !== null) utc(value, field);
      break;
    case "uint":
      uint(value, field);
      break;
    case "bool":
      requireThat(typeof value === "boolean", "INVALID_SHAPE", field);
      break;
    case "refs":
    case "strings":
      requireThat(Array.isArray(value), "INVALID_SHAPE", field);
      for (const item of value)
        spec === "refs" ? reference(item, field, context) : text(item, field);
      break;
    case "limits":
      for (const limit of Object.values(object(value, field)))
        requireThat(
          typeof limit === "number" && Number.isFinite(limit) && limit >= 0,
          "INVALID_SHAPE",
          field,
        );
      break;
    case "childBudget": {
      const budget = object(value, field);
      for (const key of ["concurrency", "maxTurns", "maxTokens", "wallClockMs"])
        uint(budget[key], `${field}.${key}`);
      requireThat(
        Object.keys(budget).length === 4,
        "INVALID_SHAPE",
        "budget fields",
      );
      break;
    }
    case "citations":
      requireThat(Array.isArray(value), "INVALID_SHAPE", field);
      for (const item of value) {
        const citation = object(item, field);
        text(citation.path, `${field}.path`);
        if (citation.line !== undefined) uint(citation.line, `${field}.line`);
        requireThat(
          Object.keys(citation).every(
            (key) => key === "path" || key === "line",
          ),
          "INVALID_SHAPE",
          "citation fields",
        );
      }
      break;
    case "diffFiles":
      requireThat(Array.isArray(value), "INVALID_SHAPE", field);
      for (const item of value) {
        const file = object(item, field);
        text(file.path, `${field}.path`);
        text(file.status, `${field}.status`);
        requireThat(
          Object.keys(file).length === 2,
          "INVALID_SHAPE",
          "diff file fields",
        );
      }
      break;
    case "childDiff": {
      const diff = object(value, field);
      requireThat(
        Object.keys(diff).length === 1 && Object.hasOwn(diff, "files"),
        "INVALID_SHAPE",
        "diff fields",
      );
      rule(diff.files, "diffFiles", `${field}.files`, context);
      break;
    }
  }
}
function shape(
  value: Record<string, unknown>,
  required: Shape,
  optional: Shape,
  context: ContractContext,
  strict: boolean,
): void {
  for (const [key, spec] of Object.entries(required)) {
    requireThat(Object.hasOwn(value, key), "INVALID_SHAPE", key);
    rule(value[key], spec, key, context);
  }
  for (const [key, spec] of Object.entries(optional))
    if (Object.hasOwn(value, key)) rule(value[key], spec, key, context);
  if (strict)
    for (const key of Object.keys(value))
      requireThat(
        Object.hasOwn(required, key) || Object.hasOwn(optional, key),
        "INVALID_SHAPE",
        "unknown field",
      );
}
function version(value: unknown, field: string): void {
  requireThat(
    value === (field === "schemaVersion" ? CONTRACT_VERSION : PROTOCOL_VERSION),
    "UNSUPPORTED_VERSION",
    field,
  );
}
function current(
  value: Record<string, unknown>,
  field: string,
  revision: string,
): void {
  requireThat(value[field] === revision, "STALE_REVISION", field);
}
function scope(value: Record<string, unknown>, context: ContractContext): void {
  requireThat(value.scopeId === context.scopeId, "WRONG_SCOPE", "scopeId");
}
function metadata(
  value: Record<string, unknown>,
  context: ContractContext,
): void {
  version(value.schemaVersion, "schemaVersion");
  shape(
    value,
    { recordId: "id", createdAt: "utc", scopeId: "id", sourceIds: "refs" },
    {},
    context,
    false,
  );
  scope(value, context);
}

/** Validation establishes shape and references, never dispatch authority. */
export function validateRecord<K extends RecordKind>(
  kind: K,
  value: unknown,
  context: ContractContext,
): RecordByKind[K] {
  contextValid(context);
  requireThat(Object.hasOwn(RECORD_SCHEMAS, kind), "UNKNOWN_KIND", "kind");
  json(value, true);
  const record = object(value, "record");
  metadata(record, context);
  shape(record, RECORD_SCHEMAS[kind], {}, context, false);
  if (kind === "profileSnapshot" && Object.hasOwn(record, "bindings")) {
    requireThat(Array.isArray(record.bindings), "INVALID_SHAPE", "bindings");
    const roles = new Set<string>();
    for (const value of record.bindings as unknown[]) {
      const binding = object(value, "binding");
      shape(
        binding,
        { role: "id", providerConnectionId: "id", connectionRevision: "id" },
        {},
        context,
        true,
      );
      const role = binding.role as string;
      requireThat(!roles.has(role), "INVALID_SHAPE", "duplicate binding role");
      roles.add(role);
    }
    requireThat(roles.has("chat"), "INVALID_SHAPE", "chat binding");
  }
  if (kind === "configurationTransition") {
    const hasProfile = Object.hasOwn(record, "profileId");
    const hasRevision = Object.hasOwn(record, "profileRevision");
    requireThat(
      hasProfile === hasRevision,
      "INVALID_SHAPE",
      "profile identity",
    );
    if (hasProfile) {
      opaque(record.profileId, "profileId");
      opaque(record.profileRevision, "profileRevision");
    }
  }
  if (kind === "event") {
    const envelope = object(record.envelope, "envelope");
    requireThat(
      record.scopeId === envelope.scopeId &&
        record.createdAt === envelope.createdAt &&
        JSON.stringify(record.sourceIds) ===
          JSON.stringify(envelope.sourceIds) &&
        record.recordId === `event:${String(envelope.eventId)}`,
      "INVALID_SHAPE",
      "event record metadata",
    );
  }
  if (kind === "action")
    requireThat(
      record.targetScopeId === context.scopeId,
      "WRONG_SCOPE",
      "targetScopeId",
    );
  if (kind === "providerRole" && record.locality === "hosted")
    reference(record.qualificationRef, "qualificationRef", context);
  if (Object.hasOwn(record, "kind"))
    requireThat(record.kind === kind, "UNKNOWN_KIND", "kind");
  return value as RecordByKind[K];
}

export function validateCursor(
  afterSeq: unknown,
  context: ContractContext,
): number {
  contextValid(context);
  uint(afterSeq, "afterSeq");
  requireThat(afterSeq <= context.lastDurableSeq, "INVALID_CURSOR", "afterSeq");
  return afterSeq;
}

export function validateCommand(
  value: unknown,
  context: ContractContext,
): SplyceCommand {
  contextValid(context);
  json(value, false);
  const command = object(value, "command");
  version(command.protocolVersion, "protocolVersion");
  shape(
    command,
    {
      protocolVersion: "uint",
      correlationId: "id",
      sessionId: "id",
      scopeId: "id",
      expectedConfigRevision: "text",
      expectedProfileRevision: "text",
      expectedPolicyRevision: "text",
      op: COMMAND_OPS,
    },
    {},
    context,
    false,
  );
  requireThat(
    Object.keys(command).every((key) =>
      [
        "protocolVersion",
        "correlationId",
        "sessionId",
        "scopeId",
        "expectedConfigRevision",
        "expectedProfileRevision",
        "expectedPolicyRevision",
        "op",
        "payload",
      ].includes(key),
    ),
    "INVALID_SHAPE",
    "unknown command field",
  );
  scope(command, context);
  requireThat(
    command.sessionId === context.sessionId,
    "WRONG_SCOPE",
    "sessionId",
  );
  current(command, "expectedConfigRevision", context.configRevision);
  current(command, "expectedProfileRevision", context.profileRevision);
  current(command, "expectedPolicyRevision", context.policyRevision);
  const op = command.op as CommandOp;
  const payload = object(command.payload, "payload");
  shape(
    payload,
    COMMAND_SCHEMAS[op],
    COMMAND_OPTIONAL[op] ?? {},
    context,
    true,
  );
  if (op === "session.subscribe") validateCursor(payload.afterSeq, context);
  return value as SplyceCommand;
}

export function validateEvent(
  value: unknown,
  context: ContractContext,
): SplyceEvent {
  contextValid(context);
  json(value, false);
  const event = object(value, "event");
  metadata(event, context);
  version(event.protocolVersion, "protocolVersion");
  shape(
    event,
    {
      eventId: "id",
      sessionId: "id",
      seq: "uint",
      durable: "bool",
      kind: EVENT_KINDS,
    },
    {},
    context,
    false,
  );
  requireThat(
    event.sessionId === context.sessionId,
    "WRONG_SCOPE",
    "sessionId",
  );
  requireThat(
    typeof event.seq === "number" && event.seq > 0,
    "INVALID_SHAPE",
    "seq",
  );
  requireThat(
    Object.keys(event).every((key) =>
      [
        "schemaVersion",
        "protocolVersion",
        "recordId",
        "eventId",
        "createdAt",
        "sourceIds",
        "scopeId",
        "sessionId",
        "seq",
        "durable",
        "kind",
        "payload",
        "payloadArtifactId",
      ].includes(key),
    ),
    "INVALID_SHAPE",
    "unknown event field",
  );
  const kind = event.kind as EventKind;
  const transient =
    kind === "turn.stream_delta" || kind === "turn.thought_delta";
  requireThat(event.durable === !transient, "INVALID_SHAPE", "durable");
  requireThat(
    Object.hasOwn(event, "payload") !==
      Object.hasOwn(event, "payloadArtifactId"),
    "INVALID_SHAPE",
    "payload",
  );
  if (Object.hasOwn(event, "payloadArtifactId"))
    reference(event.payloadArtifactId, "payloadArtifactId", context);
  else {
    requireThat(
      new TextEncoder().encode(JSON.stringify(event.payload)).byteLength <=
        context.maxInlineBytes,
      "FRAME_TOO_LARGE",
      "payload",
    );
    const payload = object(event.payload, "payload");
    const optional = EVENT_OPTIONAL[kind] ?? {};
    if (kind === "turn.failed") {
      requireThat(Object.hasOwn(payload, "error"), "INVALID_SHAPE", "error");
      shape(payload, EVENT_SCHEMAS[kind], {}, context, false);
      requireThat(
        Object.keys(payload).every((key) => key === "runId" || key === "error"),
        "INVALID_SHAPE",
        "unknown payload field",
      );
      shape(
        object(payload.error, "error"),
        {
          code: ERROR_CODES,
          message: "text",
          correlationId: "id",
          retryable: "bool",
        },
        {
          suggestedAction: [
            "RESTART_ENGINE",
            "SWITCH_PROFILE",
            "REVERT_HUNK",
            "RETRY_SAFE",
          ],
        },
        context,
        true,
      );
    } else shape(payload, EVENT_SCHEMAS[kind], optional, context, true);
    if (kind === "approval.requested")
      requireThat(
        payload.targetScope === context.scopeId,
        "WRONG_SCOPE",
        "targetScope",
      );
    if (kind === "session.tree_updated")
      requireThat(
        payload.sessionId === context.sessionId,
        "WRONG_SCOPE",
        "sessionId",
      );
    if (kind === "stream.resync") validateCursor(payload.fromSeq, context);
    if (kind === "run.reconnect_snapshot")
      validateCursor(payload.lastDurableSeq, context);
  }
  return value as SplyceEvent;
}

export function validatePortAvailability(value: unknown): PortAvailability {
  json(value, false);
  const ports = object(value, "readiness.ports");
  const keys = ["generation", "provider", "workspace", "modules"];
  requireThat(
    Object.keys(ports).length === keys.length &&
      keys.every(
        (key) => Object.hasOwn(ports, key) && typeof ports[key] === "boolean",
      ),
    "INVALID_SHAPE",
    "readiness.ports",
  );
  return Object.freeze({
    generation: ports.generation as boolean,
    provider: ports.provider as boolean,
    workspace: ports.workspace as boolean,
    modules: ports.modules as boolean,
  });
}

export function validateHandshake(value: unknown): Handshake {
  json(value, false);
  const handshake = object(value, "handshake");
  for (const key of [
    "protocolVersion",
    "schemaVersion",
    "engineProtocolVersion",
    "bridgeProtocolVersion",
  ])
    version(handshake[key], key);
  requireThat(
    Object.keys(handshake).length === 8 &&
      Object.keys(handshake).every((key) =>
        [
          "protocolVersion",
          "schemaVersion",
          "engineProtocolVersion",
          "bridgeProtocolVersion",
          "piRevision",
          "entryMode",
          "disabledBuiltinExtensions",
          "readiness",
        ].includes(key),
      ),
    "INVALID_SHAPE",
    "handshake fields",
  );
  requireThat(
    handshake.piRevision === PI_REVISION &&
      handshake.entryMode === FOUNDATION.entryMode,
    "UNSUPPORTED_VERSION",
    "foundation",
  );
  const disabled = handshake.disabledBuiltinExtensions;
  requireThat(
    Array.isArray(disabled) &&
      disabled.length === FOUNDATION.disabledBuiltinExtensions.length &&
      FOUNDATION.disabledBuiltinExtensions.every(
        (name, index) => disabled[index] === name,
      ),
    "UNSUPPORTED_VERSION",
    "disabledBuiltinExtensions",
  );
  const readiness = object(handshake.readiness, "readiness");
  requireThat(
    Object.keys(readiness).length === 5 &&
      Object.keys(readiness).every((key) =>
        ["state", "policy", "store", "receipts", "ports"].includes(key),
      ),
    "INVALID_SHAPE",
    "readiness",
  );
  requireThat(
    readiness.state === "ready" || readiness.state === "unavailable",
    "INVALID_ENUM",
    "readiness.state",
  );
  for (const key of ["policy", "store", "receipts"])
    requireThat(typeof readiness[key] === "boolean", "INVALID_SHAPE", key);
  const ports = validatePortAvailability(readiness.ports);
  requireThat(
    readiness.state === "ready" || !Object.values(ports).some(Boolean),
    "INVALID_SHAPE",
    "readiness.ports",
  );
  requireThat(
    readiness.state !== "ready" ||
      (readiness.policy === true &&
        readiness.store === true &&
        readiness.receipts === true),
    "INVALID_SHAPE",
    "readiness",
  );
  return value as Handshake;
}
