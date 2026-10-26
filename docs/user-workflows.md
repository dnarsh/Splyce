# Desktop workflows: what a user can do today

**Status: working draft for TD-59, written 2026-10-27 from the source on `staging`; packaged-app, screenshot and accessibility evidence n=0.** This is a guide to what the desktop app presents, not a product manual. Every control named here exists in the source linked beside it; anything not wired into the app is listed as such and is never described as shipped. The guide has no screenshots because there is no packaged Windows build to capture yet (tracked by TD-34 and the bootstrap work); a screenshot would otherwise depict a mock. It is updated as each linked task lands.

Reading order follows a first session: [setup](#1-first-launch-and-setup), [sessions](#2-choosing-a-session), [conversation](#3-conversation-and-the-composer), [providers and usage](#4-providers-and-usage), [modules](#5-optional-modules), [recovery](#6-recovery-and-unavailable-states), [keyboard](#7-keyboard).

## What is wired today

| Area                  | In the running app (`apps/desktop/src/App.svelte`)                            | Built but not yet reachable from the app                           |
| --------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Shell and navigation  | Rail, conversation pane, evidence pane, composer footer, Views navigation     | Command palette, shortcut reference, settings and help panels      |
| Sessions              | Session tree (select, focus, refresh, lost-selection notice, subscribe retry) | Fork, resume and rewind actions (TD-33)                            |
| Conversation          | Live transcript and tool cards                                                | Run outcome panel (TD-36); approval controls (TD-30)               |
| Composer              | Present; sending is disabled with a stated reason                             | Sending (session revisions are not delivered to the renderer yet)  |
| Providers and usage   | Providers view (disabled, empty), Usage view (unavailable)                    | Connection cards, custom endpoint form, model switcher, usage rows |
| Setup and modules     | Not present                                                                   | Setup and Modules screens (TD-29, open pull request)               |
| Memory, diff, plugins | Not present                                                                   | Memory list, diff and verification views, plugin details           |

## 1. First launch and setup

The design is in [the setup flow](../research/docs/design/setup-flow.md): the primary action is **Continue with base only**, and **Skip setup** is a valid way to finish. Neither needs the network, a catalog, a credential or a model, and nothing optional is selected, fetched or enabled. The app opens straight into the workbench, which says **Engine unavailable** until the engine reports ready.

- **Today:** the app has no setup screen. It starts in the workbench described below, which is the same place Continue and Skip lead to.
- **Not yet:** the Setup and Modules screens exist as components with fixture-driven tests (TD-29) but are not routed in the app. Until they are, no module can be installed, enabled or removed from the interface.
- **Failure and recovery:** when the engine is not ready, the status badge in the rail shows its state, the conversation pane shows the unavailable banner, and the session tree says **Sessions could not be loaded** with a Retry button instead of looking empty.

## 2. Choosing a session

The rail lists sessions as a tree of branches. Each entry shows its session and branch, how many leaves it has, and a text badge reading **Selected** or **Not selected**, so state is never colour-only.

- Arrow Up and Arrow Down move focus, Home and End jump to the first and last entry, Enter or Space selects. Moving focus does not change the selection.
- Choosing an entry follows and subscribes to that session only. Choosing the already selected session does nothing; switching to another and back restarts it.
- **Refresh keeps your place.** The previous entries, selection and focus stay visible (marked **Refreshing…**) until the new list arrives. If the selected branch is gone from the new list, the selection is cleared and a notice says which branch was lost; it is never silently replaced.
- **Failure:** if subscribing to the session fails, a banner reads **Could not subscribe to the session** with a Retry button.

Sources: `components/SessionTree.svelte`, `stores/sessions.ts`, `stores/session-selection.ts`.

## 3. Conversation and the composer

The conversation pane shows the live transcript for the selected session: streamed text and tool cards. A tool call that has not executed reads as pending, never as done.

- The composer sits in the footer. Enter or Ctrl+Enter sends, Shift+Enter inserts a newline, and Esc cancels only when a run can be cancelled. Empty drafts cannot be sent, and a draft is kept if sending fails.
- **Sending is unavailable today.** The composer's own status line gives the reason in order: the engine is not connected or busy, **No session is selected**, then **Sending is not available yet**. No message leaves the app.
- Approval cards are shown as read-only context. Approve and deny controls are hidden until a session context with its current revisions exists.

The run outcome panel (`components/RunOutcome.svelte`, TD-36) is built but not mounted, so the transcript does not yet show a separate outcome line per run.

Sources: `components/Composer.svelte`, `stores/composer.ts`, `components/TurnStream.svelte`.

## 4. Providers and usage

- **Providers** opens a disabled view with **Provider connections are unavailable: no profile service is connected.** The list is empty and the add form cannot be used. A connection card and a custom OpenAI-compatible endpoint form exist as components: hosted endpoints must use https, a loopback address is the only thing treated as local, credentials, query strings and transport headers are refused in the URL and headers, and header values are masked.
- **Usage** reads **Usage unavailable**. When usage is reported later, only present numbers are shown, labelled reported or estimated; a missing number is never shown as zero.

## 5. Optional modules

Not reachable yet. The design shows a plan before anything changes: exact source and pin, required dependencies separated from your selection, sizes (**Unknown** with its reason, never 0 B), and any step that runs code listed separately. Installing and enabling are two separate choices with separate outcomes; disabling is not uninstalling; deleting data is a third, separate confirmation.

## 6. Recovery and unavailable states

| Situation                   | What you see                                                                   | What to do                                         |
| --------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| Engine not ready            | Status badge and the unavailable banner; sessions say they could not be loaded | Wait for ready or use Retry on the session list    |
| Session list empty          | **No sessions yet.** (only when the engine is ready and has none)              | Start work from the engine side; nothing to repair |
| Subscription failed         | Banner with Retry                                                              | Retry; the selection is kept                       |
| Selected branch disappeared | Notice naming the branch; selection cleared                                    | Choose another entry                               |
| Feature not connected       | Disabled view with a plain explanation (providers, usage)                      | None; it is not available yet                      |

When the run outcome panel is mounted, an uncertain or unconfirmed effect will show as uncertain, with fixed wording and a reference, never as success, and a retry only when the engine says it is safe (the behaviour is implemented and tested in the component, not yet visible in the app).

## 7. Keyboard

| Keys                   | Action                               | Where it works today                            |
| ---------------------- | ------------------------------------ | ----------------------------------------------- |
| Ctrl+B                 | Show or hide the rail                | Anywhere in the app window (`components/shell`) |
| Ctrl+Shift+E           | Show or hide the evidence pane       | Anywhere in the app window                      |
| Arrows, Home, End      | Move through the session tree        | When the tree has focus                         |
| Enter, Space           | Select the focused session entry     | When the tree has focus                         |
| Enter, Ctrl+Enter, Esc | Send, send, cancel a cancellable run | In the composer (sending itself is disabled)    |
| Ctrl+K                 | Command palette                      | Component built; not mounted in the app         |

Layout follows window width: narrow shows one pane at a time, medium one side panel, wide both.

## How this guide is kept honest

Each section names its source files. Before a section is edited to say a control works, the control must be mounted in the app and covered by a test that fails when it is removed (for the wiring, `apps/desktop/src/App.test.ts`). Packaged-app checks, UI automation and a non-author walkthrough are required before any claim beyond this status guide; none exist yet.

[Task plan](../research/docs/design/team-delivery-plan.md) · [Setup flow](../research/docs/design/setup-flow.md)
