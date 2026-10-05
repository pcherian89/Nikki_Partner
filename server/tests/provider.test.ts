import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../provider/anthropic.js";
import { ProviderError } from "../provider/types.js";
import { ModelResponse, RESPONSE_JSON_SCHEMA } from "../schema.js";

const reply = {
  message: "Hi",
  questions: [],
  captured_items: [{ ref: "n1", kind: "action", title: "Write report", notes: "", estimate_minutes: 0, deadline: "", project: "", duplicate_of: "" }],
  task_updates: [],
  meetings: [],
  context_updates: [],
  plan: null,
};

function apiMessage(text: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function fakeFetch(responses: { status: number; body: unknown }[], seen: any[]) {
  return (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", "request-id": "req_test" } });
  }) as unknown as typeof fetch;
}

const req = { system: "sys", messages: [{ role: "user" as const, content: "hello" }], schema: RESPONSE_JSON_SCHEMA as unknown as Record<string, unknown> };

test("falls back to JSON instructions when the API rejects the output schema, then stays there", async () => {
  const seen: any[] = [];
  const grammarError = {
    type: "error",
    error: { type: "invalid_request_error", message: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools." },
  };
  const p = new AnthropicProvider("sk-test", "claude-opus-5-5", {
    fetch: fakeFetch(
      [
        { status: 400, body: grammarError },
        { status: 200, body: apiMessage("```json\n" + JSON.stringify(reply) + "\n```") },
        { status: 200, body: apiMessage(JSON.stringify(reply)) },
      ],
      seen,
    ),
    maxRetries: 0,
  });
  const r1 = await p.generate(req);
  assert.match(r1.text, /Write report/);
  assert.ok(seen[0].output_config.format, "first attempt uses structured output");
  assert.equal(seen[1].output_config.format, undefined, "fallback drops the format");
  assert.match(seen[1].system[0].text, /JSON Schema/);
  await p.generate(req);
  assert.equal(seen[2].output_config.format, undefined, "remembers the fallback");
  assert.equal(seen.length, 3);
});

test("other 400 errors are reported, not retried", async () => {
  const seen: any[] = [];
  const p = new AnthropicProvider("sk-test", "claude-opus-5-5", {
    fetch: fakeFetch([{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "messages: bad" } } }], seen),
    maxRetries: 0,
  });
  await assert.rejects(p.generate(req), (e: unknown) => e instanceof ProviderError && e.code === "bad_request" && e.message === "Claude rejected the request: messages: bad");
  assert.equal(seen.length, 1);
});

test("schema reply with empty-string/zero placeholders parses to nulls", () => {
  const parsed = ModelResponse.parse(reply);
  const c = parsed.captured_items[0];
  assert.equal(c.notes, null);
  assert.equal(c.estimate_minutes, null);
  assert.equal(c.deadline, null);
  assert.equal(c.duplicate_of, null);
  assert.equal(parsed.availability, null);
});

test("schema stays small: few anyOf unions", () => {
  const anyOfs = JSON.stringify(RESPONSE_JSON_SCHEMA).split('"anyOf"').length - 1;
  assert.ok(anyOfs <= 1, `anyOf count ${anyOfs}`);
});
