import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";

// The only fake: the native IPC boundary. Stores, transport and components are real.
const ipc = vi.hoisted(() => ({
  ready: false,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));

import App from "./App.svelte";
import {
  dispatchEngineEvent,
  handshake as engineHandshake,
} from "./stores/engine";
import {
  FOUNDATION,
  PI_REVISION,
  type SplyceEvent,
} from "@splyce/pi/contracts";
import { clearSession, selectedSession } from "./stores/session-selection";

const settle = () => new Promise((r) => setTimeout(r, 0));
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  )!;
const subscribes = () =>
  ipc.invoke.mock.calls.filter(([c]) => c === "subscribe");

let app: object | undefined;
const readyHandshake = {
  protocolVersion: 2,
  schemaVersion: 1,
  engineProtocolVersion: 2,
  bridgeProtocolVersion: 2,
  piRevision: PI_REVISION,
  entryMode: FOUNDATION.entryMode,
  disabledBuiltinExtensions: [...FOUNDATION.disabledBuiltinExtensions],
  readiness: {
    state: "ready",
    policy: true,
    store: true,
    receipts: true,
    ports: { generation: true, provider: true, workspace: true, modules: true },
  },
};
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  ipc.ready = false;
  ipc.invoke.mockImplementation(async (cmd: string) => {
    if (cmd !== "handshake") return undefined;
    if (!ipc.ready) throw new Error("no native backend");
    return readyHandshake;
  });
  window.innerWidth = 1400;
  ipc.invoke.mockClear();
  clearSession();
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function boot(props: Record<string, unknown> = {}) {
  app = mount(App, { target: document.body, props });
  await settle();
}

const treeEvent = (sessionId: string, scopeId: string) =>
  ({
    kind: "session.tree_updated",
    sessionId,
    scopeId,
    seq: 1,
    payload: { sessionId, branchAnchorId: "b1", leaves: ["e1"] },
  }) as never;

