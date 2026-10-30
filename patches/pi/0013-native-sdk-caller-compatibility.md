# Native SDK caller compatibility

This historical work-in-progress record pins the canonical source checkpoint
listed below. Its archive replay and original vendor check are complete for that
checkpoint; this is not a native, installed-app or release qualification.

Donor: Pi `d5b3de22d0e24a3e9c38a9410d3329b099717283`, coding-agent 1.4.0.
Preserve its MIT license and notices. This patch adds no dependencies.

Patch 0013 records eleven SDK, Agent and extension caller paths at canonical
source `8c278114b6ad3ebb7b120bc6c87f2e7b455670ec`, full Git tree
`911c1bfa2d3c28c984c17fc3be2fc318a1636019`. It excludes ModelRuntime, whose
native registration and original-options checks belong to unchanged patches
0012 and 0014. Apply this series to exact owned core
`c2ea6a6ad267c8631de178d3cd798f3f9e9f2961`; patch 0011 records that core's
awaited-persistence delta from its earlier owned base. No provider, grant or
production readiness is activated by applying these patches.

## Caller contract

Native registration promises propagate through service creation, the registry,
extension loading and live registration. Loading acknowledges queueing; runner
binding awaits actual registration before startup. Session initialization retains
its first failure, and reload invalidation prevents a late registration from
refreshing an old runner. SDK construction awaits initialization and disposes an
unsuccessful session.

The SDK selects the native route only through the request model's actually
registered provider. Private original-Agent and loop-request provenance permits
omission of already consumed loop plumbing and unchanged SDK-generated defaults.
This does not permit arbitrary callers to omit meaningful options: explicit
semantic request options or settings, active hooks, accessors and symbol keys
fail closed with `PROVIDER_OPTIONS_UNSUPPORTED`. Undefined own data properties
are omitted; the supported cancellation signal is retained. Projection accepts
only plain or null-prototype option objects, so inherited semantics and inherited
already-aborted signals cannot disappear during property enumeration. Error-code
descriptor checks avoid invoking getters. The native adapter remains signal-only;
this patch does not relax its option admission.

Owned trusted-extension `ctx.compact` refuses synchronously before starting
detached asynchronous work. Its void notification API cannot propagate an awaited
persistence failure. Owned MCP register/unregister and interactive UI prompt
routes likewise deny before registry mutation, handler notification or renderer
callbacks. The explicitly awaited public `AgentSession.compact` path remains
available and propagates persistence refusal. Unowned donor behavior remains
available outside the owned route. These denials close review findings rather
than claim extension support in the demo.

The eleven paths are:

- `vendor/pi/packages/agent/src/agent-loop.ts`
- `vendor/pi/packages/agent/src/agent.ts`
- `vendor/pi/packages/agent/src/index.ts`
- `vendor/pi/packages/agent/src/splyce-readiness.ts`
- `vendor/pi/packages/coding-agent/src/core/agent-session-services.ts`
- `vendor/pi/packages/coding-agent/src/core/agent-session.ts`
- `vendor/pi/packages/coding-agent/src/core/extensions/loader.ts`
- `vendor/pi/packages/coding-agent/src/core/extensions/runner.ts`
- `vendor/pi/packages/coding-agent/src/core/extensions/types.ts`
- `vendor/pi/packages/coding-agent/src/core/model-registry.ts`
- `vendor/pi/packages/coding-agent/src/core/sdk.ts`

## Canonical series replay

The replay captures dependency patches from committed Git blobs. Patch 0012 is
unchanged, with declared base `66b9b9ea056224d775715c53bfe4d8b86629ce9a`.
That base and core c2ea share ModelRuntime Git blob
`eaef58de5fc0ad30cb8a7ddbe39363a48361b8eb`. Patch 0014 is pinned to source
`3058c5187b2b1ff51ea15c8becc9a262610809e8`; its target ModelRuntime Git blob is
`a49e121edb81c6e8971f9f0c01ea0fa625ff1ef8`.

| Artifact          | SHA-256                                                            | Bytes |
| ----------------- | ------------------------------------------------------------------ | ----: |
| Unchanged 0012    | `4afb6d6665add18a345c433ba4d77d3709505f8e422a51f3349734c1818f2b22` | 12325 |
| Current 0013      | `0a19431abaf9babe1423e2f66d187667385fa3e178d22ba8aaae9e856d67ae4f` | 29584 |
| Owner-pinned 0014 | `e2ada7e19f31709673d69155380effed011923ce9b350b120c712b9d3c03fb65` |  4903 |

The canonical source/path freeze digest is
`43ff4cff4f34547fde9e297e9903332b36fa62b547d862cdc7bc8db367e8a8f6`;
the replay generator digest is
`a8d03e29f389874151ba6164d3d805ec8420920fca4b4a28524e1c19332fe0ed`.
Its freeze algorithm is `post-dependency-index-v3`. The post-dependency staged
index tree is `a45acf33f2b515ef8949069e8fb31297ddc40f4b`.

In separate isolated archives of exact c2ea bytes, every dependency and candidate
patch passed `git apply --check --binary --whitespace=error` and strict binary
application. Both orders reproduced **12/12 canonical final Git blobs**:

1. 0012, then 0013, then 0014.
2. 0012, then 0014, then 0013.

