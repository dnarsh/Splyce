import { afterEach, describe, expect, it } from "vitest";
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import ThemeSpecimen from "./ThemeSpecimen.svelte";
import StateMessage, { STATE_KINDS } from "./StateMessage.svelte";
import StateSpecimen from "./StateSpecimen.svelte";
import {
  CONTRAST_PAIRS,
  THEMES,
  TOKENS,
  TOKEN_NAMES,
  contrastRatio,
} from "./tokens";

const mounted: object[] = [];
function render(c: unknown, props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(c as never, { target, props: props as never }));
  flushSync();
  return target;
}
afterEach(() => {
  mounted.splice(0).forEach((c) => unmount(c));
  document.body.innerHTML = "";
});

describe("TD-75 theme specimens", () => {
  it("every token pair meets its contrast minimum in every theme", () => {
    for (const theme of THEMES)
      for (const p of CONTRAST_PAIRS)
        expect(
          contrastRatio(TOKENS[theme][p.fg], TOKENS[theme][p.bg]),
          `${theme} ${p.fg}/${p.bg}`,
        ).toBeGreaterThanOrEqual(p.min);
  });

  it("contrast function is correct and rejects bad colours", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(() => contrastRatio("red", "#fff")).toThrow();
  });

  it("renders every token in every theme with passing text results", () => {
    for (const theme of THEMES) {
      const t = render(ThemeSpecimen, { theme });
      for (const name of TOKEN_NAMES) {
        const li = t.querySelector(`[data-token=${name}]`);
        expect(li, `${theme} ${name}`).not.toBeNull();
        expect(li!.textContent).toContain(TOKENS[theme][name]);
      }
      const rows = t.querySelectorAll("tbody tr");
      expect(rows.length).toBe(CONTRAST_PAIRS.length);
      rows.forEach((r) => expect(r.textContent).toContain("Pass"));
    }
  });

  it("status samples carry glyph and text, not colour alone", () => {
    const t = render(ThemeSpecimen, { theme: "dark" });
    const chips = [...t.querySelectorAll(".chip")].map((c) => c.textContent);
    expect(chips).toEqual(["✕ Failed", "? Uncertain", "✓ Completed"]);
  });
});

describe("TD-76 state specimens", () => {
  it("renders every state distinguishable by text", () => {
    const t = render(StateSpecimen, {});
    const kinds = [...t.querySelectorAll("[data-testid=state-kind]")].map(
      (e) => e.textContent,
    );
    expect(kinds).toEqual([
      "Loading",
      "Nothing here yet",
      "Error",
      "Out of date",
      "Unavailable",
    ]);
    expect(new Set(kinds).size).toBe(STATE_KINDS.length);
  });

  it("error is an alert, loading is busy, others are status", () => {
    const t = render(StateSpecimen, {});
    const by = (k: string) => t.querySelector(`[data-kind=${k}]`)!;
    expect(by("error").getAttribute("role")).toBe("alert");
    expect(by("loading").getAttribute("aria-busy")).toBe("true");
    expect(by("empty").getAttribute("role")).toBe("status");
    expect(by("empty").hasAttribute("aria-busy")).toBe(false);
  });

  it("is inert: no buttons unless the parent supplies an action slot", () => {
    expect(render(StateSpecimen, {}).querySelector("button")).toBeNull();
    const action = createRawSnippet(() => ({
      render: () => "<button>Retry</button>",
    }));
    const t = render(StateMessage, { kind: "error", title: "x", action });
    expect(t.querySelector(".action button")!.textContent).toBe("Retry");
  });

  it("long text wraps without being truncated", () => {
    const long = "a".repeat(500);
    const t = render(StateMessage, {
      kind: "unavailable",
      title: long,
      detail: long,
    });
    expect(t.querySelector(".title")!.textContent).toBe(long);
    expect(t.querySelector(".detail")!.textContent).toBe(long);
  });
});
