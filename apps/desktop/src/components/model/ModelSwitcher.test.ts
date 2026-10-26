import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { SelectionTransitionRecord } from "@splyce/pi/contracts";
import ModelSwitcher from "./ModelSwitcher.svelte";
import {
  applyTransition,
  createModelSelection,
  requestSwitch,
  type ModelOption,
  type ModelSelectionState,
} from "../../stores/model-selection";

const options: ModelOption[] = [
  { ref: "bind_a", label: "Model A", locality: "local" },
  {
    ref: "bind_b",
    label: "Model B",
    locality: "hosted",
    labels: ["unbenchmarked"],
  },
  {
    ref: "bind_c",
    label: "Model C",
    locality: "hosted",
    unavailableReason: "service is down",
  },
];

const record = (
  state: SelectionTransitionRecord["state"],
  requestedBindingRef = "bind_b",
): SelectionTransitionRecord =>
  ({
    transitionId: "tr_1",
    runId: "run_1",
    branchAnchorId: "anchor_1",
    previousBindingRef: "bind_a",
    requestedBindingRef,
    profileRevision: "1",
    configRevision: "1",
    intentRef: "intent_1",
    disposition: "next-turn",
    state,
  }) as SelectionTransitionRecord;

let cmp: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = "";
});

function render(
  state: ModelSelectionState,
  extra: {
    turnActive?: boolean;
    onRequest?: (r: string, d: string) => void;
  } = {},
) {
  cmp = mount(ModelSwitcher, {
    target: document.body,
    props: {
      selection: state,
      options,
      onRequest: () => {},
      ...extra,
    } as never,
  });
  flushSync();
}
const text = (id: string) =>
  document
    .querySelector(`[data-testid="${id}"]`)
    ?.textContent?.replace(/\s+/g, " ") ?? "";

describe("ModelSwitcher", () => {
  it("shows requested separately from active until applied", () => {
    const base = requestSwitch(
      createModelSelection("bind_a"),
      "bind_b",
      "next-turn",
    );
    const pending = applyTransition(base, record("pending"));
    render(pending);
    expect(text("model-current")).toBe("Active: Model A");
    expect(text("model-requested")).toContain("Requested: Model B · Pending");
    expect(text("model-requested")).toContain("next turn");
  });

  it("applied moves the active binding", () => {
    const s = applyTransition(
      requestSwitch(createModelSelection("bind_a"), "bind_b", "next-turn"),
      record("ready"),
    );
    render(s);
    expect(text("model-current")).toBe("Active: Model B");
    expect(text("model-requested")).toContain("Applied");
  });

  it("rejected keeps the old binding visible with the reason", () => {
    const s = applyTransition(
      requestSwitch(createModelSelection("bind_a"), "bind_b", "next-turn"),
      record("failed"),
      "credential revoked",
    );
    render(s);
    expect(text("model-current")).toBe("Active: Model A");
    const req = text("model-requested");
    expect(req).toContain("Rejected");
    expect(req).toContain("credential revoked");
    expect(req).toContain("Still using Model A");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("an engine-chosen different binding is flagged, never shown as success", () => {
    const s = applyTransition(
      requestSwitch(createModelSelection("bind_a"), "bind_b", "next-turn"),
      record("ready", "bind_c"),
    );
    render(s);
    expect(text("model-requested")).toContain(
      "different model than you requested",
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("keeps the user's requested binding across pending(C) then ready(C) after asking for B", () => {
    let s = requestSwitch(
      createModelSelection("bind_a"),
      "bind_b",
      "next-turn",
    );
    s = applyTransition(s, record("pending", "bind_c"));
    render(s);
    expect(text("model-requested")).toContain("Requested: Model B");
    expect(text("model-requested")).toContain(
      "different model than you requested",
    );
    expect(text("model-current")).toBe("Active: Model A");
    unmount(cmp!);
    document.body.innerHTML = "";
    s = applyTransition(s, record("ready", "bind_c"));
    render(s);
    expect(text("model-current")).toBe("Active: Model C");
    expect(text("model-requested")).toContain("Requested: Model B");
    expect(s.transition?.mismatch).toBe(true);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("disables unavailable models with an honest reason and labels unbenchmarked", () => {
    render(createModelSelection("bind_a"));
    const c = document.querySelector<HTMLInputElement>(
      'input[value="bind_c"]',
    )!;
    expect(c.disabled).toBe(true);
    expect(text("model-unavailable")).toContain("service is down");
    expect(document.body.textContent).toContain("[unbenchmarked]");
  });

  it("mid-turn shows when the switch takes effect and offers disposition", () => {
    const s = requestSwitch(
      createModelSelection("bind_a"),
      "bind_b",
      "cancel-and-switch",
    );
    render(s, { turnActive: true });
    expect(text("model-requested")).toContain("Cancels the running turn");
    expect(
      document.querySelector('input[value="cancel-and-switch"]'),
    ).not.toBeNull();
  });

  it("is keyboard operable with accessible names and requests the chosen model", () => {
    const onRequest = vi.fn();
    render(createModelSelection("bind_a"), { turnActive: true, onRequest });
    const radio = document.querySelector<HTMLInputElement>(
      'input[value="bind_b"]',
    )!;
    expect(radio.closest("label")?.textContent).toContain("Model B");
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Request switch"),
    )!;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(onRequest).toHaveBeenCalledWith("bind_b", "next-turn");
    expect(document.querySelector("fieldset legend")?.textContent).toBe(
      "Switch model",
    );
  });

  it("blocks a second request while one is pending", () => {
    const s = applyTransition(
      requestSwitch(createModelSelection("bind_a"), "bind_b", "next-turn"),
      record("pending"),
    );
    render(s);
    expect(document.querySelector("fieldset")!.disabled).toBe(true);
  });
});
