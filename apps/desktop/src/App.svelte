<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type {
    Handshake,
    PortAvailability,
    SplyceEvent,
  } from "@splyce/pi/contracts";
  import Composer from "./components/Composer.svelte";
  import SessionTree from "./components/SessionTree.svelte";
  import SessionActions from "./components/SessionActions.svelte";
  import TurnStream from "./components/TurnStream.svelte";
  import Shell from "./components/shell/Shell.svelte";
  import UsageView from "./components/usage/UsageView.svelte";
  import ApprovalSurface from "./components/ApprovalSurface.svelte";
  import PermissionModeSelect from "./components/PermissionModeSelect.svelte";
  import SupportStatus from "./components/SupportStatus.svelte";
  import Providers from "./routes/Providers.svelte";
  import Setup from "./routes/Setup.svelte";
  import Modules from "./routes/Modules.svelte";
  import { unavailableModuleSnapshot } from "./stores/modules";
  import type {
    ApprovalContext,
    ApprovalRequestView,
  } from "./stores/approvals";
  import {
    initialPermissionMode,
    type PermissionModeContext,
  } from "./stores/permission-mode";
  import {
    connectionState,
    cancelSession,
    handshake,
    invoke,
    onEvent,
    portAvailability,
    selectWorkspace,
    sendSetup,
    subscribe,
    type EngineConnectionState,
    type SelectedWorkspace,
  } from "./stores/engine";
  import {
    configuredProfileResult,
    profileSelectPayload,
    providerConfigurePayload,
    sessionStartPayload,
    setupErrorCopy,
    validateProfileSelectionResult,
    validateSessionStartResult,
    validateSetupReadResult,
    type ConfiguredProfile,
    type ProfileSelectionResult,
    type ProviderSetupDraft,
    type SessionStartResult,
  } from "./stores/profiles";
  import {
    bindSelection,
    clearSession,
    selectedSession,
    selectSession,
    type BindingStatus,
  } from "./stores/session-selection";
  import {
    createSessionNav,
    reduceSessionNav,
    visibleNodes,
    type SessionNavAction,
    type SessionNavState,
    type TreeEventLike,
  } from "./stores/sessions";
  import type { SessionActionsContext } from "./stores/session-actions";
  import {
    createTurnStreamTransport,
    createTurnsState,
    type TurnsState,
  } from "./stores/turns";

  type View = "conversation" | "setup" | "modules" | "providers" | "usage";
  const VIEWS: readonly (readonly [View, string])[] = [
    ["conversation", "Conversation"],
    ["setup", "Setup"],
    ["modules", "Modules"],
    ["providers", "Providers"],
    ["usage", "Usage"],
  ];

  // No setup/module service is connected: the screens stay honest and disabled
  // instead of implying a catalog, plan or installation.
  const moduleSnapshot = unavailableModuleSnapshot(
    "No setup or module service is connected.",
  );

  // TD-30: the turns store carries tool-call approvals for the inline
  // ApprovalCard, but no request carries the config/profile/policy revisions it
  // was issued against, and the dialog must not ask about a target it cannot
  // verify. The surface therefore shows only requests with a known revision:
  // there are none today, so the shell never claims an approval is pending.
  const approvalRequests: readonly ApprovalRequestView[] = [];
  const approvalContext: ApprovalContext = {
    engine: "unavailable",
    engineReason: "Session revisions are not delivered to the renderer yet.",
    sessionId: null,
    scopeId: null,
    runId: null,
    actionId: null,
    targetScope: null,
    normalizedTarget: null,
    revision: null,
    runCanceled: false,
    nowMs: 0,
  };

  // TD-30 Supervisor: a mode change is engine-admitted, and without the session
  // revisions it cannot be admitted at all. The selector is visibly disabled
  // with that reason instead of pretending a selection could take effect.
  const permissionContext: PermissionModeContext = {
    engine: "unavailable",
    engineReason: "Session revisions are not delivered to the renderer yet",
    configRevision: null,
    policyRevision: null,
  };

  // Snapshot seam: the only thing allowed to complete a session load. Readiness proves nothing about sessions.
  let {
    loadSessions,
  }: { loadSessions?: () => Promise<readonly SplyceEvent[]> } = $props();

  let view = $state<View>("conversation");
  let nav = $state.raw<SessionNavState>(createSessionNav());
  // sessionId -> scopeId, as carried by the engine's own events; never invented.
  const scopes = new Map<string, string>();
  const dispatchNav = (action: SessionNavAction) => {
    nav = untrack(() => reduceSessionNav(nav, action));
  };

  let status = $state<EngineConnectionState>("disconnected");
  let readiness = $state<Handshake["readiness"] | null>(null);
  let ports = $state<PortAvailability | null>(null);
  let startedSession = $state<SessionStartResult | null>(null);
  let sessionPortWitness = $state(false);
  let generationReady = $derived(
    ports === null || (startedSession !== null && !sessionPortWitness)
      ? undefined
      : ports.generation && ports.provider,
  );
  let engineConnected = $state(false);
  // Only the id and display name of the admitted project; never its path or selection ref.
  let workspace = $state<SelectedWorkspace | null>(null);
  let choosing = $state(false);
  let chooserError = $state<string | null>(null);
  let profiles = $state<ConfiguredProfile[]>([]);
  let profileSelection = $state<ProfileSelectionResult | null>(null);
  let startReplay: { requestId: string; payload: ReturnType<typeof sessionStartPayload> } | null = null;
  let activeRunId = $state<string | null>(null);
  let cancelPending = $state(false);
  let profilePending = $state(false);
  let configuring = $state(false);
  let profileStatus = $state<string | null>(null);
  let setupEpoch = 0;

  function invalidateSetup() {
    setupEpoch++;
    sessionPortWitness = false;
    startReplay = null;
    activeRunId = null;
    cancelPending = false;
    profiles = [];
    profileSelection = null;
    startedSession = null;
    profilePending = false;
    configuring = false;
    profileStatus = null;
  }
  const chooserReason = $derived(
    readiness?.state === "ready"
      ? null
      : "The engine is not connected. A project cannot be chosen yet.",
  );
  const providerUnavailable = $derived(
    profilePending || configuring
      ? "Provider setup is already in progress."
      : readiness?.state !== "ready"
      ? "The engine is not connected. Nothing can be saved."
      : workspace === null
        ? "Choose a project first. Provider setup is saved for a project."
        : undefined,
  );

  async function chooseProject() {
    if (choosing || chooserReason) return;
    choosing = true;
    chooserError = null;
    try {
      const chosen = await selectWorkspace();
      // Cancel (null) keeps the current project.
      if (chosen && chosen.workspaceId !== workspace?.workspaceId) {
        invalidateSetup();
        clearSession();
        workspace = chosen;
        void readSetup(chosen);
      }
    } catch {
      chooserError = "Could not open the project. Nothing changed.";
    } finally {
      choosing = false;
    }
  }

  async function readSetup(project: SelectedWorkspace) {
    const epoch = ++setupEpoch;
    const requestId = crypto.randomUUID();
    try {
      const result = validateSetupReadResult(await sendSetup("setup.read", requestId, {
        requestId, workspaceId: project.workspaceId,
      }));
      if (epoch !== setupEpoch) return;
      profiles = result.profiles;
      profileSelection = result.selection;
      startedSession = null;
      profileStatus = "Saved profiles loaded. Start a session before sending.";
    } catch {
      if (epoch === setupEpoch) profileStatus = "Saved profiles could not be loaded.";
    }
  }

  // The secret lives only in this one send; the payload object is not kept.
  async function configureProvider(draft: ProviderSetupDraft) {
    if (!workspace || readiness?.state !== "ready" || configuring || profilePending)
      throw new Error("Setup unavailable");
    const project = workspace;
    const epoch = ++setupEpoch;
    configuring = true;
    profileSelection = null;
    startedSession = null;
    profileStatus = null;
    const requestId = crypto.randomUUID();
    try {
      const result = configuredProfileResult(
        await sendSetup(
          "provider.configure",
          requestId,
          providerConfigurePayload(draft, project.workspaceId, requestId),
        ),
      );
      if (epoch !== setupEpoch) throw { code: "WORKSPACE_SUPERSEDED" };
      profiles = [
        ...profiles
          .filter((p) => p.profileId !== result.profileId)
          .map((p) => ({ ...p, configRevision: result.configRevision })),
        result,
      ];
    } finally {
      if (epoch === setupEpoch) configuring = false;
    }
  }

  async function useProfile(profile: ConfiguredProfile) {
    if (!workspace || readiness?.state !== "ready" || profilePending || configuring || profile.credential === "missing") return;
    const project = workspace;
    const epoch = ++setupEpoch;
    profilePending = true;
    sessionPortWitness = false;
    startReplay = null;
    activeRunId = null;
    profileSelection = null;
    startedSession = null;
    profileStatus = "Selecting profile…";
    try {
      const requestId = crypto.randomUUID();
      const selected = validateProfileSelectionResult(
        await sendSetup(
          "profile.select",
          requestId,
          profileSelectPayload(profile, project.workspaceId, requestId),
        ),
      );
      if (epoch !== setupEpoch) return;
      if (selected.selectedProfileId !== profile.profileId)
        throw new Error("Invalid selection");
      profileSelection = selected;
      clearSession();
      profiles = profiles.map((p) => ({
        ...p,
        configRevision: selected.configRevision,
        ...(p.profileId === selected.selectedProfileId && {
          profileRevision: selected.profileRevision,
        }),
      }));
      // A saved profile never proves session readiness. Only this native receipt can.
      profileStatus = "Starting session…";
      const startRequestId = crypto.randomUUID();
      const startPayload = sessionStartPayload(selected, project.workspaceId, startRequestId);
      const started = validateSessionStartResult(
        await sendSetup("session.start", startRequestId, startPayload),
      );
      if (epoch !== setupEpoch) return;
      startedSession = started;
      startReplay = { requestId: startRequestId, payload: startPayload };
      if (started.readiness.state === "ready") {
        profileStatus = "Checking engine readiness…";
        try {
          const verified = await handshake();
          if (epoch !== setupEpoch) return;
          readiness = verified.readiness;
          sessionPortWitness = true;
          selectSession({ sessionId: started.sessionId, scopeId: project.workspaceId });
          profileStatus = "Profile selected. Session ready.";
        } catch {
          if (epoch !== setupEpoch) return;
          profileStatus = "Profile selected. Engine readiness could not be confirmed. Sending stays blocked.";
        }
      } else {
        profileStatus = "Profile selected. The session is unavailable. Sending stays blocked.";
      }
    } catch (error) {
      if (epoch === setupEpoch) {
        startedSession = null;
        profileStatus = profileSelection
          ? `Profile selected. Session could not be started. ${setupErrorCopy(error)}`
          : setupErrorCopy(error);
      }
    } finally {
      if (epoch === setupEpoch) profilePending = false;
    }
  }
  function isOpaqueId(value: string) {
    return !/[\uD800-\uDFFF]/u.test(value) && value.length > 0 && value.length <= 128 && !/[\s\p{Cc}\p{Cf}\/\\]/u.test(value);
  }

  async function refreshStaleSession(epoch: number) {
    const replay = startReplay;
    const previous = startedSession;
    sessionPortWitness = false;
    if (!replay || !previous) return;
    try {
      const refreshed = validateSessionStartResult(await sendSetup("session.start", replay.requestId, replay.payload));
      if (epoch !== setupEpoch || refreshed.sessionId !== previous.sessionId || refreshed.sessionRevision !== previous.sessionRevision || refreshed.readiness.state !== "ready") return;
      const verified = await handshake();
      if (epoch !== setupEpoch) return;
      startedSession = refreshed;
      readiness = verified.readiness;
      sessionPortWitness = true;
      retry();
    } catch {
      if (epoch === setupEpoch) profileStatus = "Session readiness could not be refreshed. Sending stays blocked.";
    }
  }

  let stopped = $derived(engineConnected && status === "disconnected");
  let mounted = false;
  let turns = $state.raw<TurnsState>(createTurnsState());
  let subscription = $state<BindingStatus>({ state: "idle" });
  let retry = $state<() => void>(() => {});
  let currentRun = $derived(
    turns.currentRunId ? turns.runs[turns.currentRunId] : undefined,
  );
  // A different session starts on the safe mode: no mode or pending request
  // carries over from the previous one.
  const permissionModeState = $derived(
    initialPermissionMode($selectedSession?.sessionId ?? null),
  );

  // TD-33: the actions target the branch the tree actually selected. The engine
  // still does not deliver the revisions a lifecycle request needs, and a
  // rewind/code restore is not admitted yet, so every action is visibly disabled
  // with its own reason instead of pretending to run.
  const sessionActionContext: SessionActionsContext = $derived.by(() => {
    const key = nav.selectedKey;
    const node =
      key === null ? undefined : visibleNodes(nav).find((n) => n.key === key);
    return {
      engine: {
        status: "unavailable",
        reason: "Session revisions are not delivered to the renderer yet.",
      },
      rewind: {
        status: "unavailable",
        reason:
          "A rewind request is not admitted yet: TD-25 restore receipts are not wired.",
      },
      codeRestore: {
        status: "unavailable",
        reason:
          "Code restore is not available yet: TD-25 restore receipts are not wired.",
      },
      selected: node
        ? {
            sessionId: node.sessionId,
            branchAnchorId: node.branchAnchorId,
            leaves: node.leaves,
          }
        : null,
      draft: "",
    };
  });

  function applyTree(event: SplyceEvent) {
    if (event.kind !== "session.tree_updated") return;
    scopes.set(event.sessionId, event.scopeId);
    dispatchNav({ type: "event", event: event as TreeEventLike });
  }

  async function runLoad() {
    dispatchNav({ type: "refresh" });
    try {
      for (const event of await loadSessions!()) applyTree(event);
      dispatchNav({ type: "loaded" });
    } catch (e) {
      dispatchNav({
        type: "failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Readiness never completes a load: without a snapshot the previous navigation state is kept, selection included.
  $effect(() => {
    if (status === "ready") {
      if (loadSessions) void runLoad();
      else if (untrack(() => Object.keys(nav.branches).length > 0))
        dispatchNav({ type: "loaded" });
    } else if (status === "unavailable" || status === "error")
      dispatchNav({ type: "failed", message: "Engine unavailable." });
  });

  function onSelect(key: string) {
    dispatchNav({ type: "select", key });
    const node = visibleNodes(nav).find((n) => n.key === key);
    const scopeId = node && scopes.get(node.sessionId);
    if (node && startedSession && node.sessionId !== startedSession.sessionId) {
      startedSession = null;
      profileStatus =
        "Readiness has not been reported for the selected session.";
    }
    if (node && scopeId) selectSession({ sessionId: node.sessionId, scopeId });
  }

  // The selected branch vanished from the latest snapshot: drop the selection with it.
  $effect(() => {
    if (nav.lostSelection) clearSession();
  });

  function onApproval() {
    // Session context arrives with the workbench (TD-08/TD-30); never invent revisions here.
  }

  async function connect() {
    invalidateSetup();
    readiness = null;
    try {
      const verified = await handshake();
      if (!mounted) return;
      readiness = status === "disconnected" ? null : verified.readiness;
      engineConnected = true;
      if (workspace && readiness?.state === "ready") void readSetup(workspace);
    } catch {
      // The engine store publishes the unavailable/error state.
    }
  }

  onMount(() => {
    mounted = true;
    // This component is the workbench: the only writer of the session-selection store.
    const transport = createTurnStreamTransport({
      onState: (next) => {
        turns = next;
        if (activeRunId && ["completed", "failed", "canceled", "stopped"].includes(next.runs[activeRunId]?.status ?? "")) activeRunId = null;
      },
      onResync: (fromSeq, sessionId) => {
        void binding.resubscribe(sessionId, fromSeq);
      },
    });
    const binding = bindSelection(transport, subscribe);
    const unsubState = connectionState.subscribe((val) => {
      status = val;
      if (val === "disconnected") {
        invalidateSetup();
        readiness = null;
        ports = null;
      }
    });
    const unsubPorts = portAvailability.subscribe((val) => {
      ports = val;
    });
    const unsubBinding = binding.status.subscribe((next) => {
      subscription = next;
    });
    retry = () => void binding.retry();
    const unsubEvents = onEvent((event) => {
      applyTree(event);
      transport.enqueue(event);
    });

    void connect();

    return () => {
      mounted = false;
      setupEpoch++;
      unsubState();
      unsubPorts();
      unsubEvents();
      unsubBinding();
      binding.dispose();
      transport.dispose();
      clearSession();
    };
  });
</script>

<div
  data-testid="app-shell"
  data-connection-state={status}
  data-readiness-policy={readiness ? readiness.policy : "unknown"}
  data-readiness-store={readiness ? readiness.store : "unknown"}
  data-readiness-receipts={readiness ? readiness.receipts : "unknown"}
  data-readiness-generation={ports ? ports.generation : "unknown"}
>
  <Shell {rail} {transcript} {composer} {evidence} />
</div>

{#snippet rail()}
  <div class="brand">
    <h1>Splyce</h1>
    <span class="status-badge" class:ready={status === "ready"} class:unavailable={status !== "ready"}>
      {stopped ? "engine stopped" : status}
    </span>
  </div>
  <nav class="views-nav" aria-label="Views">
    {#each VIEWS as [id, label] (id)}
      <button type="button" aria-current={view === id ? "page" : undefined} onclick={() => (view = id)}>
        {label}
      </button>
    {/each}
  </nav>
  <section class="project" aria-labelledby="project-title">
    <h2 id="project-title">Project</h2>
    <p data-testid="project-name">{workspace ? workspace.displayName : "No project selected."}</p>
    <button
      type="button"
      disabled={chooserReason !== null || choosing}
      aria-describedby="project-status"
      onclick={() => void chooseProject()}
    >
      {choosing ? "Choosing…" : "Choose project"}
    </button>
    <p id="project-status" role="status">{chooserReason ?? chooserError}</p>
  </section>
  <SessionTree
    {nav}
    {onSelect}
    canRetry={status === "ready"}
    onFocus={(key) => dispatchNav({ type: "focus", key })}
    onMove={(to) => dispatchNav({ type: "move", to })}
    onRetry={() => {
      if (status === "ready" && loadSessions) void runLoad();
    }}
  />
  <SessionActions context={sessionActionContext} />
  <section class="supervisor" aria-label="Supervisor" data-testid="supervisor">
    <h2>Supervisor</h2>
    <PermissionModeSelect modeState={permissionModeState} context={permissionContext} />
  </section>
{/snippet}

{#snippet transcript()}
  <!-- TD-30: engine-facing approval mount. Empty until requests carry revisions. -->
  <ApprovalSurface requests={approvalRequests} context={approvalContext} />
  {#if subscription.state === "failed"}
    <div class="subscribe-error" role="alert" data-testid="subscribe-error">
      <span>Could not subscribe to the session: {subscription.error}</span>
      <button type="button" onclick={retry}>Retry</button>
    </div>
  {/if}
  {#if view === "providers"}
    <!-- No profile service is connected: the list is empty and custom endpoints stay disabled, not faked. -->
    <div class="providers" data-testid="providers-view">
      <Providers
        connections={[]}
        families={[]}
        {profiles}
        workspaceSelected={workspace !== null}
        selectedProfileId={profileSelection?.selectedProfileId ?? null}
        selectProfile={useProfile}
        {profilePending}
        {profileStatus}
        credentialSubmit={providerUnavailable ? undefined : configureProvider}
        credentialUnavailable={providerUnavailable}
      />
    </div>
    <SupportStatus cells={null} />
  {:else if view === "setup"}
    <Setup
      snapshot={moduleSnapshot}
      onEnterWorkbench={() => (view = "conversation")}
      onOpenModules={() => (view = "modules")}
      onConfigureProvider={() => (view = "providers")}
    />
  {:else if view === "modules"}
    <Modules
      snapshot={moduleSnapshot}
      onConfigureProvider={() => (view = "providers")}
    />
  {:else if view === "usage"}
    <UsageView usage={null} status="unavailable" />
  {:else}
    <div class="app-content" class:conversation={currentRun !== undefined}>
      {#if status !== "ready"}
        <div class="unavailable-view" data-testid="unavailable-banner" role="status" aria-live="polite">
          <h2>{stopped ? "Engine stopped" : readiness?.state === "ready" ? "Generation unconfigured" : "Engine Unavailable"}</h2>
          <p>
            {stopped
              ? "The native engine exited. Reconnect to resume or restart the app; the last transcript may be incomplete."
              : readiness?.state === "ready"
                ? "Generation requires a configured provider and workspace."
              : "Backend native services (policy, durable store, and receipts) are currently initializing or unavailable. Release qualification requires all three subsystems verified before task execution."}
          </p>
          {#if stopped || status === "unavailable" || status === "error"}
            <button type="button" class="retry-btn" onclick={() => void connect()}>Retry</button>
          {/if}
        </div>
      {/if}
      {#if currentRun}
        <section class="turn-pane" aria-label="Transcript">
          <TurnStream
            run={currentRun}
            stale={turns.stale || turns.needsResync || status !== "ready"}
            showApprovalControls={false}
            canRespond={() => false}
            {onApproval}
          />
        </section>
      {:else if status === "ready"}
        <div class="workspace-view">
          <p>Ready for workspace execution.</p>
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet composer()}
  {#if ports && !ports.workspace}
    <p role="status">Workspace tools unavailable</p>
  {/if}
  <Composer
    connection={status}
    sessionId={startedSession?.sessionId ?? $selectedSession?.sessionId ?? null}
    {generationReady}
    workspaceSelected={workspace !== null}
    profileSelected={profileSelection !== null}
    sessionReadiness={startedSession?.readiness.state}
    stale={turns.stale || turns.needsResync}
    unavailable={subscription.state !== "live" || $selectedSession?.sessionId !== startedSession?.sessionId || $selectedSession?.scopeId !== workspace?.workspaceId
      ? "Session subscription is unavailable. Sending stays blocked."
      : activeRunId ? "A turn is running." : undefined}
    cancellable={activeRunId !== null && !cancelPending}
    cancel={async () => {
      if (!startedSession || !activeRunId || cancelPending) return;
      const epoch = setupEpoch;
      const sessionId = startedSession.sessionId;
      const runId = activeRunId;
      cancelPending = true;
      try {
        await cancelSession(sessionId);
        if (epoch === setupEpoch && activeRunId === runId) activeRunId = null;
      } catch {
        if (epoch === setupEpoch) profileStatus = "Cancellation could not be confirmed.";
      } finally { if (epoch === setupEpoch) cancelPending = false; }
    }}
    send={async (payload) => {
      const project = workspace;
      const selected = profileSelection;
      const session = startedSession;
      const epoch = setupEpoch;
      if (!project || !selected || !session || status !== "ready" || generationReady !== true || subscription.state !== "live" || !sessionPortWitness || turns.stale || turns.needsResync || $selectedSession?.sessionId !== session.sessionId || $selectedSession?.scopeId !== project.workspaceId) throw new Error("Session unavailable");
      try {
        const result = await invoke("session.prompt", payload, {
          sessionId: session.sessionId, scopeId: project.workspaceId,
          expectedConfigRevision: selected.configRevision,
          expectedProfileRevision: selected.profileRevision,
          expectedPolicyRevision: session.policyRevision,
        });
        if (result === null || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 3 ||
          (result as { accepted?: unknown }).accepted !== true ||
          typeof (result as { runId?: unknown }).runId !== "string" || !isOpaqueId((result as { runId: string }).runId) ||
          typeof (result as { turnId?: unknown }).turnId !== "string" || !isOpaqueId((result as { turnId: string }).turnId)) throw new Error("Invalid acknowledgement");
        if (epoch !== setupEpoch) throw new Error("Session changed");
        const runId = (result as { runId: string }).runId;
        if (!["completed", "failed", "canceled", "stopped"].includes(turns.runs[runId]?.status ?? "")) activeRunId = runId;
      } catch (error) {
        if (epoch === setupEpoch && error !== null && typeof error === "object" && Object.hasOwn(error, "code") && (error as { code?: unknown }).code === "STALE_REVISION") void refreshStaleSession(epoch);
        throw error;
      }
    }}
  />
{/snippet}

{#snippet evidence()}
  <p>No changes or evidence available.</p>
{/snippet}

<style>
  :global(html),
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #111827;
    background: #f9fafb;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
  }
  .brand h1 {
    font-size: 1.125rem;
    margin: 0;
    font-weight: 700;
  }
  .views-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 0 12px 12px 12px;
    border-bottom: 1px solid #e5e7eb;
  }
  .views-nav button {
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 0.8125rem;
    font-weight: 500;
    color: #4b5563;
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .views-nav button:hover {
    background: #f3f4f6;
    color: #111827;
  }
  .views-nav button[aria-current="page"] {
    background: #ffffff;
    color: #111827;
    font-weight: 600;
    border-color: #d1d5db;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  }
  .status-badge {
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    background: #f3f4f6;
    color: #4b5563;
  }
  .status-badge.ready {
    background: #d1fae5;
    color: #065f46;
  }
  .status-badge.unavailable {
    background: #fee2e2;
    color: #991b1b;
  }
  [aria-current="page"] {
    font-weight: 700;
  }
  .project {
    display: grid;
    gap: 4px;
    padding: 12px;
    border-bottom: 1px solid #e5e7eb;
  }
  .project h2 {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    color: #4b5563;
  }
  .project p {
    margin: 0;
    font-size: 0.8125rem;
  }
  .supervisor {
    display: grid;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid #e5e7eb;
    margin-top: 8px;
  }
  .supervisor h2 {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #4b5563;
  }
  .providers {
    padding: 12px;
  }
  .subscribe-error {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 20px;
    background: #fee2e2;
    color: #991b1b;
    font-size: 0.875rem;
  }
  .app-content {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    min-height: 100%;
    box-sizing: border-box;
  }
  .app-content.conversation {
    flex-direction: column;
    gap: 16px;
    align-items: stretch;
    justify-content: flex-start;
  }
  .turn-pane {
    width: 100%;
    max-width: 880px;
    margin: 0 auto;
  }
  .unavailable-view {
    max-width: 480px;
    text-align: center;
    padding: 32px;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  }
  .unavailable-view h2 {
    margin-top: 0;
    color: #b91c1c;
  }
  .unavailable-view p {
    color: #4b5563;
    font-size: 0.875rem;
    line-height: 1.5;
    margin-bottom: 20px;
  }
  .retry-btn {
    padding: 8px 20px;
    font-size: 0.875rem;
    font-weight: 500;
    color: #ffffff;
    background: #111827;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .retry-btn:hover {
    background: #374151;
  }
</style>
