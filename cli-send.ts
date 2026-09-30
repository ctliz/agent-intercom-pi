import { randomUUID } from "node:crypto";
import { IntercomClient } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { loadConfig } from "./config.ts";

async function main(): Promise<void> {
  const [to, ...parts] = process.argv.slice(2);
  const message = parts.join(" ");
  if (!to?.trim() || !message.trim()) {
    throw new Error("Usage: intercom-send <session-name-or-id> <message>");
  }
  const config = loadConfig();
  if (!config.enabled) throw new Error("Intercom disabled");
  await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
  const client = new IntercomClient();
  const now = Date.now();
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
    const result = await client.send(to, { text: message });
    console.log(JSON.stringify({ messageId: result.id, ...result }));
    if (!result.delivered) process.exitCode = 1;
  } finally {
    await client.disconnect();
  }
}

main().catch((error: Error & { code?: string }) => {
  console.log(JSON.stringify({ accepted: false, delivered: false, reason: error.message, ...(error.code ? { code: error.code } : {}) }));
  process.exitCode = 1;
});
