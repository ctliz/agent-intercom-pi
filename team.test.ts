import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveIntercomPresenceName, resolveIntercomSessionId } from "./index.ts";
import {
  formatIntercomTeam,
  resolveIntercomTeam,
  resolveManagedInboxSession,
  type IntercomTeam,
} from "./team.ts";

const worker = (id: string, runId: string, managerSessionId?: string, state = "running") => ({
  id,
  runId,
  harness: "pi",
  role: "reviewer",
  state,
  owned: true,
  ...(managerSessionId !== undefined ? { managerSessionId } : {}),
  intercomTarget: id,
});

test("intercom team resolves orchestrator current self record and live coworkers after adoption", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "intercom-team-"));
  const storeDir = join(agentDir, "intercom", "orchestrator");
  await mkdir(storeDir, { recursive: true });
  try {
    await writeFile(
      join(storeDir, "workers.json"),
      JSON.stringify({
        version: 1,
        workers: [
          worker("self", "run-self", "manager-a"),
          worker("sibling", "run-sibling", "manager-a"),
          worker("stopped", "run-stopped", "manager-a", "stopped"),
          worker("other", "run-other", "manager-b"),
        ],
      }),
    );
    const first = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "self",
        AGENT_INTERCOM_RUN_ID: "run-self",
        AGENT_INTERCOM_MANAGER_SESSION_ID: "stale-manager",
      },
      sessions: [{ id: "manager-a" }, { id: "sibling" }],
    });
    assert.equal(first.source, "orchestrator");
    assert.deepEqual(first.manager, { target: "manager-a", connected: true });
    assert.deepEqual(first.coworkers.map((entry) => entry.id), ["sibling"]);
    assert.match(formatIntercomTeam(first), /Manager: manager-a \[connected\]/);

    await writeFile(
      join(storeDir, "workers.json"),
      JSON.stringify({
        version: 1,
        workers: [
          worker("self", "run-self", "manager-b"),
          worker("other", "run-other", "manager-b"),
        ],
      }),
    );
    const adopted = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "self",
        AGENT_INTERCOM_RUN_ID: "run-self",
        AGENT_INTERCOM_MANAGER_SESSION_ID: "manager-a",
      },
      sessions: [{ id: "manager-b" }, { id: "other" }],
    });
    assert.equal(adopted.source, "orchestrator");
    assert.deepEqual(adopted.manager, { target: "manager-b", connected: true });
    assert.deepEqual(adopted.coworkers.map((entry) => entry.id), ["other"]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("orchestrator resolution never compares undefined manager IDs and denies malformed workers manager elevation", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "intercom-team-malformed-"));
  const storeDir = join(agentDir, "intercom", "orchestrator");
  await mkdir(storeDir, { recursive: true });
  try {
    await writeFile(
      join(storeDir, "workers.json"),
      JSON.stringify({
        version: 1,
        workers: [
          // Malformed worker with absent managerSessionId
          worker("malformed-worker", "run-malformed", undefined),
          // Another worker with absent managerSessionId
          worker("other-worker", "run-other", undefined),
        ],
      }),
    );

    // Resolving as the malformed worker: must NOT become manager, must NOT collect other-worker
    const malformedTeam = await resolveIntercomTeam({
      selfId: "session-malformed",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "malformed-worker",
        AGENT_INTERCOM_RUN_ID: "run-malformed",
      },
      sessions: [{ id: "session-malformed" }, { id: "session-other" }],
    });

    assert.equal(malformedTeam.source, "orchestrator");
    assert.equal(malformedTeam.self.isManager, false);
    assert.equal(malformedTeam.manager, undefined);
    assert.deepEqual(malformedTeam.coworkers, []);

    // Inbox inspection must fail closed
    assert.throws(
      () => resolveManagedInboxSession({
        team: malformedTeam,
        sessions: [{ id: "session-other", origin: "local" }],
        requestedSession: "session-other",
      }),
      /Only a manager/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("intercom team resolves explicit TmuxDeck manifest for Lead and Workers", async () => {
  const tempBaseDir = mkdtempSync(join(tmpdir(), "tmuxdeck-team-manifest-"));
  const teamsDir = join(tempBaseDir, "teams");
  mkdirSync(teamsDir, { mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(teamsDir, 0o700);
  }

  try {
    const leadId = "tmuxdeck-c8f1e03a-9b4d-4c7e-81f6-a8b0c3d5e7f9";
    const worker1 = "tmuxdeck-9a1b3c5d-7e9f-4a2b-84cc-8f1e03a9b4d2";
    const worker2 = "tmuxdeck-3e5f7a9b-1c2d-4e6f-8a0b-2c4d6e8f0a1b";
    const runId = "team_1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6";

    const manifestPath = join(teamsDir, "team.json");
    const manifestPayload = {
      version: "tmuxdeck.team.v1",
      backend: "tmuxdeck",
      runId,
      leadId,
      members: [
        { sessionId: leadId, role: "lead" },
        { sessionId: worker1, role: "worker" },
        { sessionId: worker2, role: "worker" },
      ],
      createdAt: 1723680000000,
      capabilities: [],
    };
    writeFileSync(manifestPath, JSON.stringify(manifestPayload, null, 2), { mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(manifestPath, 0o600);
    }

    const liveSessions = [
      { id: leadId, name: "Lead" },
      { id: worker1, name: "Worker 1" },
      // worker2 is not currently connected
    ];

    // Lead Perspective
    const leadTeam = await resolveIntercomTeam({
      selfId: leadId,
      env: { AGENT_INTERCOM_TEAM_MANIFEST: manifestPath },
      sessions: liveSessions,
    });
    assert.equal(leadTeam.source, "manifest");
    assert.equal(leadTeam.self.isManager, true);
    assert.equal(leadTeam.self.role, "lead");
    assert.equal(leadTeam.manager?.target, leadId);
    assert.equal(leadTeam.manager?.connected, true);
    assert.equal(leadTeam.coworkers.length, 2);
    assert.equal(leadTeam.coworkers[0]?.id, worker1);
    assert.equal(leadTeam.coworkers[0]?.connected, true);
    assert.equal(leadTeam.coworkers[1]?.id, worker2);
    assert.equal(leadTeam.coworkers[1]?.connected, false);

    // Worker 1 Perspective: coworkers must be other workers (excluding Lead, since Lead is manager)
    const wTeam = await resolveIntercomTeam({
      selfId: worker1,
      env: { AGENT_INTERCOM_TEAM_MANIFEST: manifestPath },
      sessions: liveSessions,
    });
    assert.equal(wTeam.source, "manifest");
    assert.equal(wTeam.self.isManager, false);
    assert.equal(wTeam.self.role, "worker");
    assert.equal(wTeam.manager?.target, leadId);
    assert.equal(wTeam.manager?.connected, true);
    // Coworkers strictly contains worker2, NOT leadId
    assert.equal(wTeam.coworkers.length, 1);
    assert.equal(wTeam.coworkers[0]?.id, worker2);
    assert.equal(wTeam.coworkers[0]?.connected, false);
  } finally {
    rmSync(tempBaseDir, { recursive: true, force: true });
  }
});

test("intercom team throws fail-closed on invalid manifest and does NOT downgrade to live roster", async () => {
  const tempBaseDir = mkdtempSync(join(tmpdir(), "tmuxdeck-invalid-manifest-"));
  const teamsDir = join(tempBaseDir, "teams");
  mkdirSync(teamsDir, { mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(teamsDir, 0o700);
  }

  try {
    const manifestPath = join(teamsDir, "corrupt.json");
    writeFileSync(manifestPath, "{ invalid json", { mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(manifestPath, 0o600);
    }

    // Both manifest and scope env are set: must fail closed on invalid manifest, NOT downgrade
    await assert.rejects(
      () =>
        resolveIntercomTeam({
          selfId: "tmuxdeck-c8f1e03a-9b4d-4c7e-81f6-a8b0c3d5e7f9",
          env: {
            AGENT_INTERCOM_TEAM_MANIFEST: manifestPath,
            AGENT_INTERCOM_SCOPE_ID: "7a4b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
          },
          sessions: [],
        }),
      /ERR_TEAM_MANIFEST_INVALID|ERR_TEAM_MANIFEST_UNAVAILABLE/,
    );
  } finally {
    rmSync(tempBaseDir, { recursive: true, force: true });
  }
});

test("intercom team throws when selfId is not in manifest members", async () => {
  const tempBaseDir = mkdtempSync(join(tmpdir(), "tmuxdeck-manifest-nonmember-"));
  const teamsDir = join(tempBaseDir, "teams");
  mkdirSync(teamsDir, { mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(teamsDir, 0o700);
  }

  try {
    const leadId = "tmuxdeck-c8f1e03a-9b4d-4c7e-81f6-a8b0c3d5e7f9";
    const manifestPath = join(teamsDir, "team.json");
    const manifestPayload = {
      version: "tmuxdeck.team.v1",
      backend: "tmuxdeck",
      runId: "team_1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6",
      leadId,
      members: [{ sessionId: leadId, role: "lead" }],
      createdAt: 1723680000000,
      capabilities: [],
    };
    writeFileSync(manifestPath, JSON.stringify(manifestPayload), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(manifestPath, 0o600);

    await assert.rejects(
      () =>
        resolveIntercomTeam({
          selfId: "tmuxdeck-9a1b3c5d-7e9f-4a2b-84cc-8f1e03a9b4d2",
          env: { AGENT_INTERCOM_TEAM_MANIFEST: manifestPath },
          sessions: [],
        }),
      /ERR_TEAM_MANIFEST_INVALID/,
    );
  } finally {
    rmSync(tempBaseDir, { recursive: true, force: true });
  }
});

test("intercom team fails closed on empty or whitespace AGENT_INTERCOM_TEAM_MANIFEST without live roster downgrade", async () => {
  const liveSessions = [
    { id: "session-self", name: "Self" },
    { id: "session-peer", name: "Peer" },
  ];

  // Empty string manifest env
  await assert.rejects(
    () =>
      resolveIntercomTeam({
        selfId: "session-self",
        env: {
          AGENT_INTERCOM_TEAM_MANIFEST: "",
          AGENT_INTERCOM_SCOPE_ID: "7a4b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
        },
        sessions: liveSessions,
      }),
    /ERR_TEAM_MANIFEST_INVALID/,
  );

  // Whitespace-only manifest env
  await assert.rejects(
    () =>
      resolveIntercomTeam({
        selfId: "session-self",
        env: {
          AGENT_INTERCOM_TEAM_MANIFEST: "   \t\n  ",
          AGENT_INTERCOM_SCOPE_ID: "7a4b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
        },
        sessions: liveSessions,
      }),
    /ERR_TEAM_MANIFEST_INVALID/,
  );
});

test("intercom team resolves live same-scope non-human roster fallback with exact human contract", async () => {
  const selfId = "session-self";
  const managerId = "session-manager";
  const peerId = "session-peer";
  const exactHumanId = "session-human-viewer";
  const capitalHumanId = "session-capital-human";

  const liveSessions = [
    { id: selfId, name: "Self" },
    { id: managerId, name: "Lead" },
    { id: peerId, name: "Peer" },
    { id: exactHumanId, name: "Exact Human", model: "human" },
    { id: capitalHumanId, name: "Capital Human", model: "Human" },
  ];

  // Worker perspective with manager target
  const workerTeam = await resolveIntercomTeam({
    selfId,
    env: {
      AGENT_INTERCOM_SCOPE_ID: "7a4b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
      AGENT_INTERCOM_MANAGER_TARGET: managerId,
    },
    sessions: liveSessions,
  });

  assert.equal(workerTeam.source, "live_roster");
  assert.equal(workerTeam.self.isManager, false);
  assert.equal(workerTeam.manager?.target, managerId);
  assert.equal(workerTeam.manager?.connected, true);
  // Coworkers must exclude self, manager, and exact "human" model, but keep "Human"
  assert.deepEqual(
    workerTeam.coworkers.map((c) => c.id).sort(),
    [peerId, capitalHumanId].sort(),
  );

  // Manager perspective (self is manager)
  const managerTeam = await resolveIntercomTeam({
    selfId: managerId,
    env: {
      AGENT_INTERCOM_SCOPE_ID: "7a4b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f",
    },
    sessions: liveSessions,
  });

  assert.equal(managerTeam.source, "live_roster");
  assert.equal(managerTeam.self.isManager, true);
  assert.equal(managerTeam.manager?.target, managerId);
  // Coworkers include all non-human peers except manager self (includes capital Human)
  const managerCoworkerIds = managerTeam.coworkers.map((c) => c.id).sort();
  assert.deepEqual(managerCoworkerIds, [selfId, peerId, capitalHumanId].sort());
});

test("intercom team resolves standalone when unmanaged and unscoped", async () => {
  const team = await resolveIntercomTeam({
    selfId: "session-standalone",
    env: {},
    sessions: [{ id: "session-other" }],
  });

  assert.equal(team.source, "standalone");
  assert.equal(team.self.isManager, false);
  assert.equal(team.manager, undefined);
  assert.deepEqual(team.coworkers, []);
});

test("resolveManagedInboxSession strictly requires source === orchestrator", () => {
  const orchestratorTeam: IntercomTeam = {
    source: "orchestrator",
    self: { id: "manager-session", isManager: true },
    manager: { target: "manager-session", connected: true },
    coworkers: [{ id: "worker-record-alias", target: "worker-session", connected: true }],
  };
  const sessions = [
    { id: "worker-session", name: "worker-name", origin: "local" as const },
  ];

  // Allowed on orchestrator team
  assert.equal(
    resolveManagedInboxSession({ team: orchestratorTeam, sessions, requestedSession: "worker-session" }).id,
    "worker-session",
  );

  // Denied on manifest team (no inbox inspection in MVP)
  const manifestTeam: IntercomTeam = {
    ...orchestratorTeam,
    source: "manifest",
  };
  assert.throws(
    () => resolveManagedInboxSession({ team: manifestTeam, sessions, requestedSession: "worker-session" }),
    /only available for orchestrator-managed teams/,
  );

  // Denied on live_roster team
  const liveTeam: IntercomTeam = {
    ...orchestratorTeam,
    source: "live_roster",
  };
  assert.throws(
    () => resolveManagedInboxSession({ team: liveTeam, sessions, requestedSession: "worker-session" }),
    /only available for orchestrator-managed teams/,
  );

  // Denied on standalone team
  const standaloneTeam: IntercomTeam = {
    source: "standalone",
    self: { id: "manager-session", isManager: true },
    coworkers: [{ id: "worker-session", target: "worker-session", connected: true }],
  };
  assert.throws(
    () => resolveManagedInboxSession({ team: standaloneTeam, sessions, requestedSession: "worker-session" }),
    /only available for orchestrator-managed teams/,
  );

  // Denied on legacy object where source is undefined
  const untypedTeam = {
    ...orchestratorTeam,
    source: undefined as unknown as "orchestrator",
  };
  assert.throws(
    () => resolveManagedInboxSession({ team: untypedTeam, sessions, requestedSession: "worker-session" }),
    /only available for orchestrator-managed teams/,
  );
});

test("resolveIntercomSessionId honors harness over generic precedence and validates format without echoing secret", () => {
  // 1. Harness ID wins over generic
  assert.equal(
    resolveIntercomSessionId("pi-session-manager-id", {
      PI_INTERCOM_SESSION_ID: "tmuxdeck-11111111-2222-4333-8444-555555555555",
      AGENT_INTERCOM_SESSION_ID: "tmuxdeck-99999999-8888-4777-8666-555555555555",
    }),
    "tmuxdeck-11111111-2222-4333-8444-555555555555",
  );

  // 2. Generic fallback works and validates
  assert.equal(
    resolveIntercomSessionId("pi-session-manager-id", {
      AGENT_INTERCOM_SESSION_ID: "tmuxdeck-99999999-8888-4777-8666-555555555555",
    }),
    "tmuxdeck-99999999-8888-4777-8666-555555555555",
  );

  // 3. No launch identity uses the Pi session-manager fallback
  assert.equal(
    resolveIntercomSessionId("pi-session-manager-id", {}),
    "pi-session-manager-id",
  );

  // 4. Dynamic session switching with fallback ID
  assert.equal(
    resolveIntercomSessionId("pi-session-switch-1", {}),
    "pi-session-switch-1",
  );
  assert.equal(
    resolveIntercomSessionId("pi-session-switch-2", {}),
    "pi-session-switch-2",
  );

  // Fail closed on invalid generic session ID without echoing secret/raw value
  const badId = "invalid session with secret values 123";
  try {
    resolveIntercomSessionId("fallback-id", { AGENT_INTERCOM_SESSION_ID: badId });
    assert.fail("Should have thrown");
  } catch (error: any) {
    assert.match(error.message, /Invalid AGENT_INTERCOM_SESSION_ID/);
    assert.doesNotMatch(error.message, new RegExp(badId));
  }
});

test("resolveIntercomPresenceName resolves session display names correctly", () => {
  // Provided name takes priority
  assert.equal(
    resolveIntercomPresenceName("Explicit Name", "session-12345678", {
      PI_SUBAGENT_INTERCOM_SESSION_NAME: "Subagent Name",
      AGENT_INTERCOM_SESSION_NAME: "Generic Name",
    }),
    "Explicit Name",
  );

  // Subagent name takes priority over generic
  assert.equal(
    resolveIntercomPresenceName(undefined, "session-12345678", {
      PI_SUBAGENT_INTERCOM_SESSION_NAME: "Subagent Name",
      AGENT_INTERCOM_SESSION_NAME: "Generic Name",
    }),
    "Subagent Name",
  );

  // Generic name fallback
  assert.equal(
    resolveIntercomPresenceName(undefined, "session-12345678", {
      AGENT_INTERCOM_SESSION_NAME: "Generic Name",
    }),
    "Generic Name",
  );

  // Default alias fallback
  assert.equal(
    resolveIntercomPresenceName(undefined, "session-abcdef123456", {}),
    "subagent-chat-abcdef12",
  );
});
