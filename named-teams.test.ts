import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildJoinableCircles,
  createNamedTeam,
  findNamedTeam,
  findNamedTeamByScope,
  formatCreateSuccess,
  formatJoinableCircleList,
  formatNamedJoinSuccess,
  generateNamedTeamScope,
  listNamedTeams,
  parseCreateArgs,
  parseTeamName,
  resolveJoinCircle,
} from "./named-teams.ts";

const VALID_SCOPE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function withTempAgentDir(run: (agentDir: string) => void): void {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-named-teams-"));
  try {
    run(agentDir);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("parseTeamName and parseCreateArgs reject numbers, flags, and punctuation", () => {
  assert.equal(parseTeamName("billing"), "billing");
  assert.equal(parseCreateArgs("  Frontend_1  "), "Frontend_1");
  assert.throws(() => parseCreateArgs(""), /Usage|用法/);
  assert.throws(() => parseCreateArgs("one two"), /Usage|用法/);
  assert.throws(() => parseTeamName("1"), /Usage|用法/);
  assert.throws(() => parseTeamName("-billing"), /Usage|用法/);
  assert.throws(() => parseTeamName("has space"), /Usage|用法/);
  assert.throws(() => parseTeamName("bad.name"), /Usage|用法/);
});

test("generateNamedTeamScope is 48 lowercase hex and skips taken values", () => {
  const first = generateNamedTeamScope();
  assert.match(first, /^[0-9a-f]{48}$/);
  const second = generateNamedTeamScope([first]);
  assert.match(second, /^[0-9a-f]{48}$/);
  assert.notEqual(second, first);
});

test("createNamedTeam persists a team and refuses duplicates without leaking the scope", () => {
  withTempAgentDir((agentDir) => {
    const created = createNamedTeam({
      name: "billing",
      managerSessionId: "planner-id",
      agentDir,
      now: 1_700_000_000_000,
      generateScope: () => VALID_SCOPE,
    });
    assert.deepEqual(created, {
      name: "billing",
      scopeId: VALID_SCOPE,
      managerSessionId: "planner-id",
      createdAt: 1_700_000_000_000,
    });
    assert.deepEqual(listNamedTeams(agentDir), [created]);
    assert.deepEqual(findNamedTeam("billing", agentDir), created);
    assert.deepEqual(findNamedTeamByScope(VALID_SCOPE, agentDir), created);
    assert.equal(findNamedTeam("missing", agentDir), undefined);

    const stored = readFileSync(join(agentDir, "intercom", "named-teams.json"), "utf8");
    assert.match(stored, /"name":"billing"/);
    assert.throws(
      () => createNamedTeam({ name: "billing", managerSessionId: "other", agentDir }),
      /already exists|已存在/,
    );

    const listed = formatJoinableCircleList({
      circles: [{ name: "billing", kind: "named" }],
      zh: false,
    });
    assert.match(listed, /Joinable intercom teams/);
    assert.match(listed, /  1\) billing/);
    assert.doesNotMatch(listed, new RegExp(VALID_SCOPE));
    assert.doesNotMatch(formatCreateSuccess({ team: "billing", name: "planner", zh: false }), new RegExp(VALID_SCOPE));
    assert.doesNotMatch(formatNamedJoinSuccess({ team: "billing", name: "worker", zh: false }), new RegExp(VALID_SCOPE));
  });
});

test("joinable circles put named teams first and resolve by name, index, or scope", () => {
  const namedTeams = [{
    name: "billing",
    scopeId: VALID_SCOPE,
    managerSessionId: "planner-id",
    createdAt: 1,
  }];
  const workspaces = [{ sessionName: "frontend", scopeId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }];
  const circles = buildJoinableCircles({ namedTeams, workspaces });
  assert.equal(circles[0]?.kind, "named");
  assert.equal(circles[1]?.kind, "tmuxdeck");
  assert.equal(resolveJoinCircle({ parsed: { kind: "workspace", workspace: "billing" }, namedTeams, workspaces })?.kind, "named");
  assert.equal(resolveJoinCircle({ parsed: { kind: "index", index: 2 }, namedTeams, workspaces })?.name, "frontend");
  assert.equal(resolveJoinCircle({ parsed: { kind: "scope", scope: VALID_SCOPE }, namedTeams, workspaces })?.name, "billing");
  assert.equal(resolveJoinCircle({ parsed: { kind: "list" }, namedTeams, workspaces }), undefined);

  const listed = formatJoinableCircleList({
    circles: circles.map((circle) => ({ name: circle.name, kind: circle.kind })),
    zh: false,
  });
  assert.match(listed, /  1\) billing\n  2\) frontend \(TmuxDeck\)/);
  assert.doesNotMatch(listed, /aaaaaaaa|bbbbbbbb|scopeId|SCOPE_ID/);
});
