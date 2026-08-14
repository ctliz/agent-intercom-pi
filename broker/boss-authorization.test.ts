import assert from "node:assert/strict";
import test from "node:test";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_PARTICIPANT_BINDING_VERSION,
  BOSS_POLICY_SEMANTICS_HASH,
  BOSS_RUN_FEATURE_CONTRACT,
  type BossParticipantRole,
} from "@ctliz/agent-intercom-core/boss";
import { BOSS_POLICY_PRINCIPAL_VERSION } from "@ctliz/agent-intercom-core/boss/policy";
import type { SessionInfo } from "../types.ts";
import { authorizeSessionAction, visibleSessions } from "./authorization.ts";
import { parseBossSessionMetadata } from "./boss-adapter.ts";

const VERIFIED_BROKER = { brokerIdentityVerified: true } as const;

function authorize(
  sessions: SessionInfo[],
  actorId: string,
  action: Parameters<typeof authorizeSessionAction>[2],
  targetId: string,
  context?: Parameters<typeof authorizeSessionAction>[4],
) {
  return authorizeSessionAction(sessions, actorId, action, targetId, context, VERIFIED_BROKER);
}

function bossSession(
  role: BossParticipantRole,
  id: string,
  options: { runId?: string; participantId?: string; managerParticipantId?: string; assignedParticipantIds?: string[]; requestingPrincipalId?: string } = {},
): SessionInfo {
  const participantId = options.participantId ?? `${role}-participant`;
  const bossRunId = options.runId ?? "run-a";
  const assignedManagerParticipantId = role === "worker" || role === "scout"
    ? options.managerParticipantId ?? "manager-participant"
    : undefined;
  const boss = parseBossSessionMetadata({
    binding: {
      version: BOSS_PARTICIPANT_BINDING_VERSION,
      bossRunId,
      participantId,
      role,
      communicationProfile: role,
      bindingEpoch: 2,
      sessionId: id,
      brokerGeneration: 1,
      brokerBootInstance: "boot-a",
      state: "active",
      ...(assignedManagerParticipantId ? { assignedManagerParticipantId } : {}),
      authorityTransitionId: `bind-${id}`,
    },
    principal: {
      version: BOSS_POLICY_PRINCIPAL_VERSION,
      principalId: id,
      principalClass: "boss-private",
      state: "active",
      bossRunId,
      participantId,
      role,
      bindingEpoch: 2,
      ...(assignedManagerParticipantId ? { assignedManagerParticipantId } : {}),
      ...(role === "manager" ? { assignedParticipantIds: options.assignedParticipantIds ?? ["worker-participant"] } : {}),
      ...(role === "council" ? { requestingPrincipalId: options.requestingPrincipalId ?? "boss-session" } : {}),
    },
    featureContract: BOSS_RUN_FEATURE_CONTRACT,
    policySemanticsHash: BOSS_POLICY_SEMANTICS_HASH,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
    brokerIdentityVerified: true,
  }, id);
  return {
    id,
    name: id,
    cwd: "/tmp",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    origin: "local",
    boss,
  };
}

function ordinary(id: string): SessionInfo {
  return {
    id,
    name: id,
    cwd: "/tmp",
    model: "test",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
    origin: "local",
  };
}

test("Boss send/ask/reply/discover authorization is run-scoped and assignment-filtered", () => {
  const manager = bossSession("manager", "manager-session", { assignedParticipantIds: ["worker-participant"] });
  const worker = bossSession("worker", "worker-session");
  const boss = bossSession("boss", "boss-session");
  const unassigned = bossSession("worker", "unassigned-session", {
    participantId: "unassigned-participant",
    managerParticipantId: "other-manager",
  });
  const otherRun = bossSession("manager", "other-run-manager", { runId: "run-b", assignedParticipantIds: [] });
  const localA = ordinary("local-a");
  const localB = ordinary("local-b");
  const sessions = [manager, worker, boss, unassigned, otherRun, localA, localB];

  for (const action of ["send", "ask", "reply", "discover"] as const) {
    assert.equal(authorize(sessions, manager.id, action, worker.id).allowed, true, action);
  }
  assert.deepEqual(authorize(sessions, manager.id, "send", unassigned.id), {
    allowed: false,
    code: "POLICY_DENIED",
  });
  assert.deepEqual(authorize(sessions, manager.id, "send", otherRun.id), {
    allowed: false,
    code: "CROSS_RUN_DENIED",
  });
  assert.deepEqual(authorize(sessions, manager.id, "send", localA.id), {
    allowed: false,
    code: "FEATURE_CLASS_DENIED",
  });
  assert.equal(authorize(sessions, localA.id, "send", localB.id).allowed, true);

  const visible = new Set(visibleSessions(sessions, manager.id, VERIFIED_BROKER).map((session) => session.id));
  assert.equal(visible.has(manager.id), true);
  assert.equal(visible.has(worker.id), true);
  assert.equal(visible.has(boss.id), true);
  assert.equal(visible.has(unassigned.id), false);
  assert.equal(visible.has(otherRun.id), false);
  assert.equal(visible.has(localA.id), false);
});

test("typed Boss control requires correlation and the directional Core allowlist", () => {
  const manager = bossSession("manager", "manager-session", { assignedParticipantIds: ["worker-participant"] });
  const worker = bossSession("worker", "worker-session");
  const sessions = [manager, worker];

  assert.equal(authorize(sessions, manager.id, "control", worker.id, {
    controlKind: "assignment_request",
    correlated: true,
  }).allowed, true);
  assert.deepEqual(authorize(sessions, manager.id, "control", worker.id, {
    controlKind: "assignment_request",
    correlated: false,
  }), { allowed: false, code: "CONTROL_REQUIRES_CORRELATION" });
  assert.deepEqual(authorize(sessions, manager.id, "control", worker.id, {
    controlKind: "health",
    correlated: true,
  }), { allowed: false, code: "CONTROL_KIND_DENIED" });
  assert.equal(authorize(sessions, worker.id, "control", manager.id, {
    controlKind: "assignment_response",
    correlated: true,
  }).allowed, true);
  assert.deepEqual(authorizeSessionAction(
    sessions,
    manager.id,
    "send",
    worker.id,
    undefined,
    { brokerIdentityVerified: false },
  ), { allowed: false, code: "FEATURE_ATTESTATION_DENIED" });
});

test("ambiguous participant identities and hostile descriptors fail closed", () => {
  const manager = bossSession("manager", "manager-session", { assignedParticipantIds: ["worker-participant"] });
  const worker = bossSession("worker", "worker-session");
  const duplicateWorker = bossSession("worker", "worker-duplicate", { participantId: "worker-participant" });
  assert.deepEqual(authorize([manager, worker, duplicateWorker], manager.id, "send", worker.id), {
    allowed: false,
    code: "AMBIGUOUS_PARTICIPANT_IDENTITY",
  });

  let invoked = false;
  const hostile = ordinary("hostile") as SessionInfo;
  hostile.boss = Object.defineProperty({}, "binding", {
    enumerable: true,
    get() {
      invoked = true;
      return {};
    },
  }) as SessionInfo["boss"];
  assert.deepEqual(authorize([manager, hostile], manager.id, "send", hostile.id), {
    allowed: false,
    code: "FEATURE_ATTESTATION_DENIED",
  });
  assert.equal(invoked, false);
});
