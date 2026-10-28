import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));

import { FOUNDATION, PI_REVISION } from "@splyce/pi/contracts";
import App from "./App.svelte";
import Composer from "./components/Composer.svelte";
import Providers from "./routes/Providers.svelte";
import { dispatchEngineEvent, invoke, sendSetup } from "./stores/engine";
import { selectedSession } from "./stores/session-selection";

const profile = {
  profileId: "profile_1",
  profileRevision: "pr_1",
  configRevision: "cfg_1",
};
const selection = {
  selectedProfileId: "profile_1",
  profileRevision: "pr_2",
  configRevision: "cfg_2",
};
const session = {
  sessionId: "session_1",
  sessionRevision: "sr_1",
  policyRevision: "7",
  readiness: { state: "ready" },
};
const tick = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  )!;
const sends = (op: string) =>
  ipc.invoke.mock.calls.filter(
    ([cmd, args]) => cmd === "send" && args.op === op,
  );
let app: object | undefined;
let selectedWorkspace = "ws_1";
let reply: (op: string) => Promise<unknown>;

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  window.innerWidth = 1400;
  selectedWorkspace = "ws_1";
  reply = async (op) =>
    op === "setup.read"
      ? { configRevision: "cfg_0", selectedProfileId: null, profiles: [] }
      : op === "provider.configure"
        ? profile
        : op === "profile.select"
          ? selection
          : session;
  ipc.invoke.mockReset();
  ipc.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "handshake")
      return {
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
          ports: {
            generation: true,
            provider: true,
            workspace: true,
            modules: true,
          },
        },
      };
    if (cmd === "dialog_select_workspace")
      return {
        workspace: { workspaceId: selectedWorkspace, displayName: "Demo" },
      };
    if (cmd === "send") return reply(args.op);
  });
});
afterEach(async () => {
  if (app) await unmount(app);
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function configured() {
  app = mount(App, { target: document.body });
  await tick();
  button("Choose project").click();
  await tick();
  button("Providers").click();
  flushSync();
  for (const [id, value] of Object.entries({
    "setup-endpoint": "https://example.test/v1",
    "setup-model": "test-model",
    "setup-key": "test-key",
  })) {
    const input = document.getElementById(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  flushSync();
  (
    document.querySelector('[aria-label="Provider setup"]') as HTMLFormElement
  ).requestSubmit();
  await tick();
}

describe("native profile and session setup", () => {
  it("recovers profiles with provider port unavailable and blocks generation", async () => {
    const initial = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "handshake") {
        const result = (await initial(cmd, args)) as any;
        result.readiness.ports.provider = false;
        return result;
      }
      return initial(cmd, args);
    });
    reply = async (op) =>
      op === "setup.read"
        ? {
            configRevision: "cfg_2",
            selectedProfileId: "profile_1",
            profiles: [
              {
                profileId: "profile_1",
                profileRevision: "pr_2",
                apiFamily: "openai-responses",
                modelId: "model_1",
                endpointOrigin: "https://example.test",
                credential: "configured",
              },
              {
                profileId: "profile_2",
                profileRevision: "pr_3",
                apiFamily: "openai-responses",
                modelId: "model_2",
                endpointOrigin: "https://example.test",
                credential: "missing",
              },
            ],
          }
        : op === "profile.select"
          ? selection
          : session;
    app = mount(App, { target: document.body });
    await tick();
    button("Choose project").click();
    await tick();
    button("Providers").click();
    flushSync();
    const read = sends("setup.read")[0]![1];
    expect(read.payload).toEqual({
      frame: "setup",
      command: "setup.read",
      requestId: read.payload.requestId,
      payload: { requestId: read.payload.requestId, workspaceId: "ws_1" },
    });
    expect(document.body.textContent).toContain("profile_1 (selected)");
    expect(document.body.textContent).toContain("missing");
    const profileButtons = [...document.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Use this profile",
    );
    expect(profileButtons[0]!.disabled).toBe(false);
    expect(profileButtons[1]!.disabled).toBe(true);
    profileButtons[0]!.click();
    await tick();
    expect(sends("profile.select")).toHaveLength(1);
    expect(sends("session.start")).toHaveLength(1);
    expect(
      (document.getElementById("setup-key") as HTMLInputElement).disabled,
    ).toBe(false);
    expect(button("Send").disabled).toBe(true);
  });

  it("refreshes native ports, sends the actual revision context, and waits for cancellation cleanup", async () => {
    const initial = ipc.invoke.getMockImplementation()!;
    let handshakes = 0;
    ipc.invoke.mockImplementation(async (cmd, args) => {
      const result = await initial(cmd, args);
      if (cmd === "handshake") {
        handshakes++;
        (result as any).readiness.ports.provider = handshakes > 1;
        (result as any).readiness.ports.generation = handshakes > 1;
        (result as any).readiness.ports.workspace = false;
        (result as any).readiness.ports.modules = false;
      }
      return result;
    });
    await configured();
    button("Use this profile").click();
    await tick();
    const input = document.querySelector("textarea")!;
    input.value = "draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(handshakes).toBe(2);
    expect(get(selectedSession)).toEqual({
      sessionId: "session_1",
      scopeId: "ws_1",
    });
    expect(
      ipc.invoke.mock.calls.some(
        ([cmd, args]) => cmd === "subscribe" && args.sessionId === "session_1",
      ),
    ).toBe(true);
    expect(document.body.textContent).toContain("Workspace tools unavailable");
    expect(button("Send").disabled).toBe(false);
    reply = async () => ({ accepted: true, runId: "run_1", turnId: "turn_1" });
    button("Send").click();
    await tick();
    const prompt = sends("session.prompt")[0]![1].payload;
    expect(prompt).toMatchObject({
      sessionId: "session_1",
      scopeId: "ws_1",
      expectedConfigRevision: "cfg_2",
      expectedProfileRevision: "pr_2",
      expectedPolicyRevision: "7",
      op: "session.prompt",
      payload: { text: "draft" },
    });
    expect(button("Send").disabled).toBe(true);
    let resolveCancel!: (value: unknown) => void;
    ipc.invoke.mockImplementation(async (cmd, args) =>
      cmd === "cancel"
        ? new Promise((resolve) => {
            resolveCancel = resolve;
          })
        : initial(cmd, args),
    );
    button("Cancel turn").click();
    await tick();
    expect(button("Send").disabled).toBe(true);
    resolveCancel({ canceled: true });
    await tick();
    expect(button("Cancel turn")).toBeUndefined();
  });

  it("blocks sending if the selected session subscription fails", async () => {
    const initial = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "subscribe") throw new Error("private subscribe failure");
      return initial(cmd, args);
    });
    await configured();
    button("Use this profile").click();
    await tick();
    const input = document.querySelector("textarea")!;
    input.value = "draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(button("Send").disabled).toBe(true);
    expect(sends("session.prompt")).toHaveLength(0);
  });

  it("preserves the draft when prompt acknowledgement is malformed", async () => {
    await configured();
    button("Use this profile").click();
    await tick();
    reply = async () => ({
      accepted: true,
      runId: "run_1",
      turnId: "turn_1",
      extra: true,
    });
    const input = document.querySelector("textarea")!;
    input.value = "keep draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    button("Send").click();
    await tick();
    expect(input.value).toBe("keep draft");
    expect(button("Cancel turn")).toBeUndefined();
  });

  it("replays the same start request after stale revision without resending the prompt", async () => {
    await configured();
    button("Use this profile").click();
    await tick();
    const firstStart = sends("session.start")[0]![1];
    reply = async (op) => {
      if (op === "session.prompt") throw { code: "STALE_REVISION" };
      if (op === "session.start") return { ...session, policyRevision: "8" };
      return selection;
    };
    const input = document.querySelector("textarea")!;
    input.value = "keep draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    button("Send").click();
    await tick();
    await tick();
    expect(sends("session.prompt")).toHaveLength(1);
    expect(sends("session.start")[1]![1]).toEqual(firstStart);
    expect(input.value).toBe("keep draft");
    expect(button("Send").disabled).toBe(false);
  });

  it("preserves the selected profile when the readiness refresh fails", async () => {
    const initial = ipc.invoke.getMockImplementation()!;
    let handshakes = 0;
    ipc.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "handshake" && ++handshakes === 2)
        throw new Error("private native error");
      return initial(cmd, args);
    });
    await configured();
    button("Use this profile").click();
    await tick();
    expect(document.body.textContent).toContain("profile_1 (selected)");
    expect(document.getElementById("profile-status")?.textContent).toContain(
      "could not be confirmed",
    );
    expect(document.body.textContent).not.toContain("private native error");
    expect(button("Send").disabled).toBe(true);
  });

  it("does not use a late readiness refresh after changing project", async () => {
    const initial = ipc.invoke.getMockImplementation()!;
    let handshakes = 0;
    let resolve!: (value: unknown) => void;
    ipc.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "handshake" && ++handshakes === 2)
        return new Promise((r) => {
          resolve = r;
        });
      return initial(cmd, args);
    });
    await configured();
    button("Use this profile").click();
    await tick();
    selectedWorkspace = "ws_2";
    button("Choose project").click();
    await tick();
    resolve(await initial("handshake", {}));
    await tick();
    expect(button("Send").disabled).toBe(true);
  });

  it("reloads saved profiles after reconnect without restoring session readiness", async () => {
    await configured();
    button("Use this profile").click();
    await tick();
    const lifecycle = ipc.invoke.mock.calls
      .filter(([cmd]) => cmd === "handshake")
      .at(-1)![1].onLifecycle;
    lifecycle.onmessage({
      protocolVersion: 2,
      kind: "engine_exited",
      expected: false,
      exitCode: 1,
      cleanupComplete: true,
    });
    await tick();
    button("Conversation").click();
    flushSync();
    button("Retry").click();
    await tick();
    expect(sends("setup.read")).toHaveLength(2);
    expect(button("Send").disabled).toBe(true);
  });

  it("discards a delayed setup read after project change", async () => {
    let resolve!: (value: unknown) => void;
    reply = async (op) =>
      op === "setup.read"
        ? new Promise((r) => {
            resolve = r;
          })
        : session;
    app = mount(App, { target: document.body });
    await tick();
    button("Choose project").click();
    await tick();
    const oldResolve = resolve;
    selectedWorkspace = "ws_2";
    button("Choose project").click();
    await tick();
    oldResolve({
      configRevision: "cfg_2",
      selectedProfileId: null,
      profiles: [
        {
          profileId: "old_profile",
          profileRevision: "pr_2",
          apiFamily: "openai-responses",
          modelId: "model_1",
          endpointOrigin: "https://example.test",
          credential: "configured",
        },
      ],
    });
    await tick();
    button("Providers").click();
    flushSync();
    expect(document.body.textContent).not.toContain("old_profile");
  });

  it.each([
    {
      configRevision: "cfg_2",
      selectedProfileId: null,
      profiles: [],
      extra: "secret",
    },
    {
      configRevision: "cfg_2",
      selectedProfileId: null,
      profiles: [
        {
          profileId: "profile_1",
          profileRevision: "pr_2",
          apiFamily: "openai-responses",
          modelId: "model_1",
          endpointOrigin: "https://example.test/path",
          credential: "configured",
        },
      ],
    },
    {
      configRevision: "cfg_2",
      selectedProfileId: null,
      profiles: [
        {
          profileId: "profile_1",
          profileRevision: "pr_2",
          apiFamily: "openai-responses",
          modelId: "model_1",
          endpointOrigin: "https://example.test",
          credential: "configured",
          credentialRef: "secret",
        },
      ],
    },
  ])(
    "rejects malformed setup reads without exposing metadata",
    async (invalid) => {
      reply = async () => invalid;
      app = mount(App, { target: document.body });
      await tick();
      button("Choose project").click();
      await tick();
      button("Providers").click();
      flushSync();
      expect(document.getElementById("profile-status")?.textContent).toContain(
        "could not be loaded",
      );
      expect(document.body.textContent).not.toContain("secret");
      expect(button("Send").disabled).toBe(true);
    },
  );

  it("provider save alone keeps Send disabled; selecting sends both exact frozen setup frames", async () => {
    await configured();
    expect(button("Send").disabled).toBe(true);
    expect(sends("session.start")).toHaveLength(0);
    button("Use this profile").click();
    await tick();
    for (const [op, payload] of [
      [
        "profile.select",
        {
          workspaceId: "ws_1",
          profileId: "profile_1",
          expectedProfileRevision: "pr_1",
          expectedConfigRevision: "cfg_1",
        },
      ],
      [
        "session.start",
        {
          workspaceId: "ws_1",
          profileId: "profile_1",
          expectedConfigRevision: "cfg_2",
        },
      ],
    ] as const) {
      expect(sends(op)).toHaveLength(1);
      const args = sends(op)[0]![1];
      const requestId = args.payload.requestId;
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(args).toStrictEqual({
        op,
        payload: {
          frame: "setup",
          command: op,
          requestId,
          payload: { requestId, ...payload },
        },
      });
    }
    expect(sends("profile.select")[0]![1].payload.requestId).not.toBe(
      sends("session.start")[0]![1].payload.requestId,
    );
  });

  it.each(
    [
      ["STALE_REVISION", "changed"],
      ["SETUP_REQUEST_CONFLICT", "conflict"],
      ["WORKSPACE_SUPERSEDED", "project"],
      ["UNKNOWN", "could not"],
      ["toString", "could not"],
    ].flatMap(([code, copy]) => [
      ["profile.select", code, copy],
      ["session.start", code, copy],
    ]),
  )("%s maps %s to fixed copy without echo", async (command, code, copy) => {
    await configured();
    reply = async (op) => {
      if (op !== command) return selection;
      throw { code, message: "private-native-message", path: "private-path" };
    };
    button("Use this profile").click();
    await tick();
    expect(document.getElementById("profile-status")?.textContent).toContain(
      copy,
    );
    expect(document.body.textContent).not.toMatch(
      /private-native-message|private-path/,
    );
    expect(sends("session.start")).toHaveLength(
      command === "profile.select" ? 0 : 1,
    );
    expect(button("Send").disabled).toBe(true);
  });

  it("keeps Send disabled while start is pending and when native readiness is unavailable", async () => {
    await configured();
    let resolve!: (value: unknown) => void;
    reply = async (op) =>
      op === "profile.select"
        ? selection
        : new Promise((r) => {
            resolve = r;
          });
    button("Use this profile").click();
    await tick();
    expect(button("Send").disabled).toBe(true);
    resolve({
      ...session,
      readiness: { state: "unavailable", code: "PROVIDER_UNAVAILABLE" },
    });
    await tick();
    expect(button("Send").disabled).toBe(true);
    expect(document.getElementById("profile-status")?.textContent).toContain(
      "unavailable",
    );
  });

  it("does not start a session for a late profile selection after changing project", async () => {
    await configured();
    let resolve!: (value: unknown) => void;
    reply = async () =>
      new Promise((r) => {
        resolve = r;
      });
    button("Use this profile").click();
    await tick();
    selectedWorkspace = "ws_2";
    button("Choose project").click();
    await tick();
    resolve(selection);
    await tick();
    expect(sends("session.start")).toHaveLength(0);
    expect(button("Send").disabled).toBe(true);
  });

  it.each([
    ["profile.select", { ...selection, extra: "private-path" }],
    ["profile.select", { profileRevision: "pr_2", configRevision: "cfg_2" }],
    ["profile.select", { ...selection, selectedProfileId: "other" }],
    ["session.start", { ...session, credentialRef: "private-path" }],
    [
      "session.start",
      { sessionId: "session_1", readiness: { state: "ready" } },
    ],
    [
      "session.start",
      { ...session, readiness: { state: "ready", grantIds: ["private"] } },
    ],
  ])(
    "rejects a malformed %s result at the rendered entrypoint",
    async (command, invalid) => {
      await configured();
      reply = async (op) => (op === command ? invalid : selection);
      button("Use this profile").click();
      await tick();
      expect(document.getElementById("profile-status")?.textContent).toContain(
        "could not",
      );
      expect(document.body.textContent).not.toContain("private-path");
      expect(button("Send").disabled).toBe(true);
    },
  );

  it("discards a late ready session after the native engine exits", async () => {
    await configured();
    let resolve!: (value: unknown) => void;
    reply = async (op) =>
      op === "profile.select"
        ? selection
        : new Promise((r) => {
            resolve = r;
          });
    button("Use this profile").click();
    await tick();
    const lifecycle = ipc.invoke.mock.calls.find(
      ([cmd]) => cmd === "handshake",
    )![1].onLifecycle;
    lifecycle.onmessage({
      protocolVersion: 2,
      kind: "engine_exited",
      expected: false,
      exitCode: 1,
      cleanupComplete: true,
    });
    resolve(session);
    await tick();
    expect(
      document.getElementById("profile-status")?.textContent,
    ).not.toContain("Session ready");
    expect(button("Send").disabled).toBe(true);
  });

  it("retains the last session when profile selection fails and blocks sending", async () => {
    await configured();
    dispatchEngineEvent({
      kind: "session.tree_updated",
      sessionId: "old_session",
      scopeId: "old_scope",
      seq: 1,
      payload: {
        sessionId: "old_session",
        branchAnchorId: "b1",
        leaves: ["e1"],
      },
    } as never);
    await tick();
    document.querySelector<HTMLElement>("[role=treeitem]")!.click();
    await tick();
    expect(get(selectedSession)?.sessionId).toBe("old_session");
    reply = async () => {
      throw new Error("private-native-message");
    };
    button("Use this profile").click();
    await tick();
    expect(get(selectedSession)?.sessionId).toBe("old_session");
    expect(button("Send").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("private-native-message");
  });

  it("keeps the acknowledged profile selected when session start fails", async () => {
    await configured();
    reply = async (op) => {
      if (op === "profile.select") return selection;
      throw new Error("private-native-message");
    };
    button("Use this profile").click();
    await tick();
    expect(document.body.textContent).toContain("profile_1 (selected)");
    expect(document.getElementById("profile-status")?.textContent).toContain(
      "could not",
    );
    expect(button("Send").disabled).toBe(true);
  });

  it("uses the acknowledged revisions when session start fails after profile selection", async () => {
    await configured();
    reply = async (op) => {
      if (op === "profile.select") return selection;
      throw new Error("private-native-message");
    };
    button("Use this profile").click();
    await tick();
    button("Use this profile").click();
    await tick();
    expect(sends("profile.select")[1]![1].payload.payload).toMatchObject({
      expectedProfileRevision: "pr_2",
      expectedConfigRevision: "cfg_2",
    });
    expect(document.body.textContent).not.toContain("private-native-message");
  });

  it("does not start a session after the workbench unmounts", async () => {
    await configured();
    let resolve!: (value: unknown) => void;
    reply = async () =>
      new Promise((r) => {
        resolve = r;
      });
    button("Use this profile").click();
    await tick();
    await unmount(app!);
    app = undefined;
    resolve(selection);
    await tick();
    expect(sends("session.start")).toHaveLength(0);
  });

  it("disables profile selection without a chosen project", () => {
    app = mount(Providers, {
      target: document.body,
      props: {
        connections: [],
        families: [],
        profiles: [profile],
        workspaceSelected: false,
        credentialSubmit: async () => {},
        selectProfile: async () => {
          await sendSetup("profile.select", "unused", {});
        },
      },
    });
    flushSync();
    button("Use this profile").click();
    expect(button("Use this profile").disabled).toBe(true);
    expect(sends("profile.select")).toHaveLength(0);
  });

  it("treats missing save metadata as uncertain and never claims a rollback", async () => {
    reply = async () => ({});
    await configured();
    const status = document.getElementById("connect-status")!.textContent!;
    expect(status).toContain("Could not confirm");
    expect(status).not.toContain("Nothing was stored");
    expect(button("Use this profile")).toBeUndefined();
    expect(button("Send").disabled).toBe(true);
  });
});

