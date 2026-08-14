import assert from "node:assert/strict";
import test from "node:test";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_CONTROL_ENVELOPE_VERSION,
  BOSS_PARTICIPANT_BINDING_VERSION,
  BOSS_PARTICIPANT_CREDENTIAL_VERSION,
  BOSS_POLICY_SEMANTICS_HASH,
  BOSS_RUN_FEATURE,
  BOSS_RUN_FEATURE_CONTRACT,
  type BossParticipantRole,
} from "@ctliz/agent-intercom-core/boss";
import {
  BOSS_POLICY_PRINCIPAL_VERSION,
} from "@ctliz/agent-intercom-core/boss/policy";
import {
  bossControlKind,
  brokerCapabilityAdvertisement,
  correlateBossControl,
  DORMANT_BOSS_READINESS,
  missingBossReadinessPredicates,
  negotiateBossRegistration,
  parseBossControl,
  parseBossParticipantRegistrationMetadata,
  parseBossSessionMetadata,
  type BossReadinessPredicates,
} from "./boss-adapter.ts";
import { isIntercomCommonControlEnvelope } from "../control.ts";

function trapCountingProxy<T extends object>(target: T): { proxy: T; traps: () => number } {
  let trapCount = 0;
  const trapped = () => {
    trapCount += 1;
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
    traps: () => trapCount,
  };
}

export function bossRegistrationRequest(role: BossParticipantRole = "worker") {
  return {
    featureContract: BOSS_RUN_FEATURE_CONTRACT,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
    credential: {
      version: BOSS_PARTICIPANT_CREDENTIAL_VERSION,
      namespace: BOSS_RUN_FEATURE,
      credentialKind: "enrollment" as const,
      credentialId: `credential-${role}`,
      credential: "secret-material",
      bossRunId: "run-a",
      participantId: `${role}-participant`,
      role,
      communicationProfile: role,
      bindingEpoch: 2,
      issuedAt: "2026-07-28T12:00:00.000Z",
      expiresAt: "2026-07-28T13:00:00.000Z",
      nonce: "nonce-a",
    },
  };
}

export function bossSessionMetadata(
  role: BossParticipantRole,
  sessionId: string,
  options: { runId?: string; participantId?: string; managerParticipantId?: string; assignedParticipantIds?: string[]; requestingPrincipalId?: string } = {},
) {
  const participantId = options.participantId ?? `${role}-participant`;
  const bossRunId = options.runId ?? "run-a";
  const assignedManagerParticipantId = role === "worker" || role === "scout"
    ? options.managerParticipantId ?? "manager-participant"
    : undefined;
  const binding = {
    version: BOSS_PARTICIPANT_BINDING_VERSION,
    bossRunId,
    participantId,
    role,
    communicationProfile: role,
    bindingEpoch: 2,
    sessionId,
    brokerGeneration: 1,
    brokerBootInstance: "boot-a",
    state: "active" as const,
    ...(assignedManagerParticipantId ? { assignedManagerParticipantId } : {}),
    authorityTransitionId: `bind-${sessionId}`,
  };
  const principal = {
    version: BOSS_POLICY_PRINCIPAL_VERSION,
    principalId: sessionId,
    principalClass: "boss-private" as const,
    state: "active" as const,
    bossRunId,
    participantId,
    role,
    bindingEpoch: 2,
    ...(assignedManagerParticipantId ? { assignedManagerParticipantId } : {}),
    ...(role === "manager" ? { assignedParticipantIds: options.assignedParticipantIds ?? ["worker-participant"] } : {}),
    ...(role === "council" ? { requestingPrincipalId: options.requestingPrincipalId ?? "boss-session" } : {}),
  };
  return {
    binding,
    principal,
    featureContract: BOSS_RUN_FEATURE_CONTRACT,
    policySemanticsHash: BOSS_POLICY_SEMANTICS_HASH,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
    brokerIdentityVerified: true as const,
  };
}

test("Boss remains dormant until every readiness predicate is true", () => {
  assert.deepEqual(brokerCapabilityAdvertisement(), { baseProtocolVersion: 4, features: [] });
  assert.deepEqual(missingBossReadinessPredicates(DORMANT_BOSS_READINESS), [
    "providerAttested",
    "brokerIdentityVerified",
    "credentialsAuthoritative",
    "authorityTransitionsDurable",
    "participantHealthIntegrated",
    "recipientIngressIntegrated",
  ]);
  const almostReady = Object.fromEntries(
    Object.keys(DORMANT_BOSS_READINESS).map((key) => [key, true]),
  ) as unknown as BossReadinessPredicates;
  almostReady.recipientIngressIntegrated = false;
  assert.equal(brokerCapabilityAdvertisement(almostReady).features.length, 0);
});

