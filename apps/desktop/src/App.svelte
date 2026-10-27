<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { Handshake, SplyceEvent } from "@splyce/pi/contracts";
  import Composer from "./components/Composer.svelte";
  import SessionTree from "./components/SessionTree.svelte";
  import TurnStream from "./components/TurnStream.svelte";
  import Shell from "./components/shell/Shell.svelte";
  import UsageView from "./components/usage/UsageView.svelte";
  import Providers from "./routes/Providers.svelte";
  import Setup from "./routes/Setup.svelte";
  import Modules from "./routes/Modules.svelte";
  import { unavailableModuleSnapshot } from "./stores/modules";
  import {
    connectionState,
    handshake,
    onEvent,
    subscribe,
    type EngineConnectionState,
  } from "./stores/engine";
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
  let engineConnected = $state(false);
  let stopped = $derived(engineConnected && status === "disconnected");
  let mounted = false;
  let turns = $state.raw<TurnsState>(createTurnsState());
  let subscription = $state<BindingStatus>({ state: "idle" });
  let retry = $state<() => void>(() => {});
  let currentRun = $derived(
    turns.currentRunId ? turns.runs[turns.currentRunId] : undefined,
  );

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
    readiness = null;
    try {
      const verified = await handshake();
      if (!mounted) return;
      readiness = status === "disconnected" ? null : verified.readiness;
      engineConnected = true;
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
      },
      onResync: (fromSeq, sessionId) => {
        void binding.resubscribe(sessionId, fromSeq);
      },
    });
    const binding = bindSelection(transport, subscribe);
    const unsubState = connectionState.subscribe((val) => {
      status = val;
      if (val === "disconnected") readiness = null;
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
      unsubState();
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
  <nav aria-label="Views">
    {#each VIEWS as [id, label] (id)}
      <button type="button" aria-current={view === id ? "page" : undefined} onclick={() => (view = id)}>
        {label}
      </button>
    {/each}
  </nav>
  <SessionTree
    {nav}
    {onSelect}
    onFocus={(key) => dispatchNav({ type: "focus", key })}
    onMove={(to) => dispatchNav({ type: "move", to })}
    onRetry={() => {
      if (status === "ready" && loadSessions) void runLoad();
      else void connect();
    }}
  />
{/snippet}

{#snippet transcript()}
  {#if subscription.state === "failed"}
    <div class="subscribe-error" role="alert" data-testid="subscribe-error">
      <span>Could not subscribe to the session: {subscription.error}</span>
      <button type="button" onclick={retry}>Retry</button>
    </div>
  {/if}
  {#if view === "providers"}
    <!-- No profile service is connected: the list is empty and the add form is disabled, not faked. -->
    <fieldset disabled data-testid="providers-view">
      <Providers connections={[]} families={[]} onAddCustom={() => {}} />
      <p role="status">Provider connections are unavailable: no profile service is connected.</p>
    </fieldset>
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
    <UsageView usage={null} />
    <p role="status" data-testid="usage-unavailable-note">Usage unavailable - no engine usage report.</p>
  {:else}
    <div class="app-content" class:conversation={currentRun !== undefined}>
      {#if status !== "ready"}
        <div class="unavailable-view" data-testid="unavailable-banner" role="status" aria-live="polite">
          <h2>{stopped ? "Engine stopped" : readiness?.state === "ready" ? "Generation unconfigured" : "Engine Unavailable"}</h2>
          <p>
            {stopped
              ? "The native engine exited. Restart the app to reconnect; the last transcript may be incomplete."
              : readiness?.state === "ready"
                ? "Generation requires a configured provider and workspace."
              : "Backend native services (policy, durable store, and receipts) are currently initializing or unavailable. Release qualification requires all three subsystems verified before task execution."}
          </p>
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
  <!-- stale: config/profile/policy revisions are not delivered to the renderer yet, so sending is disabled. -->
  <Composer
    connection={status}
    sessionId={$selectedSession?.sessionId ?? null}
    unavailable="Sending is not available yet"
    send={async () => {
      throw new Error("Sending is unavailable: session revisions are not wired.");
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
    padding: 12px;
  }
  .brand h1 {
    font-size: 1.125rem;
    margin: 0;
    font-weight: 700;
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
  fieldset {
    border: 0;
    margin: 0;
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
  }
</style>
