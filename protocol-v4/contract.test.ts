import test from "node:test";
import assert from "node:assert/strict";
import {
  INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
  INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION,
  INTERCOM_PROTOCOL_V4_VECTORS,
  intercomScopeIdFromEnv,
  parseIntercomScopeId,
  sameIntercomScope,
} from "./contract.ts";

const EXPECTED_CORE_PROTOCOL_V4_SEMANTICS_HASH = "ef23cae55b3cca7683fee60e5f2421350cde731dc5424c82286a33a8b9cdf6cb";

test("Pi consumes the reviewed Core protocol-v4 corpus", () => {
  assert.equal(INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION, 2);
  assert.equal(INTERCOM_PROTOCOL_V4_VECTORS.length, 48);
  assert.equal(INTERCOM_PROTOCOL_V4_SEMANTICS_HASH, EXPECTED_CORE_PROTOCOL_V4_SEMANTICS_HASH);
});

test("scope parser is exact and unscoped is strict", () => {
  assert.equal(parseIntercomScopeId(""), undefined);
  assert.equal(intercomScopeIdFromEnv({ AGENT_INTERCOM_SCOPE_ID: "Scope_1234567890" }), "Scope_1234567890");
  assert.throws(() => intercomScopeIdFromEnv({ AGENT_INTERCOM_SCOPE_ID: " Scope_1234567890" }), /must match/);
  assert.equal(sameIntercomScope(undefined, undefined), true);
  assert.equal(sameIntercomScope(undefined, "Scope_1234567890"), false);
});
