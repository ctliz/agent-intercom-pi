import { createHash } from "node:crypto";
import { getAskTimeoutMs } from "./config.ts";
import type { Message, SessionInfo } from "./types.ts";

export interface IntercomContext {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
  deferredAt?: number;
}

export type ReplyWhich = "oldest" | "latest";

/** Stable, receiver-local selector that does not expose the wire message ID. */
export function pendingAskId(fromSessionId: string, messageId: string): string {
  const digest = createHash("sha256")
    .update(fromSessionId)
    .update("\0")
    .update(messageId)
    .digest("base64url");
  return `ask-${digest}`;
}

export function replyContextId(fromSessionId: string, messageId: string): string {
  return pendingAskId(fromSessionId, messageId).replace(/^ask-/, "ctx-");
}

function matchesPendingSender(context: IntercomContext, to: string): boolean {
  if (context.from.id === to) {
    return true;
  }

  return context.from.name?.toLowerCase() === to.toLowerCase();
}

function contextKey(fromSessionId: string, messageId: string): string {
  return `${fromSessionId}\u0000${messageId}`;
}

function selectByAge(contexts: IntercomContext[], which: ReplyWhich): IntercomContext {
  const sorted = [...contexts].sort((a, b) => a.receivedAt - b.receivedAt);
  return which === "oldest" ? sorted[0]! : sorted[sorted.length - 1]!;
}

function distinctSenders(contexts: IntercomContext[]): number {
  return new Set(contexts.map((context) => context.from.id)).size;
}

