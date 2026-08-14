import assert from "node:assert/strict";
import test from "node:test";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_PARTICIPANT_CREDENTIAL_VERSION,
  BOSS_RUN_FEATURE,
  BOSS_RUN_FEATURE_CONTRACT,
} from "@dataforxyz/agent-intercom-core/boss";
import {
  isExactClientRegistrationEnvelope,
  isExactClientRegistrationRequest,
  isExactRegisteredFrame,
  parseSessionRegistration,
} from "./registration.ts";

function ordinarySession() {
  return {
    name: "worker",
    cwd: "/tmp/workspace",
    model: "test-model",
    pid: 42,
    startedAt: 1,
    lastActivity: 2,
    status: "idle",
    runtimeInstanceId: "runtime-a",
  };
}

function bossRegistration() {
  return {
    featureContract: BOSS_RUN_FEATURE_CONTRACT,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
    credential: {
      version: BOSS_PARTICIPANT_CREDENTIAL_VERSION,
      namespace: BOSS_RUN_FEATURE,
      credentialKind: "enrollment" as const,
      credentialId: "credential-worker",
      credential: "secret-material",
      bossRunId: "run-a",
      participantId: "worker-participant",
      role: "worker" as const,
      communicationProfile: "worker" as const,
      bindingEpoch: 2,
      issuedAt: "2026-07-28T12:00:00.000Z",
      expiresAt: "2026-07-28T13:00:00.000Z",
      nonce: "nonce-a",
    },
  };
}

function trapCountingProxy<T extends object>(target: T) {
  let traps = 0;
  const trapped = () => {
    traps += 1;
    throw new Error("proxy trap must not execute");
  };
  return {
    proxy: new Proxy(target, {
      get: trapped,
      getOwnPropertyDescriptor: trapped,
      getPrototypeOf: trapped,
      has: trapped,
      ownKeys: trapped,
    }),
    traps: () => traps,
  };
}

test("ordinary registration is an exact plain data schema and rejects folded authority", () => {
  const session = ordinarySession();
  assert.equal(parseSessionRegistration(session), session);

  for (const foldedKey of [
    "featureContract",
    "capabilityDigest",
    "credential",
    "bossRunId",
    "participantId",
    "bindingEpoch",
    "role",
    "communicationProfile",
    "binding",
    "principal",
    "brokerIdentityVerified",
    "capabilities",
  ]) {
    assert.equal(parseSessionRegistration({ ...session, [foldedKey]: "forged" }), null, foldedKey);
  }
  assert.equal(parseSessionRegistration({ ...session, boss: undefined }), null);
  assert.equal(parseSessionRegistration({ ...session, unknown: true }), null);

  const symbol = { ...session, [Symbol("authority")]: true };
  assert.equal(parseSessionRegistration(symbol), null);
  assert.equal(parseSessionRegistration(Object.assign(Object.create({ bossRunId: "run-a" }), session)), null);
  assert.equal(parseSessionRegistration(Object.assign(Object.create(null), session)), null);
  assert.equal(parseSessionRegistration(Object.assign([], session)), null);

  let accessorCalls = 0;
  const accessor = Object.defineProperty({ ...session }, "cwd", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "/tmp/forged";
    },
  });
  assert.equal(parseSessionRegistration(accessor), null);
  assert.equal(accessorCalls, 0);

  const nonEnumerable = Object.defineProperty({ ...session }, "cwd", {
    enumerable: false,
    value: session.cwd,
  });
  assert.equal(parseSessionRegistration(nonEnumerable), null);
});

test("registration request and nested Boss graphs reject proxies with zero traps", () => {
  const session = ordinarySession();
  const request = {
    type: "register",
    protocol: "pi-intercom",
    version: 4,
    session,
  };
  assert.equal(isExactClientRegistrationEnvelope(request), true);
  assert.equal(isExactClientRegistrationRequest(request), true);
  assert.equal(isExactClientRegistrationEnvelope({ ...request, scopeId: "Scope_1234567890" }), true);
  assert.equal(isExactClientRegistrationRequest({ ...request, scopeId: "Scope_1234567890" }), true);
  assert.equal(isExactClientRegistrationEnvelope({ ...request, session: { folded: true } }), true);
  assert.equal(isExactClientRegistrationRequest({ ...request, session: { folded: true } }), false);

  const outer = trapCountingProxy(request);
  assert.equal(isExactClientRegistrationRequest(outer.proxy), false);
  assert.equal(outer.traps(), 0);

  const nestedSession = trapCountingProxy(session);
  assert.equal(isExactClientRegistrationRequest({ ...request, session: nestedSession.proxy }), false);
  assert.equal(nestedSession.traps(), 0);

  const nestedBoss = trapCountingProxy(bossRegistration());
  assert.equal(parseSessionRegistration({ ...session, boss: nestedBoss.proxy }), null);
  assert.equal(nestedBoss.traps(), 0);

  assert.equal(parseSessionRegistration({ ...session, boss: bossRegistration() })?.boss !== undefined, true);
});

test("registered frames have exact mode-specific baseline shapes", () => {
  const ordinary = {
    type: "registered",
    sessionId: "session-a",
    protocol: "pi-intercom",
    version: 4,
  };
  assert.equal(isExactRegisteredFrame(ordinary, "ordinary"), true);
  for (const foldedKey of ["boss", "capabilities", "binding", "principal", "bossRunId", "bindingEpoch"]) {
    assert.equal(isExactRegisteredFrame({ ...ordinary, [foldedKey]: {} }, "ordinary"), false, foldedKey);
  }
  assert.equal(isExactRegisteredFrame({ ...ordinary, registrationKind: "ordinary" }, "ordinary"), false);
  assert.equal(isExactRegisteredFrame({ ...ordinary, [Symbol("unknown")]: true }, "ordinary"), false);
  assert.equal(isExactRegisteredFrame(Object.assign(Object.create({}), ordinary), "ordinary"), false);
  assert.equal(isExactRegisteredFrame(Object.defineProperty({ ...ordinary }, "sessionId", {
    enumerable: false,
    value: "session-a",
  }), "ordinary"), false);
  let accessorCalls = 0;
  assert.equal(isExactRegisteredFrame(Object.defineProperty({ ...ordinary }, "sessionId", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "session-a";
    },
  }), "ordinary"), false);
  assert.equal(accessorCalls, 0);

  const proxy = trapCountingProxy(ordinary);
  assert.equal(isExactRegisteredFrame(proxy.proxy, "ordinary"), false);
  assert.equal(proxy.traps(), 0);

  const nestedCapabilities = trapCountingProxy({ baseProtocolVersion: 3, features: [] });
  assert.equal(isExactRegisteredFrame({
    ...ordinary,
    capabilities: nestedCapabilities.proxy,
    boss: {},
  }, "boss"), false);
  assert.equal(nestedCapabilities.traps(), 0);
});
