import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageReader, writeMessage } from "../broker/framing.ts";
import { releaseBrokerOwnership } from "../broker/ownership.ts";

const scopeA = "Scope_AAAAAAAAAA";
const scopeB = "Scope_BBBBBBBBBB";

type EmissionEvent = { contractVersion: number; correlation: string; sequence: number; eventType: "session_left" | "session_joined" };

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

async function replace(socketPath: string, oldScope: string | undefined, newScope: string | undefined, id: string): Promise<void> {
  const oldPeer = await connect(socketPath);
  oldPeer.send(registration(id, oldScope));
  await oldPeer.waitFor((m) => m.type === "registered");
  const newPeer = await connect(socketPath);
  newPeer.send(registration(id, newScope));
  await newPeer.waitFor((m) => m.type === "registered");
  await new Promise((r) => setTimeout(r, 40));
  oldPeer.socket.destroy(); newPeer.socket.destroy();
}

test("two broker instances keep independent sequences; reentrant observer does not corrupt", { concurrency: false }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-adv-"));
  const agentDir = join(home, "agent");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const socketPath = join(agentDir, "intercom", "broker.sock");
  const ownerPath = join(agentDir, "intercom", "broker.owner");
  try {
    const mod = await import("../broker/broker-impl.ts");

    // Broker A: observer A
    const eventsA: EmissionEvent[] = [];
    const brokerA = mod.createBrokerWithObserver((e: EmissionEvent) => eventsA.push(e));
    brokerA.start();
    await new Promise((r) => setTimeout(r, 60));
    await replace(socketPath, scopeA, scopeB, "cccccccc-cccc-4ccc-8ccc-cccccccccc2a");
    assert.equal(eventsA.length, 2);
    assert.equal(eventsA[0].sequence, 1);
    assert.equal(eventsA[1].sequence, 2);
    brokerA.server.close(); brokerA.remoteServer.close();
    releaseBrokerOwnership(ownerPath);

    // Broker B: observer B — sequence restarts at 1 (per-instance, not module-global).
    const eventsB: EmissionEvent[] = [];
    const brokerB = mod.createBrokerWithObserver((e: EmissionEvent) => eventsB.push(e));
    brokerB.start();
    await new Promise((r) => setTimeout(r, 60));
    await replace(socketPath, scopeA, scopeB, "cccccccc-cccc-4ccc-8ccc-cccccccccc2b");
    assert.equal(eventsB.length, 2);
    assert.equal(eventsB[0].sequence, 1, "second broker sequence restarts at 1");
    assert.equal(eventsB[1].sequence, 2);
    brokerB.server.close(); brokerB.remoteServer.close();
    releaseBrokerOwnership(ownerPath);

    // Broker C: reentrant observer — nested replacement queued from session_left callback.
    const eventsC: EmissionEvent[] = [];
    const armed = { on: true };
    const nestedId = "cccccccc-cccc-4ccc-8ccc-cccccccccc2c";
    let nestedPeer: RawPeer;
    const brokerC = mod.createBrokerWithObserver((e: EmissionEvent) => {
      eventsC.push(e);
      if (armed.on && e.eventType === "session_left") {
        armed.on = false;
        process.nextTick(() => { nestedPeer.send(registration(nestedId, scopeA)); });
      }
    });
    brokerC.start();
    await new Promise((r) => setTimeout(r, 60));
    nestedPeer = await connect(socketPath);
    await replace(socketPath, scopeA, scopeB, nestedId);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(eventsC.filter((e) => e.eventType === "session_left").length >= 1, "outer left emitted");
    assert.ok(eventsC.filter((e) => e.eventType === "session_joined").length >= 1, "outer joined emitted");
    for (let i = 1; i < eventsC.length; i++) assert.ok(eventsC[i - 1].sequence < eventsC[i].sequence, "monotonic under reentrant");
    nestedPeer.socket.destroy();
    brokerC.server.close(); brokerC.remoteServer.close();
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
