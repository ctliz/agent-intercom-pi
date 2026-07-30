import { types as nodeUtilTypes } from "node:util";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_CONTROL_ENVELOPE_VERSION,
  BOSS_POLICY_SEMANTICS_HASH,
  BOSS_RUN_FEATURE,
  BOSS_RUN_FEATURE_CONTRACT,
  BOSS_RUN_FEATURE_SEMANTICS_HASH,
  BOSS_RUN_FEATURE_VERSION,
  BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH,
  BROKER_FEATURE_ATTESTATION_VERSION,
  INTERCOM_BASE_PROTOCOL_VERSION,
  brokerFeatureSetHash,
  evaluateBrokerCompatibility,
  parseBossControlEnvelope,
  parseBossParticipantBinding,
  parseBossParticipantCredentialEnvelope,
  parseBossRunFeatureContract,
  parseBrokerCapabilityAdvertisement,
  type BossControlEnvelope,
  type BossFeatureRegistration,
  type BossParticipantBinding,
  type BossParticipantCredentialEnvelope,
  type BossRunFeatureContract,
  type BrokerCapabilityAdvertisement,
} from "@dataforxyz/agent-intercom-core/boss";
import {
  parseBossPolicyPrincipal,
  type BossAuthorizationContext,
  type BossControlKind,
  type BossPrivatePrincipal,
} from "@dataforxyz/agent-intercom-core/boss/policy";
import {
  assertExactKeys,
  assertRecord,
  canonicalJson,
  ContractValidationError,
  readHexDigest,
} from "@dataforxyz/agent-intercom-core/canonical";

/** Gates which must all be implemented before Pi may advertise boss-run-v1. */
export interface BossReadinessPredicates {
  providerAttested: boolean;
  brokerIdentityVerified: boolean;
  credentialsAuthoritative: boolean;
  authorityTransitionsDurable: boolean;
  participantHealthIntegrated: boolean;
  recipientIngressIntegrated: boolean;
}

const BOSS_READINESS_PREDICATE_KEYS = [
  "providerAttested",
  "brokerIdentityVerified",
  "credentialsAuthoritative",
  "authorityTransitionsDurable",
  "participantHealthIntegrated",
  "recipientIngressIntegrated",
] as const satisfies ReadonlyArray<keyof BossReadinessPredicates>;

function assertNoProxyGraph(value: unknown, path: string): void {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, candidatePath: string): void => {
    if (typeof candidate !== "object" || candidate === null) return;
    if (nodeUtilTypes.isProxy(candidate)) {
      throw new ContractValidationError(candidatePath, "proxies are not supported");
    }
    if (seen.has(candidate)) return;
    seen.add(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor && Object.hasOwn(descriptor, "value")) {
        visit(descriptor.value, `${candidatePath}.${typeof key === "symbol" ? String(key) : key}`);
      }
    }
  };
  visit(value, path);
}

function parseBossReadinessPredicates(value: unknown): BossReadinessPredicates {
  if (
    typeof value !== "object"
    || value === null
    || nodeUtilTypes.isProxy(value)
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ContractValidationError("$.readiness", "must be a non-proxy plain object");
  }
  if (
    Object.getOwnPropertyNames(value).length !== BOSS_READINESS_PREDICATE_KEYS.length
    || Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new ContractValidationError("$.readiness", "must contain exactly the six readiness predicates");
  }
  for (const key of BOSS_READINESS_PREDICATE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "boolean"
    ) {
      throw new ContractValidationError(`$.readiness.${key}`, "must be an own enumerable boolean data property");
    }
  }
  return value as BossReadinessPredicates;
}

export const DORMANT_BOSS_READINESS: Readonly<BossReadinessPredicates> = Object.freeze({
  providerAttested: false,
  brokerIdentityVerified: false,
  credentialsAuthoritative: false,
  authorityTransitionsDurable: false,
  participantHealthIntegrated: false,
  recipientIngressIntegrated: false,
});

