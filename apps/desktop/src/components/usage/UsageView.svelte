<script lang="ts">
  import { usageRows, type UsageInput } from "./usage";

  let { usage = null }: { usage?: UsageInput | null } = $props();

  const rows = $derived(usage ? usageRows(usage) : []);
</script>

{#if usage}
  <section class="usage" aria-label="Usage" data-testid="usage-view">
    {#if rows.length === 0}
      <p data-testid="usage-unavailable">Usage unavailable - not zero.</p>
    {:else}
      <p class="semantics" data-testid="usage-semantics">
        {usage.semantics === "estimated" ? "Estimated usage" : "Reported usage"}
      </p>
      <dl>
        {#each rows as row (row.label)}
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        {/each}
      </dl>
    {/if}
  </section>
{/if}
