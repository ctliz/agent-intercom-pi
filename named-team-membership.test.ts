import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { appendNamedTeamMembership, namedTeamMemberIds, requireNamedTeamMembers, resolveNamedMessageTeam, sessionNamedTeams } from "./named-team-membership.ts";
import { createNamedTeam, listNamedTeams } from "./named-teams.ts";

const exec = promisify(execFile);

async function temporary(run: (agentDir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-teams-"));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("task-team joins append, are idempotent, preserve each manager, and persist across reads", async () => {
  await temporary(async (agentDir) => {
    await appendNamedTeamMembership({ name: "launch", selfId: "anonymous", members: ["front", "writer"], work: "Launch a product", create: true, agentDir });
    await appendNamedTeamMembership({ name: "review", selfId: "reviewer", members: ["front"], create: true, agentDir });
    await appendNamedTeamMembership({ name: "launch", selfId: "front", agentDir });
    const teams = sessionNamedTeams("front", agentDir);
    assert.deepEqual(teams.map((team) => team.name), ["launch", "review"]);
    assert.deepEqual(teams.map((team) => team.managerSessionId), ["anonymous", "reviewer"]);
    assert.deepEqual(namedTeamMemberIds(teams[0]!), ["anonymous", "front", "writer"]);
    assert.equal(teams[0]?.work, "Launch a product");
    assert.equal(resolveNamedMessageTeam("front", "writer", undefined, agentDir), "launch");
    await appendNamedTeamMembership({ name: "review", selfId: "reviewer", members: ["writer"], agentDir });
    assert.throws(() => resolveNamedMessageTeam("front", "writer", undefined, agentDir), /Multiple shared teams/);
    assert.equal(resolveNamedMessageTeam("front", "writer", "review", agentDir), "review");
    assert.throws(() => requireNamedTeamMembers("review", "anonymous", "front", agentDir), /Both sessions/);
    assert.equal(resolveNamedMessageTeam("front", "outsider", undefined, agentDir), undefined);
    assert.equal(resolveNamedMessageTeam("outsider", "front", undefined, agentDir), undefined);
    assert.equal(resolveNamedMessageTeam("ungrouped", "outsider", undefined, agentDir), undefined);
    await appendNamedTeamMembership({ name: "unrelated", selfId: "outsider", create: true, agentDir });
    const beforeContact = listNamedTeams(agentDir);
    assert.equal(resolveNamedMessageTeam("front", "outsider", undefined, agentDir), undefined);
    assert.equal(resolveNamedMessageTeam("outsider", "front", undefined, agentDir), undefined);
    assert.throws(() => resolveNamedMessageTeam("front", "outsider", "launch", agentDir), /Both sessions/);
    assert.deepEqual(listNamedTeams(agentDir), beforeContact, "direct contact must not change membership");
  });
});

test("failed membership changes do not create teams or overwrite work or management", async () => {
  await temporary(async (agentDir) => {
    await appendNamedTeamMembership({ name: "launch", selfId: "manager", create: true, agentDir });
    const before = readFileSync(join(agentDir, "intercom", "named-teams.json"), "utf8");
    await assert.rejects(appendNamedTeamMembership({ name: "missing", selfId: "front", agentDir }), /does not exist/);
    await assert.rejects(appendNamedTeamMembership({ name: "launch", selfId: "front", members: ["writer"], agentDir }), /Only the manager/);
    await assert.rejects(appendNamedTeamMembership({ name: "launch", selfId: "manager", work: "Another task", agentDir }), /Work is set/);
    await assert.rejects(appendNamedTeamMembership({ name: "launch", selfId: "front", create: true, agentDir }), /already exists/);
    assert.equal(readFileSync(join(agentDir, "intercom", "named-teams.json"), "utf8"), before);
  });
});

test("legacy named-team records keep their manager and gain explicit membership on join", async () => {
  await temporary(async (agentDir) => {
    const legacy = createNamedTeam({ name: "legacy", managerSessionId: "manager", agentDir });
    assert.deepEqual(namedTeamMemberIds(legacy), ["manager"]);
    await appendNamedTeamMembership({ name: "legacy", selfId: "worker", agentDir });
    assert.deepEqual(listNamedTeams(agentDir)[0]?.memberSessionIds, ["manager", "worker"]);
    const file = join(agentDir, "intercom", "named-teams.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    parsed.teams[0].memberSessionIds = ["worker"];
    writeFileSync(file, JSON.stringify(parsed));
    assert.throws(() => listNamedTeams(agentDir), /Could not read|无法读取/);
  });
});

test("independent Pi processes cannot lose concurrent joins or team creation", async () => {
  await temporary(async (agentDir) => {
    await appendNamedTeamMembership({ name: "shared", selfId: "manager", create: true, agentDir });
    await Promise.all([0, 1, 2, 3].map(async (index) => {
      const code = `import { appendNamedTeamMembership } from './named-team-membership.ts';
await appendNamedTeamMembership(${JSON.stringify({ name: "shared", selfId: `worker-${index}`, agentDir })});
await appendNamedTeamMembership(${JSON.stringify({ name: `task-${index}`, selfId: `worker-${index}`, create: true, agentDir })});`;
      await exec(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], { cwd: process.cwd(), timeout: 15000 });
    }));
    const teams = listNamedTeams(agentDir);
    assert.equal(teams.length, 5);
    assert.deepEqual(new Set(namedTeamMemberIds(teams.find((team) => team.name === "shared")!)), new Set(["manager", "worker-0", "worker-1", "worker-2", "worker-3"]));
  });
});
