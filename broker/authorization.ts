import {
  authorizeFeatureAware,
  type BossAuthorizationContext,
  type FeatureAwareAuthorizationDecision,
  type FeatureAwarePolicyState,
  type OrdinaryFeatureRegistration,
} from "@ctliz/agent-intercom-core/boss";
import type { BossPolicyAction, BossPolicyState } from "@ctliz/agent-intercom-core/boss/policy";
import type { PolicyAction, PolicyPrincipal, PolicyState } from "@ctliz/agent-intercom-core/policy";
import type { SessionInfo } from "../types.ts";
import {
  bossFeatureRegistration,
  parseBossSessionMetadata,
} from "./boss-adapter.ts";

export type BrokerSessionAction = PolicyAction | BossPolicyAction;

export interface SessionAuthorizationView {
  info: SessionInfo;
}

export interface BrokerAuthorizationState {
  /** Set only by protected broker identity verification, never participant metadata. */
  brokerIdentityVerified: boolean;
}

export const DORMANT_BROKER_AUTHORIZATION: Readonly<BrokerAuthorizationState> = Object.freeze({
  brokerIdentityVerified: false,
});

type SessionAuthorizationInput = SessionInfo | SessionAuthorizationView;

function asView(session: SessionAuthorizationInput): SessionAuthorizationView {
  return "info" in session ? session : { info: session };
}

export function policyPrincipalForSession(session: SessionInfo): PolicyPrincipal {
  if (session.boss) {
    throw new Error(`Boss session ${session.id} cannot cross the legacy policy boundary`);
  }
  if (session.origin === "remote") {
    if (!session.parentSessionId || !session.rootSessionId || !session.generation) {
      throw new Error(`Remote session ${session.id} is missing broker-owned policy metadata`);
    }
    return {
      id: session.id,
      kind: "remote",
      state: "active",
      generation: session.generation,
      policy: "remote-tree",
      parentSessionId: session.parentSessionId,
      rootSessionId: session.rootSessionId,
    };
  }
  return {
    id: session.id,
    kind: "local",
    state: "active",
    generation: 1,
    policy: "local-public",
    rootSessionId: session.id,
  };
}

/** Frozen ordinary-only helper retained for remote-access administration. */
export function policyStateForSessions(sessions: Iterable<SessionInfo>): PolicyState {
  const principals: Record<string, PolicyPrincipal> = {};
  for (const session of sessions) principals[session.id] = policyPrincipalForSession(session);
  return { principals };
}

export function featureAwarePolicyStateForSessions(
  sessions: Iterable<SessionAuthorizationInput>,
  authority: BrokerAuthorizationState = DORMANT_BROKER_AUTHORIZATION,
): FeatureAwarePolicyState {
  const legacy: PolicyState = { principals: {} };
  const boss: BossPolicyState = { principals: {} };
  const registrations: FeatureAwarePolicyState["registrations"] = {};

  for (const input of sessions) {
    const { info } = asView(input);
    if (info.boss !== undefined) {
      const metadata = parseBossSessionMetadata(info.boss, info.id);
      registrations[info.id] = bossFeatureRegistration(info.id, metadata, authority.brokerIdentityVerified);
      boss.principals[info.id] = metadata.principal;
      continue;
    }

    const registration: OrdinaryFeatureRegistration = {
      principalId: info.id,
      principalClass: "ordinary",
      state: "active",
    };
    registrations[info.id] = registration;
    legacy.principals[info.id] = policyPrincipalForSession(info);
  }
  return { legacy, boss, registrations };
}

export function authorizeSessionAction(
  sessions: Iterable<SessionAuthorizationInput>,
  actorId: string,
  action: BrokerSessionAction,
  targetId: string,
  bossContext?: BossAuthorizationContext,
  authority: BrokerAuthorizationState = DORMANT_BROKER_AUTHORIZATION,
): FeatureAwareAuthorizationDecision {
  const values = Array.from(sessions, asView);
  const actor = values.find((session) => session.info.id === actorId);
  const target = values.find((session) => session.info.id === targetId);
  const useBossNamespace = actor?.info.boss !== undefined || target?.info.boss !== undefined;
  try {
    return authorizeFeatureAware(featureAwarePolicyStateForSessions(values, authority), {
      actorId,
      targetId,
      action,
      ...(useBossNamespace
        ? (bossContext === undefined ? {} : { bossContext })
        : {
            legacyContext: {
              actorGeneration: actor?.info.generation ?? 1,
              targetGeneration: target?.info.generation ?? 1,
            },
          }),
    });
  } catch {
    return { allowed: false, code: "FEATURE_ATTESTATION_DENIED" };
  }
}

export function visibleSessions(
  sessions: Iterable<SessionAuthorizationInput>,
  actorId: string,
  authority: BrokerAuthorizationState = DORMANT_BROKER_AUTHORIZATION,
): SessionInfo[] {
  const values = Array.from(sessions, asView);
  return values
    .filter((target) => authorizeSessionAction(values, actorId, "discover", target.info.id, undefined, authority).allowed)
    .map((session) => session.info);
}
