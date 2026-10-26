<script lang="ts">
  import {
    whenEffective,
    type Disposition,
    type ModelOption,
    type ModelSelectionState,
  } from "../../stores/model-selection";

  let {
    selection,
    options,
    turnActive = false,
    onRequest,
  }: {
    selection: ModelSelectionState;
    options: ModelOption[];
    turnActive?: boolean;
    onRequest: (ref: string, disposition: Disposition) => void;
  } = $props();

  let chosen = $state<string | null>(null);
  let disposition = $state<Disposition>("next-turn");

  const labelOf = (ref: string): string =>
    options.find((o) => o.ref === ref)?.label ?? ref;
  const busy = $derived(
    selection.transition?.status === "requested" ||
      selection.transition?.status === "pending",
  );
  const STATUS_TEXT = {
    requested: "Requested",
    pending: "Pending",
    applied: "Applied",
    rejected: "Rejected",
    canceled: "Canceled",
  } as const;
</script>

<section aria-labelledby="model-switch-title" data-testid="model-switcher">
  <h3 id="model-switch-title">Model</h3>
  <p data-testid="model-current">Active: {labelOf(selection.currentRef)}</p>

  {#if selection.transition}
    {@const t = selection.transition}
    <p
      role={t.status === "rejected" || t.mismatch ? "alert" : "status"}
      data-testid="model-requested"
      data-status={t.status}
    >
      Requested: {labelOf(t.requestedRef)} · {STATUS_TEXT[t.status]}
      {#if t.status === "rejected"}
        · {t.reason}. Still using {labelOf(selection.currentRef)}.
      {:else if t.mismatch}
        · Engine chose a different model than you requested.
      {:else if t.status === "requested" || t.status === "pending"}
        · {whenEffective(t.disposition, turnActive)}
      {/if}
    </p>
  {/if}

  <fieldset disabled={busy}>
    <legend>Switch model</legend>
    {#each options as o (o.ref)}
      <label>
        <input
          type="radio"
          name="model"
          value={o.ref}
          disabled={o.unavailableReason !== undefined}
          checked={chosen === o.ref}
          onchange={() => (chosen = o.ref)}
        />
        {o.label}
        <span>({o.locality === "local" ? "Local" : "Cloud"})</span>
        {#each o.labels ?? [] as l}<span>[{l}]</span>{/each}
        {#if o.unavailableReason !== undefined}
          <span data-testid="model-unavailable">
            Unavailable: {o.unavailableReason}
          </span>
        {/if}
      </label>
    {/each}

    {#if turnActive}
      <label>
        <input
          type="radio"
          name="disposition"
          value="next-turn"
          checked={disposition === "next-turn"}
          onchange={() => (disposition = "next-turn")}
        />
        After the running turn
      </label>
      <label>
        <input
          type="radio"
          name="disposition"
          value="cancel-and-switch"
          checked={disposition === "cancel-and-switch"}
          onchange={() => (disposition = "cancel-and-switch")}
        />
        Cancel the running turn and switch
      </label>
    {/if}

    <button
      type="button"
      disabled={chosen === null || chosen === selection.currentRef}
      onclick={() => chosen !== null && onRequest(chosen, disposition)}
    >
      Request switch
    </button>
  </fieldset>
</section>
