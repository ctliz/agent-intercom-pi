import { types as nodeUtilTypes } from "node:util";
import { BROKER_PROTECTED_PROVIDER_ROOT } from "@dataforxyz/agent-intercom-core/boss";

export const PI_BOSS_PROTECTED_PROVIDER_ID = "pi" as const;
export const PI_BOSS_PROTECTED_PROVIDER_PACKAGE = "@dataforxyz/agent-intercom-pi" as const;
export const PI_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH =
  `${BROKER_PROTECTED_PROVIDER_ROOT}${PI_BOSS_PROTECTED_PROVIDER_ID}/provider.mjs` as const;
export const BOSS_PROTECTED_SERVICE_UNAVAILABLE = "BOSS_PROTECTED_SERVICE_UNAVAILABLE" as const;

const PI_BOSS_PROTECTED_PROVIDER_MODE = "0555" as const;
const CANONICAL_SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CANDIDATE_KEYS = [
  "adapterId",
  "providerPackage",
  "providerVersion",
  "providerDigest",
  "artifactPath",
  "artifactOwnerUid",
  "artifactOwnerGid",
  "artifactMode",
] as const;

export interface PiBossProtectedProviderArtifactCandidate {
  adapterId: typeof PI_BOSS_PROTECTED_PROVIDER_ID;
  providerPackage: typeof PI_BOSS_PROTECTED_PROVIDER_PACKAGE;
  providerVersion: string;
  providerDigest: string;
  artifactPath: typeof PI_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH;
  artifactOwnerUid: 0;
  artifactOwnerGid: 0;
  artifactMode: typeof PI_BOSS_PROTECTED_PROVIDER_MODE;
}

export type PiBossProtectedServiceErrorCode =
  | "INVALID_PI_PROTECTED_PROVIDER_CANDIDATE"
  | typeof BOSS_PROTECTED_SERVICE_UNAVAILABLE;

export class PiBossProtectedServiceError extends Error {
  readonly code: PiBossProtectedServiceErrorCode;
  readonly path: string;

  constructor(code: PiBossProtectedServiceErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PiBossProtectedServiceError";
    this.code = code;
    this.path = path;
  }
}

function invalid(path: string, message: string): never {
  throw new PiBossProtectedServiceError("INVALID_PI_PROTECTED_PROVIDER_CANDIDATE", path, message);
}

function assertExactOwnDataCandidate(value: unknown): asserts value is Record<string, unknown> {
  const path = "$candidate";
  if (
    typeof value !== "object"
    || value === null
    || nodeUtilTypes.isProxy(value)
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(path, "must be a non-proxy plain data object");
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== CANDIDATE_KEYS.length
    || keys.some((key) => typeof key !== "string" || !CANDIDATE_KEYS.includes(key as typeof CANDIDATE_KEYS[number]))
  ) {
    invalid(path, "must contain exactly the canonical unsigned Pi provider candidate fields");
  }

  for (const key of CANDIDATE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) {
      invalid(`${path}.${key}`, "must be an own enumerable data property");
    }
  }
}

function ownValue(value: Record<string, unknown>, key: typeof CANDIDATE_KEYS[number]): unknown {
  return Object.getOwnPropertyDescriptor(value, key)!.value;
}

function readProviderVersion(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 128
    || !CANONICAL_SEMANTIC_VERSION.test(value)
  ) {
    invalid("$candidate.providerVersion", "must be a canonical semantic version");
  }
  return value;
}

function readProviderDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    invalid("$candidate.providerDigest", "must be a lowercase SHA-256 digest");
  }
  return value;
}

/**
 * Normalize an unsigned release candidate for the packaged Pi provider.
 * This parser cannot verify installation, signatures, service identities, or
 * authority. Its frozen result remains explicitly non-authoritative.
 */
export function parsePiBossProtectedProviderArtifactCandidate(
  value: unknown,
): Readonly<PiBossProtectedProviderArtifactCandidate> {
  assertExactOwnDataCandidate(value);

  if (ownValue(value, "adapterId") !== PI_BOSS_PROTECTED_PROVIDER_ID) {
    invalid("$candidate.adapterId", "must identify the Pi provider");
  }
  if (ownValue(value, "providerPackage") !== PI_BOSS_PROTECTED_PROVIDER_PACKAGE) {
    invalid("$candidate.providerPackage", "must identify the canonical Pi package");
  }
  if (ownValue(value, "artifactPath") !== PI_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH) {
    invalid("$candidate.artifactPath", "must equal the canonical protected Pi provider path");
  }
  if (ownValue(value, "artifactOwnerUid") !== 0 || ownValue(value, "artifactOwnerGid") !== 0) {
    invalid("$candidate.artifactOwnerUid", "must describe a root:root artifact");
  }
  if (ownValue(value, "artifactMode") !== PI_BOSS_PROTECTED_PROVIDER_MODE) {
    invalid("$candidate.artifactMode", "must be read/execute-only mode 0555");
  }

  return Object.freeze({
    adapterId: PI_BOSS_PROTECTED_PROVIDER_ID,
    providerPackage: PI_BOSS_PROTECTED_PROVIDER_PACKAGE,
    providerVersion: readProviderVersion(ownValue(value, "providerVersion")),
    providerDigest: readProviderDigest(ownValue(value, "providerDigest")),
    artifactPath: PI_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH,
    artifactOwnerUid: 0,
    artifactOwnerGid: 0,
    artifactMode: PI_BOSS_PROTECTED_PROVIDER_MODE,
  });
}

/**
 * Production ensure is intentionally unavailable until a protected
 * provisioner supplies release and service identity facts outside caller data.
 * The request is never inspected while that provisioner is absent.
 */
export function ensurePiBossProtectedService(_request: unknown): never {
  throw new PiBossProtectedServiceError(
    BOSS_PROTECTED_SERVICE_UNAVAILABLE,
    "$provisioner",
    "the protected Pi broker service provisioner is not installed",
  );
}
