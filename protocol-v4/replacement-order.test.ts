import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageReader, writeMessage } from "../broker/framing.ts";

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

function assertPair(events: EmissionEvent[], label: string): { left: EmissionEvent; joined: EmissionEvent } {
  const byCorr = new Map<string, EmissionEvent[]>();
  for (const e of events) {
    if (!byCorr.has(e.correlation)) byCorr.set(e.correlation, []);
    byCorr.get(e.correlation)!.push(e);
  }
  let left: EmissionEvent | undefined;
  let joined: EmissionEvent | undefined;
  for (const evs of byCorr.values()) {
    const l = evs.find((e) => e.eventType === "session_left");
    const j = evs.find((e) => e.eventType === "session_joined");
    if (l && j) { left = l; joined = j; break; }
  }
  assert.ok(left && joined, `${label}: replacement left+joined pair must exist`);
  assert.equal(left.correlation, joined.correlation, `${label}: shared correlation`);
  assert.ok(left.sequence < joined.sequence, `${label}: left.sequence(${left.sequence}) < joined.sequence(${joined.sequence})`);
  assert.equal(left.contractVersion, 1);
  for (const e of [left, joined]) {
    assert.deepEqual(Object.keys(e).sort(), ["contractVersion", "correlation", "eventType", "sequence"], `${label}: exact 4-key`);
    assert.equal(Object.isFrozen(e), true, `${label}: frozen`);
    assert.doesNotMatch(JSON.stringify(e), /Scope_|scopeId|cwd|runtimeInstanceId|credential|adminToken|enrollment|token/i, `${label}: no leak`);
  }
  return { left, joined };
}

