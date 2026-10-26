<script lang="ts">
  import type { EventPayloads } from "@splyce/pi/contracts";
  import ApprovalCard from "./ApprovalCard.svelte";
  import type { ApprovalView, ToolCallView, TurnView } from "../stores/turns";

  type ApprovalDecision = "approve" | "deny";
  type ApprovalRequest = EventPayloads["approval.requested"];

  let {
    run,
    stale = false,
    showApprovalControls = true,
    canRespond = () => true,
    onApproval,
  }: {
    run: TurnView;
    stale?: boolean;
    showApprovalControls?: boolean;
    canRespond?: (actionId: string) => boolean;
    onApproval: (
      approvalRequestId: string,
      runId: string,
      actionId: string,
      decision: ApprovalDecision,
    ) => void;
  } = $props();

  const statusLabel: Record<TurnView["status"], string> = {
    streaming: "Working",
    waiting_approval: "Waiting for approval",
    completed: "Completed",
    failed: "Failed",
    canceled: "Canceled",
    stopped: "Stopped",
  };

  const toolStatusLabel: Record<ToolCallView["status"], string> = {
    pending: "Pending - not executed",
    success: "Success",
    error: "Failed",
    uncertain: "Uncertain",
    canceled: "Canceled",
  };

  let actions = $derived(
    new Map(run.actions.map((action) => [action.actionId, action])),
  );
  let sending = $state<Record<string, ApprovalDecision>>({});

  function approvalRequest(approval: ApprovalView): ApprovalRequest {
    return {
      approvalRequestId: approval.approvalRequestId,
      runId: approval.runId,
      actionId: approval.actionId,
      capabilityId: approval.capabilityId,
      targetScope: approval.targetScope,
      normalizedTarget: approval.normalizedTarget,
      riskRationale: approval.riskRationale,
      ...(approval.timeoutMs !== undefined
        ? { timeoutMs: approval.timeoutMs }
        : {}),
    };
  }

  function respond(action: ToolCallView, decision: ApprovalDecision) {
    const approval = action.approval;
    if (
      !approval ||
      approval.state !== "requested" ||
      stale ||
      sending[approval.approvalRequestId] ||
      !canRespond(action.actionId)
    ) {
      return;
    }
    sending[approval.approvalRequestId] = decision;
    onApproval(
      approval.approvalRequestId,
      approval.runId,
      action.actionId,
      decision,
    );
  }

  function onApprovalKeydown(event: KeyboardEvent, action: ToolCallView) {
    if (event.repeat) return;
    if (event.key === "Escape" || event.key === "n" || event.key === "N") {
      event.preventDefault();
      respond(action, "deny");
    } else if (event.key === "y" || event.key === "Y") {
      event.preventDefault();
      respond(action, "approve");
    }
  }

  function approvalKeys(node: HTMLElement, action: ToolCallView) {
    const handler = (event: KeyboardEvent) => onApprovalKeydown(event, action);
    node.addEventListener("keydown", handler);
    return {
      destroy() {
        node.removeEventListener("keydown", handler);
      },
    };
  }

  function focusDeny(node: HTMLElement) {
    node
      .querySelector<HTMLButtonElement>('[data-testid="approval-deny-button"]')
      ?.focus();
  }
</script>

<article
  class="turn"
  class:stale
  data-testid="turn-stream"
  data-run-id={run.runId}
  data-status={run.status}
  data-stale={stale}
  aria-label="Assistant turn"
