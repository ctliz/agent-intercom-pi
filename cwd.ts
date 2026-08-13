import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, win32 } from "node:path";

const normalizeCache = new Map<string, string>();
const WORKSPACE_CACHE_TTL_MS = 1000;
const workspaceCache = new Map<string, { value: string; expiresAt: number }>();

export function normalizeCwd(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const key = `${platform}\0${cwd}`;
  const cached = normalizeCache.get(key);
  if (cached !== undefined) return cached;
  const resolved = platform === "win32" ? win32.resolve(cwd) : resolve(cwd);
  let normalized: string;
  try {
    normalized = realpathSync(resolved);
  } catch {
    normalized = resolved;
  }
  if (platform === "win32") normalized = normalized.toLowerCase();
  normalizeCache.set(key, normalized);
  return normalized;
}

export function sameCwd(a: string, b: string): boolean {
  return normalizeCwd(a) === normalizeCwd(b);
}

/** Best-effort discovery scope, not a broker security boundary. */
export function workspaceKey(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = normalizeCwd(cwd);
  const cacheKey = `${env.PATH ?? ""}\0${normalized}`;
  const cached = workspaceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const result = spawnSync("git", ["-C", normalized, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const root = result.status === 0 && stdout ? normalizeCwd(stdout) : normalized;
  workspaceCache.set(cacheKey, { value: root, expiresAt: Date.now() + WORKSPACE_CACHE_TTL_MS });
  return root;
}

export function sameWorkspace(a: string, b: string): boolean {
  return workspaceKey(a) === workspaceKey(b);
}
