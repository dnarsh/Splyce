# Splyce setup envelope: provider.configure / profile.select / session.start + Credential Manager reconciliation

Status: PROPOSAL (read-only study). Narrowed per lead ruling 87ef90e0 (frozen: envelope `{frame:'setup',command,requestId,payload}` under existing `send`; no sessionId; `metadata` is Codex's and out of scope here).
Basis: `Itachi-1824/td07-11-bootstrap@c4df619` (fetched; `bc8fa19` and SDK `89933b2` are ancestors). Throwaway worktree: `C:\Users\Khadi\Downloads\splyce-arch-ro` (detached). TD-26 modelId: fork `dnarsh/Splyce` branch `dnarsh/td26-modelid` @ `d17c528` (NOT merged into bootstrap; its base `9a33735` is an ancestor of c4df619, so it is a clean 4-file pick).
Paths are relative to repo root. `file:line` are at c4df619 unless stated. Anything not read is marked INFERRED.

---------------------------------------------------------------------------------------------------

## 1. SETTLED existing contracts (read, cited)

| # | Fact | Source |
|---|------|--------|
| S1 | Every sessionful command needs `sessionId, scopeId, expected{Config,Profile,Policy}Revision`; all validated against a live ContractContext. No sessionless path exists in `COMMAND_SCHEMAS`. | `packages/splyce-pi/src/contracts.ts:644-705`, `1349-1410` |
| S2 | Renderer `invoke` builds that full command and calls Tauri `send {op,payload}`; Rust `valid_command` rejects anything not exactly the 9 fields + per-op payload schema. | `apps/desktop/src/stores/engine.ts:286-314`; `src-tauri/src/ipc.rs:420-475`, `541-560` |
| S3 | Engine host `send` is a stub: always `POLICY_DENIED`/`STALE_REVISION`, "Generation unconfigured". Requests are exactly `{id,method,params}`, id <=128 bytes no whitespace/slash, queue <=8, one serial `operations` chain. | `packages/splyce-pi/src/engine-host.mjs:91-109`, `219-250`, `270-278` |
| S4 | Precedent for a sessionless native command: `dialog_select_workspace` -> Rust -> engine `native.workspace.admit` -> public view. It stamps a FAKE caller `sessionId:"native-workspace-admission"` (the thing setup must NOT copy). | `ipc.rs:666-707`; `engine-host.mjs:180-205`; `native-host.mjs:129-138` |
| S5 | Handshake readiness v2: `{state,policy,store,receipts,ports{generation,provider,workspace,modules}}`; ports all-false unless `state:"ready"`. Native host hardcodes ports all `false` today. | `contracts.ts:874-896`, `1533-1627`; `native-host.mjs:104-119` |
| S6 | Renderer treats engine "ready" only if `generation && provider && workspace`; ports come from `handshake()` or a session-subscribed `engine.status` event (which is sessionful: has `sessionId`, needs `subscribe`). | `engine.ts:89-96`, `144-180`, `193-234`; `contracts.ts:766-770`; `ipc.rs:155-159` |
| S7 | Workspace scope: `admitWorkspace` writes `scopeId: workspaceId` (`ws-<uuid>`); `listWorkspaceViews()` gives path-free views `{workspaceId,displayName,admittedAt,revision}`. Config revision is per scope, initial `"cfg-0"`. | `store.ts:2404`, `2484`, `191-200`, `38`, `900-929` |
| S8 | ProviderProfiles: connections and profile snapshots are append-only immutable revisions (`c1,c2..`, `p1,p2..`); `writeProfile` pins EXACT connection revisions and requires a `chat` binding; `expectedProfileRevision` is CAS (`PROFILE_STALE_REVISION`); `select` = `ConfigAuthority.request` then `.apply` with `expectedConfigRevision`; `effective()` = latest APPLIED selection. | `provider-profiles.ts:1-10`, `166-193`, `318-443`, `444-499`; `config.ts:57-78`, `80-130` |
| S9 | CAS is atomic in one `BEGIN IMMEDIATE`: `compareAndAppend` guards `providerConnection`/`profileSnapshot`/`providerEndpoint` by (scope, entityId, expectedRevision); config apply guards `expectedConfigRevision`. Multi-kind writes are NOT one transaction (`prepared.length !== 1`). | `store.ts:990-1014`, `1164-1209`; `config.ts:106-118` |
| S10 | `providerEndpoint` is native-only, written solely by `compareAndAppend`; canonical URL rules (https, or http only on `127.0.0.1`/`[::1]`/`localhost`; no userinfo/query/fragment/dot-segments; <=2048). Grant origin is `scheme://host:port`. | `store.ts:253-264`; `contracts.ts:569-620`, `1325-1331` |
| S11 | Record fields typed `"ref"` (`endpointRef`, `credentialRef`, `accountScopeRef`, `intentRef`, `changedValuesArtifactId`, `limitsArtifactId`, `egressPolicyRefs`) MUST pass `context.resolveReference(id, scopeId)`; Store default is `false` unless the caller supplies a resolver. | `contracts.ts:458-468`, `1064-1080`; `store.ts:794-806` |
| S12 | Persisted JSON rejects keys named `apikey/secret/password/token/authorization/credential(s)...` and path-looking strings. `credentialRef` as a key is allowed (normalizes to `credentialref`). | `contracts.ts:957-1036` |
| S13 | Credential Manager already exists natively: ref `splyce-credential:v1:<64 lowercase hex>` (32 bytes from `BCryptGenRandom`), target `Splyce/credentials/v1/<hex>`, `CRED_TYPE_GENERIC`, `CRED_PERSIST_LOCAL_MACHINE`; `write_generated` always makes a fresh ref; `read_owned`, `delete_owned`; secret <= `CRED_MAX_CREDENTIAL_BLOB_SIZE`, no control chars. No enumerate function. No Tauri command exposes it; only the private `credential.scope.*` reader uses it. Module doc: "callers own admission and reference persistence". | `src-tauri/src/credentials.rs:18-21`, `27-52`, `101-158`, `180-213`; `process.rs:588-710`; `lib.rs:29-35`; `capabilities/main.json` |
| S14 | Engine reads secrets only through single-use native scopes: `target` must match `^splyce-credential:v1:[0-9a-f]{64}$`; failure surface is the single fixed code `CREDENTIAL_UNAVAILABLE`. | `native-control.mjs:18-24`, `122-198`, `71-120`; `process.rs:664-688`, `703-708` |
| S15 | Native-provider supports only `apiFamily` `openai-completions` \| `openai-responses`; scope creation requires connection revision/endpointRef equality and non-empty `modelId`. | `native-provider.ts:31-35`, `114-141` |
| S16 | `mintGrant` needs an existing admitted workspace and (for fs/shell) an existing Pi-derived session; `revokeProviderGrants(workspaceId)` exists for "profile change". | `store.ts:2488-2492`, `2593-2608` |
| S17 | `SessionMap.bind(key{scopeId,sessionId}, piSessionView)` binds a live Pi `SessionManager` to a NATIVE session id; foreign rebinding is `SESSION_FOREIGN`. | `session-map.ts:70-90`, `169-235` |
| S18 | modelId TD-26 successor (unmerged): `ProfileBinding.modelId` required on write (`modelRef`: 1..256, no whitespace/control, `/` and `:` allowed), optional on stored legacy snapshots; `select` rejects legacy snapshot with `PROFILE_MODEL_UNBOUND`; `effective()` returns `generationReady` + `generationBlocker`. | fork `d17c528`: `provider-profiles.ts`, `contracts.ts` (+17/-?), tests `provider-profiles.ts`, `provider-profile-cas.ts` |
| S19 | UI seam: `CredentialForm.svelte` (PR #151 `6255699`, NOT in bootstrap) injects `submit(draft:{displayName,baseUrl,apiKey})`, clears the key in `finally`, shows fixed copy on any rejection. In bootstrap only `ConnectionCard`/`CustomEndpointForm` exist; `profiles.ts` already exposes `ConnectionView.credentialRef` and `CredentialStatus = configured|missing|unavailable`. | `apps/desktop/src/stores/profiles.ts:1-25`; `git show 6255699:apps/desktop/src/components/provider/CredentialForm.svelte` |

Not found: hive `commons/backend-frontend-contracts.md` / `renderer-view-contracts.md` (no `~/.agentmesh` hive clone on this machine; repo has none). Only `research/docs/design/client-contract.md` and `implementation-contracts.md` (the latter line 22: locality must be derived from the admitted endpoint, never a caller label).

---------------------------------------------------------------------------------------------------

## 2. DECISIONS NEEDING LEAD RESOLUTION (recommended default first)

1. **Profile scope = `workspaceId`.** All profile/connection/config revisions are per scope (S7,S8) and `session.start` takes a workspace. Default: `scopeId := workspaceId`; `provider.configure` and `profile.select` carry `workspaceId`; first-run order is admit workspace -> configure -> select -> session.start. Alternative (a global `app` scope) breaks `fence()` which reads effective profile by the session's scope (`native-host.mjs:56-102`). Cost of default: a key is per workspace (re-use via `credential:{kind:"keep"}` is per connection, so entering the key once per workspace).
2. **Renderer needs a way to read current revisions** (CAS tokens) after restart, and the 4-command envelope is frozen. Default: Codex's `metadata` result gets ONE additive optional field per workspace view: `setup?: SetupView` (type in 4.1). Without it the renderer cannot form `expectedConnectionRevision/expectedProfileRevision/expectedConfigRevision`. If rejected, fallback is returning `setup` only from configure/select (breaks after restart).
3. **Commit granularity.** Store cannot atomically write endpoint+connection+profile (S9). Default: three sequential CAS appends, commit point = the `profileSnapshot` append (last), partial prefixes are invisible (nothing selected) and harmless immutable revisions. Alternative: add `Store.commitProviderSetup()` one-transaction API (store.ts + validation work) to remove partial states. Recommend defer.
4. **Idempotency key persistence.** Default: `requestId` becomes the deterministic `recordId` of the artifact/profileSnapshot (`profile-<requestId>`) and the transition (`select-<requestId>`); needs an optional `recordIdSeed`-style input on `writeConnection`/`writeProfile` (today `metadata()` uses `crypto.randomUUID()`, `provider-profiles.ts:308-316`). `record_id` uniqueness gives duplicate detection; the values-artifact digest detects requestId reuse with a different payload.
5. **Owned immutable descriptors for refs the user never supplies.** `ProfileInput` requires `egressPolicyRefs`, `limitsArtifactId`; `ConnectionInput` requires `accountScopeRef`, `apiVersion`, `adapterRevision`; `ConfigChange` requires `intentRef`, `changedValuesArtifactId`; all `ref`s must resolve (S11). Default: the engine idempotently writes small `artifact` records (recordIds `splyce-desc-account-provider-default-v1`, `splyce-desc-limits-default-v1`, `splyce-desc-egress-provider-only-v1`, and per request `setup-values-<requestId>` = sha256 digest of the canonical non-secret payload used as both `intentRef` and `changedValuesArtifactId`). `apiVersion := "v1"`, `adapterRevision := PI_REVISION` (INFERRED constants). `credentialRef` and `endpointRef` are admitted through an engine-owned `resolveReference` closure that accepts exactly the refs of that request, never `() => true`.
6. **Endpoint pinning.** `providerConnection` has only `endpointRef` (no endpoint revision) but `resolveEndpoint(scope, endpointRef, revision)` needs both (`store.ts:2611-2629`). Default: `endpointRef := "<endpointId>@<revision>"` (`endpointId = ep-<providerConnectionId>`, revisions `r1..`), resolver splits on `@`. Origin-only per ruling means a provider needing `/v1` base path is NOT expressible; default: adapter appends the family path, `basePath` deferred.
7. **Model dependency.** `provider.configure` needs `modelId`; take `d17c528` (fork td26-modelid) into bootstrap first. Edge: persisted-JSON path filter (`contracts.ts:972`) rejects model ids that start with `/` or contain `X:/`/`X:\`; reject those in the DTO (`MODEL_INVALID`).
8. **Error-code set.** Frozen `ERROR_CODES` (`contracts.ts:709-716`) is for the session event payload. Default: a separate `SETUP_ERROR_CODES` list (4.5) plus reuse `STALE_REVISION`/`POLICY_DENIED`; `BridgeError` gains optional fixed-enum `detail` (`ipc.rs:14-19`).
9. **Readiness scope.** `ports` is global; default: `workspace` = any admitted workspace; `provider` = some workspace has an effective profile with a `chat` binding whose credential state is `present`; `generation` = `provider` AND that profile `generationReady` (modelId bound). Per-workspace truth is `SetupView.generation`, and `session.start` re-checks for its own workspace (`SETUP_NOT_READY`).
10. **Locality is validated, not trusted.** DTO carries explicit `locality`; it must equal the value derived from the endpoint host (`loopback` host -> `local`), else `SETUP_LOCALITY_MISMATCH`. Renderer's `isLoopbackUrl` accepts all `127.0.0.0/8` (`profiles.ts:99-111`) but contracts accept only `127.0.0.1`,`[::1]`,`localhost` (`contracts.ts:569`); native wins, tighten the renderer.
11. **`displayName` has no home** in any record (S19 draft has it). Default: not persisted; renderer-local label only. A record field needs a contracts change.
12. **Wire op string.** Default: renderer calls `invoke("send",{op:"setup",payload:<SetupFrame>})`; Rust branches on `op==="setup"` before `valid_command`. Engine method name `setup` (not `send`). INFERRED; lead may prefer a different op token.
13. **Credential-liveness rule for GC** (4.4): a credential is live iff it is the `credentialRef` of the LATEST revision of any connection OR is pinned by an effective profile. Rotation therefore destroys the previous key; older revisions become unselectable (`credential:"missing"`). Recommended; the alternative (keep every historical key) leaks superseded secrets.

---------------------------------------------------------------------------------------------------

## 3. Envelope (frozen shape) and common rules

```ts
// packages/splyce-pi/src/contracts.ts (additive; ERROR_CODES untouched)
export const SETUP_COMMANDS = ["metadata","provider.configure","profile.select","session.start"] as const;
export type SetupCommand = (typeof SETUP_COMMANDS)[number];

export interface SetupFrame<C extends SetupCommand = SetupCommand> {
  frame: "setup";
  command: C;
  /** Opaque id, 1..96 chars, /^[A-Za-z0-9][A-Za-z0-9._-]*$/ ; IDEMPOTENCY KEY for configure/select/start. */
  requestId: string;
  payload: SetupPayloads[C];
}
export interface SetupOk<C extends SetupCommand> {
  frame: "setup"; command: C; requestId: string; ok: true; result: SetupResults[C];
}
```

Validation (Rust first, then engine re-validates; both exact):
- Frame has exactly 4 keys; `frame==="setup"`; `command` in enum; payload an object with EXACTLY the command's keys (no extra, no missing, no `__proto__`/non-enumerable; mirror `object()` at `provider-profiles.ts:136-155`, and `#[serde(deny_unknown_fields)]` as `process.rs:588-596`). Structural failure returns the existing `POLICY_DENIED` `BridgeError::denied()` (`ipc.rs:25-31`): no field oracle.
- Frame size <= `TRANSPORT_LIMITS.maxInlineBytes` (65536); `secret` <= `MAX_SECRET_BYTES` (`credentials.rs:21`) and the Tauri arg is rejected before any forwarding if larger.
- ids (`workspaceId`, `providerConnectionId`, `profileId`, revisions): non-empty, <=64 chars, `^[A-Za-z0-9][A-Za-z0-9._-]*$` (stricter than `opaque()` which only forbids whitespace and `\ /`).
- The engine NEVER receives key names `secret|apiKey|password|token|authorization` (reject at Rust and at the engine; defence in depth with S12).
- Only one setup call in flight (existing `try_lock` in `ipc.rs:278`; map the contention to `SETUP_BUSY`).

### 3.1 Payloads

```ts
export type ApiFamily = "openai-completions" | "openai-responses";          // S15

export interface ProviderConfigurePayload {
  workspaceId: string;                       // admitted workspace; scopeId == workspaceId (D1)
  providerConnectionId: string;              // stable connection identity (e.g. "openai-main")
  apiFamily: ApiFamily;
  /** ORIGIN ONLY: scheme://host[:port]. https required unless host is 127.0.0.1|[::1]|localhost (then http|https). No path, query, fragment, userinfo. <=253 host chars. */
  endpoint: string;
  locality: "local" | "hosted";              // must equal derived (D10)
  /** The single chat role binding the profile will pin. */
  chat: { modelId: string };                 // modelRef: 1..256, no whitespace/control (d17c528)
  /** Provider-default only. Any other string -> SETUP_ACCOUNT_UNSUPPORTED (typed, never ignored). */
  accountScopeRef: "provider-default";
  /** `new`: secret goes to Windows Credential Manager inside Rust and never reaches Node/Store.
   *  `keep`: reuse the credentialRef of the connection revision named by expectedConnectionRevision. */
  credential: { kind: "new"; secret: string } | { kind: "keep" };
  /** Profile identity written/advanced by this call. */
  profileId: string;
  /** CAS tokens: null only for first-ever write. Latest-at-commit must equal these exactly. */
  expectedConnectionRevision: string | null; // "c<N>"
  expectedProfileRevision: string | null;    // "p<N>"
  expectedEndpointRevision: string | null;   // "r<N>"
}
// keep requires expectedConnectionRevision !== null.

export interface ProfileSelectPayload {
  workspaceId: string;
  profileId: string;
  profileRevision: string;                   // exact "p<N>", never "latest"
  expectedConfigRevision: string;            // effective config revision seen by caller ("cfg-0" initially)
}

export interface SessionStartPayload {
  workspaceId: string;
  expectedWorkspaceRevision: string;         // WorkspaceView.revision from metadata (admitted-workspace snapshot)
  profileId: string;
  expectedProfileRevision: string;           // must be the EFFECTIVE profile's revision
  expectedConfigRevision: string;
}
// No sessionId, no piSessionId, no initialPrompt, no grants, no model: all native-derived.
```

### 3.2 Results

```ts
export type CredentialState = "present" | "missing" | "unknown";
export interface ConnectionSetupView {
  providerConnectionId: string; revision: string;           // "c<N>"
  apiFamily: ApiFamily; endpointOrigin: string;              // originView(): scheme://host:port
  endpointRevision: string;                                  // "r<N>"
  locality: "local" | "hosted";
  credentialRef: string;                                     // splyce-credential:v1:<64 hex>; a locator, never a secret
  credential: CredentialState;                               // from native probe, never from the record
}
export interface SetupView {                                 // per workspace; also the additive metadata field (D2)
  workspaceId: string;
  configRevision: string;                                    // effective, "cfg-N"
  connection: ConnectionSetupView | null;                    // LATEST connection revision
  profile: { profileId: string; latestRevision: string;      // "p<N>"
             effectiveRevision: string | null;               // applied selection, else null
             modelId: string | null; pinnedConnectionRevision: string } | null;
  generation: { ready: boolean; blocker: null
    | "PROFILE_NONE" | "PROFILE_NOT_SELECTED" | "MODEL_UNBOUND"
    | "CREDENTIAL_MISSING" | "CREDENTIAL_UNKNOWN" | "WORKSPACE_UNAVAILABLE" };
}
export interface NativeReadiness { /* exactly Handshake["readiness"] (contracts.ts:889-895) */
  state: "ready" | "unavailable"; policy: boolean; store: boolean; receipts: boolean; ports: PortAvailability }

export interface SetupResults {
  "provider.configure": { setup: SetupView; readiness: NativeReadiness; replayed: boolean };
  "profile.select":     { setup: SetupView; readiness: NativeReadiness; replayed: boolean };
  "session.start": {
    sessionId: string;            // native-minted, "ses-<uuid>"
    scopeId: string;              // == workspaceId
    piSessionId: string;          // opaque Pi id, informational
    configRevision: string; profileRevision: string; policyRevision: string; // for the next sessionful CommandContext
    cursor: 0;                    // first session.subscribe afterSeq
  };
  metadata: unknown;              // Codex-owned, settled
}
```

### 3.3 Error table (fixed codes, fixed messages, no value echo, no stack/OS text)

`BridgeError{code,message,correlationId=requestId,retryable}` plus optional `detail` from a fixed enum (`ipc.rs:14-19`).

| code | when | retryable | detail enum |
|------|------|-----------|-------------|
| `POLICY_DENIED` (existing) | bad frame/keys/size, wrong window, unknown command | no | none |
| `SETUP_INVALID` | semantic field failure | no | `field`: `workspaceId`,`providerConnectionId`,`apiFamily`,`endpoint`,`locality`,`modelId`,`profileId`,`revision`,`requestId`,`credential` |
| `SETUP_ACCOUNT_UNSUPPORTED` | `accountScopeRef !== "provider-default"` | no | none |
| `SETUP_ENDPOINT_REJECTED` | not origin-only / not https / non-loopback http / userinfo/query/path | no | none |
| `SETUP_LOCALITY_MISMATCH` | declared locality != derived | no | none |
| `SETUP_CREDENTIAL_INVALID` | empty/oversize/control-char secret (`validate_secret`) | no | none |
| `SETUP_CREDENTIAL_UNAVAILABLE` | any `CredentialError` from write/read-back (collapsed: access denied, no logon session, platform failure, corrupt, not found) | yes | none |
| `STALE_REVISION` (existing) | any CAS miss | no | `stale`: `connection`,`endpoint`,`profile`,`config`,`workspace` |
| `SETUP_WORKSPACE_UNAVAILABLE` | unknown/superseded/identity-changed workspace | no | none |
| `SETUP_PROFILE_UNAVAILABLE` | unknown profile/revision, bindings do not resolve | no | none |
| `SETUP_MODEL_UNBOUND` | legacy snapshot without modelId (`PROFILE_MODEL_UNBOUND`) | no | none |
| `SETUP_NOT_READY` | `session.start` while `generation.ready=false` | no | `blocker` (SetupView enum) |
| `SETUP_STORE_FAILED` | definite Store failure, reconciled as NOT applied | yes | none |
| `SETUP_OUTCOME_UNKNOWN` | engine/Store outcome not provable after read-back | yes (same `requestId`) | none |
| `SETUP_BUSY` | another setup call in flight | yes | none |
| `ENGINE_CRASH` (existing) | engine channel lost | no | none |

Mapping from engine internals: `ProviderProfilesError` `PROFILE_STALE_REVISION`->`STALE_REVISION`, `PROFILE_UNKNOWN_*`/`PROFILE_CONNECTION_REVISION_MISMATCH`->`SETUP_PROFILE_UNAVAILABLE`, `PROFILE_MODEL_UNBOUND`->`SETUP_MODEL_UNBOUND`, `PROFILE_INVALID`->`SETUP_INVALID`; `StoreError ENTITY_STALE_REVISION`/`CONFIG_STALE_REVISION`->`STALE_REVISION`; anything else -> `SETUP_STORE_FAILED` or `SETUP_OUTCOME_UNKNOWN` (4.2). Messages are static strings per code (like `ipc.rs:25-39`).

---------------------------------------------------------------------------------------------------

## 4. Credential Manager <-> Store reconciliation (provider.configure)

### 4.1 credentialRef format (exact, already implemented)
`splyce-credential:v1:` + 64 lowercase hex = 85 chars. Generated ONLY by Rust `credentials::write_generated` (32 bytes `BCryptGenRandom`, `credentials.rs:120-141`). CM target `Splyce/credentials/v1/<hex>` (`credentials.rs:19,45-51`). The renderer can never supply one (not in the DTO); the engine validates it against `^splyce-credential:v1:[0-9a-f]{64}$` (same as `native-control.mjs:130`) and the Rust parse (`credentials.rs:27-39`). It is a locator; it is returned to the renderer inside `ConnectionSetupView` only for display/`ConnectionView.credentialRef` (`profiles.ts:18`), and may be dropped from the view with no contract impact.

### 4.2 Order (secret ends in Rust; Node sees only the ref)

New Rust module `src-tauri/src/setup.rs`; new Rust->engine methods (same `bridge.call` channel as `native.workspace.admit`, S4): `native.setup.lookup`, `native.setup.commit`, `native.setup.readback`, `native.setup.reconcile`, `native.credential.report`.

```
Rust                                            Engine (Node)                         Windows CM
 1 validate frame+DTO (strict), caller()
 2 lookup {requestId} ───────────────────────►  profile-<requestId> snapshot exists?
        ◄── replayed? ─────────────────────────  yes -> return SetupView (replayed:true) ──► DONE (no CM write, secret discarded)
 3 (kind:"new") write_generated(secret) ─────────────────────────────────────────────────► R created   [W1]
   (kind:"keep") R := none (engine resolves latest ref)
 4 commit {payload-sans-secret, credential:{kind:"new",credentialRef:R}|{kind:"keep"}} ─►
                                               4a validate; CAS pre-check vs latest c/p/r  -> STALE_REVISION
                                               4b ensure descriptor artifacts + setup-values-<requestId>
                                               4c endpoint compareAndAppend (skip if identical to latest)  [W2]
                                               4d writeConnection c(N+1) (credentialRef=R)                  [W3]
                                               4e writeProfile  p(M+1) pins c(N+1)+modelId  <-- COMMIT     [W4]
        ◄── {ok, SetupView} | {ok:false, code, credentialReferenced:boolean}
 5 read-back (BOTH sides) :
     5a  engine read: native.setup.readback {requestId,R} -> {committed, referenced}
     5b  CM probe: read_owned(R) then wipe  (kind:new or keep ref)
 6 success reply ONLY if 5a.committed && 5b present. Else see matrix.
 7 post-success GC (best-effort): native.credential... liveness -> delete non-live (previous R).
```

Rules:
- **Never report success on assumption.** Reply `ok` only after step 5 proves the profile snapshot is committed AND the credential is readable. A lost/timed-out step 4 is resolved by 5a (retry up to 3x, 250/500/1000 ms) before any code is returned.
- **Idempotency key = `requestId`.** Deterministic ids: `profile-<requestId>` (profileSnapshot recordId, D4), `setup-values-<requestId>` (artifact; its digest binds the exact non-secret payload; same `requestId` + different payload -> `SETUP_INVALID{field:requestId}`), `select-<requestId>` (transition id; recordIds `select-<requestId>.pending|.applied`, `config.ts:88`). Step 2 short-circuits replays before touching CM, so a retry after a lost reply never creates a second credential.
- **Compensation rule** (step 4 failed): Rust deletes the fresh `R` ONLY IF the engine/readback says `referenced:false` (no providerConnection record carries R). If W3 landed (connection c(N+1) is latest and references R) R is LIVE and must stay; the user retries with `credential:{kind:"keep"}` and `expectedConnectionRevision:"c(N+1)"`.
- **Unknown after read-back fails** (engine dead/closed, `BridgeState.closed`, `ipc.rs:344-367`): return `SETUP_OUTCOME_UNKNOWN`, do NOT delete R; next-start reconciliation decides (4.4). The app has no engine restart path today (INFERRED from `BridgeState`: once `closed` it never respawns), so unknown outcomes are resolved after restart.
- Write ordering is always secret-store first, record second (a Store record never points at a ref that was never written). The reverse failure (record without credential) can only be an external deletion or a failed GC.
- `keep` never writes CM; engine copies `credentialRef` from the exact connection revision `expectedConnectionRevision` (CAS-checked), then Rust 5b still probes it.

### 4.3 Redaction / non-leak rules
- Secret exists only in: the Tauri `payload` Value in Rust (best-effort wipe after use: copy into a `SecretBuffer`-style owned vec and zero, same discipline as `credentials.rs:54-72`, `215-221`; `serde_json::Value` copies cannot be fully wiped, document as residual), then the `CREDENTIALW` blob.
- Never in: engine frames, Store, logs, `BridgeError`, error `detail`, panic messages, `Debug`/`Serialize` impls (no derives on the secret holder). Renderer clears its input in `finally` (S19). Rust error mapping is the fixed table in 3.3; OS error codes are never forwarded.
- Engine rejects any setup frame containing a secret-like key (defence in depth with `contracts.ts:1009-1030`).
- Engine redactor (`credential-resolver.ts:103-109`) does not apply (engine never holds it); tests assert absence by scanning every outbound frame and Store payload for the secret and its encodings (base64/url/JSON forms as `credential-resolver.ts:207-217`).

### 4.4 Startup reconciliation (after `native.bootstrap`, before first renderer `handshake` is served)
1. Rust `credentials::enumerate_owned()` (NEW; `CredEnumerateW` with filter `Splyce/credentials/v1/*`; `windows-sys` feature `Win32_Security_Credentials` is already enabled, `Cargo.toml` target deps; INFERRED not compiled) returns `[(CredentialRef, LastWritten FILETIME)]`.
2. Rust -> engine `native.setup.reconcile {present:[refs]}`. Engine scans via `store.audit()` (`store.ts:601`, includes every scope) and computes:
   - `live` = `credentialRef` of the LATEST revision of each `providerConnection` ∪ refs of connection revisions pinned by each scope's `effective()` profile (D13);
   - `missing` = live refs not in `present` (Store record without credential);
   - `garbage` = `present \ live` (credential without live record).
   Engine caches `credentialPresent: Map<ref,bool>` for readiness; it returns `{garbage:[refs], missing:[{scopeId,providerConnectionId,revision}]}` (no mutation of the Store).
3. Rust deletes each `garbage` ref whose `LastWritten` is older than 15 minutes (grace for a second app instance or an in-flight write; `delete_owned`). Failures are ignored and retried next start (never block startup, never surface a secret/OS code).
4. Store record without credential: NEVER auto-deleted (append-only). `SetupView.connection.credential="missing"`, `generation.ready=false`, blocker `CREDENTIAL_MISSING`; user fixes via `provider.configure` with `credential:{kind:"new"}`.
5. The same liveness computation runs after every successful configure/select to drop the superseded key (step 7).

### 4.5 `profile.select` ordering and idempotency
`requestId` -> transition `select-<requestId>`; engine: (1) replay check `select-<requestId>.applied` exists -> return view `replayed:true` (payload digest compared via `setup-values-<requestId>`); (2) validate snapshot, bindings resolve, `modelId` bound (else `SETUP_MODEL_UNBOUND`), credential `present` for the pinned connection revision (probe via cache, else `SETUP_NOT_READY{CREDENTIAL_*}`); (3) `store.revokeProviderGrants(workspaceId)` BEFORE apply (crash between leaves fewer grants, never stale ones; S16); (4) `ProviderProfiles.select` with `acceptedConfigRevision = "cfg-<n+1>"` derived from `expectedConfigRevision` (`/^cfg-\d+$/`, else `SETUP_INVALID`), `ConfigAuthority.request` then `.apply` (CAS, `config.ts:57-78`). Crash after `.pending` before `.applied`: pending changes nothing (`store.ts:894-898`); replay re-applies. Reply only after reading back `effective()` equals the requested `(profileId,profileRevision)`.

### 4.6 `session.start` ordering
1. Validate; load admitted workspace by id and compare `revision === expectedWorkspaceRevision` and native identity still current (`store.getWorkspace`, `workspace.rs` identity), else `SETUP_WORKSPACE_UNAVAILABLE`/`STALE_REVISION{workspace}`.
2. Read `effective()` for the scope; require `profileId/revision` equal expected and config revision equal expected (`STALE_REVISION`), `generationReady`, credential `present` (probe), else `SETUP_NOT_READY{blocker}`.
3. `SessionManager.create(...)` (real Pi; session dir under `<appData>/splyce/`), mint native `sessionId = "ses-"+uuid`, `SessionMap.bind({scopeId:workspaceId,sessionId}, pi)` (`session-map.ts:180`). Any bind failure -> dispose the Pi session, reply `SETUP_STORE_FAILED`.
4. NO grant is minted here (`mintGrant` is a later, user-approved step). Idempotency: `requestId` -> an in-memory `requestId -> sessionId` map for this process; across restarts a replayed `session.start` creates a NEW session (documented; sessions are cheap and uncommitted state is empty). Response carries revisions for the renderer's next `CommandContext` (`engine.ts:42-49`).

---------------------------------------------------------------------------------------------------

## 5. Readiness consequences (S5, S6)

- `native-host.mjs` `handshakeReadiness` stays sync; ports computed from cached state (4.4 step 2 cache + commit-time updates): `workspace = listWorkspaces().length>0`; `provider = ∃ scope: effective profile has chat binding ∧ connection credential cache = present`; `generation = provider ∧ generationReady`; `modules = false` always (not touched).
- Flips are driven only by: successful `profile.select` (profile becomes effective), successful `provider.configure` with `keep`/`new` for the EFFECTIVE connection (credential now present), reconcile discovering missing/present, workspace admission. A configure alone does not flip `generation` (nothing is selected).
- Every configure/select reply carries `readiness` (same shape as handshake). Renderer feeds it through a NEW `applyReadiness(r)` in `engine.ts` that runs `validatePortAvailability` and the `projectPorts` rule (`engine.ts:89-96`), then `notifyPorts`/`notifyState`. Re-handshake is the fallback. Before a session exists there is no `engine.status` stream; once a session is subscribed the existing `engine.status.ports` (`contracts.ts:766-770`, `ipc.rs:155-159`) re-delivers the same computed readiness (engine must emit it from the same source).
- Loss of credential later (external deletion) flips `generation` false on the next reconcile/probe and the existing resolver fails closed with `CREDENTIAL_UNAVAILABLE` (S14).

---------------------------------------------------------------------------------------------------

## 6. One exact caller example per command (renderer-side typed adapter over `invoke`)

```ts
// apps/desktop/src/stores/setup.ts  (NEW; imports invoke from "@tauri-apps/api/core" only here)
type Send = <C extends SetupCommand>(f: SetupFrame<C>) => Promise<SetupOk<C>>;
const send: Send = (frame) => invokeNative("send", { op: "setup", payload: frame }) as never;
const rid = () => `req-${crypto.randomUUID()}`;               // <=96, matches the id regex

// 6.1 provider.configure  (first-ever save; secret goes straight to Rust, nothing returned)
const requestId = rid();
const r1 = await send({
  frame: "setup", command: "provider.configure", requestId,
  payload: {
    workspaceId: "ws-3b1f...", providerConnectionId: "openai-main",
    apiFamily: "openai-responses", endpoint: "https://api.openai.com", locality: "hosted",
    chat: { modelId: "gpt-5" }, accountScopeRef: "provider-default",
    credential: { kind: "new", secret: apiKeyField.value },   // cleared in finally
    profileId: "chat-default",
    expectedConnectionRevision: null, expectedProfileRevision: null, expectedEndpointRevision: null,
  },
});
// Expected native response (ok):
// { frame:"setup", command:"provider.configure", requestId, ok:true, result:{
//   replayed:false,
//   setup:{ workspaceId:"ws-3b1f...", configRevision:"cfg-0",
//     connection:{ providerConnectionId:"openai-main", revision:"c1", apiFamily:"openai-responses",
//       endpointOrigin:"https://api.openai.com:443", endpointRevision:"r1", locality:"hosted",
//       credentialRef:"splyce-credential:v1:<64 hex>", credential:"present" },
//     profile:{ profileId:"chat-default", latestRevision:"p1", effectiveRevision:null,
//       modelId:"gpt-5", pinnedConnectionRevision:"c1" },
//     generation:{ ready:false, blocker:"PROFILE_NOT_SELECTED" } },
//   readiness:{ state:"ready", policy:true, store:true, receipts:true,
//     ports:{ generation:false, provider:false, workspace:true, modules:false } } } }
// Retry after a lost reply: SAME requestId (secret may be omitted from retry? NO: the DTO is exact,
// resend it; Rust's step-2 lookup returns replayed:true and discards it without any CM write).

// 6.2 profile.select
const r2 = await send({
  frame: "setup", command: "profile.select", requestId: rid(),
  payload: { workspaceId: "ws-3b1f...", profileId: "chat-default", profileRevision: "p1",
             expectedConfigRevision: r1.result.setup.configRevision },       // "cfg-0"
});
// ok result: setup.configRevision:"cfg-1", profile.effectiveRevision:"p1",
//   generation:{ ready:true, blocker:null },
//   readiness.ports:{ generation:true, provider:true, workspace:true, modules:false }
// stale: rejects BridgeError {code:"STALE_REVISION", detail:"config", retryable:false, correlationId:<requestId>}

// 6.3 session.start (no sessionId in, native-minted sessionId out; no grant)
const r3 = await send({
  frame: "setup", command: "session.start", requestId: rid(),
  payload: { workspaceId: "ws-3b1f...", expectedWorkspaceRevision: ws.revision,
             profileId: "chat-default", expectedProfileRevision: "p1",
             expectedConfigRevision: r2.result.setup.configRevision },
});
// ok result: { sessionId:"ses-9d2c...", scopeId:"ws-3b1f...", piSessionId:"<pi id>",
//   configRevision:"cfg-1", profileRevision:"p1", policyRevision:"cfg-0", cursor:0 }
// then existing sessionful path: engine.subscribe(r3.result.sessionId, 0);
//   engine.invoke("session.prompt", {...}, { sessionId, scopeId, expected*Revision from the result }).

// 6.4 key rotation / edit without retyping the key (CAS on current revisions)
await send({ frame:"setup", command:"provider.configure", requestId: rid(), payload: {
  /* same fields */ credential:{ kind:"keep" },
  expectedConnectionRevision:"c1", expectedProfileRevision:"p1", expectedEndpointRevision:"r1" }});
// -> c2/p2, profile.effectiveRevision stays "p1" until profile.select(p2).
```

CredentialForm seam (PR #151 `CredentialForm.svelte`): `submit(draft)` is implemented by `setup.ts` as `provider.configure`; the form needs three added inputs (model id, workspace, connection id); the component keeps its fixed-copy failure text and clears `apiKey` in `finally` (S19).

---------------------------------------------------------------------------------------------------

## 7. Files to add/change, by owner

**Native Rust (`apps/desktop/src-tauri/src`)**
- NEW `setup.rs`: frame/DTO deserialization (`deny_unknown_fields`), validators, orchestration 4.2, readback retry, reply mapping to 3.3.
- CHANGE `ipc.rs`: in `send`, `if op == "setup"` -> `setup::handle` BEFORE `valid_command` (`ipc.rs:541-560`); add `detail: Option<&'static str>` to `BridgeError` (`14-19`); keep `caller()` check. Reuse `BridgeState::call`.
- CHANGE `credentials.rs`: add `enumerate_owned()`; add `exists/probe` wrapper over `read_owned` that wipes immediately; keep `write_generated/delete_owned` untouched.
- CHANGE `lib.rs`: `mod setup;` and call startup reconcile after `BridgeState::start` (`lib.rs:19-28`). No new `#[tauri::command]`, no capability change (`send` already allowed).
- NOT touched: `process.rs` private `credential.scope.*` reader, `workspace.rs`, `dialog_select_workspace`, `valid_command`, subscribe/cancel.

**Engine host / native host (`packages/splyce-pi/src`)**
- CHANGE `engine-host.mjs`: new branch for method `setup` and `native.setup.{lookup,commit,readback,reconcile}`, `native.credential.report`, all exact-param validated, errors mapped to 3.3; existing `send` stub unchanged (`219-250`).
- CHANGE `native-host.mjs`: add `configureProvider`, `selectProfile`, `startSession`, `setupView(scopeId)`, `reconcile`, computed `handshakeReadiness` (5), engine-owned `resolveReference` closure, descriptor artifact ensure. Do NOT reuse the fake `native-workspace-admission` caller (`132`); setup callers use `sessionId: requestId`-derived `setup-<requestId>` ONLY as Store row attribution (INFERRED: `CallerContext.sessionId` is mandatory, `store.ts:82-88`) and it is never exposed to the renderer.
- CHANGE `provider-profiles.ts`: optional deterministic record id seed on `writeConnection`/`writeProfile`; endpoint write helper (`providerEndpoint` via `compareAndAppend`); apply `d17c528` first.
- NEW `session-start.mjs` (or inside native-host): `SessionManager.create` + `SessionMap.bind`.
- NOT touched: `credential-resolver.ts`, `native-control.mjs`, `policy.ts`, `admission.ts`, `native-provider.ts`, `store.ts` schema (one optional read helper is allowed only if `audit()` proves too heavy).

**contracts.ts (`packages/splyce-pi/src/contracts.ts`)**
- ADD (additive only): `SETUP_COMMANDS`, `SetupFrame`, `SetupPayloads/Results`, `SETUP_ERROR_CODES`, `validateSetupFrame` (exact-key validators), `SetupView`; extend `BRIDGE_PROTOCOL_JSON` ONLY if Rust is to consume the schema (otherwise Rust has its own serde types and a drift test pins both, see 8). `modelRef` rule from `d17c528`.
- NOT touched: `COMMAND_SCHEMAS`, `ERROR_CODES`, `Handshake`, `PROTOCOL_VERSION`, `RECORD_SCHEMAS` (no new record kind; `artifact` and `providerEndpoint` already exist).

**Renderer (`apps/desktop/src`)**
- NEW `stores/setup.ts` (typed adapter, 6), `applyReadiness` in `stores/engine.ts`, `CredentialForm.svelte` (from `6255699`) extended with model/workspace/connection fields, `stores/profiles.ts` `validateCredentialDraft` tightened to origin-only + native loopback set (D10).
- NOT touched: `engine.invoke` sessionful path, `handshake()` semantics, Tauri capability file.

---------------------------------------------------------------------------------------------------

## 8. Tests (failing-first), per layer

**contracts (node:test, `tests/contracts.test.mjs`)**
1. unknown/missing key in each of the 3 payloads rejected; frame with `sessionId` rejected; `command` outside enum rejected.
2. `endpoint` table: `https://api.openai.com` ok; `http://api.openai.com`, `https://a/b`, `https://u:p@a`, `https://a?x=1`, `https://a/#f`, `http://127.0.0.1:11434` (ok, local), `http://[::1]:11434` (ok), `http://127.0.0.2` (rejected) .
3. `accountScopeRef:"acct-123"` -> `SETUP_ACCOUNT_UNSUPPORTED`; omitted -> `POLICY_DENIED`.
4. `modelId` bounds (256 ok, 257 rejected, whitespace/control rejected, `/x` and `a:/b` rejected).
5. Drift: Rust serde field list equals TS field list (parse `setup.rs` DTO names vs `SetupPayloads`).

**engine/store (integration, real `Store`, `tests/integration/setup-*.ts`)**
6. configure first write -> endpoint r1, connection c1, profile p1; nothing effective; `readiness.generation=false`.
7. CAS: stale `expectedConnectionRevision`/`expectedProfileRevision`/`expectedEndpointRevision` each -> `STALE_REVISION{detail}`; no record written (cursor unchanged).
8. select p1 -> `cfg-1`, effective p1, `generationReady`; two concurrent selects with same expected: exactly one applies.
9. Idempotency: same `requestId` replay returns `replayed:true`, zero new records; same `requestId` different payload -> `SETUP_INVALID{requestId}`.
10. Crash windows via injected failure after each of W2/W3/W4 and after `.pending`: only expected rows exist, effective profile unchanged until `.applied`, retry with `keep` completes.
11. select revokes live `net.provider` grants before apply; legacy snapshot without `modelId` -> `SETUP_MODEL_UNBOUND`.
12. `session.start` before readiness -> `SETUP_NOT_READY`; after: real `SessionManager.create` + `SessionMap.bind`, no `grant` records exist, no `sessionId` accepted from input, stale workspace revision rejected.
13. Reconcile function: live/missing/garbage sets (latest-revision rule, effective-pin rule, superseded-key rule); no Store mutation.
14. Secret scan: run configure with a canary secret through a fake Rust; assert canary and its base64/url/JSON forms appear in no engine frame, Store payload, error message.

**Rust (cargo test, `src-tauri`)**
15. `setup.rs`: unknown fields/oversize/secret-like keys -> denied; every `CredentialError` maps to the single fixed code; `Debug` of DTO/holder never prints the secret.
16. Orchestration with a fake engine: lookup replay performs NO `write_generated`; step-4 failure + `referenced:false` deletes R; `referenced:true` keeps R; lost reply -> readback `committed` -> success; readback unavailable -> `SETUP_OUTCOME_UNKNOWN` and R kept.
17. Windows-only: `write_generated` -> `enumerate_owned` lists it with `LastWritten`; `delete_owned` removes; garbage younger than 15 min is kept, older deleted; cleanup uses `Drop` guard like `process.rs:1311-1320`.
18. `send` with `op:"setup"` from a non-main window or non-allowed origin -> denied; `valid_command` regression: sessionful commands unchanged.

**Renderer (vitest)**
19. `setup.ts` sends exactly `{op:"setup",payload:frame}`; generates `requestId` matching the id regex; rejects responses with extra keys.
20. `CredentialForm`: key field cleared on success AND failure; failure copy fixed; `submit` rejection with secret-bearing message never rendered.
21. `applyReadiness`: ports true with `state:"unavailable"` rejected; flips `connectionState` to `ready` only for generation+provider+workspace.

**E2E (wdio, gated like existing e2e)**
22. Fresh profile: admit workspace -> configure -> select -> session.start -> subscribe; kill app between configure and reply, relaunch, retry same `requestId` -> replayed success, exactly one CM entry under `Splyce/credentials/v1/` (inspect with `cmdkey /list`, test only).
23. Delete the CM entry externally, relaunch: `credential:"missing"`, `generation:false`, session.start `SETUP_NOT_READY{CREDENTIAL_MISSING}`.

---------------------------------------------------------------------------------------------------

## 9. Crash/failure matrix (two-phase write)

| Window | State left | Detected/healed by | User-visible |
|--------|-----------|--------------------|--------------|
| W0 before CM write | nothing | n/a | retry same `requestId` |
| W1 after CM write R, before engine call | R unreferenced | startup reconcile: `garbage`, deleted after 15 min | `SETUP_OUTCOME_UNKNOWN` or crash; retry makes new R |
| W2 endpoint r(N+1) written only | endpoint orphan revision; R unreferenced | immutable orphan harmless; R garbage-collected | `STALE_REVISION{endpoint}` on naive retry with old token; re-read `setup` |
| W3 connection c(N+1) written, no profile | R LIVE (latest connection); effective profile unchanged | liveness rule keeps R; retry with `keep` + new tokens | `SetupView` shows connection newer than profile |
| W4 profile p(M+1) written, reply lost | COMMITTED | lookup/readback returns `replayed:true`; Rust probes R | success on retry |
| Select `.pending` only | no effect | replay applies | none |
| Select `.applied`, reply lost | effective changed | replay returns `replayed:true` | success on retry |
| Grants revoked, apply failed | fewer grants | re-mint needed | none (safe direction) |
| CM deleted externally / GC failed | Store record, no credential | reconcile `missing` + probe | `credential:"missing"`, `generation=false` |
| Engine dies mid-call | unknown | after restart: reconcile + readback by `requestId` | `SETUP_OUTCOME_UNKNOWN`, then consistent view |
| Two app instances | R of other instance unreferenced for a moment | 15 min `LastWritten` grace | none |
| GC delete fails (`AccessDenied`) | garbage stays | retried next start | none |

---------------------------------------------------------------------------------------------------

## 10. Could not verify
- Hive commons contracts (`backend-frontend-contracts.md`, `renderer-view-contracts.md`): not present locally.
- Nothing compiled or run (read-only): `CredEnumerateW` availability/signature in `windows-sys 0.61.2`, `LastWritten` use, `SessionManager.create` wiring inside `engine-host`, Pi session dir layout.
- Whether Tauri logs invoke arguments in release (secret residency in `serde_json::Value`).
- `c4df619` reviewed only for the files in section 7; `bc8fa19`'s policy changes (`policy.ts`, 2 lines) not studied beyond the diff stat.