>
  <header class="turn-head">
    <span class="status" data-status={run.status}>
      {statusLabel[run.status]}
    </span>
    {#if stale}
      <span class="stale-badge">Stale</span>
    {/if}
  </header>

  {#if stale}
    <p class="banner" role="status">
      Engine stopped. This transcript may be incomplete.
    </p>
  {/if}

  <div class="transcript" aria-busy={run.status === "streaming"}>
    {#each run.blocks as block (block.id)}
      {#if block.type === "thought"}
        <details class="thought" data-kind="thought">
          <summary>Thought</summary>
          <p data-testid="turn-thought">{block.text}</p>
        </details>
      {:else if block.type === "text"}
        <p class="text" data-testid="turn-text" data-kind="text">
          {block.text}
        </p>
      {:else}
        {@const action = actions.get(block.actionId)}
        {#if action}
          <article
            class="tool"
            data-testid="tool-card"
            data-action-id={action.actionId}
            data-status={action.status}
            aria-label={`Tool ${action.capabilityId}`}
          >
            <div class="tool-head">
              <code class="capability">{action.capabilityId}</code>
              <span class="tool-status" data-status={action.status}>
                {toolStatusLabel[action.status]}
              </span>
            </div>
            <p class="target">{action.target}</p>
            {#if action.argsSummary}
              <p class="args">
                <span>Requested arguments</span>
                <code>{action.argsSummary}</code>
              </p>
            {/if}
            {#if action.outcomeRef}
              <p class="outcome">Outcome: <code>{action.outcomeRef}</code></p>
            {/if}
            {#if action.error}
              <p class="tool-error">{action.error}</p>
            {/if}

            {#if action.approval?.state === "requested" && showApprovalControls}
              {#if canRespond(action.actionId) && !stale}
                <div
                  class="approval"
                  use:approvalKeys={action}
                  use:focusDeny
                >
                  <ApprovalCard
                    request={approvalRequest(action.approval)}
                    decision={sending[action.approval.approvalRequestId] ?? null}
                    onRespond={(decision) => respond(action, decision)}
                  />
                </div>
              {:else}
                <p class="approval-closed" role="status">
                  {stale
                    ? "Approval closed - this request can no longer be answered."
                    : "Approval controls are not available in this view."}
                </p>
              {/if}
            {/if}
          </article>
        {/if}
      {/if}
    {/each}
  </div>

  {#if run.status === "canceled"}
    <p class="terminal" role="alert">Run was canceled.</p>
  {:else if run.status === "failed"}
    <p class="terminal" role="alert">
      Run failed{run.error ? `: ${run.error.message}` : ""}.
    </p>
  {:else if run.status === "stopped"}
    <p class="terminal" role="status">Run stopped.</p>
  {/if}
</article>

<style>
  .turn {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-3, 0.75rem);
    color: var(--splyce-text-primary, #111827);
    font-family: var(
      --splyce-font-family-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      system-ui,
      sans-serif
    );
    font-size: var(--splyce-font-size-base, 1rem);
    line-height: var(--splyce-line-height-normal, 1.5);
  }

  .turn-head {
    display: flex;
    align-items: center;
    gap: var(--splyce-space-2, 0.5rem);
  }

  .status,
  .stale-badge,
  .tool-status {
    font-size: var(--splyce-font-size-xs, 0.75rem);
    padding: var(--splyce-space-1, 0.25rem) var(--splyce-space-2, 0.5rem);
    border-radius: 999px;
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    color: var(--splyce-text-secondary, #4b5563);
  }

  .status[data-status="streaming"],
  .tool-status[data-status="pending"] {
    color: var(--splyce-status-pending, #7c3aed);
    border-color: var(--splyce-status-pending, #7c3aed);
  }

  .status[data-status="waiting_approval"],
  .tool-status[data-status="uncertain"] {
    color: var(--splyce-status-warning, #b45309);
    border-color: var(--splyce-status-warning, #b45309);
  }

  .status[data-status="completed"],
  .tool-status[data-status="success"] {
    color: var(--splyce-status-success, #047857);
    border-color: var(--splyce-status-success, #047857);
  }

  .status[data-status="failed"],
  .tool-status[data-status="error"] {
    color: var(--splyce-status-danger, #b91c1c);
    border-color: var(--splyce-status-danger, #b91c1c);
  }

  .stale-badge {
    color: var(--splyce-status-warning, #b45309);
    border-color: var(--splyce-status-warning, #b45309);
  }

  .banner,
  .terminal {
    margin: 0;
    padding: var(--splyce-space-2, 0.5rem) var(--splyce-space-3, 0.75rem);
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--splyce-space-2, 0.5rem);
    background: var(--splyce-surface-raised, #ffffff);
    color: var(--splyce-text-secondary, #4b5563);
    font-size: var(--splyce-font-size-sm, 0.875rem);
  }

  .transcript {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-3, 0.75rem);
  }

  .text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .thought {
    border-left: 2px solid var(--splyce-border-subtle, #f3f4f6);
    padding-left: var(--splyce-space-3, 0.75rem);
    color: var(--splyce-text-secondary, #4b5563);
    font-size: var(--splyce-font-size-sm, 0.875rem);
  }

  .thought summary {
    cursor: pointer;
    color: var(--splyce-text-muted, #6b7280);
  }

  .thought p {
    margin: var(--splyce-space-2, 0.5rem) 0 0;
    white-space: pre-wrap;
  }

  .tool {
    display: flex;
    flex-direction: column;
    gap: var(--splyce-space-2, 0.5rem);
    padding: var(--splyce-space-3, 0.75rem);
    border: 1px solid var(--splyce-border-default, #e5e7eb);
    border-radius: var(--splyce-space-2, 0.5rem);
    background: var(--splyce-surface-raised, #ffffff);
  }

  .tool-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--splyce-space-2, 0.5rem);
  }

  .capability,
  .args code,
  .outcome code {
    font-family: var(
      --splyce-font-family-mono,
      "Cascadia Code",
      Consolas,
      monospace
    );
    font-size: var(--splyce-font-size-sm, 0.875rem);
    line-height: var(--splyce-line-height-mono, 1.4);
    overflow-wrap: anywhere;
  }

  .target,
  .args,
  .outcome,
  .tool-error,
  .approval-closed {
    margin: 0;
    color: var(--splyce-text-secondary, #4b5563);
    font-size: var(--splyce-font-size-sm, 0.875rem);
  }

  .args span {
    display: block;
    color: var(--splyce-text-muted, #6b7280);
    font-size: var(--splyce-font-size-xs, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .tool-error {
    color: var(--splyce-status-danger, #b91c1c);
  }

  .approval {
    display: flex;
    flex-direction: column;
  }

  .approval :global(.btn-approve:focus-visible),
  .approval :global(.btn-deny:focus-visible) {
    outline: 2px solid var(--splyce-focus-ring, #2563eb);
    outline-offset: var(--splyce-focus-offset, 2px);
  }

  .approval-closed {
    padding: var(--splyce-space-2, 0.5rem) var(--splyce-space-3, 0.75rem);
    border: 1px dashed var(--splyce-border-default, #e5e7eb);
    border-radius: var(--splyce-space-2, 0.5rem);
  }

  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none;
    }
  }
</style>