const COMPLETE_BOSS_READINESS: Readonly<BossReadinessPredicates> = Object.freeze({
  providerAttested: true,
  brokerIdentityVerified: true,
  credentialsAuthoritative: true,
  authorityTransitionsDurable: true,
  participantHealthIntegrated: true,
  recipientIngressIntegrated: true,
});

export function missingBossReadinessPredicates(readiness: BossReadinessPredicates): Array<keyof BossReadinessPredicates> {
  const parsed = parseBossReadinessPredicates(readiness);
  return BOSS_READINESS_PREDICATE_KEYS.filter((predicate) => parsed[predicate] !== true);
}

export function isBossReady(readiness: BossReadinessPredicates): boolean {
  return missingBossReadinessPredicates(readiness).length === 0;
}

/** Untrusted client request. A client never gets to assert its own binding. */
export interface BossParticipantRegistrationMetadata {
  featureContract: BossRunFeatureContract;
  capabilityDigest: string;
  credential: BossParticipantCredentialEnvelope;
}

/** Broker-owned metadata returned only after protected credential binding. */
export interface BossSessionMetadata {
  binding: BossParticipantBinding;
  principal: BossPrivatePrincipal;
  featureContract: BossRunFeatureContract;
  policySemanticsHash: string;
  capabilityDigest: string;
  brokerIdentityVerified: true;
}

/** Exact, descriptor-safe projection of an optional Boss registration request. */
export function parseBossParticipantRegistrationMetadata(value: unknown): BossParticipantRegistrationMetadata {
  assertNoProxyGraph(value, "$.boss");
  assertRecord(value, "$.boss");
  assertExactKeys(value, ["featureContract", "capabilityDigest", "credential"], [], "$.boss");
  const featureContract = parseBossRunFeatureContract(Object.getOwnPropertyDescriptor(value, "featureContract")!.value);
  const capabilityDigest = readHexDigest(
    Object.getOwnPropertyDescriptor(value, "capabilityDigest")!.value,
    "$.boss.capabilityDigest",
  );
  const credential = parseBossParticipantCredentialEnvelope(
    Object.getOwnPropertyDescriptor(value, "credential")!.value,
  );
  if (
    canonicalJson(featureContract) !== canonicalJson(BOSS_RUN_FEATURE_CONTRACT)
    || capabilityDigest !== BOSS_CAPABILITY_FEATURE_DIGEST
    || credential.namespace !== BOSS_RUN_FEATURE
  ) {
    throw new ContractValidationError("$.boss", "must exactly request boss-run-v1 over base protocol v3");
  }
  return { featureContract, capabilityDigest, credential };
}