describe("App wiring", () => {
  it("shows generation unconfigured while the native core is ready and runnable ports are unavailable", async () => {
    ipc.invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "handshake") return undefined;
      return {
        ...readyHandshake,
        readiness: {
          ...readyHandshake.readiness,
          ports: {
            generation: false,
            provider: false,
            workspace: false,
            modules: false,
          },
        },
      };
    });
    await boot();
    const shell = q("[data-testid=app-shell]")!;
    expect(shell.dataset.connectionState).toBe("unavailable");
    for (const service of ["Policy", "Store", "Receipts"])
      expect(shell.dataset[`readiness${service}`]).toBe("true");
    const banner = q("[data-testid=unavailable-banner]")!;
    expect(banner.textContent).toContain("Generation unconfigured");
    expect(banner.textContent).not.toMatch(/initializing/);
    expect(button("Send").disabled).toBe(true);
  });

  it("refreshes native readiness after Retry and observes the recovered engine exiting", async () => {
    await boot();
    ipc.ready = true;
    button("Retry").click();
    await settle();
    const shell = q("[data-testid=app-shell]")!;
    expect(shell.dataset.connectionState).toBe("ready");
    for (const service of ["Policy", "Store", "Receipts"])
      expect(shell.dataset[`readiness${service}`]).toBe("true");
    const nativeHandshake = ipc.invoke.mock.calls
      .filter(([command]) => command === "handshake")
      .at(-1)!;
    nativeHandshake[1].onLifecycle.onmessage({
      protocolVersion: 2,
      kind: "engine_exited",
      expected: false,
      exitCode: 1,
      cleanupComplete: true,
    });
    await settle();
    expect(q("[data-testid=unavailable-banner]")?.textContent).toMatch(
      /Engine stopped/,
    );
  });

  it("retains native readiness and shows engine loss beside the last transcript", async () => {
    ipc.ready = true;
    await boot();
    const shell = q("[data-testid=app-shell]")!;
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(shell.dataset.connectionState).toBe("ready");
    for (const service of ["Policy", "Store", "Receipts"])
      expect(shell.dataset[`readiness${service}`]).toBe("true");
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    q("[role=treeitem]")!.click();
    await settle();
    dispatchEngineEvent({
      schemaVersion: 1,
      protocolVersion: 2,
      recordId: "rec_1",
      eventId: "evt_1",
      createdAt: "2026-10-26T00:00:00.000Z",
      sourceIds: [],
      scopeId: "scope_1",
      sessionId: "ses_1",
      seq: 1,
      durable: true,
      kind: "turn.started",
      payload: { runId: "run_1", turnId: "turn_1" },
    } as SplyceEvent);
    await settle();
    expect(q('[aria-label="Transcript"]')).not.toBeNull();
    const nativeHandshake = ipc.invoke.mock.calls.find(
      ([command]) => command === "handshake",
    )!;
    nativeHandshake[1].onLifecycle.onmessage({
      protocolVersion: 2,
      kind: "engine_exited",
      expected: false,
      exitCode: 1,
      cleanupComplete: true,
    });
    await settle();
    expect(shell.dataset.connectionState).toBe("disconnected");
    for (const service of ["Policy", "Store", "Receipts"])
      expect(shell.dataset[`readiness${service}`]).toBe("unknown");
    expect(q("[data-testid=unavailable-banner]")?.textContent).toMatch(
      /Engine stopped.*last transcript may be incomplete/s,
    );
    expect(q('[aria-label="Transcript"]')).not.toBeNull();
    expect(button("Send").disabled).toBe(true);
  });

  it("shows an unavailable, disabled composer when no session is selected", async () => {
    await boot();
    expect(q("[data-testid=unavailable-banner]")).not.toBeNull();
    expect(q("#composer-status")?.textContent).toMatch(
      /not connected|unavailable|error/i,
    );
    expect(button("Send").disabled).toBe(true);
    // Sessions never read as empty or loading while the engine is down.
    expect(q("[data-testid=session-tree]")?.textContent).toMatch(
      /could not be loaded/,
    );
    expect(get(selectedSession)).toBeNull();
  });

  it("mounts each surface from shell navigation", async () => {
    await boot();
    button("Providers").click();
    flushSync();
    const providers = q("[data-testid=providers-view]") as HTMLFieldSetElement;
    expect(providers).not.toBeNull();
    expect(providers.disabled).toBe(true);
    expect(q("#providers-title")?.textContent).toBe("Provider connections");

    button("Usage").click();
    flushSync();
    expect(q("[data-testid=usage-unavailable-note]")).not.toBeNull();
    expect(q("[data-testid=providers-view]")).toBeNull();

    // Setup and Modules are mounted from the shell and stay honest with no service.
    button("Setup").click();
    flushSync();
    expect(q("[data-testid=setup]")).not.toBeNull();
    expect(q("[data-testid=engine-unavailable]")?.textContent).toContain(
      "No setup or module service is connected.",
    );
    expect(q("[data-testid=generation]")?.textContent).toContain(
      "Generation unconfigured",
    );
    // No engine means no install review or confirmation to offer.
    expect(q("[data-testid=confirm-install]")).toBeNull();
    // Continuing with the base is still valid and returns to the workbench.
    button("Continue with base only").click();
    flushSync();
    expect(q("[data-testid=setup]")).toBeNull();
    expect(q("[data-testid=unavailable-banner]")).not.toBeNull();

    // Skip setup must enter the workbench too, not leave a dead button.
    button("Setup").click();
    flushSync();
    button("Skip setup").click();
    flushSync();
    expect(q("[data-testid=setup]")).toBeNull();
    expect(q("[data-testid=unavailable-banner]")).not.toBeNull();

    button("Modules").click();
    flushSync();
    expect(q("[data-testid=modules]")).not.toBeNull();
    expect(
      q("[data-testid=modules-engine-unavailable]")?.textContent,
    ).toContain("No setup or module service is connected.");
    expect((q("[data-testid=add-module]") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (q("[data-testid=refresh-catalog]") as HTMLButtonElement).disabled,
    ).toBe(true);

    button("Conversation").click();
    flushSync();
    expect(q("[data-testid=unavailable-banner]")).not.toBeNull();
  });

  it("selecting a session follows and subscribes exactly once, and the composer binds to it", async () => {
    ipc.ready = true;
    await boot();
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    const item = q("[role=treeitem]")!;
    expect(item).not.toBeNull();
    item.click();
    await settle();
    item.click(); // re-selecting keeps the channel
    await settle();

    expect(get(selectedSession)).toEqual({
      sessionId: "ses_1",
      scopeId: "scope_1",
    });
    expect(subscribes()).toHaveLength(1);
    expect(subscribes()[0][1]).toMatchObject({ sessionId: "ses_1" });
    // Composer now sees a session; sending stays disabled for an honest reason.
    expect(q("#composer-status")?.textContent).not.toMatch(
      /No session is selected/,
    );
    expect(button("Send").disabled).toBe(true);
  });

  it("keeps Send disabled with a draft and makes no send IPC", async () => {
    ipc.ready = true;
    await boot();
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    q("[role=treeitem]")!.click();
    await settle();
    const ta = q("textarea") as HTMLTextAreaElement;
    ta.value = "hello";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    await settle();
    expect(button("Send").disabled).toBe(true);
    expect(q("#composer-status")?.textContent).toBe(
      "Sending is not available yet",
    );
    expect(ipc.invoke.mock.calls.filter(([c]) => c === "send")).toHaveLength(0);
  });

  async function dropAndRecover() {
    ipc.ready = false;
    await engineHandshake().catch(() => {});
    await settle();
    ipc.ready = true;
    button("Retry").click();
    await settle();
  }

  it("keeps the selection and binding across Retry when no snapshot arrives", async () => {
    ipc.ready = true;
    await boot();
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    q("[role=treeitem]")!.click();
    await settle();
    await dropAndRecover();
    expect(q("[data-testid=lost-selection]")).toBeNull();
    expect(get(selectedSession)?.sessionId).toBe("ses_1");
    expect(q("[role=treeitem]")?.getAttribute("aria-selected")).toBe("true");
    expect(subscribes()).toHaveLength(1);
  });

  it("clears the selection when a real snapshot lacks the session", async () => {
    ipc.ready = true;
    const snapshots = [[treeEvent("ses_1", "scope_1")], []];
    await boot({ loadSessions: async () => snapshots.shift() ?? [] });
    q("[role=treeitem]")!.click();
    await settle();
    expect(get(selectedSession)?.sessionId).toBe("ses_1");
    await dropAndRecover();
    expect(q("[data-testid=lost-selection]")).not.toBeNull();
    expect(get(selectedSession)).toBeNull();
  });
});
