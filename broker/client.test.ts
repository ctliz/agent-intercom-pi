import test from "node:test";
import assert from "node:assert/strict";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_CONTROL_ENVELOPE_VERSION,
  BOSS_PARTICIPANT_CREDENTIAL_VERSION,
  BOSS_RUN_FEATURE,
  BOSS_RUN_FEATURE_CONTRACT,
} from "@dataforxyz/agent-intercom-core/boss";
import { IntercomClient } from "./client.ts";
import { brokerCapabilityAdvertisement } from "./boss-adapter.ts";

function requestedBossRegistration() {
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

test("cancelAsk resolves false after synchronous socket write failures", async () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      throw new Error("write failed");
    },
  };

  assert.equal(await client.cancelAsk("ask-1"), false);
});

test("a client that requested Boss rejects absent capability and binding responses", () => {
  const absentCapabilityClient = new IntercomClient();
  (absentCapabilityClient as any).requestedBossRegistration = requestedBossRegistration();
  assert.throws(() => (absentCapabilityClient as any).handleBrokerMessage({
    type: "registered",
    sessionId: "worker-session",
    protocol: "pi-intercom",
    version: 3,
  }), /Invalid registered message/);

  const absentBindingClient = new IntercomClient();
  (absentBindingClient as any).requestedBossRegistration = requestedBossRegistration();
  assert.throws(() => (absentBindingClient as any).handleBrokerMessage({
    type: "registered",
    sessionId: "worker-session",
    protocol: "pi-intercom",
    version: 3,
    capabilities: brokerCapabilityAdvertisement({
      providerAttested: true,
      brokerIdentityVerified: true,
      credentialsAuthoritative: true,
      authorityTransitionsDurable: true,
      participantHealthIntegrated: true,
      recipientIngressIntegrated: true,
    }),
  }));
});

test("client Boss registration and live metadata boundaries reject proxies without traps", async () => {
  let outerRegistrationTraps = 0;
  const outerRegistrationProxy = new Proxy({
    cwd: "/tmp",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
  }, {
    get() {
      outerRegistrationTraps += 1;
      throw new Error("outer registration proxy trap must not execute");
    },
    ownKeys() {
      outerRegistrationTraps += 1;
      throw new Error("outer registration proxy trap must not execute");
    },
  });
  await assert.rejects(new IntercomClient().connect(outerRegistrationProxy as never));
  assert.equal(outerRegistrationTraps, 0);

  let registrationTraps = 0;
  const registrationProxy = new Proxy(requestedBossRegistration(), {
    get() {
      registrationTraps += 1;
      throw new Error("registration proxy trap must not execute");
    },
    ownKeys() {
      registrationTraps += 1;
      throw new Error("registration proxy trap must not execute");
    },
  });
  const client = new IntercomClient();
  await assert.rejects(client.connect({
    cwd: "/tmp",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    boss: registrationProxy,
  }));
  assert.equal(registrationTraps, 0);

  let metadataTraps = 0;
  const metadataProxy = new Proxy({}, {
    get() {
      metadataTraps += 1;
      throw new Error("metadata proxy trap must not execute");
    },
    ownKeys() {
      metadataTraps += 1;
      throw new Error("metadata proxy trap must not execute");
    },
  });
  (client as any)._sessionId = "registered-session";
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "sessions",
    requestId: "list-request",
    sessions: [{
      id: "boss-session",
      cwd: "/tmp",
      model: "test",
      pid: 1,
      startedAt: 1,
      lastActivity: 1,
      boss: metadataProxy,
    }],
  }), /Invalid sessions message/);
  assert.equal(metadataTraps, 0);

  let registeredFrameTraps = 0;
  const registeredFrameProxy = new Proxy({
    type: "registered",
    sessionId: "worker-session",
    protocol: "pi-intercom",
    version: 3,
  }, {
    get() {
      registeredFrameTraps += 1;
      throw new Error("registered frame proxy trap must not execute");
    },
    getOwnPropertyDescriptor() {
      registeredFrameTraps += 1;
      throw new Error("registered frame proxy trap must not execute");
    },
    ownKeys() {
      registeredFrameTraps += 1;
      throw new Error("registered frame proxy trap must not execute");
    },
  });
  assert.throws(() => (new IntercomClient() as any).handleBrokerMessage(registeredFrameProxy));
  assert.equal(registeredFrameTraps, 0);
});

test("Boss typed control fails before outbox, pending state, or transport routing", async () => {
  const client = new IntercomClient();
  let writes = 0;
  let enqueues = 0;
  (client as any)._sessionId = "manager-session";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      writes += 1;
    },
  };
  (client as any).outbox = {
    enqueue() {
      enqueues += 1;
    },
    list() {
      return [];
    },
  };

  const baseControl = {
    type: "boss.assignment.created" as const,
    version: BOSS_CONTROL_ENVELOPE_VERSION,
    messageId: "transport-message-a",
    bossRunId: "run-a",
    participantId: "manager-participant",
    bindingEpoch: 2,
    idempotencyKey: "stable-idempotency-key",
    payload: { assignmentId: "assignment-a" },
  };
  const first = await client.send("worker-session", {
    text: "unavailable",
    messageId: "transport-message-a",
    control: baseControl,
  });
  const replay = await client.send("worker", {
    text: "still unavailable",
    messageId: "transport-message-b",
    control: {
      ...baseControl,
      messageId: "transport-message-b",
      payload: { assignmentId: "assignment-a" },
    },
  });

  for (const result of [first, replay]) {
    assert.equal(result.accepted, false);
    assert.equal(result.delivered, false);
    assert.equal(result.code, "CONTROL_DISPATCH_UNAVAILABLE");
  }
  assert.equal(writes, 0);
  assert.equal(enqueues, 0);
  assert.equal((client as any).pendingSends.size, 0);
});
