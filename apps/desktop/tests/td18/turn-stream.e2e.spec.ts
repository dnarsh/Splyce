import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { SplyceEventEnvelope } from "@splyce/pi/contracts";
import type { TurnView } from "../../src/stores/turns";

type Snapshot = {
  run: Pick<
    TurnView,
    "text" | "thought" | "status" | "blocks" | "actions"
  > | null;
  lastSeq: number;
  lastDurableSeq: number;
  needsResync: boolean;
  resyncCount: number;
  resyncs: number[];
  errors: string[];
};

declare global {
  interface Window {
    __td18: {
      start(): void;
      play(events: SplyceEventEnvelope[]): void;
      burst(count: number): void;
      overflow(): void;
      recover(): void;
      snapshot(): Snapshot;
    };
  }
}

function fixtureEvents(file: string): SplyceEventEnvelope[] {
  const fixture = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "../../tests/fixtures/gui", file),
      "utf8",
    ),
  ) as { eventSequence: { event: SplyceEventEnvelope }[] };
  return fixture.eventSequence.map((step) => step.event);
}

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/td18/fixture.html");
  await page.waitForFunction(() => Boolean(window.__td18));
});

test("FUI-W4 renders the durable transcript without losing text or attribution", async ({
  page,
}) => {
  const events = fixtureEvents("fui-w4-stream-backpressure.json");
  await page.evaluate((sequence) => window.__td18.play(sequence), events);
  await expect
    .poll(() => page.evaluate(() => window.__td18.snapshot().run?.status))
    .toBe("completed");

  const snapshot = await page.evaluate(() => window.__td18.snapshot());
  expect(snapshot.run).not.toBeNull();
  expect(snapshot.resyncs).toEqual([]);
  expect(snapshot.needsResync).toBe(false);

  const visible = (
    await page.locator('[data-testid="turn-text"]').allTextContents()
  ).join("");
  expect(visible).toBe(snapshot.run?.text);

  const cards = page.locator('[data-testid="tool-card"]');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-action-id", "act_w4_scan");
  await expect(cards.first()).toContainText("Outcome:");
});

test("10x render-rate burst keeps the rendered bytes identical to the store", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__td18.start();
    window.__td18.burst(10_000);
  });

  await expect
    .poll(() => page.evaluate(() => window.__td18.snapshot().run?.text.length))
    .toBe(10_000);

  const snapshot = await page.evaluate(() => window.__td18.snapshot());
  expect(snapshot.resyncs).toEqual([]);
  expect(snapshot.lastSeq).toBe(10_001);

  const visible = (
    await page.locator('[data-testid="turn-text"]').allTextContents()
  ).join("");
  expect(visible).toHaveLength(10_000);
  expect(fnv(visible)).toBe(fnv(snapshot.run?.text ?? ""));
  expect(visible).toBe(snapshot.run?.text);
});

test("overflow requests exactly one resync from the durable cursor and recovers", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__td18.start();
    window.__td18.overflow();
  });

  await expect
    .poll(() => page.evaluate(() => window.__td18.snapshot().errors))
    .toEqual(["ERR_STREAM_RENDER_OVERFLOW"]);

  const overflowed = await page.evaluate(() => window.__td18.snapshot());
  expect(overflowed.needsResync).toBe(true);
  expect(overflowed.resyncs).toEqual([overflowed.lastDurableSeq]);
  expect(overflowed.resyncs).toHaveLength(1);

  await page.evaluate(() => window.__td18.recover());
  await expect
    .poll(() => page.evaluate(() => window.__td18.snapshot().needsResync))
    .toBe(false);

  const recovered = await page.evaluate(() => window.__td18.snapshot());
  expect(recovered.resyncs).toHaveLength(1);
  expect(recovered.resyncCount).toBe(1);
  expect(recovered.run?.status).toBe("streaming");
  await expect(page.getByTestId("turn-stream")).toHaveAttribute(
    "data-status",
    "streaming",
  );
});
