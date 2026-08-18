import { execFile } from "node:child_process";
import { INTERCOM_SCOPE_ENV } from "./protocol-v4/contract.ts";

export type JoinMembership = "standalone" | "same-scope" | "tmuxdeck-team" | "orchestrator";

export type ScopedWorkspace = {
  sessionName: string;
  scopeId: string;
};

export type TmuxExec = (
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<{ ok: boolean; stdout: string }>;

export interface ParsedJoinArgs {
  kind: "list" | "workspace" | "index" | "scope";
  workspace?: string;
  index?: number;
  scope?: string;
}

export function isTmuxDeckScope(value: string): boolean {
  if (value.length !== 48) return false;
  for (const char of value) {
    if (!((char >= "0" && char <= "9") || (char >= "a" && char <= "f"))) {
      return false;
    }
  }
  return true;
}

export function isZhLocale(env: NodeJS.ProcessEnv = process.env): boolean {
  const locale = `${env.LC_ALL || env.LC_MESSAGES || env.LANG || ""}`.toLowerCase();
  return locale.startsWith("zh");
}

export function parseJoinArgs(raw: string): ParsedJoinArgs {
  const args = raw.trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) {
    return { kind: "list" };
  }
  if (args[0] === "--scope") {
    if (args.length !== 2 || !args[1]) {
      throw new Error(isZhLocale()
        ? "用法：/intercom-join --scope <48 hex>"
        : "Usage: /intercom-join --scope <48 hex>");
    }
    return { kind: "scope", scope: parseJoinScope(args[1]) };
  }
  if (args.length !== 1 || args[0].startsWith("-")) {
    throw new Error(isZhLocale()
      ? "用法：/intercom-join [工作区名或编号] 或 /intercom-join --scope <48 hex>"
      : "Usage: /intercom-join [workspace or number] or /intercom-join --scope <48 hex>");
  }
  if (/^[1-9]\d*$/.test(args[0])) {
    return { kind: "index", index: Number(args[0]) };
  }
  return { kind: "workspace", workspace: args[0] };
}

export function parseJoinScope(value: string): string {
  if (!isTmuxDeckScope(value)) {
    throw new Error(isZhLocale()
      ? "无法加入该工作区通话圈。"
      : "Could not join that workspace intercom circle.");
  }
  return value;
}

export function classifyMembership(env: NodeJS.ProcessEnv = process.env): JoinMembership {
  if (env.AGENT_INTERCOM_WORKER_ID?.trim() || env.AGENT_INTERCOM_OWNED === "1") {
    return "orchestrator";
  }
  if (env.AGENT_INTERCOM_TEAM_MANIFEST?.trim()) {
    return "tmuxdeck-team";
  }
  if (env.AGENT_INTERCOM_SCOPE_ID?.trim()) {
    return "same-scope";
  }
  return "standalone";
}

export function parseTmuxEnvironmentStdout(stdout: string, varName = INTERCOM_SCOPE_ENV): string | undefined {
  const unsetMarker = `-${varName}`;
  const prefix = `${varName}=`;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === unsetMarker) {
      return undefined;
    }
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      return value || undefined;
    }
  }
  return undefined;
}

export function defaultExecTmux(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile("tmux", args, { encoding: "utf8", timeout: 2000, env }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, stdout: "" });
        return;
      }
      resolve({ ok: true, stdout: stdout ?? "" });
    });
  });
}

export const tmuxRuntime = {
  exec: defaultExecTmux as TmuxExec,
};

export async function listScopedWorkspaces(options: {
  env?: NodeJS.ProcessEnv;
  execTmux?: TmuxExec;
} = {}): Promise<ScopedWorkspace[]> {
  const env = options.env ?? process.env;
  const execTmux = options.execTmux ?? tmuxRuntime.exec;
  const listed = await execTmux(["list-sessions", "-F", "#{session_name}"], env);
  if (!listed.ok) {
    return [];
  }
  const names = listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const workspaces: ScopedWorkspace[] = [];
  for (const sessionName of names) {
    const scopeId = await readSessionScope(sessionName, { env, execTmux });
    if (scopeId) {
      workspaces.push({ sessionName, scopeId });
    }
  }
  return workspaces;
}

