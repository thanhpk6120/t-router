import { describe, it, expect } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const enc = new TextEncoder();
async function run(lines, targetFormat, sourceFormat) {
  const src = new ReadableStream({ start(c) { for (const x of lines) c.enqueue(enc.encode(x)); c.close(); } });
  const s = createPassthroughStreamWithLogger("claude", null, "m", "c1", null, null, null, null, targetFormat, sourceFormat);
  return await new Response(src.pipeThrough(s)).text();
}

const openaiChunk = (delta) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta }] })}\n\n`;
const claudeEvent = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

describe("passthrough flush terminal synthesis (t.11)", () => {
  it("B: OpenAI tool_calls with no upstream finish_reason -> finish_reason must be tool_calls", async () => {
    const out = await run([openaiChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] })], FORMATS.OPENAI, FORMATS.OPENAI);
    expect(out).toContain('"finish_reason":"tool_calls"');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("C: Claude upstream cut before message_stop -> synthesize message_delta + message_stop", async () => {
    const out = await run([claudeEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })], FORMATS.CLAUDE, FORMATS.CLAUDE);
    expect(out).toContain("event: message_delta");
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain("event: message_stop");
    expect(out).not.toContain("data: [DONE]");
  });

  it("C2: Claude tool_use turn cut -> stop_reason tool_use", async () => {
    const out = await run([
      claudeEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read", input: {} } }),
      claudeEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }),
    ], FORMATS.CLAUDE, FORMATS.CLAUDE);
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(out).toContain("event: message_stop");
  });

  it("C3: Claude upstream already sent message_stop -> no duplicate terminal", async () => {
    const out = await run([
      claudeEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      claudeEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      claudeEvent({ type: "message_stop" }),
    ], FORMATS.CLAUDE, FORMATS.CLAUDE);
    const stops = (out.match(/event: message_stop/g) || []).length;
    const deltas = (out.match(/event: message_delta/g) || []).length;
    expect(stops).toBe(1);
    expect(deltas).toBe(1);
  });

  it("D: OpenAI upstream sends finish_reason normally -> untouched", async () => {
    const out = await run([
      openaiChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] }),
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ], FORMATS.OPENAI, FORMATS.OPENAI);
    expect(out).toContain('"finish_reason":"tool_calls"');
    expect((out.match(/finish_reason/g) || []).length).toBe(1); // no injected duplicate
  });
});