export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly pendingTurnContexts: IntercomContext[][] = [];
  private currentTurnContexts: IntercomContext[] = [];

  constructor(private readonly askTimeoutMs = getAskTimeoutMs()) {}

  recordIncomingMessage(from: SessionInfo, message: Message, receivedAt = Date.now()): IntercomContext {
    const key = contextKey(from.id, message.id);
    const existing = this.pendingAsks.get(key);
    const context = {
      from,
      message,
      receivedAt,
      ...(existing?.deferredAt === undefined ? {} : { deferredAt: existing.deferredAt }),
    };
    if (message.expectsReply) {
      this.pendingAsks.set(key, context);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    this.queueTurnContexts([context]);
  }

  queueTurnContexts(contexts: readonly IntercomContext[]): void {
    if (contexts.length > 0) {
      this.pendingTurnContexts.push([...contexts]);
    }
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    if (this.currentTurnContexts.length === 0) {
      this.currentTurnContexts = this.pendingTurnContexts.shift() ?? [];
    }
  }

  endTurn(): void {
    this.currentTurnContexts = [];
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContexts = [];
  }

  resolveReplyTarget(options: { to?: string; replyTo?: string; askId?: string; which?: ReplyWhich; team?: string; contextId?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);
    const checkTeam = (context: IntercomContext): IntercomContext => {
      if (options.team !== undefined && context.message.content.team !== options.team) {
        throw new Error("Reply team must match the original message; it cannot be changed");
      }
      return context;
    };
    if (options.contextId) {
      const match = [...this.currentTurnContexts, ...this.pendingAsks.values()].find((context) =>
        replyContextId(context.from.id, context.message.id) === options.contextId
      );
      if (!match) throw new Error(`No active message with context ID "${options.contextId}"`);
      if (options.to && !matchesPendingSender(match, options.to)) throw new Error("Reply context is not from the selected sender");
      if (options.askId && pendingAskId(match.from.id, match.message.id) !== options.askId) throw new Error("Reply selectors refer to different messages");
      return checkTeam(match);
    }

    if (options.askId) {
      const match = Array.from(this.pendingAsks.values()).find((context) =>
        pendingAskId(context.from.id, context.message.id) === options.askId
      );
      if (!match) {
        throw new Error(`No pending ask with ask ID "${options.askId}"`);
      }
      if (options.to && !matchesPendingSender(match, options.to)) {
        throw new Error(`Pending ask "${options.askId}" is not from "${options.to}"`);
      }
      return checkTeam(match);
    }

    if (options.replyTo) {
      const candidates = Array.from(this.pendingAsks.values()).filter((context) => context.message.id === options.replyTo);
      if (candidates.length === 0) {
        throw new Error(`No pending ask with message ID "${options.replyTo}"`);
      }
      const matches = options.to ? candidates.filter((context) => matchesPendingSender(context, options.to!)) : candidates;
      if (matches.length === 0) {
        throw new Error(`Pending ask "${options.replyTo}" is not from "${options.to}"`);
      }
      if (matches.length > 1) {
        throw new Error(`Multiple pending asks use message ID "${options.replyTo}" — specify \`to\``);
      }
      return checkTeam(matches[0]!);
    }

    const inTeam = (context: IntercomContext) => options.team === undefined || context.message.content.team === options.team;
    const currentTurnContexts = this.currentTurnContexts.filter(inTeam);
    if (currentTurnContexts.length > 0) {
      const turnMatches = options.to
        ? currentTurnContexts.filter((context) => matchesPendingSender(context, options.to!))
        : currentTurnContexts;
      if (new Set(turnMatches.map((context) => context.message.content.team)).size > 1) {
        throw new Error("Messages from multiple teams are active — specify `contextId`, `askId`, or `team`");
      }
      const replyableMatches = turnMatches.filter((context) => context.message.expectsReply);
      if (replyableMatches.length === 1) {
        return replyableMatches[0]!;
      }
      if (replyableMatches.length > 1) {
        if (!options.to && distinctSenders(replyableMatches) > 1) {
          throw new Error("Multiple asks are active in this intercom batch — specify `to` to select the sender");
        }
        if (options.which) return selectByAge(replyableMatches, options.which);
        throw new Error("Multiple asks from the selected sender are active — specify `which` as `oldest` or `latest`");
      }
      if (turnMatches.length === 1) {
        return turnMatches[0]!;
      }
      if (turnMatches.length > 1) {
        if (distinctSenders(turnMatches) === 1) return selectByAge(turnMatches, "latest");
        throw new Error("Multiple senders are active in this intercom batch — specify `to` using an exact sender name or full session ID");
      }
    }

    const pending = Array.from(this.pendingAsks.values()).filter(inTeam);
    const matches = options.to
      ? pending.filter((context) => matchesPendingSender(context, options.to!))
      : pending;
    if (new Set(matches.map((context) => context.message.content.team)).size > 1) {
      throw new Error("Pending asks belong to multiple teams — specify `askId` or `team`");
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      if (!options.to && distinctSenders(matches) > 1) {
        throw new Error("Multiple pending asks — specify `to` using a sender from `intercom_pending`");
      }
      if (options.which) return selectByAge(matches, options.which);
      const sender = options.to ? ` from \"${options.to}\"` : "";
      throw new Error(`Multiple pending asks${sender} — specify \`which\` as \`oldest\` or \`latest\``);
    }
    if (pending.length === 0) {
      throw new Error("No active intercom context to reply to");
    }
    if (options.to) throw new Error(`No pending ask from \"${options.to}\"`);
    throw new Error("No matching pending ask");
  }

  markReplied(replyTo: string, fromSessionId?: string): void {
    this.dismissPendingAsk(replyTo, fromSessionId);
  }

  dismissOrdinarySender(fromSessionId: string, messageId?: string): void {
    this.currentTurnContexts = this.currentTurnContexts.filter((context) =>
      context.message.expectsReply || context.from.id !== fromSessionId || (messageId !== undefined && context.message.id !== messageId)
    );
  }

  markDeferred(replyTo: string, fromSessionIdOrDeferredAt?: string | number, deferredAt = Date.now()): boolean {
    const fromSessionId = typeof fromSessionIdOrDeferredAt === "string" ? fromSessionIdOrDeferredAt : undefined;
    const effectiveDeferredAt = typeof fromSessionIdOrDeferredAt === "number" ? fromSessionIdOrDeferredAt : deferredAt;
    let changed = false;
    for (const context of this.pendingAsks.values()) {
      if (context.message.id === replyTo && (!fromSessionId || context.from.id === fromSessionId)) {
        context.deferredAt = effectiveDeferredAt;
        changed = true;
      }
    }
    return changed;
  }

  dismissPendingAsk(replyTo: string, fromSessionId?: string): void {
    for (const [key, context] of this.pendingAsks) {
      if (context.message.id === replyTo && (!fromSessionId || context.from.id === fromSessionId)) {
        this.pendingAsks.delete(key);
      }
    }
    for (let batchIndex = this.pendingTurnContexts.length - 1; batchIndex >= 0; batchIndex -= 1) {
      const batch = this.pendingTurnContexts[batchIndex]!;
      for (let contextIndex = batch.length - 1; contextIndex >= 0; contextIndex -= 1) {
        if (
          batch[contextIndex]?.message.id === replyTo
          && (!fromSessionId || batch[contextIndex]?.from.id === fromSessionId)
        ) {
          batch.splice(contextIndex, 1);
        }
      }
      if (batch.length === 0) this.pendingTurnContexts.splice(batchIndex, 1);
    }
    this.currentTurnContexts = this.currentTurnContexts.filter((context) =>
      context.message.id !== replyTo || (fromSessionId !== undefined && context.from.id !== fromSessionId)
    );
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private pruneExpired(now: number): void {
    for (const context of Array.from(this.pendingAsks.values())) {
      if (now - context.receivedAt > this.askTimeoutMs) {
        this.dismissPendingAsk(context.message.id, context.from.id);
      }
    }
  }
}
