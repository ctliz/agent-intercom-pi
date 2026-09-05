import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureIntercomRuntimeDir, getAgentDirPath, getIntercomDirPath } from "./broker/paths.ts";
import { writeDurableJson } from "./durable-json.ts";
import { isTmuxDeckScope, isZhLocale, type ParsedJoinArgs, type ScopedWorkspace } from "./workspace-join.ts";

export const NAMED_TEAMS_FILE = "named-teams.json";
export const NAMED_TEAMS_VERSION = 1;
export const NAMED_TEAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export interface NamedTeam {
  name: string;
  scopeId: string;
  managerSessionId: string;
  createdAt: number;
}

export type JoinableCircleKind = "named" | "tmuxdeck";

export interface JoinableCircle {
  name: string;
  kind: JoinableCircleKind;
  scopeId: string;
  managerSessionId?: string;
}

interface NamedTeamsFile {
  version: number;
  teams: NamedTeam[];
}

function teamsFilePath(agentDir?: string): string {
  return join(getIntercomDirPath(agentDir ?? getAgentDirPath()), NAMED_TEAMS_FILE);
}

function genericReadError(zh: boolean): Error {
  return new Error(zh ? "无法读取本地团队列表。" : "Could not read the local named-team list.");
}

function genericWriteError(zh: boolean): Error {
  return new Error(zh ? "无法创建该团队。" : "Could not create that named team.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredTeam(value: unknown): NamedTeam | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.name !== "string" || !NAMED_TEAM_NAME_PATTERN.test(value.name)) return undefined;
  if (typeof value.scopeId !== "string" || !isTmuxDeckScope(value.scopeId)) return undefined;
  if (typeof value.managerSessionId !== "string" || !value.managerSessionId.trim()) return undefined;
  if (value.managerSessionId !== value.managerSessionId.trim() || /[\u0000-\u001f\u007f]/.test(value.managerSessionId)) {
    return undefined;
  }
  if (typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    return undefined;
  }
  return {
    name: value.name,
    scopeId: value.scopeId,
    managerSessionId: value.managerSessionId,
    createdAt: value.createdAt,
  };
}

export function parseTeamName(raw: string, zh: boolean = isZhLocale()): string {
  const name = raw.trim();
  if (!name || name.includes(" ") || !NAMED_TEAM_NAME_PATTERN.test(name)) {
    throw new Error(zh
      ? "用法：/intercom-create <名称>\n团队名需以字母开头，只能包含字母、数字、连字符或下划线（最长 32）。"
      : "Usage: /intercom-create <name>\nTeam names start with a letter and may include letters, numbers, hyphens, or underscores (max 32).");
  }
  return name;
}

export function parseCreateArgs(raw: string, zh: boolean = isZhLocale()): string {
  const args = raw.trim().split(/\s+/).filter(Boolean);
  if (args.length !== 1) {
    throw new Error(zh
      ? "用法：/intercom-create <名称>"
      : "Usage: /intercom-create <name>");
  }
  return parseTeamName(args[0]!, zh);
}

export function generateNamedTeamScope(existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const scopeId = randomBytes(24).toString("hex");
    if (!taken.has(scopeId)) return scopeId;
  }
  throw genericWriteError(isZhLocale());
}

