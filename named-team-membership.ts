import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureIntercomRuntimeDir, getAgentDirPath, getIntercomDirPath } from "./broker/paths.ts";
import { writeDurableJson } from "./durable-json.ts";
import { generateNamedTeamScope, listNamedTeams, NAMED_TEAMS_FILE, NAMED_TEAMS_VERSION, parseTeamName, type NamedTeam } from "./named-teams.ts";
import type { SessionInfo } from "./types.ts";

export function namedTeamMemberIds(team: NamedTeam): string[] {
  return team.memberSessionIds ?? [team.managerSessionId];
}

export function sessionNamedTeams(sessionId: string, agentDir?: string): NamedTeam[] {
  return listNamedTeams(agentDir).filter((team) => namedTeamMemberIds(team).includes(sessionId));
}

/** Serialize the complete read-modify-write across independently launched Pi processes. */
export async function appendNamedTeamMembership(input: {
  name: string;
  selfId: string;
  members?: string[];
  create?: boolean;
  work?: string;
  agentDir?: string;
}): Promise<NamedTeam> {
  const name = parseTeamName(input.name);
  const memberIds = [...new Set([input.selfId, ...(input.members ?? [])])];
  if (memberIds.some((id) => !id || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id))) {
    throw new Error("Invalid team member session ID");
  }
  if (input.work !== undefined && (!input.work.trim() || input.work.length > 2000)) {
    throw new Error("Work must be a non-empty task description (max 2000 characters)");
  }
  const dir = getIntercomDirPath(input.agentDir ?? getAgentDirPath());
  ensureIntercomRuntimeDir(dir);
  const lock = join(dir, "named-teams.lock");
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Team registry is busy; retry. If a writer crashed, remove the stale named-teams.lock directory after verifying no writer is active.");
      await delay(25);
    }
  }
  try {
    const teams = listNamedTeams(input.agentDir);
    let team = teams.find((entry) => entry.name === name);
    if (input.create) {
      if (team) throw new Error(`A named team called ${name} already exists; join it instead.`);
      team = { name, scopeId: generateNamedTeamScope(teams.map((entry) => entry.scopeId)), managerSessionId: input.selfId, createdAt: Date.now() };
      teams.push(team);
    }
    if (!team) throw new Error(`Team "${name}" does not exist; create it explicitly.`);
    if (memberIds.some((id) => id !== input.selfId) && team.managerSessionId !== input.selfId) {
      throw new Error(`Only the manager of team "${name}" may add other sessions`);
    }
    if (input.work !== undefined && !input.create) {
      throw new Error("Work is set when creating a team; use a new team for a different task");
    }
    const updated: NamedTeam = {
      ...team,
      memberSessionIds: [...new Set([...namedTeamMemberIds(team), ...memberIds])],
      ...(input.work === undefined ? {} : { work: input.work.trim() }),
    };
    writeDurableJson(join(dir, NAMED_TEAMS_FILE), {
      version: NAMED_TEAMS_VERSION,
      teams: teams.map((entry) => entry.name === name ? updated : entry),
    });
    return updated;
  } finally {
    rmSync(lock, { recursive: true });
  }
}

export function requireNamedTeamMembers(name: string, selfId: string, peerId: string, agentDir?: string): NamedTeam {
  const team = listNamedTeams(agentDir).find((entry) => entry.name === name);
  if (!team) throw new Error(`Unknown team "${name}"`);
  const members = namedTeamMemberIds(team);
  if (!members.includes(selfId) || !members.includes(peerId)) {
    throw new Error(`Both sessions must belong to team "${name}" before messaging`);
  }
  return team;
}

export function resolveNamedMessageTeam(selfId: string, peerId: string, requested?: string, agentDir?: string): string | undefined {
  if (requested !== undefined) return requireNamedTeamMembers(requested, selfId, peerId, agentDir).name;
  const mine = sessionNamedTeams(selfId, agentDir);
  const shared = mine.filter((team) => namedTeamMemberIds(team).includes(peerId));
  if (shared.length === 1) return shared[0]!.name;
  if (shared.length > 1) throw new Error("Multiple shared teams; specify `team` for this task");
  // No shared team means an ungrouped contact, even when either session belongs
  // to unrelated teams. Do not silently create a team or add the recipient.
  return undefined;
}

export function namedTeamRoster(team: NamedTeam, selfId: string, sessions: SessionInfo[]) {
  return {
    name: team.name,
    ...(team.work ? { work: team.work } : {}),
    self: { id: selfId, isManager: selfId === team.managerSessionId },
    manager: { target: team.managerSessionId, connected: sessions.some((entry) => entry.id === team.managerSessionId) },
    members: namedTeamMemberIds(team).map((id) => ({
      id,
      target: id,
      name: sessions.find((entry) => entry.id === id)?.name,
      role: id === team.managerSessionId ? "manager" : "member",
      connected: sessions.some((entry) => entry.id === id),
    })),
  };
}

export function formatNamedTeamRoster(team: ReturnType<typeof namedTeamRoster>): string {
  return [
    `Team: ${team.name}`,
    ...(team.work ? [`Work: ${team.work}`] : []),
    `You: ${team.self.id}${team.self.isManager ? " [manager]" : ""}`,
    `Manager: ${team.manager.target}${team.manager.connected ? "" : " [offline]"}`,
    "Members:",
    ...team.members.map((member) => `- ${member.name || member.id} (${member.id}) [${member.role}]${member.connected ? "" : " [offline]"}`),
  ].join("\n");
}