test("replacement emission-intent matrix via the internal factory seam", { concurrency: false }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-obs-"));
  const agentDir = join(home, "agent");
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let broker: any;
  try {
    const mod = await import("../broker/broker-impl.ts");
    const events: EmissionEvent[] = [];
    let shouldThrow = false;
    broker = mod.createBrokerWithObserver((e: EmissionEvent) => { events.push(e); if (shouldThrow && e.eventType === "session_left") throw new Error("observer boom"); });
    broker.start();
    const socketPath = join(agentDir, "intercom", "broker.sock");

    // Ordinary join emits zero observer events.
    const ordinaryPeer = await connect(socketPath);
    ordinaryPeer.send(registration("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01", scopeA));
    await ordinaryPeer.waitFor((m) => m.type === "registered");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(events.length, 0, "ordinary join must emit zero observer events");

    // A -> B
    const old1 = await connect(socketPath);
    old1.send(registration("cccccccc-cccc-4ccc-8ccc-cccccccccca1", scopeA));
    await old1.waitFor((m) => m.type === "registered");
    const new1 = await connect(socketPath);
    new1.send(registration("cccccccc-cccc-4ccc-8ccc-cccccccccca1", scopeB));
    await new1.waitFor((m) => m.type === "registered");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(events.length, 2, "A->B: exactly left+joined");
    assertPair(events, "A->B");
    const pairA = { left: events[0], joined: events[1] };

    // Stale list/presence/send/ask-controls from the old socket emit zero observer events.
    events.length = 0;
    old1.send({ type: "list", requestId: "stale-list" });
    old1.send({ type: "presence", name: "stale-name" });
    old1.send({ type: "send", to: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01", message: { id: "stale-send", timestamp: Date.now(), content: { text: "stale" } } });
    old1.send({ type: "defer_ask", requestId: "stale-defer", messageId: "stale-ask" });
    old1.send({ type: "cancel_ask", requestId: "stale-cancel", messageId: "stale-ask" });
    old1.send({ type: "send", to: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01", message: { id: "stale-reply", timestamp: Date.now(), replyTo: "stale-ask", content: { text: "late" } } });
    old1.send({ type: "message_received", deliveryId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(events.length, 0, "stale list/presence/send/ask-controls/ack must emit zero observer events");

    // Unregister/disconnect of the new session emits zero observer events (ordinary left is not a replacement).
    events.length = 0;
    new1.send({ type: "unregister" });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(events.length, 0, "ordinary unregister/disconnect must emit zero observer events");

    // B -> unscoped
    events.length = 0;
    const old2 = await connect(socketPath);
    old2.send(registration("cccccccc-cccc-4ccc-8ccc-ccccccccccb2", scopeB));
    await old2.waitFor((m) => m.type === "registered");
    const new2 = await connect(socketPath);
    new2.send(registration("cccccccc-cccc-4ccc-8ccc-ccccccccccb2"));
    await new2.waitFor((m) => m.type === "registered");
    await new Promise((r) => setTimeout(r, 40));
    assertPair(events, "B->unscoped");

    // same-scope
    events.length = 0;
    const old3 = await connect(socketPath);
    old3.send(registration("cccccccc-cccc-4ccc-8ccc-ccccccccccc3", scopeA));
    await old3.waitFor((m) => m.type === "registered");
    const new3 = await connect(socketPath);
    new3.send(registration("cccccccc-cccc-4ccc-8ccc-ccccccccccc3", scopeA));
    await new3.waitFor((m) => m.type === "registered");
    await new Promise((r) => setTimeout(r, 40));
    assertPair(events, "same-scope");

    // Parallel (two rapid replacements on distinct IDs): distinct correlations, monotonic sequence.
    events.length = 0;
    const idA = "cccccccc-cccc-4ccc-8ccc-ccccccccccd6";
    const idB = "cccccccc-cccc-4ccc-8ccc-ccccccccccd7";
    const ra1 = await connect(socketPath);
    ra1.send(registration(idA, scopeA));
    await ra1.waitFor((m) => m.type === "registered");
    const rb1 = await connect(socketPath);
    rb1.send(registration(idB, scopeA));
    await rb1.waitFor((m) => m.type === "registered");
    const ra2 = await connect(socketPath);
    ra2.send(registration(idA, scopeB));
    await ra2.waitFor((m) => m.type === "registered");
    const rb2 = await connect(socketPath);
    rb2.send(registration(idB, scopeB));
    await rb2.waitFor((m) => m.type === "registered");
    await new Promise((r) => setTimeout(r, 60));
    const lefts = events.filter((e) => e.eventType === "session_left");
    const joins = events.filter((e) => e.eventType === "session_joined");
    assert.equal(lefts.length, 2, "two replacements -> two left");
    assert.equal(joins.length, 2, "two replacements -> two joined");
    assert.notEqual(lefts[0].correlation, lefts[1].correlation, "distinct correlations per replacement");
    assert.ok(lefts[0].sequence < joins[0].sequence);
    assert.ok(lefts[1].sequence < joins[1].sequence);
    assert.ok(lefts[0].sequence < lefts[1].sequence, "monotonic sequence");

    // Reentrant/throw isolation: a throwing observer must not affect replacement.
    events.length = 0;
    shouldThrow = true;
    const old4 = await connect(socketPath);
    old4.send(registration("cccccccc-cccc-4ccc-8ccc-ccccccccccd8", scopeA));
    await old4.waitFor((m) => m.type === "registered");
    const new4 = await connect(socketPath);
    new4.send(registration("cccccccc-cccc-4ccc-8ccc-ccccccccccd8", scopeB));
    const registered = await new4.waitFor((m) => m.type === "registered");
    assert.equal(registered.type, "registered", "replacement completes despite observer throw");
    shouldThrow = false;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(events.filter((e) => e.eventType === "session_left").length, 1);
    assert.equal(events.filter((e) => e.eventType === "session_joined").length, 1);
    assertPair(events, "throw-isolation");

    // Correlation non-leak: observer correlations must not appear in wire frames,
    // persisted broker stores, audit, or log surfaces.
    const intercomDir = join(agentDir, "intercom");
    for (const e of [pairA.left, pairA.joined]) {
      for (const peer of [ordinaryPeer]) {
        assert.equal(JSON.stringify(peer.messages).includes(e.correlation), false, "correlation must not leak into wire frames");
      }
      for (const file of ["broker-audit.jsonl", "broker-asks.json", "broker-access.json", "broker-admin.json", "broker.port.json"]) {
        try {
          assert.equal(readFileSync(join(intercomDir, file), "utf8").includes(e.correlation), false, `correlation must not leak into ${file}`);
        } catch (err: any) {
          if (err.code !== "ENOENT") throw err;
        }
      }
    }

    // Reentrant: observer callback that throws during session_left must not corrupt the
    // outer replacement (captured callback is used for both left and joined).
    // (Already exercised above via throw-isolation; here assert the joined still emits
    //  after a reentrant throw with no additional left events.)
    assert.equal(events.filter((e) => e.eventType === "session_left").length, 1);

    // Full-surface scan: capture broker stdout/stderr during a replacement and assert no correlation leak.
    const captured: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (chunk: any, ...rest: any[]) => { captured.push(String(chunk)); return origOut(chunk, ...rest); };
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => { captured.push(String(chunk)); return origErr(chunk, ...rest); };
    const old6 = await connect(socketPath);
    old6.send(registration("cccccccc-cccc-4ccc-8ccc-ccccccccccdA", scopeA));
    await old6.waitFor((m) => m.type === "registered");
    const new6 = await connect(socketPath);
    new6.send(registration("cccccccc-cccc-4ccc-8ccc-ccccccccccdA", scopeB));
    await new6.waitFor((m) => m.type === "registered");
    await new Promise((r) => setTimeout(r, 40));
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
    for (const e of events) {
      assert.equal(captured.join("").includes(e.correlation), false, "correlation must not leak into stdout/stderr");
    }

    for (const peer of [ordinaryPeer, old1, new1, old2, new2, old3, new3, ra1, ra2, rb1, rb2, old4, new4, old6, new6]) peer.socket.destroy();
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