export function listNamedTeams(agentDir?: string): NamedTeam[] {
  const zh = isZhLocale();
  let raw: string;
  try {
    raw = readFileSync(teamsFilePath(agentDir), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw genericReadError(zh);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw genericReadError(zh);
  }
  if (!isPlainObject(parsed) || parsed.version !== NAMED_TEAMS_VERSION || !Array.isArray(parsed.teams)) {
    throw genericReadError(zh);
  }

  const teams: NamedTeam[] = [];
  const names = new Set<string>();
  const scopes = new Set<string>();
  for (const entry of parsed.teams) {
    const team = parseStoredTeam(entry);
    if (!team || names.has(team.name) || scopes.has(team.scopeId)) {
      throw genericReadError(zh);
    }
    names.add(team.name);
    scopes.add(team.scopeId);
    teams.push(team);
  }
  return teams;
}

export function findNamedTeam(name: string, agentDir?: string): NamedTeam | undefined {
  return listNamedTeams(agentDir).find((team) => team.name === name);
}

export function findNamedTeamByScope(scopeId: string, agentDir?: string): NamedTeam | undefined {
  return listNamedTeams(agentDir).find((team) => team.scopeId === scopeId);
}

export function createNamedTeam(input: {
  name: string;
  managerSessionId: string;
  agentDir?: string;
  now?: number;
  generateScope?: () => string;
}): NamedTeam {
  const zh = isZhLocale();
  const name = parseTeamName(input.name, zh);
  const managerSessionId = input.managerSessionId.trim();
  if (!managerSessionId || managerSessionId !== input.managerSessionId || /[\u0000-\u001f\u007f]/.test(managerSessionId)) {
    throw genericWriteError(zh);
  }

  const existing = listNamedTeams(input.agentDir);
  if (existing.some((team) => team.name === name)) {
    throw new Error(zh
      ? `团队 ${name} 已存在。`
      : `A named team called ${name} already exists.`);
  }

  const scopeId = (input.generateScope ?? (() => generateNamedTeamScope(existing.map((team) => team.scopeId))))();
  if (!isTmuxDeckScope(scopeId) || existing.some((team) => team.scopeId === scopeId)) {
    throw genericWriteError(zh);
  }

  const team: NamedTeam = {
    name,
    scopeId,
    managerSessionId,
    createdAt: input.now ?? Date.now(),
  };
  const dir = getIntercomDirPath(input.agentDir ?? getAgentDirPath());
  ensureIntercomRuntimeDir(dir);
  const payload: NamedTeamsFile = { version: NAMED_TEAMS_VERSION, teams: [...existing, team] };
  writeDurableJson(teamsFilePath(input.agentDir), payload);
  return team;
}

export function buildJoinableCircles(input: {
  namedTeams: NamedTeam[];
  workspaces: ScopedWorkspace[];
}): JoinableCircle[] {
  return [
    ...input.namedTeams.map((team) => ({
      name: team.name,
      kind: "named" as const,
      scopeId: team.scopeId,
      managerSessionId: team.managerSessionId,
    })),
    ...input.workspaces.map((workspace) => ({
      name: workspace.sessionName,
      kind: "tmuxdeck" as const,
      scopeId: workspace.scopeId,
    })),
  ];
}

export function resolveJoinCircle(input: {
  parsed: ParsedJoinArgs;
  namedTeams: NamedTeam[];
  workspaces: ScopedWorkspace[];
}): JoinableCircle | undefined {
  const circles = buildJoinableCircles(input);
  if (input.parsed.kind === "list") return undefined;
  if (input.parsed.kind === "index") {
    return input.parsed.index ? circles[input.parsed.index - 1] : undefined;
  }
  if (input.parsed.kind === "workspace" && input.parsed.workspace) {
    return circles.find((circle) => circle.name === input.parsed.workspace);
  }
  if (input.parsed.kind === "scope" && input.parsed.scope) {
    return circles.find((circle) => circle.scopeId === input.parsed.scope);
  }
  return undefined;
}

export function formatJoinableCircleList(input: {
  circles: Array<Pick<JoinableCircle, "name" | "kind">>;
  zh: boolean;
}): string {
  if (input.circles.length === 0) {
    return input.zh
      ? "没有可加入的团队。\n使用 /intercom-create <名称> 创建一个。"
      : "No joinable teams found.\nCreate one with /intercom-create <name>.";
  }
  const header = input.zh ? "可加入的通话团队：" : "Joinable intercom teams:";
  const footer = input.zh ? "请输入编号或精确名称：" : "Select a team by number or exact name:";
  return [
    header,
    ...input.circles.map((circle, index) => {
      const suffix = circle.kind === "tmuxdeck" ? " (TmuxDeck)" : "";
      return `  ${index + 1}) ${circle.name}${suffix}`;
    }),
    footer,
  ].join("\n");
}

export function formatCreateSuccess(input: { team: string; name: string; zh: boolean }): string {
  return input.zh
    ? `已创建团队 ${input.team}，并以管理者身份加入。\n你的显示名：${input.name}`
    : `Created team ${input.team} and joined as manager.\nDisplay name: ${input.name}`;
}

export function formatNamedJoinSuccess(input: { team: string; name: string; zh: boolean }): string {
  return input.zh
    ? `已加入团队 ${input.team}。\n身份：团队成员\n你的显示名：${input.name}`
    : `Joined team ${input.team}.\nRole: teammate\nDisplay name: ${input.name}`;
}
