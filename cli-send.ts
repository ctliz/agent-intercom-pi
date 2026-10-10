import { randomUUID } from "node:crypto";
import { IntercomClient } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { loadConfig } from "./config.ts";
import type { Message, SessionInfo } from "./types.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let waitMs = 0;
  if (args[0] === "--wait-reply") {
    args.shift();
    const seconds = Number(args.shift());
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) {
      throw new Error("--wait-reply requires a timeout in seconds (0 < seconds <= 86400)");
    }
    waitMs = seconds * 1000;
  }
  const [to, ...parts] = args;
  const message = parts.join(" ");
  if (!to?.trim() || !message.trim()) {
    throw new Error("Usage: intercom-send [--wait-reply <seconds>] <session-name-or-id> <message>");
  }
  const config = loadConfig();
  if (!config.enabled) throw new Error("Intercom disabled");
  await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
  const client = new IntercomClient();
  const messageId = randomUUID();
  const now = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    // Never inherit the calling Pi's session ID or take over its mailbox.
    await client.connect({
      name: `intercom-cli-${randomUUID()}`,
      cwd: process.cwd(),
      model: "cli-sender",
      pid: process.pid,
      startedAt: now,
      lastActivity: now,
      runtimeInstanceId: randomUUID(),
    });
    let reply: Promise<{ from: SessionInfo; message: Message } | null> | undefined;
    let target = to;
    if (waitMs) {
      const sessions = await client.listSessions();
      const matches = sessions.filter((session) => session.id === to || session.name?.toLowerCase() === to.toLowerCase());
      if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous target; use the session ID" : "Session not found");
      target = matches[0]!.id;
      reply = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
        client.on("message", (from: SessionInfo, incoming: Message, deliveryId: string) => {
          if (from.id !== target || (incoming.replyTo && incoming.replyTo !== messageId)) return;
          client.acknowledgeMessage(deliveryId);
          resolve({ from, message: incoming });
        });
        client.once("disconnected", () => resolve(null));
      });
    }
    const result = await client.send(target, { text: message, messageId, ...(waitMs ? { expectsReply: true } : {}) });
    console.log(JSON.stringify({ messageId: result.id, ...result }));
    if (!result.delivered) process.exitCode = 1;
    else if (reply) {
      const response = await reply;
      console.log(JSON.stringify(response
        ? { type: "reply", ...response }
        : { type: "reply_wait_failed", code: client.isConnected() ? "REPLY_TIMEOUT" : "DISCONNECTED", messageId: result.id }));
      if (!response) process.exitCode = 2;
    }
  } finally {
    clearTimeout(timer);
    await client.disconnect();
  }
}

main().catch((error: Error & { code?: string }) => {
  console.log(JSON.stringify({ accepted: false, delivered: false, reason: error.message, ...(error.code ? { code: error.code } : {}) }));
  process.exitCode = 1;
});