export async function readSessionScope(sessionName: string, options: {
  env?: NodeJS.ProcessEnv;
  execTmux?: TmuxExec;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const execTmux = options.execTmux ?? tmuxRuntime.exec;
  const shown = await execTmux(["show-environment", "-t", sessionName, INTERCOM_SCOPE_ENV], env);
  if (!shown.ok) {
    return undefined;
  }
  const raw = parseTmuxEnvironmentStdout(shown.stdout);
  if (!raw || !isTmuxDeckScope(raw)) {
    return undefined;
  }
  return raw;
}

export async function workspaceNameForScope(scope: string, options: {
  env?: NodeJS.ProcessEnv;
  execTmux?: TmuxExec;
} = {}): Promise<string | undefined> {
  for (const workspace of await listScopedWorkspaces(options)) {
    if (workspace.scopeId === scope) {
      return workspace.sessionName;
    }
  }
  return undefined;
}

export async function currentTmuxWorkspace(options: {
  env?: NodeJS.ProcessEnv;
  execTmux?: TmuxExec;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (!env.TMUX?.trim()) {
    return undefined;
  }
  const execTmux = options.execTmux ?? tmuxRuntime.exec;
  const shown = await execTmux(["display-message", "-p", "#S"], env);
  const name = shown.stdout.trim();
  return name || undefined;
}

export function formatJoinableWorkspaceList(input: {
  workspaces: Array<{ sessionName: string }>;
  zh: boolean;
}): string {
  if (input.workspaces.length === 0) {
    return input.zh
      ? "没有找到带通话圈的 TmuxDeck 工作区。"
      : "No scoped TmuxDeck workspaces found.";
  }
  const header = input.zh ? "可加入的 TmuxDeck 工作区：" : "Available TmuxDeck workspaces:";
  const footer = input.zh
    ? "请输入编号或精确工作区名（Ctrl-C 取消）："
    : "Select a workspace by number or exact name (Ctrl-C to cancel):";
  return [
    header,
    ...input.workspaces.map((workspace, index) => `  ${index + 1}) ${workspace.sessionName}`),
    footer,
  ].join("\n");
}

export function formatJoinSuccess(input: { workspace: string; name: string; zh: boolean }): string {
  return input.zh
    ? `已加入工作区 ${input.workspace} 的通话圈。\n身份：外部协作者（不是 Team Worker）\n你的显示名：${input.name}`
    : `Joined the intercom circle for workspace ${input.workspace}.\nRole: external collaborator (not a Team Worker)\nDisplay name: ${input.name}`;
}

export function formatJoinStatus(input: {
  membership: JoinMembership;
  workspace?: string;
  name: string;
  peers: string[];
  zh: boolean;
}): string {
  return input.zh
    ? [
      input.membership,
      `工作区：${input.workspace || "无"}`,
      `显示名：${input.name}`,
      `同圈可见：${input.peers.length > 0 ? input.peers.join(", ") : "无"}`,
    ].join("\n")
    : [
      input.membership,
      `Workspace: ${input.workspace || "none"}`,
      `Display name: ${input.name}`,
      `Visible in circle: ${input.peers.length > 0 ? input.peers.join(", ") : "none"}`,
    ].join("\n");
}

export function rejectManagedJoin(membership: JoinMembership, zh: boolean): string | undefined {
  if (membership === "tmuxdeck-team" || membership === "orchestrator") {
    return zh
      ? "当前会话已是正式成员，不能再加入其他工作区通话圈。"
      : "This session is already a managed member and cannot join another workspace circle.";
  }
  return undefined;
}
