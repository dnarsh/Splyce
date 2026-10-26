<script lang="ts">
  import ConnectionCard from "../components/provider/ConnectionCard.svelte";
  import CustomEndpointForm from "../components/provider/CustomEndpointForm.svelte";
  import {
    groupByFamily,
    type ConnectionInput,
    type CustomEndpointDraft,
  } from "../stores/profiles";

  let {
    connections,
    families,
    onAddCustom,
  }: {
    connections: readonly ConnectionInput[];
    families: readonly string[];
    onAddCustom: (draft: CustomEndpointDraft) => void;
  } = $props();

  const groups = $derived(groupByFamily(connections, families));
  const existing = $derived(
    connections.map((c) => ({
      id: c.record.providerConnectionId,
      endpointLabel: c.endpointLabel,
    })),
  );
</script>

<main aria-labelledby="providers-title">
  <h2 id="providers-title">Provider connections</h2>
  {#each groups as group (group.apiFamily)}
    <section aria-labelledby={`fam-${group.apiFamily}`} data-testid="family">
      <h3 id={`fam-${group.apiFamily}`}>{group.apiFamily}</h3>
      {#if group.connections.length === 0}
        <p>No connections configured.</p>
      {:else}
        <ul>
          {#each group.connections as connection (connection.id)}
            <ConnectionCard {connection} />
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
  <CustomEndpointForm {existing} onAdd={onAddCustom} />
</main>
