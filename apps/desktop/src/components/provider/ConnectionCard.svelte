<script lang="ts">
  import type { ConnectionView } from "../../stores/profiles";

  let { connection }: { connection: ConnectionView } = $props();
  const label: Record<ConnectionView["credential"], string> = {
    configured: "Configured",
    missing: "Missing",
    unavailable: "Unavailable",
  };
</script>

<li class="connection" data-state={connection.state} data-testid="connection">
  <h4 id={`conn-${connection.id}`}>{connection.id}</h4>
  <dl aria-labelledby={`conn-${connection.id}`}>
    <dt>Endpoint</dt>
    <dd>{connection.endpointLabel}</dd>
    <dt>Data destination</dt>
    <dd>{connection.egress}</dd>
    <dt>Locality</dt>
    <dd>{connection.locality === "local" ? "Local" : "Cloud"}</dd>
    <dt>Credential</dt>
    <dd>{label[connection.credential]} ({connection.credentialRef})</dd>
    <dt>Revision</dt>
    <dd>{connection.revision}</dd>
  </dl>
  {#if connection.error}
    <p role="alert" class="error">Unavailable: {connection.error}</p>
  {/if}
</li>

<style>
  .connection { border: 1px solid currentColor; padding: 0.5rem; margin: 0.5rem 0; list-style: none; }
  .error { font-weight: 600; }
  dt { font-weight: 600; }
  dd { margin: 0 0 0.25rem; }
</style>
