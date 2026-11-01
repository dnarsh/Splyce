// TD-21 / C4 Messages: a provider or proxy that omits `usage` must not turn a good response into an internal TypeError,
// and omitted usage must not be reported as known. Real adapter, real SSE parsing; only the HTTP client is replaced, as in
// splyce-anthropic-stream-safety.test.ts.
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Ev = { event: string; data: unknown };
const sse = (events: Ev[]) =>
	new Response(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n"), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
const client = (response: Response) =>
	({ beta: { messages: { create: () => ({ asResponse: async () => response }) } } }) as unknown as Anthropic;

const model: Model<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 200000,
	maxTokens: 64000,
};
const context = () => normalizeContext({ messages: [{ role: "user", content: "go", timestamp: 1 }], tools: [] });
const run = async (events: Ev[]) => streamAnthropic(model, context(), { client: client(sse(events)) }).result();

const startWith = (message: object): Ev => ({
	event: "message_start",
	data: { type: "message_start", message: { id: "msg", ...message } },
});
const body: Ev[] = [
	{
		event: "content_block_start",
		data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	},
	{
		event: "content_block_delta",
		data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
	},
	{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
];
const endWith = (usage?: object): Ev[] => [
	{
		event: "message_delta",
		data: { type: "message_delta", delta: { stop_reason: "end_turn" }, ...(usage ? { usage } : {}) },
	},
	{ event: "message_stop", data: { type: "message_stop" } },
];

describe("TD-21 Anthropic Messages omitted usage", () => {
	it("reports an explicit usage error, not an internal TypeError, when message_start has no usage", async () => {
		for (const tail of [endWith({ input_tokens: 12, output_tokens: 9 }), endWith()]) {
			const result = await run([startWith({}), ...body, ...tail]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/usage/i);
			expect(result.errorMessage).not.toMatch(/Cannot read properties/);
		}
	});

	it("pins the current behaviour when only message_delta omits usage: message_start values survive", async () => {
		const result = await run([startWith({ usage: { input_tokens: 12, output_tokens: 1 } }), ...body, ...endWith()]);
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(12);
		expect(result.usage.output).toBe(1);
	});

	it("keeps cumulative usage when both events carry it", async () => {
		const result = await run([
			startWith({ usage: { input_tokens: 12, output_tokens: 1 } }),
			...body,
			...endWith({ output_tokens: 9 }),
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(12);
		expect(result.usage.output).toBe(9);
		expect(result.usage.totalTokens).toBe(21);
	});
});
