import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageReader, writeMessage } from "../broker/framing.ts";

const scopeA = "Scope_AAAAAAAAAA";
const scopeB = "Scope_BBBBBBBBBB";

function registration(id: string, scopeId?: string) {
  return {
    type: "register", protocol: "pi-intercom", version: 4, sessionId: id,
    ...(scopeId === undefined ? {} : { scopeId }),
    session: { name: "replace-me", cwd: "/obs", model: "obs", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), runtimeInstanceId: `rt-${id}` },
  };
}

class RawPeer {
  messages: any[] = [];
  constructor(readonly socket: net.Socket) {
    socket.on("data", createMessageReader((m) => this.messages.push(m), () => socket.destroy()));
  }
  send(m: unknown): void { writeMessage(this.socket, m); }
  async waitFor(p: (m: any) => boolean, t = 3000): Promise<any> {
    const deadline = Date.now() + t;
    while (Date.now() < deadline) {
      const f = this.messages.find(p);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout; msgs=${JSON.stringify(this.messages)}`);
  }
}

async function connect(socketPath: string): Promise<RawPeer> {
  const s = net.connect(socketPath);
  await once(s, "connect");
  return new RawPeer(s);
}

test("disabled broker (no observer) allocates zero replacement correlation and emits zero observer events", { concurrency: false }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dis-"));
  const agentDir = join(home, "agent");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let broker: any;
  try {
    const mod = await import("../broker/broker-impl.ts");
    broker = new mod.IntercomBroker(); // NO observer bound
    broker.start();
    const socketPath = join(agentDir, "intercom", "broker.sock");

    const observerA = await connect(socketPath);
    observerA.send(registration("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10", scopeA));
    await observerA.waitFor((m) => m.type === "registered");
    const stableId = "cccccccc-cccc-4ccc-8ccc-ccccccccccd1";
    const oldPeer = await connect(socketPath);
    oldPeer.send(registration(stableId, scopeA));
    await oldPeer.waitFor((m) => m.type === "registered");
    await observerA.waitFor((m) => m.type === "session_joined" && m.session.id === stableId);
    const newPeer = await connect(socketPath);
    newPeer.send(registration(stableId, scopeB));
    await newPeer.waitFor((m) => m.type === "registered");
    await observerA.waitFor((m) => m.type === "session_left" && m.sessionId === stableId);
    await new Promise((r) => setTimeout(r, 40));

    // Zero replacement correlation UUID/state: canonical lifecycle frames only.
    for (const frame of observerA.messages.filter((m) => m.type === "session_left" || m.type === "session_joined")) {
      assert.equal("correlation" in frame, false, `disabled wire frame must not carry correlation: ${JSON.stringify(frame)}`);
      assert.equal("scopeId" in frame, false, "disabled wire frame must not carry scopeId");
      if (frame.type === "session_left") assert.deepEqual(Object.keys(frame).sort(), ["sessionId", "type"]);
      if (frame.type === "session_joined") assert.deepEqual(Object.keys(frame).sort(), ["session", "type"]);
    }

    observerA.socket.destroy(); oldPeer.socket.destroy(); newPeer.socket.destroy();
  } finally {
    if (broker) {
      broker.server?.close();
      broker.remoteServer?.close();
    }
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