const sendPrompt = async (payload: { text: string }) => {
  await invoke("session.prompt", payload, {
    sessionId: "session_1",
    scopeId: "scope_1",
    expectedConfigRevision: "cfg_2",
    expectedProfileRevision: "pr_2",
    expectedPolicyRevision: "policy_1",
  });
};

describe("rendered Send readiness gate", () => {
  it.each([
    { workspaceSelected: false },
    { profileSelected: false },
    { sessionReadiness: undefined },
    { sessionReadiness: "unavailable" },
  ] as const)(
    "disables Send when a precondition is missing: %j",
    async (missing) => {
      app = mount(Composer, {
        target: document.body,
        props: {
          connection: "ready",
          sessionId: "session_1",
          generationReady: true,
          workspaceSelected: true,
          profileSelected: true,
          sessionReadiness: "ready",
          send: sendPrompt,
          ...missing,
        },
      });
      const input = document.querySelector("textarea")!;
      input.value = "draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      expect(button("Send").disabled).toBe(true);
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      await tick();
      expect(sends("session.prompt")).toHaveLength(0);
      expect(input.value).toBe("draft");
    },
  );

  it("enables Send only with every precondition and dispatches through real engine IPC", async () => {
    app = mount(Composer, {
      target: document.body,
      props: {
        connection: "ready",
        sessionId: "session_1",
        generationReady: true,
        workspaceSelected: true,
        profileSelected: true,
        sessionReadiness: "ready",
        send: sendPrompt,
      },
    });
    const input = document.querySelector("textarea")!;
    input.value = "draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(button("Send").disabled).toBe(false);
    button("Send").click();
    await tick();
    expect(sends("session.prompt")).toHaveLength(1);
    expect(input.value).toBe("");
  });
});
