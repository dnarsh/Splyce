import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { RevisionFence } from "../dist/admission.js";
import { ConfigAuthority } from "../dist/config.js";
import { createProviderProfiles } from "../dist/provider-profiles.js";
import { Receipts } from "../dist/receipts.js";
import { createNativeProviderSetup } from "./native-provider-setup.mjs";
import { createNativeSessionSetup } from "./native-session-setup.mjs";
import { NativeControl } from "./native-control.mjs";
import { PI_REVISION } from "../dist/contracts.js";
import {
  NATIVE_POLICY_REVISION,
  currentNativePolicyRevision,
} from "../dist/policy.js";
import {
  INITIAL_CONFIG_REVISION,
  Store,
  workspaceView,
} from "../dist/store.js";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function opaqueId(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /\s|[\\/]/u.test(value)
  )
    fail("NATIVE_INVALID_ID");
}

function lazyFactory(options) {
  let instance;
  let loading;
  const listeners = new Set();
  const get = async () => {
    loading ??= import("./native-session-factory.mjs").then(
      ({ createNativeSessionFactory }) => {
        instance = createNativeSessionFactory(options);
        for (const listener of listeners)
          listener.release = instance.onEvents?.(listener.fn);
        return instance;
      },
    );
    return loading;
  };
  const existing = () => {
    if (!instance) fail("NATIVE_SESSION_UNAVAILABLE");
    return instance;
  };
  return {
    get hasReadySession() {
      return instance?.hasReadySession === true;
    },
    onEvents(fn) {
      const listener = { fn, release: instance?.onEvents?.(fn) };
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        listener.release?.();
      };
    },
    async prepare(...args) {
      return (await get()).prepare(...args);
    },
    async restore(...args) {
      return (await get()).restore(...args);
    },
    bind(...args) {
      return existing().bind(...args);
    },
    dispose(...args) {
      return existing().dispose(...args);
    },
    preparePrompt(...args) {
      return existing().preparePrompt(...args);
    },
    cancel(...args) {
      return existing().cancel(...args);
    },
    subscribe(...args) {
      return existing().subscribe(...args);
    },
    unsubscribe(...args) {
      return existing().unsubscribe(...args);
    },
    drainEvents(...args) {
      return existing().drainEvents(...args);
    },
  };
}

