import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMembership,
  formatJoinSuccess,
  formatJoinStatus,
  formatJoinableWorkspaceList,
  isTmuxDeckScope,
  listScopedWorkspaces,
  parseJoinArgs,
  parseJoinScope,
  parseTmuxEnvironmentStdout,
  rejectManagedJoin,
} from "./workspace-join.ts";

const VALID_SCOPE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("parseJoinArgs lists, joins a workspace, or accepts --scope", () => {
  assert.deepEqual(parseJoinArgs(""), { kind: "list" });
  assert.deepEqual(parseJoinArgs("  frontend  "), { kind: "workspace", workspace: "frontend" });
  assert.deepEqual(parseJoinArgs("2"), { kind: "index", index: 2 });
  const scope = parseJoinArgs(`--scope ${VALID_SCOPE}`);
  assert.equal(scope.kind, "scope");
  assert.equal(scope.scope, VALID_SCOPE);
  assert.throws(() => parseJoinArgs("--scope"), /Usage|用法/);
  assert.throws(() => parseJoinArgs("--nope"), /Usage|用法/);
});

test("isTmuxDeckScope is an exact 48-char lowercase hex predicate", () => {
  assert.equal(isTmuxDeckScope(VALID_SCOPE), true);
  assert.equal(isTmuxDeckScope(VALID_SCOPE.toUpperCase()), false);
  assert.equal(isTmuxDeckScope(VALID_SCOPE.slice(0, 47)), false);
  assert.equal(isTmuxDeckScope(`${VALID_SCOPE}a`), false);
  assert.equal(isTmuxDeckScope("Scope_1234567890____"), false);
});

test("parseJoinScope rejects non-TmuxDeck values without leaking the validator", () => {
  assert.equal(parseJoinScope(VALID_SCOPE), VALID_SCOPE);
  try {
    parseJoinScope("short");
    assert.fail("expected invalid scope to throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /Could not join|无法加入/);
    assert.doesNotMatch(message, /AGENT_INTERCOM_SCOPE_ID|scopeId|\^\[A-Za-z|48 hex/);
  }
});

test("parseTmuxEnvironmentStdout reads set, empty, and unset values", () => {
  assert.equal(
    parseTmuxEnvironmentStdout(`AGENT_INTERCOM_SCOPE_ID=${VALID_SCOPE}\n`),
    VALID_SCOPE,
  );
  assert.equal(parseTmuxEnvironmentStdout("AGENT_INTERCOM_SCOPE_ID=\n"), undefined);
  assert.equal(parseTmuxEnvironmentStdout("-AGENT_INTERCOM_SCOPE_ID\n"), undefined);
  assert.equal(parseTmuxEnvironmentStdout("OTHER=1\n"), undefined);
});

test("listScopedWorkspaces keeps exact tmux names and skips invalid or missing scopes", async () => {
  const calls: string[][] = [];
  const workspaces = await listScopedWorkspaces({
    execTmux: async (args) => {
      calls.push(args);
      if (args[0] === "list-sessions") {
        return { ok: true, stdout: "frontend\nplain\nbad-scope\n" };
      }
      if (args[0] === "show-environment" && args[2] === "frontend") {
        return { ok: true, stdout: `AGENT_INTERCOM_SCOPE_ID=${VALID_SCOPE}\n` };
      }
      if (args[0] === "show-environment" && args[2] === "plain") {
        return { ok: true, stdout: "-AGENT_INTERCOM_SCOPE_ID\n" };
      }
      if (args[0] === "show-environment" && args[2] === "bad-scope") {
        return { ok: true, stdout: "AGENT_INTERCOM_SCOPE_ID=Scope_NotTmuxDeckValue\n" };
      }
      return { ok: false, stdout: "" };
    },
  });

  assert.deepEqual(workspaces, [{ sessionName: "frontend", scopeId: VALID_SCOPE }]);
  assert.deepEqual(calls[0], ["list-sessions", "-F", "#{session_name}"]);
  assert.deepEqual(calls[1], ["show-environment", "-t", "frontend", "AGENT_INTERCOM_SCOPE_ID"]);
  assert.deepEqual(calls[2], ["show-environment", "-t", "plain", "AGENT_INTERCOM_SCOPE_ID"]);
  assert.deepEqual(calls[3], ["show-environment", "-t", "bad-scope", "AGENT_INTERCOM_SCOPE_ID"]);
  assert.equal(calls.some((args) => args.includes("-L") || args.includes("-S")), false);
});

test("classifyMembership prefers orchestrator and team over same-scope", () => {
  assert.equal(classifyMembership({}), "standalone");
  assert.equal(classifyMembership({ AGENT_INTERCOM_SCOPE_ID: VALID_SCOPE }), "same-scope");
  assert.equal(classifyMembership({ AGENT_INTERCOM_TEAM_MANIFEST: "/tmp/team.json" }), "tmuxdeck-team");
  assert.equal(classifyMembership({ AGENT_INTERCOM_WORKER_ID: "w1" }), "orchestrator");
  assert.equal(classifyMembership({ AGENT_INTERCOM_OWNED: "1" }), "orchestrator");
});

test("formatJoinableWorkspaceList never prints a raw scope", () => {
  const listed = formatJoinableWorkspaceList({
    workspaces: [{ sessionName: "frontend" }, { sessionName: "backend" }],
    zh: false,
  });
  assert.equal(
    listed,
    "Available TmuxDeck workspaces:\n  1) frontend\n  2) backend\nSelect a workspace by number or exact name (Ctrl-C to cancel):",
  );
  assert.doesNotMatch(listed, new RegExp(`${VALID_SCOPE}|SCOPE_ID|scopeId`));

  const empty = formatJoinableWorkspaceList({ workspaces: [], zh: false });
  assert.equal(empty, "No scoped TmuxDeck workspaces found.");

  const one = formatJoinableWorkspaceList({
    workspaces: [{ sessionName: "frontend" }],
    zh: false,
  });
  assert.match(one, /  1\) frontend/);
  assert.match(one, /Select a workspace by number or exact name/);
});

test("success and status copy stay on the frozen wording", () => {
  assert.equal(
    formatJoinSuccess({ workspace: "frontend", name: "front", zh: true }),
    "已加入工作区 frontend 的通话圈。\n身份：外部协作者（不是 Team Worker）\n你的显示名：front",
  );
  assert.equal(
    formatJoinSuccess({ workspace: "frontend", name: "front", zh: false }),
    "Joined the intercom circle for workspace frontend.\nRole: external collaborator (not a Team Worker)\nDisplay name: front",
  );
  const status = formatJoinStatus({
    membership: "same-scope",
    workspace: "frontend",
    name: "front",
    peers: ["lead", "frontend · Claude 02"],
    zh: false,
  });
  assert.match(status, /^same-scope\n/);
  assert.match(status, /Workspace: frontend/);
  assert.match(status, /Display name: front/);
  assert.match(status, /Visible in circle: lead, frontend · Claude 02/);
  assert.doesNotMatch(status, /已加入 Team|编制|Team Worker enrollment/);
  assert.equal(rejectManagedJoin("tmuxdeck-team", false)?.includes("managed member"), true);
  assert.equal(rejectManagedJoin("same-scope", false), undefined);
});
