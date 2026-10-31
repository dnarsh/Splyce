// TD-21 / C4 Messages: indexed content blocks keep their arrival order in the final result.
// Conformance row API_messages_block_usage (research/docs/capabilities/provider-api-conformance.md): "Indexed text/tool/thinking
// blocks ... preserve order". Real adapter, real SSE parsing; only the HTTP client is replaced, as in
// splyce-anthropic-stream-safety.test.ts. Thinking blocks are not covered here: they need a reasoning model and signature
// handling and belong in their own case once the thinking path is exercised against real-catalog data.
import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
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

const start: Ev = {
	event: "message_start",
	data: { type: "message_start", message: { id: "msg", usage: { input_tokens: 12, output_tokens: 1 } } },
};
const textStart = (index: number): Ev => ({
	event: "content_block_start",
	data: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
});
const textDelta = (index: number, text: string): Ev => ({
	event: "content_block_delta",
	data: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
});
const toolStart = (index: number, id: string): Ev => ({
	event: "content_block_start",
	data: { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "read", input: {} } },
});
const jsonDelta = (index: number, partial_json: string): Ev => ({
	event: "content_block_delta",
	data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } },
});
const stop = (index: number): Ev => ({ event: "content_block_stop", data: { type: "content_block_stop", index } });
const end: Ev[] = [
	{
		event: "message_delta",
		data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 12, output_tokens: 9 } },
	},
	{ event: "message_stop", data: { type: "message_stop" } },
];

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
const context = () =>
	normalizeContext({
		messages: [{ role: "user", content: "go", timestamp: 1 }],
		tools: [{ name: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }) }],
	});
const run = async (events: Ev[]) => streamAnthropic(model, context(), { client: client(sse(events)) }).result();

type Block = { type: string; text?: string; id?: string; arguments?: unknown };
const blocks = (content: unknown) => content as Block[];

describe("TD-21 Anthropic Messages block order", () => {
	it("keeps a text block before the tool block that follows it", async () => {
		const result = await run([
			start,
			textStart(0),
			textDelta(0, "I will read "),
			textDelta(0, "the file."),
			stop(0),
			toolStart(1, "tu_1"),
			jsonDelta(1, '{"path": "/a.txt"}'),
			stop(1),
			...end,
		]);
		const content = blocks(result.content);
		expect(content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(content[0]?.text).toBe("I will read the file.");
		expect(content[1]?.arguments).toEqual({ path: "/a.txt" });
	});

	it("keeps a tool block before the text block that follows it", async () => {
		const result = await run([
			start,
			toolStart(0, "tu_1"),
			jsonDelta(0, '{"path": "/a.txt"}'),
			stop(0),
			textStart(1),
			textDelta(1, "done"),
			stop(1),
			...end,
		]);
		const content = blocks(result.content);
		expect(content.map((block) => block.type)).toEqual(["toolCall", "text"]);
		expect(content[0]?.arguments).toEqual({ path: "/a.txt" });
		expect(content[1]?.text).toBe("done");
	});

	it("keeps two tool blocks in order and does not cross their arguments", async () => {
		const result = await run([
			start,
			toolStart(0, "tu_1"),
			jsonDelta(0, '{"path": "/first.txt"}'),
			stop(0),
			toolStart(1, "tu_2"),
			jsonDelta(1, '{"path": "/second.txt"}'),
			stop(1),
			...end,
		]);
		const calls = blocks(result.content).filter((block) => block.type === "toolCall");
		expect(calls.map((call) => call.id)).toEqual(["tu_1", "tu_2"]);
		expect(calls.map((call) => call.arguments)).toEqual([{ path: "/first.txt" }, { path: "/second.txt" }]);
	});
});