/** Exact, descriptor-safe parser for broker-owned live-session metadata. */
export function parseBossSessionMetadata(value: unknown, expectedSessionId?: string): BossSessionMetadata {
  assertNoProxyGraph(value, "$.boss");
  assertRecord(value, "$.boss");
  assertExactKeys(value, [
    "binding",
    "principal",
    "featureContract",
    "policySemanticsHash",
    "capabilityDigest",
    "brokerIdentityVerified",
  ], [], "$.boss");
  const binding = parseBossParticipantBinding(Object.getOwnPropertyDescriptor(value, "binding")!.value);
  const parsedPrincipal = parseBossPolicyPrincipal(Object.getOwnPropertyDescriptor(value, "principal")!.value);
  if (parsedPrincipal.principalClass !== "boss-private") {
    throw new ContractValidationError("$.boss.principal", "must be boss-private");
  }
  const principal: BossPrivatePrincipal = parsedPrincipal;
  const featureContract = parseBossRunFeatureContract(Object.getOwnPropertyDescriptor(value, "featureContract")!.value);
  const policySemanticsHash = readHexDigest(
    Object.getOwnPropertyDescriptor(value, "policySemanticsHash")!.value,
    "$.boss.policySemanticsHash",
  );
  const capabilityDigest = readHexDigest(
    Object.getOwnPropertyDescriptor(value, "capabilityDigest")!.value,
    "$.boss.capabilityDigest",
  );
  if (Object.getOwnPropertyDescriptor(value, "brokerIdentityVerified")!.value !== true) {
    throw new ContractValidationError("$.boss.brokerIdentityVerified", "must be true");
  }
  if (expectedSessionId !== undefined && binding.sessionId !== expectedSessionId) {
    throw new ContractValidationError("$.boss.binding.sessionId", "must match the broker session ID");
  }
  if (
    binding.state !== "active"
    || principal.state !== "active"
    || binding.sessionId !== principal.principalId
    || binding.bossRunId !== principal.bossRunId
    || binding.participantId !== principal.participantId
    || binding.role !== principal.role
    || binding.bindingEpoch !== principal.bindingEpoch
    || binding.assignedManagerParticipantId !== principal.assignedManagerParticipantId
    || canonicalJson(featureContract) !== canonicalJson(BOSS_RUN_FEATURE_CONTRACT)
    || policySemanticsHash !== BOSS_POLICY_SEMANTICS_HASH
    || capabilityDigest !== BOSS_CAPABILITY_FEATURE_DIGEST
  ) throw new ContractValidationError("$.boss", "does not describe one active, canonically attested participant");
  return {
    binding,
    principal,
    featureContract,
    policySemanticsHash,
    capabilityDigest,
    brokerIdentityVerified: true,
  };
}

export function brokerCapabilityAdvertisement(
  readiness: BossReadinessPredicates = DORMANT_BOSS_READINESS,
): BrokerCapabilityAdvertisement {
  if (!isBossReady(readiness)) {
    return parseBrokerCapabilityAdvertisement({
      baseProtocolVersion: INTERCOM_BASE_PROTOCOL_VERSION,
      features: [],
    });
  }
  const features = [{
    version: BROKER_FEATURE_ATTESTATION_VERSION,
    feature: BOSS_RUN_FEATURE,
    featureVersion: BOSS_RUN_FEATURE_VERSION,
    semanticsHash: BOSS_RUN_FEATURE_SEMANTICS_HASH,
    controlEnvelopeVersion: BOSS_CONTROL_ENVELOPE_VERSION,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
  }];
  return parseBrokerCapabilityAdvertisement({
    baseProtocolVersion: INTERCOM_BASE_PROTOCOL_VERSION,
    features,
    protocolFeatureContractHash: BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH,
    featureSetHash: brokerFeatureSetHash(features),
    controlEnvelopeVersion: BOSS_CONTROL_ENVELOPE_VERSION,
    capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
  });
}

export type BossNegotiationDecision =
  | { accepted: true; featureContract: BossRunFeatureContract }
  | { accepted: false; code: "BOSS_FEATURE_NOT_ADVERTISED" | "BOSS_FEATURE_DIVERGENCE" };

/** Exact boss-run-v1/base-protocol-3 negotiation; no legacy downgrade exists. */
export function negotiateBossRegistration(
  metadataValue: unknown,
  advertisementValue: unknown,
): BossNegotiationDecision {
  let metadata: BossParticipantRegistrationMetadata;
  let advertisement: BrokerCapabilityAdvertisement;
  try {
    metadata = parseBossParticipantRegistrationMetadata(metadataValue);
    assertNoProxyGraph(advertisementValue, "$.capabilities");
    advertisement = parseBrokerCapabilityAdvertisement(advertisementValue);
  } catch {
    return { accepted: false, code: "BOSS_FEATURE_DIVERGENCE" };
  }
  const ordinaryCompatibility = evaluateBrokerCompatibility({
    clientKind: "ordinary",
    supportedBaseProtocolVersions: [INTERCOM_BASE_PROTOCOL_VERSION],
  }, advertisement);
  if (!ordinaryCompatibility.compatible || ordinaryCompatibility.mode !== "ordinary") {
    return { accepted: false, code: "BOSS_FEATURE_DIVERGENCE" };
  }
  const feature = advertisement.features.find((entry) => entry.feature === BOSS_RUN_FEATURE);
  if (!feature) return { accepted: false, code: "BOSS_FEATURE_NOT_ADVERTISED" };
  if (
    canonicalJson(advertisement) !== canonicalJson(brokerCapabilityAdvertisement(COMPLETE_BOSS_READINESS))
    || canonicalJson(metadata.featureContract) !== canonicalJson(BOSS_RUN_FEATURE_CONTRACT)
    || metadata.capabilityDigest !== BOSS_CAPABILITY_FEATURE_DIGEST
  ) return { accepted: false, code: "BOSS_FEATURE_DIVERGENCE" };
  return { accepted: true, featureContract: metadata.featureContract };
}