// Private entrypoint: only Rust's first bootstrap frame supplies this path.
export function createNativeHost(appDataDir, nativeControl, sessionFactory) {
  if (
    typeof appDataDir !== "string" ||
    !isAbsolute(appDataDir) ||
    !appDataDir.isWellFormed() ||
    appDataDir.includes("\0") ||
    (process.platform === "win32" &&
      !/^[A-Za-z]:[\\/]/u.test(appDataDir.replace(/^\\\\\?\\/u, "")))
  )
    fail("NATIVE_APP_DATA_INVALID");
  if (process.platform === "win32")
    appDataDir = appDataDir.replace(/^\\\\\?\\/u, "");
  const directory = join(appDataDir, "splyce");
  mkdirSync(directory, { recursive: true });
  const store = Store.open(join(directory, "store.db"));
  const config = new ConfigAuthority(store);
  const receipts = new Receipts(store);
  const profiles = createProviderProfiles({ store, config });
  const providerSetup = createNativeProviderSetup(store, directory);
  const providerCapability = (selected) => {
    const workspaceId = selected.state.workspace.workspaceId;
    const { apiFamily, adapterRevision } = selected.connection;
    if (
      !["openai-completions", "openai-responses"].includes(apiFamily) ||
      adapterRevision !== PI_REVISION
    )
      fail("NATIVE_CAPABILITY_UNAVAILABLE");
    const capabilityId = `native-provider:${apiFamily}:${adapterRevision}`;
    const descriptor = {
      kind: "native-provider-capability",
      capabilityId,
      capabilityVersion: adapterRevision,
      apiFamily,
      implementation: "NativeProviderRequests",
    };
    const bytes = Buffer.from(JSON.stringify(descriptor));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const recordId = `native-capability:${createHash("sha256").update(`${workspaceId}\0${capabilityId}`).digest("hex")}`;
    const observe = () => {
      const state = store.readSetupState(workspaceId);
      const rows = state.records.filter(
        ({ record }) =>
          record.recordId === recordId || record.artifactId === capabilityId,
      );
      return { state, rows };
    };
    const observation = observe();
    if (observation.rows.length === 0)
      store.appendBatch(
        [
          {
            kind: "artifact",
            record: {
              schemaVersion: 1,
              recordId,
              artifactId: capabilityId,
              scopeId: workspaceId,
              createdAt: new Date().toISOString(),
              sourceIds: [],
              mediaType: "application/vnd.splyce.provider-capability+json",
              retentionClass: "workspace",
              digest,
              byteLength: bytes.length,
              descriptor,
            },
          },
        ],
        {
          sessionId: "native-capability-registration",
          configRevision: selected.effective.configRevision,
          profileRevision: selected.effective.profileRevision,
          policyRevision: currentNativePolicyRevision(workspaceId),
        },
        undefined,
        undefined,
        { scopeId: workspaceId, revision: selected.effective.configRevision },
        undefined,
        { expectedDeletionEpoch: observation.state.deletionEpoch },
      );
    const { state, rows } = observe();
    const record = rows[0]?.record;
    if (
      rows.length !== 1 ||
      rows[0].kind !== "artifact" ||
      state.deletedRecordIds.includes(recordId) ||
      record.recordId !== recordId ||
      record.artifactId !== capabilityId ||
      record.scopeId !== workspaceId ||
      record.digest !== digest ||
      record.byteLength !== bytes.length ||
      record.retentionClass !== "workspace" ||
      record.mediaType !== "application/vnd.splyce.provider-capability+json" ||
      JSON.stringify(record.descriptor) !== JSON.stringify(descriptor)
    )
      fail("NATIVE_CAPABILITY_UNAVAILABLE");
    return Object.freeze({ capabilityId, capabilityVersion: adapterRevision });
  };
  const factory =
    sessionFactory ??
    (nativeControl instanceof NativeControl
      ? lazyFactory({
          store,
          profiles,
          control: nativeControl,
          directory,
          providerCapability,
          currentPolicyRevision: currentNativePolicyRevision,
        })
      : undefined);
  const sessions = createNativeSessionSetup({
    store,
    control: nativeControl,
    factory,
    currentPolicyRevision: currentNativePolicyRevision,
  });
  try {
    store.audit();
    receipts.durableCursor();
    mkdirSync(join(directory, "snapshots"), { recursive: true });
  } catch (error) {
    store.close();
    throw error;
  }

  function fence(scopeId, profileId) {
    opaqueId(scopeId);
    if (profileId !== undefined) opaqueId(profileId);
    const observation = store.readAuthority(scopeId);
    const { records, deletedRecordIds } = observation;
    const applied = records.filter(
      ({ kind, record }) =>
        kind === "configurationTransition" && record.state === "applied",
    );
    const latest = applied.at(-1)?.record;
    const selected = applied.findLast(
      ({ record }) => record.profileId !== undefined,
    )?.record;
    if (
      [latest, selected].some(
        (record) => record && deletedRecordIds.includes(record.recordId),
      )
    )
      fail("NATIVE_CONFIG_UNAVAILABLE");
    const revision = latest?.acceptedConfigRevision ?? INITIAL_CONFIG_REVISION;
    if (profileId !== undefined && selected?.profileId !== profileId)
      fail(selected ? "NATIVE_PROFILE_STALE" : "NATIVE_PROFILE_UNAVAILABLE");
    if (selected) {
      const snapshot = records.find(
        ({ kind, record }) =>
          kind === "profileSnapshot" &&
          record.profileId === selected.profileId &&
          record.profileRevision === selected.profileRevision,
      );
      if (!snapshot || deletedRecordIds.includes(snapshot.record.recordId))
        fail("NATIVE_PROFILE_UNAVAILABLE");
    }
    const effective = profiles.effective(scopeId, observation);
    const profileRevision =
      effective?.profileRevision ?? INITIAL_CONFIG_REVISION;
    // This host has no runnable grant dispatch; history never creates authority.
    return new RevisionFence(
      { effectiveRevision: () => revision },
      {
        scopeId,
        profileRevision,
        policyRevision: currentNativePolicyRevision(scopeId),
        grantIds: [],
        planMode: true,
      },
    );
  }

  return Object.freeze({
    get handshakeReadiness() {
      receipts.durableCursor();
      return Object.freeze({
        state: "ready",
        policy: true,
        store: true,
        receipts: true,
        ports: Object.freeze({
          generation: factory?.hasReadySession === true,
          provider: factory?.hasReadySession === true,
          workspace: false,
          modules: false,
        }),
      });
    },
    current(scopeId, profileId) {
      return fence(scopeId, profileId).current();
    },
    assertCurrent(scopeId, queued, profileId) {
      fence(scopeId, profileId).assertCurrent(queued);
    },
    listWorkspaces() {
      return store.listWorkspaceViews();
    },
    admitWorkspace(input) {
      return workspaceView(
        store.admitWorkspace(input, {
          sessionId: "native-workspace-admission",
          configRevision: INITIAL_CONFIG_REVISION,
          profileRevision: INITIAL_CONFIG_REVISION,
          policyRevision: NATIVE_POLICY_REVISION,
        }),
      );
    },
    resolveWorkspace(id) {
      opaqueId(id);
      return store
        .listWorkspaces()
        .find(({ workspaceId }) => workspaceId === id);
    },
    prepareProviderSetup: providerSetup.prepare,
    commitProviderSetup: providerSetup.commit,
    readProviderSetup: providerSetup.read,
    readSetup(input, requestId, signal) {
      return sessions.handle("setup.read", input, requestId, signal);
    },
    selectProfile(input, requestId, signal) {
      return sessions.handle("profile.select", input, requestId, signal);
    },
    startSession(input, requestId, signal) {
      return sessions.handle("session.start", input, requestId, signal);
    },
    preparePrompt(command, signal) {
      if (!factory?.preparePrompt) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.preparePrompt(command, signal);
    },
    cancelSession(input) {
      if (!factory?.cancel) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.cancel(input);
    },
    subscribeSession(sessionId, afterSeq) {
      if (!factory?.subscribe) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.subscribe(sessionId, afterSeq);
    },
    unsubscribeSession(sessionId) {
      if (!factory?.unsubscribe) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.unsubscribe(sessionId);
    },
    drainSessionEvents(sessionId) {
      if (!factory?.drainEvents) fail("NATIVE_SESSION_UNAVAILABLE");
      return factory.drainEvents(sessionId);
    },
    onSessionEvents(listener) {
      return factory?.onEvents?.(listener) ?? (() => {});
    },
    async shutdown() {
      try {
        await sessions.close();
      } finally {
        store.close();
      }
    },
    close() {
      if (factory) fail("NATIVE_ASYNC_SHUTDOWN_REQUIRED");
      store.close();
    },
  });
}
