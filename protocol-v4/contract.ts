import {
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
  INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION,
  INTERCOM_PROTOCOL_V4_VECTORS,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_SCOPE_ENV,
  INTERCOM_SCOPE_ID_PATTERN,
  INTERCOM_SCOPE_ID_PATTERN_SOURCE,
  intercomScopeIdFromEnv,
  parseIntercomScopeId,
  sameIntercomScope,
} from "@dataforxyz/agent-intercom-core/protocol-v4";

export const INTERCOM_REGISTRATION_METADATA_ERROR = "Registration metadata is invalid" as const;

export function parseIntercomScopeIdForRegistration(value: unknown): string | undefined {
  try { return parseIntercomScopeId(value, "registrationMetadata"); }
  catch { throw new Error(INTERCOM_REGISTRATION_METADATA_ERROR); }
}

export function intercomScopeIdFromEnvForRegistration(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try { return intercomScopeIdFromEnv(env); }
  catch { throw new Error(INTERCOM_REGISTRATION_METADATA_ERROR); }
}

export {
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
  INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION,
  INTERCOM_PROTOCOL_V4_VECTORS,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_SCOPE_ENV,
  INTERCOM_SCOPE_ID_PATTERN,
  INTERCOM_SCOPE_ID_PATTERN_SOURCE,
  intercomScopeIdFromEnv,
  parseIntercomScopeId,
  sameIntercomScope,
};
