import test from "node:test";
import assert from "node:assert/strict";
import { Compile } from "typebox/compile";
import { intercomOutputSchema, structuredIntercomResult } from "./tool-result.ts";

const schema = Compile(intercomOutputSchema);

test("codemode receives JSON data while model content and TUI details are preserved", () => {
  const content = [{ type: "text" as const, text: "Message sent" }];
  const details = { accepted: true, delivered: true, messageId: "m1", optional: undefined };
  const result = structuredIntercomResult({ content, details });
  assert.equal(result.content, content);
  assert.equal(result.details, details);
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { ok: true, text: "Message sent", data: { accepted: true, delivered: true, messageId: "m1" } });
  assert.equal(schema.Check(result.structuredContent), true);
});

test("returned errors and failed deliveries carry both isError and structured data", () => {
  for (const details of [{ error: true, code: "SESSION_ID_IN_USE" }, { accepted: true, delivered: false, reason: "No receiver" }]) {
    const result = structuredIntercomResult({ content: [{ type: "text", text: "Failed" }], details });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { ok: false, text: "Failed", data: details });
    assert.equal(schema.Check(result.structuredContent), true);
  }
});

test("a deferred ask is successful, not an error", () => {
  const result = structuredIntercomResult({ content: [{ type: "text", text: "Pending reply" }], details: { delivered: true, pending: true, deferred: true } });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.ok, true);
});

test("results without details still match the output schema", () => {
  const result = structuredIntercomResult({ content: [{ type: "text", text: "Joined" }], details: undefined });
  assert.deepEqual(result.structuredContent, { ok: true, text: "Joined", data: {} });
  assert.equal(schema.Check(result.structuredContent), true);
});
