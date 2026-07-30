import { types as nodeUtilTypes } from "node:util";
import type { SessionRegistration } from "../types.ts";
import { parseBossParticipantRegistrationMetadata } from "./boss-adapter.ts";

const REQUIRED_SESSION_KEYS = ["cwd", "model", "pid", "startedAt", "lastActivity"] as const;
const OPTIONAL_SESSION_KEYS = ["name", "status", "runtimeInstanceId", "boss"] as const;

const MAX_SESSION_NAME_LENGTH = 256;
const MAX_SESSION_CWD_LENGTH = 4096;
const MAX_SESSION_MODEL_LENGTH = 512;
const MAX_SESSION_STATUS_LENGTH = 512;
const MAX_RUNTIME_INSTANCE_ID_LENGTH = 256;

/**
 * Reject every proxy in an authoritative graph before reflecting on that
 * proxy. Descriptor traversal deliberately never invokes getters.
 */
export function assertNoProxyGraph(value: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null) return;
    if (nodeUtilTypes.isProxy(candidate)) throw new Error("Proxies are not supported");
    if (seen.has(candidate)) return;
    seen.add(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor && Object.hasOwn(descriptor, "value")) visit(descriptor.value);
    }
  };
  visit(value);
}

function isExactPlainDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): value is Record<string, unknown> {
  assertNoProxyGraph(value);
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;

  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return false;

  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) return false;
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false;
  }
  return true;
}

function dataValue(record: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

/** Exact ordinary/Boss session-registration discriminant. */
export function parseSessionRegistration(value: unknown): SessionRegistration | null {
  try {
    if (!isExactPlainDataRecord(value, REQUIRED_SESSION_KEYS, OPTIONAL_SESSION_KEYS)) return null;

    const cwd = dataValue(value, "cwd");
    const model = dataValue(value, "model");
    const pid = dataValue(value, "pid");
    const startedAt = dataValue(value, "startedAt");
    const lastActivity = dataValue(value, "lastActivity");
    if (
      typeof cwd !== "string"
      || cwd.length === 0
      || cwd.length > MAX_SESSION_CWD_LENGTH
      || typeof model !== "string"
      || model.length === 0
      || model.length > MAX_SESSION_MODEL_LENGTH
      || typeof pid !== "number"
      || !Number.isFinite(pid)
      || typeof startedAt !== "number"
      || !Number.isFinite(startedAt)
      || typeof lastActivity !== "number"
      || !Number.isFinite(lastActivity)
    ) return null;

    const name = dataValue(value, "name");
    if (name !== undefined && (typeof name !== "string" || name.length > MAX_SESSION_NAME_LENGTH)) return null;
    const status = dataValue(value, "status");
    if (status !== undefined && (typeof status !== "string" || status.length > MAX_SESSION_STATUS_LENGTH)) return null;
    const runtimeInstanceId = dataValue(value, "runtimeInstanceId");
    if (
      runtimeInstanceId !== undefined
      && (
        typeof runtimeInstanceId !== "string"
        || runtimeInstanceId.length === 0
        || runtimeInstanceId.length > MAX_RUNTIME_INSTANCE_ID_LENGTH
      )
    ) return null;

    if (Object.hasOwn(value, "boss")) {
      const boss = dataValue(value, "boss");
      if (boss === undefined) return null;
      parseBossParticipantRegistrationMetadata(boss);
    }
    return value as SessionRegistration;
  } catch {
    return null;
  }
}

/** Exact outer client register frame; remote-access fields remain optional by transport. */
export function isExactClientRegistrationRequest(value: unknown): value is Record<string, unknown> & {
  type: "register";
  protocol: string;
  version: number;
  session: SessionRegistration;
} {
  try {
    if (!isExactPlainDataRecord(
      value,
      ["type", "protocol", "version", "session"],
      ["sessionId", "stateId", "access"],
    )) return false;
    if (dataValue(value, "type") !== "register") return false;
    return parseSessionRegistration(dataValue(value, "session")) !== null;
  } catch {
    return false;
  }
}

/** Exact outer registered frame for the one mode requested by this client. */
export function isExactRegisteredFrame(
  value: unknown,
  mode: "ordinary" | "remote" | "boss",
): value is Record<string, unknown> {
  try {
    const modeKeys = mode === "remote"
      ? ["remoteAccess", "access"]
      : mode === "boss"
        ? ["capabilities", "boss"]
        : [];
    if (!isExactPlainDataRecord(
      value,
      ["type", "sessionId", "protocol", "version", ...modeKeys],
      [],
    )) return false;
    return dataValue(value, "type") === "registered";
  } catch {
    return false;
  }
}

/** Reads a frame discriminant without invoking accessors or inherited state. */
export function readExactFrameType(value: unknown): string | null {
  if (typeof value !== "object" || value === null || nodeUtilTypes.isProxy(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  return descriptor?.enumerable && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}
