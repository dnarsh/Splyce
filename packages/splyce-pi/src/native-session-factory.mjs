import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalEndpointUrl,
  originView,
  TRANSPORT_LIMITS,
} from "../dist/contracts.js";
import { lookupPinnedModel } from "./model-catalog.mjs";
import {
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  ModelRuntime,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../../../vendor/pi/packages/coding-agent/dist/core/auth-storage.js";
import { InMemoryCodingAgentModelsStore } from "../../../vendor/pi/packages/coding-agent/dist/core/models-store.js";
import { createSplyceOwner } from "../../../vendor/pi/packages/agent/dist/splyce-readiness.js";
import { NativeControl } from "./native-control.mjs";
import { acquireNativeSessionWriter } from "./native-session-writer.mjs";
import { serializeActionArguments } from "../dist/policy.js";
import { SessionMap } from "../dist/session-map.js";
import { NativePolicy } from "../dist/policy.js";
import { NativeCredentialResolver } from "../dist/credential-resolver.js";
import { NativeProviderRequests } from "../dist/native-provider.js";
import { createNativeModelProvider } from "./native-model-provider.mjs";
import { Snapshot } from "../../../src/snapshots.ts";
import { captureNativeSnapshot } from "./native-snapshots.mjs";

const unavailable = () =>
  Object.assign(new Error("Native session unavailable"), {
    code: "NATIVE_SESSION_UNAVAILABLE",
  });
const stagedTasks = new WeakSet();

export async function stageNativeTaskArtifact({
  control,
  directory,
  workspaceId,
  text,
  assertCurrent,
  signal,
}) {
  if (
    !(control instanceof NativeControl) ||
    typeof text !== "string" ||
    !text.isWellFormed() ||
    typeof assertCurrent !== "function"
  )
    throw unavailable();
  assertCurrent();
  if (signal?.aborted) throw unavailable();
  const sanitized = (await control.redact(text, signal)).text;
  assertCurrent();
  if (signal?.aborted) throw unavailable();
  const bytes = Buffer.from(JSON.stringify({ text: sanitized }));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const artifactId = `native-task:${randomUUID()}`;
  const file = join(directory, "tasks", `${hash}.json`);
  mkdirSync(join(directory, "tasks"), { recursive: true });
  try {
    writeFileSync(file, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const verify = () => {
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      !readFileSync(file).equals(bytes)
    )
      throw unavailable();
  };
  verify();
  assertCurrent();
  const record = Object.freeze({
    schemaVersion: 1,
    recordId: artifactId,
    scopeId: workspaceId,
    createdAt: new Date().toISOString(),
    sourceIds: [],
    artifactId,
    digest: `sha256:${hash}`,
    mediaType: "application/json",
    byteLength: bytes.length,
    retentionClass: "workspace",
    locationRef: `native-task-content:${hash}`,
  });
  const staged = Object.freeze({ record, text: sanitized, verify });
  stagedTasks.add(staged);
  return staged;
}

export function commitNativePromptAdmission({
  store,
  selected,
  committed,
  manager,
  sessionMap,
  task,
  snapshot,
  ownership,
  assertCurrent,
  policyRevision,
}) {
  if (
    typeof assertCurrent !== "function" ||
    typeof policyRevision !== "string" ||
    !committed?.grantIds?.length ||
    !stagedTasks.has(task)
  )
    throw unavailable();
  assertCurrent();
  const scopeId = selected.state.workspace.workspaceId;
  const sessionId = manager.getSessionId();
  if (
    committed.result.sessionId !== sessionId ||
    ownership.workspaceId !== scopeId ||
    ownership.ownerSessionId !== sessionId
  )
    throw unavailable();
  store.assertNativeSessionStartCurrent({
    workspaceId: scopeId,
    sessionId,
    sessionRevision: committed.result.sessionRevision,
  });
  const workspace = selected.state.workspace;
  const stat = statSync(workspace.canonicalPath, { bigint: true });
  if (
    !stat.isDirectory() ||
    String(stat.dev) !== workspace.volumeSerial ||
    String(stat.ino) !== workspace.fileId
  )
    throw unavailable();
  const origin = originView(selected.endpoint);
  for (const grantId of committed.grantIds) {
    const grant = store.get(grantId).record;
    if (grant.capability === "net.provider" && grant.origin === origin)
      store.requireGrant({
        grantId,
        workspaceId: scopeId,
        sessionId,
        capability: "net.provider",
        origin,
        observedIdentity: {
          volumeSerial: String(stat.dev),
          fileId: String(stat.ino),
        },
      });
  }
  if (!committed.grantIds.some((id) => store.get(id).record.origin === origin))
    throw unavailable();
  const snapshotRecord = store.get(snapshot.recordId);
  if (
    snapshotRecord.kind !== "artifact" ||
    snapshotRecord.record.scopeId !== scopeId ||
    snapshotRecord.record.digest !== snapshot.digest ||
    snapshot.baseRevision !== snapshot.digest
  )
    throw unavailable();
  Snapshot.load(store, snapshot.recordId);
  task.verify();
  if (
    task.record.scopeId !== scopeId ||
    task.record.recordId !== task.record.artifactId
  )
    throw unavailable();
  const active = sessionMap.bind({ scopeId, sessionId }, manager);
  const epoch = selected.state.deletionEpoch;
  if (store.deletionEpoch() !== epoch) throw unavailable();
  const audit = store.audit();
  if (store.deletionEpoch() !== epoch) throw unavailable();
  const deleted = new Set(audit.deletedRecordIds);
  const runId = randomUUID(),
    turnId = randomUUID(),
    runRecordId = randomUUID();
  const refs = (ref, scope) => {
    if (scope !== scopeId) return false;
    if (
      ref === scopeId ||
      ref === sessionId ||
      ref === selected.profile.profileId ||
      ref === runId ||
      ref === runRecordId ||
      ref === turnId
    )
      return true;
    if (ref === task.record.artifactId) {
      task.verify();
      return true;
    }
    if (manager.getEntries().some((entry) => entry.id === ref)) return true;
    const matches = audit.records.filter(
      ({ record }) =>
        record.scopeId === scopeId &&
        (record.recordId === ref || record.artifactId === ref),
    );
    if (matches.length)
      return matches.length === 1 && !deleted.has(matches[0].record.recordId);
    const anchors = audit.records.filter(
      ({ kind, record }) =>
        kind === "branchAnchor" &&
        record.scopeId === scopeId &&
        record.piSessionId === sessionId &&
        record.branchAnchorId === ref,
    );
    return anchors.length > 0 && !deleted.has(anchors.at(-1).record.recordId);
  };
  const caller = {
    sessionId,
    configRevision: selected.effective.configRevision,
    profileRevision: selected.effective.profileRevision,
    policyRevision,
    resolveReference: refs,
  };
  const run = {
    schemaVersion: 1,
    recordId: runRecordId,
    createdAt: new Date().toISOString(),
    scopeId,
    sourceIds: [],
    runId,
    piSessionId: sessionId,
    branchAnchorId: active.anchor.branchAnchorId,
    workspaceId: scopeId,
    baseRevision: snapshot.baseRevision,
    baseSnapshotId: snapshot.recordId,
    taskArtifactId: task.record.artifactId,
    grantIds: [...committed.grantIds],
    profileId: selected.profile.profileId,
    profileRevision: selected.profile.profileRevision,
    roleBindingRefs: [...selected.profile.roleBindingRefs],
    state: "running",
  };
  Object.freeze(run.sourceIds);
  Object.freeze(run.grantIds);
  Object.freeze(run.roleBindingRefs);
  Object.freeze(run);
  assertCurrent();
  task.verify();
  store.appendBatch(
    [
      { kind: "artifact", record: task.record },
      { kind: "run", record: run },
    ],
    caller,
    undefined,
    { workspaceId: scopeId, epoch: ownership.epoch },
    { scopeId, revision: selected.effective.configRevision },
    undefined,
    { expectedDeletionEpoch: epoch },
  );
  return Object.freeze({
    runId,
    turnId,
    runRecordId,
    ownership,
    caller,
    run,
    task,
  });
}

export async function createNativeArgumentsArtifact({
  store,
  control,
  directory,
  workspaceId,
  caller,
  semantic,
  assertCurrent,
  signal,
}) {
  const deny = () =>
    Object.assign(new Error("Native arguments unavailable"), {
      code: "NATIVE_ARGUMENTS_UNAVAILABLE",
    });
  const exact = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  if (
    !(control instanceof NativeControl) ||
    typeof assertCurrent !== "function" ||
    !exact(semantic, [
      "schema",
      "apiFamily",
      "endpointRef",
      "model",
      "context",
      "options",
    ]) ||
    semantic.schema !== "splyce-provider-request-v1" ||
    !exact(semantic.context, [
      "messages",
      "tools",
      ...(Object.hasOwn(semantic.context ?? {}, "systemPrompt")
        ? ["systemPrompt"]
        : []),
    ]) ||
    !Array.isArray(semantic.context.messages) ||
    !Array.isArray(semantic.context.tools) ||
    !exact(semantic.options, ["model"]) ||
    !semantic.options.model
  )
    throw deny();
  const bytes = Buffer.from(serializeActionArguments(semantic));
  if (bytes.length > 4194304) throw deny();
  const snapshot = JSON.parse(bytes.toString("utf8"));
  const freeze = (value) => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  freeze(snapshot);
  const units = [
    {
      schema: snapshot.schema,
      apiFamily: snapshot.apiFamily,
      endpointRef: snapshot.endpointRef,
      model: snapshot.model,
    },
    snapshot.options.model,
    ...(snapshot.context.systemPrompt === undefined
      ? []
      : [snapshot.context.systemPrompt]),
    ...snapshot.context.messages,
    ...snapshot.context.tools,
  ];
  for (const unit of units) {
    assertCurrent();
    if (signal?.aborted) throw deny();
    const serialized = serializeActionArguments(unit);
    const result = await control.redact(serialized, signal);
    assertCurrent();
    if (
      signal?.aborted ||
      result.text !== serialized ||
      result.redactedCount !== 0
    )
      throw deny();
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const digest = `sha256:${hash}`;
  const artifactId = `native-arguments:${hash}`;
  const recordId = `native-arguments:${createHash("sha256").update(`${workspaceId}\0${hash}`).digest("hex")}`;
  const locationRef = artifactId;
  const path = join(directory, "arguments", `${hash}.json`);
  const verifyFile = () => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw deny();
    const saved = readFileSync(path);
    if (
      !saved.equals(bytes) ||
      createHash("sha256").update(saved).digest("hex") !== hash
    )
      throw deny();
  };
  const verifyRecord = () => {
    const observation = store.readSetupState(workspaceId);
    const rows = observation.records.filter(
      ({ kind, record }) => kind === "artifact" && record.recordId === recordId,
    );
    if (rows.length !== 1 || observation.deletedRecordIds.includes(recordId))
      throw deny();
    const record = rows[0].record;
    if (
      record.artifactId !== artifactId ||
      record.digest !== digest ||
      record.byteLength !== bytes.length ||
      record.mediaType !== "application/json" ||
      record.retentionClass !== "workspace" ||
      record.locationRef !== locationRef
    )
      throw deny();
    verifyFile();
  };
  assertCurrent();
  mkdirSync(join(directory, "arguments"), { recursive: true });
  try {
    writeFileSync(path, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  verifyFile();
  const existing = store
    .readSetupState(workspaceId)
    .records.some(({ record }) => record.recordId === recordId);
  if (!existing)
    store.append(
      {
        kind: "artifact",
        record: {
          schemaVersion: 1,
          recordId,
          scopeId: workspaceId,
          createdAt: new Date().toISOString(),
          sourceIds: [],
          artifactId,
          digest,
          mediaType: "application/json",
          byteLength: bytes.length,
          retentionClass: "workspace",
          locationRef,
        },
      },
      caller,
    );
  verifyRecord();
  assertCurrent();
  return Object.freeze({
    artifactId,
    digest,
    semantic: snapshot,
    verify: verifyRecord,
    resolveReference(ref, scopeId) {
      if (ref !== artifactId || scopeId !== workspaceId) return false;
      verifyRecord();
      return true;
    },
  });
}

// One coherent Store observation supplies both the selected profile and its dependencies.
export function resolveNativeSessionSelection({
  store,
  profiles,
  workspaceId,
  profileId,
  profileRevision,
  directory,
}) {
  const state = store.readSetupState(workspaceId);
  if (!state.workspace || state.workspace.workspaceId !== workspaceId)
    throw unavailable();
  const deleted = new Set(state.deletedRecordIds);
  const rows = (kind, predicate) =>
    state.records.filter(
      ({ kind: k, record }) =>
        k === kind && !deleted.has(record.recordId) && predicate(record),
    );
  const one = (kind, predicate) => {
    const found = rows(kind, predicate);
    if (found.length !== 1) throw unavailable();
    return found[0].record;
  };
  const effective = profiles.effective(workspaceId, state);
  if (
    !effective ||
    effective.profileId !== profileId ||
    effective.profileRevision !== profileRevision ||
    !effective.generationReady
  )
    throw unavailable();
  const chats = effective.bindings.filter((binding) => binding.role === "chat");
  if (chats.length !== 1) throw unavailable();
  const chat = chats[0];
  const profile = one(
    "profileSnapshot",
    (r) => r.profileId === profileId && r.profileRevision === profileRevision,
  );
  const connection = one(
    "providerConnection",
    (r) =>
      r.providerConnectionId === chat.providerConnectionId &&
      r.revision === chat.connectionRevision,
  );
  const endpoint = one(
    "providerEndpoint",
    (r) => `${r.endpointId}@${r.revision}` === connection.endpointRef,
  );
  if (
    endpoint.apiFamily !== connection.apiFamily ||
    !["openai-completions", "openai-responses"].includes(endpoint.apiFamily) ||
    canonicalEndpointUrl(endpoint.canonicalUrl, endpoint.locality) !==
      endpoint.canonicalUrl ||
    connection.locality !==
      (endpoint.locality === "loopback" ? "local" : "hosted")
  )
    throw unavailable();
  function loadDescriptor(id) {
    const record = one("artifact", (r) => r.artifactId === id);
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    if (
      record.recordId !==
        `native-descriptor:${hash(`${workspaceId}\0${id}`)}` ||
      record.scopeId !== workspaceId ||
      record.mediaType !== "application/json" ||
      record.retentionClass !== "workspace"
    )
      throw unavailable();
    const bytes = readFileSync(
      join(directory, "setup-descriptors", `${hash(record.recordId)}.json`),
    );
    if (bytes.length !== record.byteLength || hash(bytes) !== record.digest)
      throw unavailable();
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.scopeId !== workspaceId || value.schemaVersion !== 1)
      throw unavailable();
    return value;
  }
  const account = loadDescriptor(connection.accountScopeRef);
  const limits = loadDescriptor(profile.limitsArtifactId);
  if (
    !isDeepStrictEqual(account, {
      schemaVersion: 1,
      scopeId: workspaceId,
      kind: "provider-account",
      accountScope: "provider-default",
    }) ||
    !isDeepStrictEqual(limits, {
      schemaVersion: 1,
      scopeId: workspaceId,
      kind: "provider-transport-limits",
      transport: "sse",
      maxRetries: 0,
      redirects: "denied",
      maxEncodedFrameBytes: TRANSPORT_LIMITS.maxEncodedFrameBytes,
      maxRequestBytes: 4194304,
      headersTimeoutMs: 10000,
      maxSseEventBytes: 1048576,
    }) ||
    profile.egressPolicyRefs.length !== 1 ||
    !isDeepStrictEqual(loadDescriptor(profile.egressPolicyRefs[0]), {
      schemaVersion: 1,
      scopeId: workspaceId,
      kind: "provider-egress",
      origin: originView(endpoint),
      requiresNativeGrant: true,
      grants: [],
    })
  )
    throw unavailable();
  const artifact = one(
    "artifact",
    (r) =>
      profile.sourceIds.includes(r.recordId) &&
      r.role === "chat" &&
      r.modelId === chat.modelId &&
      r.mediaType === "application/vnd.splyce.model-descriptor+json",
  );
  const descriptor = artifact.descriptor;
  const bytes = JSON.stringify(descriptor);
  if (
    !descriptor ||
    artifact.artifactId !== artifact.recordId ||
    artifact.retentionClass !== "workspace" ||
    artifact.byteLength !== Buffer.byteLength(bytes) ||
    artifact.digest !==
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  )
    throw unavailable();
  const keys = [
    "source",
    "contextWindow",
    "maxOutputTokens",
    "reasoning",
    "input",
    "costKnown",
    ...(descriptor.source === "catalog" ? ["catalogVersion"] : []),
  ];
  if (
    Object.keys(descriptor).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(descriptor, key)) ||
    !["user", "catalog"].includes(descriptor.source) ||
    !Number.isSafeInteger(descriptor.contextWindow) ||
    descriptor.contextWindow <= 0 ||
    descriptor.contextWindow > 2 ** 21 ||
    !Number.isSafeInteger(descriptor.maxOutputTokens) ||
    descriptor.maxOutputTokens <= 0 ||
    descriptor.maxOutputTokens > Math.min(descriptor.contextWindow, 2 ** 20) ||
    typeof descriptor.reasoning !== "boolean" ||
    !Array.isArray(descriptor.input) ||
    descriptor.input.length === 0 ||
    descriptor.input.some((item) => item !== "text" && item !== "image") ||
    new Set(descriptor.input).size !== descriptor.input.length ||
    typeof descriptor.costKnown !== "boolean"
  )
    throw unavailable();
  let metadata;
  if (descriptor.source === "catalog") {
    const catalog = lookupPinnedModel({
      apiFamily: endpoint.apiFamily,
      endpoint: endpoint.canonicalUrl,
      modelId: chat.modelId,
    });
    if (!catalog || !isDeepStrictEqual(catalog.descriptor, descriptor))
      throw unavailable();
    metadata = catalog.metadata;
  } else if (descriptor.costKnown !== false) throw unavailable();
  const model = {
    id: chat.modelId,
    name: metadata?.name ?? chat.modelId,
    api: endpoint.apiFamily,
    provider: connection.providerConnectionId,
    baseUrl: endpoint.canonicalUrl,
    reasoning: descriptor.reasoning,
    input: [...descriptor.input],
    ...(metadata?.compat ? { compat: structuredClone(metadata.compat) } : {}),
    cost:
      metadata && descriptor.costKnown
        ? structuredClone(metadata.cost)
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxOutputTokens,
  };
  return {
    state,
    effective,
    profile,
    connection,
    endpoint,
    descriptor: structuredClone(descriptor),
    limits,
    model,
  };
}

function verifyNativeProviderCapability(
  store,
  workspaceId,
  connection,
  capability,
) {
  if (
    !capability ||
    typeof capability.capabilityId !== "string" ||
    !capability.capabilityId ||
    capability.capabilityVersion !== connection.adapterRevision
  )
    throw unavailable();
  const observation = store.readSetupState(workspaceId);
  const definitions = observation.records.filter(
    ({ kind, record }) =>
      kind === "artifact" &&
      record.artifactId === capability.capabilityId &&
      !observation.deletedRecordIds.includes(record.recordId),
  );
  const expectedDefinition = {
    kind: "native-provider-capability",
    capabilityId: capability.capabilityId,
    capabilityVersion: capability.capabilityVersion,
    apiFamily: connection.apiFamily,
    implementation: "NativeProviderRequests",
  };
  const bytes = JSON.stringify(expectedDefinition);
  if (
    definitions.length !== 1 ||
    definitions[0].record.mediaType !==
      "application/vnd.splyce.provider-capability+json" ||
    definitions[0].record.retentionClass !== "workspace" ||
    !isDeepStrictEqual(definitions[0].record.descriptor, expectedDefinition) ||
    definitions[0].record.byteLength !== Buffer.byteLength(bytes) ||
    definitions[0].record.digest !==
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  )
    throw unavailable();
}

// Private host port; no session or provider object leaves preparation.
export function createNativeSessionFactory({
  store,
  profiles,
  control,
  directory,
  providerCapability,
  currentPolicyRevision,
}) {
  if (
    !(control instanceof NativeControl) ||
    typeof currentPolicyRevision !== "function"
  )
    throw unavailable();
  const prepared = new WeakMap();
  const sessions = new Map();
  const eventListeners = new Set();
  function replay(request) {
    const capture = store.prepareNativeSessionSetup("session.start", request);
    if (!capture.replay) throw unavailable();
    const committed = store.commitNativeSessionStart(
      capture,
      undefined,
      {
        sessionId: "native-session-setup",
        configRevision: "cfg-0",
        profileRevision: "cfg-0",
        policyRevision: currentPolicyRevision(request.workspaceId),
      },
      currentPolicyRevision,
    );
    if (committed.result.readiness.code || !committed.branchAnchor)
      throw unavailable();
    store.assertNativeSessionStartCurrent({
      workspaceId: request.workspaceId,
      sessionId: committed.result.sessionId,
      sessionRevision: committed.result.sessionRevision,
    });
    return committed;
  }
  async function make(input, restored) {
    const selectionInput = {
      store,
      profiles,
      directory,
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      profileRevision: input.profileRevision,
    };
    const firstSelection = resolveNativeSessionSelection(selectionInput);
    const policyRevision = currentPolicyRevision(input.workspaceId);
    if (
      typeof policyRevision !== "string" ||
      !/^(0|[1-9][0-9]*)$/u.test(policyRevision)
    )
      throw unavailable();
    if (restored && restored.committed.result.policyRevision !== policyRevision)
      throw unavailable();
    const rawCapability =
      typeof providerCapability === "function"
        ? providerCapability(structuredClone(firstSelection))
        : providerCapability;
    if (typeof providerCapability === "function" && rawCapability === undefined)
      throw unavailable();
    if (
      rawCapability !== undefined &&
      (!rawCapability ||
        typeof rawCapability !== "object" ||
        typeof rawCapability.capabilityId !== "string" ||
        typeof rawCapability.capabilityVersion !== "string")
    )
      throw unavailable();
    const capability =
      rawCapability === undefined
        ? undefined
        : Object.freeze({
            capabilityId: rawCapability.capabilityId,
            capabilityVersion: rawCapability.capabilityVersion,
          });
    const selected = resolveNativeSessionSelection(selectionInput);
    for (const key of [
      "effective",
      "profile",
      "connection",
      "endpoint",
      "descriptor",
      "model",
      "limits",
    ])
      if (!isDeepStrictEqual(firstSelection[key], selected[key]))
        throw unavailable();
    if (
      !isDeepStrictEqual(
        firstSelection.state.workspace,
        selected.state.workspace,
      ) ||
      currentPolicyRevision(input.workspaceId) !== policyRevision
    )
      throw unavailable();
    if (capability)
      verifyNativeProviderCapability(
        store,
        input.workspaceId,
        selected.connection,
        capability,
      );
    const deletionEpoch = store.deletionEpoch();
    const audit = store.audit();
    if (
      deletionEpoch !== store.deletionEpoch() ||
      deletionEpoch !== selected.state.deletionEpoch
    )
      throw unavailable();
    const deleted = new Set(audit.deletedRecordIds);
    const identity = () => {
      const stat = statSync(selected.state.workspace.canonicalPath, {
        bigint: true,
      });
      if (
        !stat.isDirectory() ||
        String(stat.dev) !== selected.state.workspace.volumeSerial ||
        String(stat.ino) !== selected.state.workspace.fileId
      )
        throw unavailable();
    };
    const stable = () => {
      identity();
      const current = resolveNativeSessionSelection(selectionInput);
      for (const key of [
        "effective",
        "profile",
        "connection",
        "endpoint",
        "descriptor",
        "model",
        "limits",
      ])
        if (!isDeepStrictEqual(current[key], selected[key]))
          throw unavailable();
      if (!isDeepStrictEqual(current.state.workspace, selected.state.workspace))
        throw unavailable();
      if (store.deletionEpoch() !== deletionEpoch) throw unavailable();
      if (currentPolicyRevision(input.workspaceId) !== policyRevision)
        throw unavailable();
    };
    let lease, manager;
    let committed = restored?.committed;
    const checkCommitted = () => {
      if (committed)
        store.assertNativeSessionStartCurrent({
          workspaceId: input.workspaceId,
          sessionId: committed.result.sessionId,
          sessionRevision: committed.result.sessionRevision,
        });
    };
    let disposed = false;
    const owner = createSplyceOwner(() => {
      if (disposed) throw unavailable();
      stable();
      checkCommitted();
      lease?.assertCurrent();
    });
    try {
      stable();
      const sessionDir = join(
        directory,
        "sessions",
        createHash("sha256").update(input.workspaceId).digest("hex"),
      );
      if (restored) {
        if (!existsSync(sessionDir)) throw unavailable();
      } else mkdirSync(sessionDir, { recursive: true });
      const bindPersistence = (subject) =>
        owner.bindPersistence(
          subject,
          async (serialized, signal) =>
            (await control.redact(serialized, signal)).text,
        );
      if (restored) {
        const candidates = readdirSync(sessionDir).filter(
          (name) =>
            name.endsWith(`_${restored.piSessionId}.jsonl`) &&
            !name.includes("/") &&
            !name.includes("\\"),
        );
        if (candidates.length !== 1) throw unavailable();
        const file = join(sessionDir, candidates[0]);
        lease = acquireNativeSessionWriter(file);
        if (!lstatSync(file).isFile()) throw unavailable();
        manager = await SessionManager.openOwned(
          file,
          bindPersistence,
          sessionDir,
          selected.state.workspace.canonicalPath,
        );
      } else {
        manager = await SessionManager.createOwned(
          selected.state.workspace.canonicalPath,
          bindPersistence,
          sessionDir,
        );
      }
      stable();
      checkCommitted();
      const file = manager.getSessionFile();
      if (!file) throw unavailable();
      if (!restored) {
        if (existsSync(file)) throw unavailable();
        lease = acquireNativeSessionWriter(file);
        if (existsSync(file)) throw unavailable();
      }
      stable();
      const piSessionId = manager.getSessionId();
      if (restored && piSessionId !== restored.piSessionId) throw unavailable();
      const key = { scopeId: input.workspaceId, sessionId: piSessionId };
      const dynamicReferences = new Map();
      const resolveReference = (ref, scopeId) => {
        if (scopeId !== undefined && scopeId !== input.workspaceId)
          return false;
        const verify = dynamicReferences.get(ref);
        if (verify) {
          verify();
          return true;
        }
        if (ref === input.workspaceId || ref === manager.getSessionId())
          return true;
        if (manager.getEntries().some((entry) => entry.id === ref)) return true;
        const scoped = audit.records.filter(
          ({ record }) => record.scopeId === input.workspaceId,
        );
        const direct = scoped.filter(
          ({ record }) => record.recordId === ref || record.artifactId === ref,
        );
        if (direct.length)
          return direct.length === 1 && !deleted.has(direct[0].record.recordId);
        const anchors = scoped.filter(
          ({ kind, record }) =>
            kind === "branchAnchor" &&
            record.piSessionId === piSessionId &&
            record.branchAnchorId === ref,
        );
        return (
          anchors.length > 0 && !deleted.has(anchors.at(-1).record.recordId)
        );
      };
      const sessionMap = new SessionMap(store, {
        configRevision: selected.effective.configRevision,
        profileRevision: selected.effective.profileRevision,
        policyRevision,
        resolveReference,
      });
      const preview = sessionMap.preview(key, manager);
      if (
        preview.piSessionId !== piSessionId ||
        preview.scopeId !== key.scopeId ||
        preview.sessionId !== key.sessionId ||
        preview.anchor?.piSessionId !== piSessionId
      )
        throw unavailable();
      const handle = Object.freeze({});
      const result = Object.freeze({
        piSessionId,
        branchAnchor: Object.freeze(
          structuredClone(restored?.branchAnchor ?? preview.anchor),
        ),
        handle,
      });
      prepared.set(handle, {
        result,
        manager,
        owner,
        lease,
        selectionInput,
        selected,
        policyRevision,
        capability,
        deleted,
        stable,
        key,
        sessionMap,
        resolveReference,
        dynamicReferences,
        input,
        restored: !!restored,
        preview: structuredClone(preview.anchor),
        get committed() {
          return committed;
        },
        set committed(value) {
          committed = value;
        },
        dispose() {
          disposed = true;
        },
      });
      return result;
    } catch (error) {
      disposed = true;
      owner.dispose();
      lease?.close();
      if (restored && error?.code === "ENOENT") throw unavailable();
      throw error;
    }
  }
  async function prepare(input) {
    return make(input);
  }
  async function restore(input) {
    const observation = store.readSetupState(input.workspaceId);
    const receipts = observation.records.filter(
      ({ kind, record }) =>
        kind === "artifact" &&
        record.nativeSetup?.command === "session.start" &&
        record.nativeSetup.sessionId === input.piSessionId &&
        !observation.deletedRecordIds.includes(record.recordId),
    );
    if (receipts.length !== 1) throw unavailable();
    const request = receipts[0].record.nativeSetup.request;
    const committed = replay(request);
    if (
      committed.result.sessionId !== input.piSessionId ||
      committed.result.policyRevision !==
        currentPolicyRevision(input.workspaceId) ||
      !isDeepStrictEqual(committed.branchAnchor, input.branchAnchor)
    )
      throw unavailable();
    return make(
      {
        workspaceId: input.workspaceId,
        profileId: committed.profileId,
        profileRevision: committed.profileRevision,
        requestId: request.requestId,
      },
      { ...input, committed },
    );
  }
  async function initialize(state) {
    const providerCapability = state.capability;
    const verifyCapability = () =>
      verifyNativeProviderCapability(
        store,
        state.key.scopeId,
        state.selected.connection,
        providerCapability,
      );
    verifyCapability();
    const assertCurrent = () => {
      if (state.closed) throw unavailable();
      state.stable();
      verifyCapability();
      state.lease.assertCurrent();
      store.assertNativeSessionStartCurrent({
        workspaceId: state.key.scopeId,
        sessionId: state.key.sessionId,
        sessionRevision: state.committed.result.sessionRevision,
      });
      if (state.activeRun) {
        const owner = store.workspaceOwner(state.key.scopeId);
        if (
          !owner ||
          owner.ownerSessionId !== state.key.sessionId ||
          owner.epoch !== state.activeRun.ownership.epoch
        )
          throw unavailable();
      }
    };
    const identity = {
      observe(workspaceId) {
        if (workspaceId !== state.key.scopeId) throw unavailable();
        const stat = statSync(state.selected.state.workspace.canonicalPath, {
          bigint: true,
        });
        if (!stat.isDirectory()) throw unavailable();
        return { volumeSerial: String(stat.dev), fileId: String(stat.ino) };
      },
    };
    const policyCaller = {
      sessionId: state.key.sessionId,
      configRevision: state.selected.effective.configRevision,
      profileRevision: state.selected.effective.profileRevision,
      policyRevision: state.policyRevision,
      resolveReference(ref, scopeId) {
        if (scopeId !== state.key.scopeId || !state.activeRun) return false;
        const verify = state.activeRun.argumentReferences.get(ref);
        if (verify) {
          verify();
          return true;
        }
        if (state.activeRun.caller.resolveReference(ref, scopeId)) return true;
        if (store.deletionEpoch() !== state.selected.state.deletionEpoch)
          return false;
        return store
          .list(scopeId, 0, state.key.sessionId)
          .records.some(
            ({ record }) =>
              !state.deleted.has(record.recordId) &&
              (record.recordId === ref || record.actionId === ref),
          );
      },
    };
    const policy = new NativePolicy(
      store,
      policyCaller,
      () => ({
        configRevision: state.selected.effective.configRevision,
        profileRevision: state.selected.effective.profileRevision,
        policyRevision: state.policyRevision,
        grantIds: state.activeRun?.run.grantIds ?? [],
        planMode: !state.activeRun,
      }),
      identity,
    );
    let requests;
    const resolver = new NativeCredentialResolver({
      env: {},
      readCredentialStore: (target, request) =>
        requests.readCredentialStore(target, request),
    });
    resolver.register({
      providerConnectionId: state.selected.connection.providerConnectionId,
      connectionRevision: state.selected.connection.revision,
      endpointRef: state.selected.connection.endpointRef,
      egressPolicyRef: state.selected.profile.egressPolicyRefs[0],
      source: {
        kind: "credentialStore",
        target: state.selected.connection.credentialRef,
      },
    });
    const scopedControl = {
      async open(binding, signal) {
        const handle = await control.open(binding, signal);
        const active = state.activeRun;
        if (!active) {
          await handle.close();
          throw unavailable();
        }
        active.scopeCleanup.set(binding.actionId, false);
        return {
          read: () => handle.read(),
          async close() {
            await handle.close();
            active.scopeCleanup.set(binding.actionId, true);
          },
        };
      },
    };
    requests = new NativeProviderRequests(policy, resolver, scopedControl);
    const runtimeOptions = {
      credentials: AuthStorage.inMemory(),
      modelsStore: new InMemoryCodingAgentModelsStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    };
    state.owner.bind(runtimeOptions, "model-runtime-options");
    const runtime = await ModelRuntime.create(runtimeOptions);
    assertCurrent();
    const model = structuredClone(state.selected.model);
    state.owner.bind(model, "model");
    const provider = createNativeModelProvider({
      model,
      credentialRef: state.selected.connection.credentialRef,
      control,
      requests,
      admit: async ({ model: requestedModel, context, signal }) => {
        assertCurrent();
        const active = state.activeRun;
        if (
          !active ||
          signal?.aborted ||
          !isDeepStrictEqual(requestedModel, model)
        )
          throw unavailable();
        const semantic = {
          schema: "splyce-provider-request-v1",
          apiFamily: model.api,
          endpointRef: state.selected.connection.endpointRef,
          model: model.id,
          context: { ...context, tools: context.tools ?? [] },
          options: { model },
        };
        const artifact = await createNativeArgumentsArtifact({
          store,
          control,
          directory,
          workspaceId: state.key.scopeId,
          caller: active.caller,
          semantic,
          assertCurrent,
          signal,
        });
        assertCurrent();
        if (state.activeRun !== active || signal?.aborted) throw unavailable();
        active.argumentReferences.set(artifact.artifactId, artifact.verify);
        const origin = originView(state.selected.endpoint);
        const matching = active.run.grantIds.filter((id) => {
          const grant = store.get(id).record;
          return grant.capability === "net.provider" && grant.origin === origin;
        });
        if (matching.length !== 1) throw unavailable();
        const actionId = randomUUID(),
          toolCallId = randomUUID();
        const permit = {
          toolCallId,
          toolName: "provider_request",
          actionId,
          runRecordId: active.runRecordId,
          grantId: matching[0],
          parentActionId: null,
          capabilityId: providerCapability.capabilityId,
          capabilityVersion: providerCapability.capabilityVersion,
          argumentsArtifactId: artifact.artifactId,
          argumentsDigest: artifact.digest,
          targetScopeId: state.key.scopeId,
          idempotencyKey: randomUUID(),
          ownership: active.ownership,
          capability: "net.provider",
          origin,
        };
        policy.authorize(permit);
        const suffix =
          model.api === "openai-completions"
            ? "/chat/completions"
            : "/responses";
        const admittedUrl = `${state.selected.endpoint.canonicalUrl.replace(/\/$/u, "")}${suffix}`;
        const scope = requests.createScope({
          permit,
          args: artifact.semantic,
          request: {
            providerConnectionId:
              state.selected.connection.providerConnectionId,
            connectionRevision: state.selected.connection.revision,
            endpointRef: state.selected.connection.endpointRef,
            egressPolicyRef: state.selected.profile.egressPolicyRefs[0],
            actionId,
            signal,
          },
          connection: state.selected.connection,
          currentConnection: () =>
            resolveNativeSessionSelection(state.selectionInput).connection,
          admittedUrl,
          modelId: model.id,
          api: model.api,
          maxRequestBytes: state.selected.limits.maxRequestBytes,
          headersTimeoutMs: state.selected.limits.headersTimeoutMs,
          profileRevision: state.selected.effective.profileRevision,
          credentialTarget: state.selected.connection.credentialRef,
          allowLocalLoopback: state.selected.endpoint.locality === "loopback",
        });
        active.actions.push(actionId);
        return scope;
      },
      assertCurrent,
    });
    await runtime.registerNativeProvider(provider);
    assertCurrent();
    const agentDir = join(directory, "agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: state.selected.state.workspace.canonicalPath,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    state.owner.bind(settingsManager, "settings-manager");
    state.owner.bind(resourceLoader, "resource-loader");
    const options = {
      cwd: state.selected.state.workspace.canonicalPath,
      agentDir,
      model,
      modelRuntime: runtime,
      sessionManager: state.manager,
      settingsManager,
      resourceLoader,
      tools: [],
    };
    state.owner.bind(options, "sdk-options");
    const { session } = await createAgentSession(options);
    try {
      assertCurrent();
    } catch (error) {
      session.dispose();
      throw error;
    }
    return { session, policy, resolver, requests, assertCurrent };
  }
  async function bind(value) {
    const state = value && prepared.get(value.handle);
    if (!state || state.closed || state.result !== value) throw unavailable();
    state.stable();
    state.lease.assertCurrent();
    const request = {
      requestId: state.input.requestId,
      workspaceId: state.input.workspaceId,
      profileId: state.input.profileId,
      expectedConfigRevision: state.selected.effective.configRevision,
    };
    const committed = replay(request);
    if (
      committed.result.sessionId !== value.piSessionId ||
      committed.result.policyRevision !== state.policyRevision ||
      !isDeepStrictEqual(committed.branchAnchor, value.branchAnchor)
    )
      throw unavailable();
    state.committed = committed;
    const current = state.sessionMap.preview(state.key, state.manager);
    if (!isDeepStrictEqual(current.anchor, state.preview)) throw unavailable();
    const before = store.cursor();
    let initialized,
      activated = false;
    try {
      const bound = state.sessionMap.bind(state.key, state.manager);
      if (
        !isDeepStrictEqual(bound.anchor, state.preview) ||
        (!state.restored && store.cursor() !== before)
      )
        throw unavailable();
      state.stable();
      state.lease.assertCurrent();
      store.assertNativeSessionStartCurrent({
        workspaceId: state.input.workspaceId,
        sessionId: committed.result.sessionId,
        sessionRevision: committed.result.sessionRevision,
      });
      initialized = await initialize(state);
      state.runtime = initialized;
      const currentAnchor = state.sessionMap.bind(
        state.key,
        state.manager,
      ).anchor;
      const anchorRow = store
        .list(state.key.scopeId, 0, state.key.sessionId)
        .records.findLast(
          ({ kind, record }) =>
            kind === "branchAnchor" &&
            record.branchAnchorId === currentAnchor.branchAnchorId &&
            record.piSessionId === state.key.sessionId,
        );
      if (!anchorRow) throw unavailable();
      const verifyAnchor = () => {
        const actual = store.get(anchorRow.record.recordId);
        if (
          actual.kind !== "branchAnchor" ||
          actual.record.scopeId !== state.key.scopeId ||
          actual.record.piSessionId !== state.key.sessionId ||
          actual.record.branchAnchorId !== currentAnchor.branchAnchorId
        )
          throw unavailable();
        if (store.deletionEpoch() !== state.selected.state.deletionEpoch)
          throw unavailable();
      };
      state.dynamicReferences.set(anchorRow.record.recordId, verifyAnchor);
      state.dynamicReferences.set(currentAnchor.branchAnchorId, verifyAnchor);
      const entries = state.manager.getEntries();
      const parents = new Set(
        entries.map((entry) => entry.parentId).filter((id) => id !== null),
      );
      const leaves = entries
        .filter((entry) => !parents.has(entry.id))
        .map((entry) => entry.id);
      state.sessionMap.publish(state.key.sessionId, {
        schemaVersion: 1,
        protocolVersion: 2,
        recordId: anchorRow.record.recordId,
        eventId: randomUUID(),
        createdAt: new Date().toISOString(),
        sourceIds: [anchorRow.record.recordId],
        durable: true,
        kind: "session.tree_updated",
        payload: {
          sessionId: state.key.sessionId,
          branchAnchorId: currentAnchor.branchAnchorId,
          leaves,
        },
      });
      state.outbox = [];
      sessions.set(state.key.sessionId, state);
      activated = true;
    } finally {
      if (!activated) {
        initialized?.session.dispose();
        state.sessionMap.dispose(state.key);
      }
    }
  }
  async function dispose(value) {
    const state = value && prepared.get(value.handle);
    if (!state || state.result !== value) throw unavailable();
    if (state.closed) return;
    if (state.disposing) return state.disposing;
    state.disposing = (async () => {
      let failure;
      try {
        if (state.preparing) {
          state.preflightAbort.abort();
          await state.preflightDone;
        }
        if (state.activeRun) {
          const active = state.activeRun;
          active.controller.abort();
          await state.runtime.session.abort();
          await active.promise;
          if (state.deliveryError) throw state.deliveryError;
        }
      } catch (error) {
        failure = error;
      } finally {
        sessions.delete(state.key.sessionId);
        state.sessionMap.dispose(state.key);
        try {
          state.runtime?.session.dispose();
        } catch (error) {
          failure ??= error;
        }
        state.closed = true;
        state.dispose();
        try {
          state.owner.dispose();
        } catch (error) {
          failure ??= error;
        }
        try {
          state.lease.close();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    })();
    return state.disposing;
  }
  function onEvents(listener) {
    if (typeof listener !== "function") throw unavailable();
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  }
  function live(sessionId) {
    const state = sessions.get(sessionId);
    if (!state || state.closed || state.deliveryError) throw unavailable();
    state.runtime.assertCurrent();
    return state;
  }
  function publish(state, active, kind, payload, durable, receipts = []) {
    const published = state.sessionMap.publish(
      state.key.sessionId,
      {
        schemaVersion: 1,
        protocolVersion: 2,
        recordId: active.runRecordId,
        eventId: randomUUID(),
        createdAt: new Date().toISOString(),
        sourceIds: [active.runRecordId],
        durable,
        kind,
        payload,
      },
      receipts,
    );
    if (published.frame) state.outbox = [published.frame.event];
    for (const listener of eventListeners) {
      try {
        listener(state.key.sessionId);
      } catch (error) {
        state.deliveryError = error;
      }
    }
  }
  async function runPrompt(state, active) {
    let terminal;
    try {
      state.runtime.assertCurrent();
      if (active.controller.signal.aborted) throw unavailable();
      await state.runtime.session.prompt(active.task.text, {
        expandPromptTemplates: false,
      });
      if (active.controller.signal.aborted) throw unavailable();
      state.runtime.assertCurrent();
      const message = state.runtime.session.messages.at(-1);
      if (
        !message ||
        message.role !== "assistant" ||
        !["stop", "length"].includes(message.stopReason) ||
        !active.actions.length
      )
        throw unavailable();
      const history = store.list(
        state.key.scopeId,
        0,
        state.key.sessionId,
      ).records;
      for (const actionId of active.actions) {
        const action = history.findLast(
          ({ kind, record }) =>
            kind === "action" && record.actionId === actionId,
        )?.record;
        const outcome = history.findLast(
          ({ kind, record }) =>
            kind === "outcome" && record.actionId === actionId,
        )?.record;
        if (
          action?.state !== "completed" ||
          outcome?.effectState !== "observed-success"
        )
          throw unavailable();
      }
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const redacted = await control.redact(text, active.controller.signal);
      state.runtime.assertCurrent();
      const candidate = await captureNativeSnapshot({
        store,
        workspace: state.selected.state.workspace,
        caller: { ...active.caller, scopeId: state.key.scopeId },
        assertCurrent: state.runtime.assertCurrent,
        control,
        signal: active.controller.signal,
      });
      state.runtime.assertCurrent();
      state.dynamicReferences.set(candidate.recordId, () => {
        const row = store.get(candidate.recordId);
        if (
          row.record.scopeId !== state.key.scopeId ||
          row.record.digest !== candidate.digest
        )
          throw unavailable();
        Snapshot.load(store, candidate.recordId);
      });
      for (let start = 0; start < redacted.text.length;) {
        let end = Math.min(start + 8192, redacted.text.length);
        if (
          end < redacted.text.length &&
          /[\uD800-\uDBFF]/u.test(redacted.text[end - 1])
        )
          end--;
        publish(
          state,
          active,
          "turn.stream_delta",
          {
            runId: active.runId,
            turnId: active.turnId,
            delta: redacted.text.slice(start, end),
          },
          false,
        );
        start = end;
      }
      terminal = {
        kind: "turn.completed",
        payload: {
          runId: active.runId,
          candidateSnapshotId: candidate.recordId,
          finalRevision: candidate.baseRevision,
        },
        state: "completed",
      };
    } catch (error) {
      const clean = active.actions.every(
        (actionId) => active.scopeCleanup.get(actionId) === true,
      );
      terminal =
        active.controller.signal.aborted && clean
          ? {
              kind: "turn.canceled",
              payload: { runId: active.runId, cleanedUp: true },
              state: "canceled",
            }
          : {
              kind: "turn.failed",
              payload: {
                runId: active.runId,
                error: {
                  code: "UNCERTAIN_EFFECT",
                  message: "The run could not be completed.",
                  correlationId: active.correlationId,
                  retryable: false,
                },
              },
              state: "failed",
            };
      active.error = error;
    }
    state.finishing = true;
    try {
      store.releaseWorkspace(
        state.key.scopeId,
        state.key.sessionId,
        active.ownership.epoch,
      );
      state.activeRun = undefined;
      const record = {
        ...active.run,
        recordId: randomUUID(),
        state: terminal.state,
      };
      publish(state, active, terminal.kind, terminal.payload, true, [
        { kind: "run", record },
      ]);
      active.completed = terminal.kind;
    } finally {
      state.finishing = false;
    }
  }
  async function preparePrompt(command, signal) {
    const state = live(command?.sessionId);
    if (
      command.op !== "session.prompt" ||
      command.scopeId !== state.key.scopeId ||
      command.expectedConfigRevision !==
        state.selected.effective.configRevision ||
      command.expectedProfileRevision !==
        state.selected.effective.profileRevision ||
      command.expectedPolicyRevision !== state.policyRevision ||
      typeof command.payload?.text !== "string" ||
      (command.payload.contextArtifactIds?.length ?? 0) !== 0 ||
      state.activeRun ||
      state.preparing ||
      state.finishing ||
      signal?.aborted
    )
      throw unavailable();
    state.preparing = true;
    state.preflightAbort = new AbortController();
    const preflightSignal = signal
      ? AbortSignal.any([signal, state.preflightAbort.signal])
      : state.preflightAbort.signal;
    let finishPreflight;
    state.preflightDone = new Promise((resolve) => {
      finishPreflight = resolve;
    });
    let ownership, active;
    try {
      ownership = store.acquireWorkspace(
        state.key.scopeId,
        state.key.sessionId,
      );
      const assertCurrent = () => {
        state.runtime.assertCurrent();
        const owner = store.workspaceOwner(state.key.scopeId);
        if (
          !owner ||
          owner.ownerSessionId !== state.key.sessionId ||
          owner.epoch !== ownership.epoch ||
          preflightSignal.aborted
        )
          throw unavailable();
      };
      const snapshot = await captureNativeSnapshot({
        store,
        workspace: state.selected.state.workspace,
        caller: {
          sessionId: state.key.sessionId,
          scopeId: state.key.scopeId,
          configRevision: state.selected.effective.configRevision,
          profileRevision: state.selected.effective.profileRevision,
          policyRevision: state.policyRevision,
          resolveReference: state.resolveReference,
        },
        assertCurrent,
        control,
        signal: preflightSignal,
      });
      const task = await stageNativeTaskArtifact({
        control,
        directory,
        workspaceId: state.key.scopeId,
        text: command.payload.text,
        assertCurrent,
        signal: preflightSignal,
      });
      const admission = commitNativePromptAdmission({
        store,
        selected: state.selected,
        committed: state.committed,
        manager: state.manager,
        sessionMap: state.sessionMap,
        task,
        snapshot,
        ownership,
        assertCurrent,
        policyRevision: state.policyRevision,
      });
      active = {
        ...admission,
        controller: new AbortController(),
        argumentReferences: new Map(),
        scopeCleanup: new Map(),
        actions: [],
        correlationId: command.correlationId,
      };
      state.activeRun = active;
      for (const id of [
        snapshot.recordId,
        task.record.artifactId,
        active.run.profileId,
        ...active.run.grantIds,
        ...active.run.roleBindingRefs,
        active.run.branchAnchorId,
      ]) {
        state.dynamicReferences.set(id, () => {
          if (!active.caller.resolveReference(id, state.key.scopeId))
            throw unavailable();
          if (id === task.record.artifactId) {
            const record = store.get(task.record.recordId);
            if (
              record.kind !== "artifact" ||
              record.record.digest !== task.record.digest
            )
              throw unavailable();
          }
        });
      }
      for (const id of [active.runId, active.runRecordId, active.turnId])
        state.dynamicReferences.set(id, () => {
          const row = store.get(active.runRecordId);
          if (
            row.kind !== "run" ||
            row.record.runId !== active.runId ||
            row.record.scopeId !== state.key.scopeId
          )
            throw unavailable();
        });
      active.promise = Promise.resolve()
        .then(() => runPrompt(state, active))
        .catch((error) => {
          state.deliveryError = error;
          for (const listener of eventListeners) {
            try {
              listener(state.key.sessionId);
            } catch (notificationError) {
              state.deliveryError = notificationError;
            }
          }
        });
      publish(
        state,
        active,
        "turn.started",
        { runId: active.runId, turnId: active.turnId },
        true,
      );
      return { accepted: true, runId: active.runId, turnId: active.turnId };
    } catch (error) {
      if (active) {
        active.controller.abort();
        await active.promise;
      } else if (ownership)
        store.releaseWorkspace(
          state.key.scopeId,
          state.key.sessionId,
          ownership.epoch,
        );
      throw error;
    } finally {
      state.preparing = false;
      finishPreflight();
    }
  }
  async function cancel({ sessionId }) {
    const state = sessions.get(sessionId);
    if (!state || state.closed) throw unavailable();
    const active = state.activeRun;
    if (!active) {
      if (!state.preparing) throw unavailable();
      state.preflightAbort.abort();
      await state.preflightDone;
      if (store.workspaceOwner(state.key.scopeId)?.ownerSessionId === sessionId)
        throw unavailable();
      return { canceled: true };
    }
    active.controller.abort();
    await state.runtime.session.abort();
    await active.promise;
    if (state.deliveryError || active.completed !== "turn.canceled")
      throw unavailable();
    return { canceled: true };
  }
  function subscribe(sessionId, afterSeq) {
    const state = live(sessionId);
    const followed = state.sessionMap.follow(state.key, afterSeq);
    state.channel = followed.channel;
    state.outbox = [...followed.replay];
    return { sessionId, scopeId: state.key.scopeId, afterSeq };
  }
  function unsubscribe(sessionId) {
    const state = live(sessionId);
    state.sessionMap.unfollow(state.key);
    state.channel = undefined;
    state.outbox = [];
  }
  function drainEvents(sessionId) {
    const state = live(sessionId);
    if (!state.channel) throw unavailable();
    if (state.deliveryError) throw state.deliveryError;
    if (state.outbox.length) {
      const frames = [];
      let bytes = 0;
      while (
        state.outbox.length &&
        frames.length < TRANSPORT_LIMITS.rendererMaxFrames
      ) {
        const next = state.outbox[0];
        const size = Buffer.byteLength(JSON.stringify(next)) + 4;
        if (bytes + size > TRANSPORT_LIMITS.rendererMaxBytes) break;
        frames.push(state.outbox.shift());
        bytes += size;
      }
      if (!frames.length) throw unavailable();
      return {
        frames,
        morePending:
          state.outbox.length > 0 ||
          state.channel.bridge.status().pendingFrames > 0,
      };
    }
    const drained = state.channel.bridge.drain();
    return {
      frames: drained.frames.map((frame) => frame.event),
      morePending: drained.morePending,
    };
  }
  return Object.freeze({
    prepare,
    restore,
    bind,
    dispose,
    preparePrompt,
    cancel,
    onEvents,
    subscribe,
    unsubscribe,
    drainEvents,
    get hasReadySession() {
      for (const state of sessions.values()) {
        if (state.deliveryError) continue;
        try {
          state.runtime.assertCurrent();
          return true;
        } catch (error) {
          state.deliveryError ??= error;
        }
      }
      return false;
    },
  });
}