test("Boss readiness accepts only the exact fixed descriptor-safe predicate set", () => {
  const ready: BossReadinessPredicates = {
    providerAttested: true,
    brokerIdentityVerified: true,
    credentialsAuthoritative: true,
    authorityTransitionsDurable: true,
    participantHealthIntegrated: true,
    recipientIngressIntegrated: true,
  };
  assert.equal(brokerCapabilityAdvertisement(ready).features.length, 1);

  const { recipientIngressIntegrated: _omitted, ...missing } = ready;
  const withSymbol = { ...ready } as BossReadinessPredicates & { [key: symbol]: boolean };
  withSymbol[Symbol("unknown")] = true;
  const nonEnumerable = Object.defineProperty({ ...ready }, "providerAttested", {
    enumerable: false,
    value: true,
  });
  let accessorCalls = 0;
  const accessor = Object.defineProperty({ ...ready }, "providerAttested", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return true;
    },
  });
  const inherited = Object.assign(Object.create({ providerAttested: true }), missing);
  const nullPrototype = Object.assign(Object.create(null), ready);
  const customPrototype = Object.assign(Object.create({}), ready);
  const array = Object.assign([], ready);

  for (const invalid of [
    missing,
    { ...ready, unknown: true },
    withSymbol,
    nonEnumerable,
    accessor,
    inherited,
    nullPrototype,
    customPrototype,
    array,
    { ...ready, providerAttested: 1 },
  ]) {
    assert.throws(() => brokerCapabilityAdvertisement(invalid as BossReadinessPredicates));
  }
  assert.equal(accessorCalls, 0);

  const proxied = trapCountingProxy(ready);
  assert.throws(() => brokerCapabilityAdvertisement(proxied.proxy));
  assert.equal(proxied.traps(), 0);
  const revoked = Proxy.revocable(ready, {});
  revoked.revoke();
  assert.throws(() => brokerCapabilityAdvertisement(revoked.proxy));
});

test("exact boss-run-v1/base-protocol-3 negotiation has no ordinary downgrade", () => {
  const request = bossRegistrationRequest();
  assert.deepEqual(parseBossParticipantRegistrationMetadata(request), request);
  assert.deepEqual(negotiateBossRegistration(request, brokerCapabilityAdvertisement()), {
    accepted: false,
    code: "BOSS_FEATURE_NOT_ADVERTISED",
  });

  const ready = Object.fromEntries(
    Object.keys(DORMANT_BOSS_READINESS).map((key) => [key, true]),
  ) as unknown as BossReadinessPredicates;
  const decision = negotiateBossRegistration(request, brokerCapabilityAdvertisement(ready));
  assert.equal(decision.accepted, true);
  assert.deepEqual("featureContract" in decision ? decision.featureContract : undefined, BOSS_RUN_FEATURE_CONTRACT);
  assert.deepEqual(negotiateBossRegistration(
    { ...request, capabilityDigest: "0".repeat(64) },
    brokerCapabilityAdvertisement(ready),
  ), { accepted: false, code: "BOSS_FEATURE_DIVERGENCE" });

  const advertisement = brokerCapabilityAdvertisement(ready);
  for (const substituted of [
    { ...advertisement, protocolFeatureContractHash: "1".repeat(64) },
    { ...advertisement, featureSetHash: "2".repeat(64) },
    { ...advertisement, controlEnvelopeVersion: 2 },
    { ...advertisement, capabilityDigest: "3".repeat(64) },
    { ...advertisement, features: advertisement.features.map((feature) => ({ ...feature, semanticsHash: "4".repeat(64) })) },
  ]) {
    assert.deepEqual(negotiateBossRegistration(request, substituted), {
      accepted: false,
      code: "BOSS_FEATURE_DIVERGENCE",
    });
  }
});

test("Boss request and live binding parsers reject unknown, accessor, and cross-identity metadata", () => {
  assert.throws(() => parseBossParticipantRegistrationMetadata({ ...bossRegistrationRequest(), unknown: true }));
  let getterInvoked = false;
  const accessor = Object.defineProperty({}, "featureContract", {
    enumerable: true,
    get() {
      getterInvoked = true;
      return BOSS_RUN_FEATURE_CONTRACT;
    },
  });
  Object.defineProperties(accessor, {
    capabilityDigest: { enumerable: true, value: BOSS_CAPABILITY_FEATURE_DIGEST },
    credential: { enumerable: true, value: bossRegistrationRequest().credential },
  });
  assert.throws(() => parseBossParticipantRegistrationMetadata(accessor));
  assert.equal(getterInvoked, false);

  const metadata = bossSessionMetadata("worker", "worker-session");
  assert.deepEqual(parseBossSessionMetadata(metadata, "worker-session"), metadata);
  assert.throws(() => parseBossSessionMetadata({
    ...metadata,
    principal: { ...metadata.principal, bossRunId: "run-b" },
  }, "worker-session"));
  assert.throws(() => parseBossSessionMetadata(metadata, "other-session"));
});