export function bossFeatureRegistration(
  principalId: string,
  metadata: BossSessionMetadata,
  brokerIdentityVerified: boolean,
): BossFeatureRegistration {
  const parsed = parseBossSessionMetadata(metadata, principalId);
  return {
    principalId,
    principalClass: "boss-bound",
    state: parsed.binding.state,
    bossRunId: parsed.binding.bossRunId,
    participantId: parsed.binding.participantId,
    bindingEpoch: parsed.binding.bindingEpoch,
    featureContract: parsed.featureContract,
    policySemanticsHash: parsed.policySemanticsHash,
    capabilityDigest: parsed.capabilityDigest,
    brokerIdentityVerified,
  };
}

const BOSS_CONTROL_KIND_BY_TYPE = {
  "boss.assignment.created": "assignment_request",
  "boss.assignment.accepted": "assignment_response",
  "boss.assignment.checkpoint": "assignment_response",
  "boss.assignment.submitted": "assignment_response",
  "boss.assignment.rejected": "assignment_response",
  "boss.assignment.cancelled": "lifecycle",
  "boss.staffing.requested": "staffing",
  "boss.staffing.resolved": "staffing",
  "boss.review.requested": "review_request",
  "boss.review.submitted": "review_result",
  "boss.council.requested": "review_request",
  "boss.council.submitted": "review_result",
  "boss.proof.submitted": "proof",
  "boss.worker.health": "health",
  "boss.worker.blocked": "health",
  "boss.worker.failed": "health",
  "boss.worker.notice": "lifecycle",
  "boss.worker.notice_delivery_failed": "lifecycle",
  "boss.decision.required": "decision",
} as const satisfies Readonly<Record<BossControlEnvelope["type"], BossControlKind>>;

export function bossControlKind(control: BossControlEnvelope): BossControlKind {
  return BOSS_CONTROL_KIND_BY_TYPE[control.type];
}

export function parseBossControl(value: unknown): BossControlEnvelope | null {
  try {
    assertNoProxyGraph(value, "$.control");
    return parseBossControlEnvelope(value);
  } catch {
    return null;
  }
}

export interface CorrelatedBossControl {
  envelope: BossControlEnvelope;
  context: BossAuthorizationContext;
}

export function correlateBossControl(
  metadataValue: unknown,
  envelopeValue: unknown,
  transportMessageId: string,
): CorrelatedBossControl | null {
  try {
    const metadata = parseBossSessionMetadata(metadataValue);
    assertNoProxyGraph(envelopeValue, "$.control");
    const envelope = parseBossControlEnvelope(envelopeValue);
    if (
      envelope.messageId !== transportMessageId
      || envelope.bossRunId !== metadata.binding.bossRunId
      || envelope.participantId !== metadata.binding.participantId
      || envelope.bindingEpoch !== metadata.binding.bindingEpoch
    ) return null;
    return {
      envelope,
      context: {
        actorBindingEpoch: metadata.binding.bindingEpoch,
        controlKind: bossControlKind(envelope),
        // Transport/envelope agreement proves identity consistency only. Pi
        // has no assignment/review/lifecycle evidence authority, so it must
        // never manufacture authoritative correlation from these fields.
        correlated: false,
      },
    };
  } catch {
    return null;
  }
}
