<script lang="ts">
  import {
    buildPrompt,
    keyAction,
    sendBlockedReason,
    type PromptPayload,
  } from "../stores/composer";
  import type { EngineConnectionState } from "../stores/engine";

  /**
   * Fixed copy for a rejected send. The rejection itself is never shown: it can
   * carry filesystem paths, secrets or stack frames, and the UI cannot know
   * whether the engine received the prompt before the failure.
   */
  const SEND_UNCERTAIN =
    "The message may not have reached the engine. Check the connection, then resend.";

  let {
    connection,
    sessionId,
    stale = false,
    generationReady,
    workspaceSelected = false,
    profileSelected = false,
    sessionReadiness,
    unavailable,
    cancellable = false,
    contextArtifactIds = [],
    send,
    cancel,
  }: {
    connection: EngineConnectionState;
    sessionId: string | null;
    stale?: boolean;
    /** Engine-reported generation readiness; fail closed when false. */
    generationReady?: boolean;
    /** A project is selected; sending is blocked without one. */
    workspaceSelected?: boolean;
    profileSelected?: boolean;
    sessionReadiness?: "ready" | "unavailable";
    unavailable?: string;
    cancellable?: boolean;
    contextArtifactIds?: readonly string[];
    send: (payload: PromptPayload) => Promise<void>;
    cancel?: () => void | Promise<void>;
  } = $props();

  let draft = $state("");
  let pending = $state(false);
  let composing = $state(false);
  let error = $state<string | null>(null);

  const reason = $derived(
    sendBlockedReason({
      connection,
      sessionId,
      stale,
      generationReady,
      workspaceSelected,
      profileSelected,
      sessionReadiness,
      pending,
      unavailable,
    }),
  );
  const payload = $derived(buildPrompt(draft, contextArtifactIds));

  async function submit() {
    // Guard on live state: a handler may run before derived values re-render.
    if (pending || sendBlockedReason({
      connection,
      sessionId,
      stale,
      generationReady,
      workspaceSelected,
      profileSelected,
      sessionReadiness,
      pending,
      unavailable,
    }))
      return;
    const request = buildPrompt(draft, contextArtifactIds);
    if (!request) return;
    pending = true;
    error = null;
    try {
      await send(request);
      draft = "";
    } catch {
      // Never echo the rejection: it can carry paths, secrets or stack text.
      // A rejected promise does not prove the engine ignored the message.
      error = SEND_UNCERTAIN;
    } finally {
      pending = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    const action = keyAction(e, composing);
    if (action === "send") {
      e.preventDefault();
      void submit();
    } else if (action === "cancel" && cancellable && cancel) {
      e.preventDefault();
      void cancel();
    }
  }
</script>

<form
  class="composer"
  aria-label="Composer"
  onsubmit={(e) => {
    e.preventDefault();
    void submit();
  }}
>
  <label for="composer-input">Message</label>
  <textarea
    id="composer-input"
    rows="3"
    bind:value={draft}
    {onkeydown}
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => (composing = false)}
    aria-describedby="composer-status"
    placeholder="Type a message or prompt…"
  ></textarea>
  <div class="composer-footer">
    <p id="composer-status" role="status">
      {#if error}Send failed: {error}{:else if reason}{reason}{/if}
    </p>
    <div class="composer-actions">
      {#if cancellable && cancel}
        <button type="button" class="btn-cancel" onclick={() => void cancel?.()}>Cancel turn</button>
      {/if}
      <button type="submit" class="btn-send" disabled={reason !== null || payload === null}>
        Send
      </button>
    </div>
  </div>
</form>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    box-sizing: border-box;
    width: 100%;
    max-width: 960px;
    margin: 0 auto;
  }
  label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #4b5563;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 12px;
    font-family: inherit;
    font-size: 0.875rem;
    line-height: 1.4;
    color: #111827;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    resize: vertical;
    min-height: 56px;
  }
  textarea:focus {
    border-color: #3b82f6;
  }
  .composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 32px;
  }
  #composer-status {
    margin: 0;
    font-size: 0.8125rem;
    color: #6b7280;
    line-height: 1.3;
    flex: 1;
  }
  .composer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .btn-send {
    padding: 6px 16px;
    font-size: 0.875rem;
    font-weight: 500;
    color: #ffffff;
    background: #111827;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-send:hover:not(:disabled) {
    background: #374151;
  }
  .btn-send:disabled {
    background: #e5e7eb;
    color: #9ca3af;
    cursor: not-allowed;
  }
  .btn-cancel {
    padding: 6px 12px;
    font-size: 0.8125rem;
    font-weight: 500;
    color: #b91c1c;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 6px;
    cursor: pointer;
  }
  .btn-cancel:hover {
    background: #fee2e2;
  }
  textarea:focus-visible,
  button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
</style>