test("adapter-owned Boss inputs reject top-level and nested proxies without executing traps", () => {
  const registration = bossRegistrationRequest();
  const registrationProxy = trapCountingProxy(registration);
  assert.throws(() => parseBossParticipantRegistrationMetadata(registrationProxy.proxy));
  assert.equal(registrationProxy.traps(), 0);

  const contractProxy = trapCountingProxy(registration.featureContract);
  assert.throws(() => parseBossParticipantRegistrationMetadata({
    ...registration,
    featureContract: contractProxy.proxy,
  }));
  assert.equal(contractProxy.traps(), 0);

  const session = bossSessionMetadata("worker", "worker-session");
  const sessionProxy = trapCountingProxy(session);
  assert.throws(() => parseBossSessionMetadata(sessionProxy.proxy, "worker-session"));
  assert.equal(sessionProxy.traps(), 0);

  const bindingProxy = trapCountingProxy(session.binding);
  assert.throws(() => parseBossSessionMetadata({ ...session, binding: bindingProxy.proxy }, "worker-session"));
  assert.equal(bindingProxy.traps(), 0);

  const control = {
    type: "boss.assignment.created",
    version: BOSS_CONTROL_ENVELOPE_VERSION,
    messageId: "message-proxy",
    bossRunId: "run-a",
    participantId: "manager-participant",
    bindingEpoch: 2,
    idempotencyKey: "idempotency-proxy",
    payload: {},
  };
  const controlProxy = trapCountingProxy(control);
  assert.equal(parseBossControl(controlProxy.proxy), null);
  assert.equal(isIntercomCommonControlEnvelope(controlProxy.proxy), false);
  assert.equal(controlProxy.traps(), 0);
  const revokedControl = Proxy.revocable(control, {});
  revokedControl.revoke();
  assert.equal(parseBossControl(revokedControl.proxy), null);
  assert.equal(isIntercomCommonControlEnvelope(revokedControl.proxy), false);

  const payloadProxy = trapCountingProxy(control.payload);
  assert.equal(parseBossControl({ ...control, payload: payloadProxy.proxy }), null);
  assert.equal(isIntercomCommonControlEnvelope({ ...control, payload: payloadProxy.proxy }), false);
  assert.equal(payloadProxy.traps(), 0);

  const advertisement = brokerCapabilityAdvertisement({
    providerAttested: true,
    brokerIdentityVerified: true,
    credentialsAuthoritative: true,
    authorityTransitionsDurable: true,
    participantHealthIntegrated: true,
    recipientIngressIntegrated: true,
  });
  const advertisementProxy = trapCountingProxy(advertisement);
  assert.deepEqual(negotiateBossRegistration(registration, advertisementProxy.proxy), {
    accepted: false,
    code: "BOSS_FEATURE_DIVERGENCE",
  });
  assert.equal(advertisementProxy.traps(), 0);
});

test("typed Boss controls use an exhaustive mapping without manufacturing authority correlation", () => {
  const expected = {
    "boss.assignment.created": "assignment_request",
    "boss.assignment.accepted": "assignment_response",
    "boss.assignment.checkpoint": "assignment_response",
    "boss.assignment.submitted": "assignment_response",
    "boss.assignment.rejected": "assignment_response",
    "boss.assignment.cancelled": "lifecycle",
    "boss.staffing.requested": "staffing",
    "boss.staffing.resolved": "staffing",
    "boss.review.requested": "review_request",
    "boss.review.submitted": "review_result",
    "boss.council.requested": "review_request",
    "boss.council.submitted": "review_result",
    "boss.proof.submitted": "proof",
    "boss.worker.health": "health",
    "boss.worker.blocked": "health",
    "boss.worker.failed": "health",
    "boss.worker.notice": "lifecycle",
    "boss.worker.notice_delivery_failed": "lifecycle",
    "boss.decision.required": "decision",
  } as const;
  const metadata = bossSessionMetadata("manager", "manager-session", { assignedParticipantIds: ["worker-participant"] });
  for (const [type, kind] of Object.entries(expected)) {
    const envelope = {
      type,
      version: BOSS_CONTROL_ENVELOPE_VERSION,
      messageId: `message-${type}`,
      bossRunId: "run-a",
      participantId: "manager-participant",
      bindingEpoch: 2,
      idempotencyKey: `idempotency-${type}`,
      payload: {},
    };
    const correlated = correlateBossControl(metadata, envelope, envelope.messageId);
    assert.ok(correlated, type);
    assert.equal(bossControlKind(correlated.envelope), kind, type);
    assert.equal(correlated.context.correlated, false, type);
  }
  const envelope = {
    type: "boss.assignment.created",
    version: 1,
    messageId: "message-a",
    bossRunId: "run-a",
    participantId: "manager-participant",
    bindingEpoch: 2,
    idempotencyKey: "idempotency-a",
    payload: {},
  };
  assert.equal(correlateBossControl(metadata, envelope, "message-b"), null);
  assert.equal(correlateBossControl(metadata, { ...envelope, participantId: "other" }, "message-a"), null);
  assert.equal(correlateBossControl(metadata, { ...envelope, bindingEpoch: 3 }, "message-a"), null);
});