0013 contains exactly eleven paths and no ModelRuntime delta; 0014 contains only
ModelRuntime. Existing 0012 and 0014 bytes stayed unchanged. The verifier compared
raw canonical Git blob bytes without EOL normalization. Declared Git modes were
checked in the source inventory and controlled staging index; final replay
filesystem modes were not independently compared. Worktree hashes were recorded
separately. This proves reconstruction, not runtime behavior.

To repeat the application checks, capture the three hash-verified patches and
an archive of c2ea, extract into a fresh isolated directory outside the active
checkout, and initialize an empty Git repository there. Run the following pairs
in that directory, using the captured patch copies:

```text
git -c core.autocrlf=false apply --check --binary --whitespace=error 0012-native-model-runtime.patch
git -c core.autocrlf=false apply --binary --whitespace=error 0012-native-model-runtime.patch
git -c core.autocrlf=false apply --check --binary --whitespace=error 0013-native-sdk-caller-compatibility.patch
git -c core.autocrlf=false apply --binary --whitespace=error 0013-native-sdk-caller-compatibility.patch
git -c core.autocrlf=false apply --check --binary --whitespace=error 0014-native-runtime-options.patch
git -c core.autocrlf=false apply --binary --whitespace=error 0014-native-runtime-options.patch
```

Use a second fresh archive to reverse the last two patch pairs. Compare each of
the eleven listed source files plus ModelRuntime with its raw Git blob at the
canonical source; successful application alone does not establish byte identity.
Any later vendor source or formatting change invalidates the freeze and requires
regeneration and another strict replay.

## Measured scope and remaining gates

Root's registered tests at source `6c6e0cbeed695ec2908fb1665199585766976a1e`
passed **78/78 owned-session cases**, **24/24 compiled persistence cases**, and
**15/15 source SessionManager cases**. The canonical strict SDK build passed.
The original test budgets were retained. Exact guard-removal checks failed at
the intended actual sanitizer/event oracle for owned compaction, physical handler
and renderer markers for MCP/UI routes, and physical blind-retry bytes for the
uncertain-append latch. Mutated emitted modules were restored byte for byte.
The corrected source verifier faults the actual append boundary after preflight,
using partial-write and zero-byte `EIO` cases; production SessionManager source
was unchanged by that verifier correction.

Earlier source-bound evidence includes **25/25 native provider caller cases**
after the SDK prototype fix, **54/54 native setup cases**, and **5/5 joins** from
the real setup producer and SQLite reader into the exact unchanged renderer
validator at `2f72caddbe6eb13151da99811dad3dc7c4a077a0`. Those results retain
their original source binding; they are not newly measured root results at 8c.

The native integration owner, Itachi-1824/codex, reported a coding-agent build
and registered SDK 25, owned-session 78, compiled persistence 24, source
persistence 15, native-factory 20 and runtime/SDK 27 cases on follow-up source
`1cc4ba81f98231914129f4bb0189a22bfd11e8ea`, whose full tree is identical to the
canonical tree above. This is attributed peer evidence, not a new root execution
or a publicly reproducible test receipt. The peer reported zero
failures, skips or cancellations. Root has not independently rerun that runtime
cohort at the canonical source; matching tree identity and peer attribution must
not be presented as a new root test execution or whole-release approval.

**Historical full original vendor check at the canonical 8c checkpoint: exit 0.**
The unchanged `npm run check` completed Biome (1,578 files, no fixes), pinned
and runtime dependency checks, TypeScript import checks, entry-graph budgets,
the coding-agent install-lock check, TypeScript 7 `tsc --noEmit`, and the browser
smoke check. This is a historical root vendor result, not a new runtime run or
qualification of a later integration source.

The first 8c attempt exited 1 after Biome and pinned-dependency checks because
`check:runtime-deps` could not resolve `typescript/unstable/ast`: this checkout
lacked its vendor dependency directory and resolved backend TypeScript 6 instead
of the vendor's pinned TypeScript 7.0.2. The repair reused existing lock-matching
third-party dependencies in an ignored local dependency directory and rebased
all workspace package aliases to this checkout. Backend TypeScript 6.0.3,
source, lockfiles, check commands, budgets and assertions stayed unchanged. This
was not a fresh dependency installation. The subsequent original vendor run
returned exit 0 without Biome fixes. Preserve the initial failure alongside that
pass; the older run stopped by an unused ModelRuntime helper warning also remains
failed history. Neither an older c2ea pass nor these vendor checks establishes
native, installed-app, actual-service, CI or release support.

The public prompt fixtures exercise the actual SDK/Agent loop, native adapter,
policy, SQLite, loopback HTTP and owned file-backed JSONL, with synthetic
NativeControl replies and a private fixture owner/sanitizer. They do not qualify
real Rust/Credential Manager or an actual provider service. The separately
observed installed 3058 candidate lacked the later 94 and 6c guards; its recorded
startup was core/unconfigured, and it cannot stand in for an installed successor
at this canonical source. This record establishes no actual-provider success,
installed successor behavior, exact candidate CI or release qualification.

The owned persistence mechanism also retains the documented partial-append crash
limit. Refusing blind retry and recovering through explicit owned reopen are not
proof of atomic append publication or complete crash recovery. Preserve that P3
boundary until its separately owned recovery work is qualified. Reapply and rerun
affected gates after donor, caller, native runtime or dependency changes.
