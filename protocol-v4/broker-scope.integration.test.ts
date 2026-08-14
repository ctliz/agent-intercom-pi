import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { IntercomClient } from "../broker/client.ts";
import { createMessageReader, writeMessage } from "../broker/framing.ts";
import {
  INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
  INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION,
  parseIntercomScopeId,
} from "./contract.ts";

const root = process.cwd();
const scopeA = "Scope_AAAAAAAAAA";
const scopeB = "Scope_BBBBBBBBBB";

function registration(name: string, pid: number) {
  return { name, cwd: root, model: "v4-test", pid, startedAt: pid, lastActivity: Date.now() };
}

async function waitReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(child.stderr.read()?.toString() || "broker startup timeout")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Intercom broker started")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`broker exited ${code}: ${child.stderr.read()?.toString() ?? ""}`));
    });
  });
}

async function connect(name: string, id: string, scopeId?: string): Promise<IntercomClient> {
  const client = new IntercomClient(scopeId === undefined ? { env: {} } : { scopeId });
  client.on("message", (_from, _message, deliveryId) => client.acknowledgeMessage(deliveryId));
  await client.connect(registration(name, Math.floor(Math.random() * 1_000_000) + 1), id);
  return client;
}

async function close(...clients: IntercomClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.disconnect().catch(() => undefined)));
}

class RawPeer {
  readonly messages: any[] = [];
  constructor(readonly socket: net.Socket) {
    socket.on("data", createMessageReader((message) => this.messages.push(message), (error) => socket.destroy(error)));
  }
  send(message: unknown): void { writeMessage(this.socket, message); }
  async waitFor(predicate: (message: any) => boolean, timeoutMs = 2000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out; received ${JSON.stringify(this.messages)}`);
  }
}

async function rawConnect(socketPath: string): Promise<RawPeer> {
  const socket = net.connect(socketPath);
  await once(socket, "connect");
  return new RawPeer(socket);
}

function rawRegistration(name: string, id: string, scopeId?: string, runtimeInstanceId = `runtime-${name}`) {
  return {
    type: "register", protocol: "pi-intercom", version: 4, sessionId: id,
    ...(scopeId === undefined ? {} : { scopeId }),
    session: { ...registration(name, 101), runtimeInstanceId },
  };
}

async function withBroker(run: (socketPath: string, home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "piv4-"));
  const agentDir = join(home, "agent");
  const broker = spawn(process.execPath, ["--import", "tsx", "broker/broker.ts"], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await waitReady(broker);
    await run(join(agentDir, "intercom", "broker.sock"), home);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
    for (const file of ["broker-audit.jsonl", "broker-asks.json"]) {
      let content: string;
      try { content = readFileSync(join(agentDir, "intercom", file), "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      assert.doesNotMatch(content, /Scope_|AGENT_INTERCOM_SCOPE_ID|scopeId|scope id|\^\[A-Za-z/i);
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("Core vector identity and invalid scope classes are pinned", () => {
  assert.equal(INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION, 2);
  assert.equal(INTERCOM_PROTOCOL_V4_SEMANTICS_HASH, "ef23cae55b3cca7683fee60e5f2421350cde731dc5424c82286a33a8b9cdf6cb");
  for (const invalid of ["short", ` ${scopeA}`, `${scopeA} `, "Scope.AAAAAAAAAA", "éAAAAAAAAAAAAAAA", "A".repeat(129)]) {
    assert.throws(() => parseIntercomScopeId(invalid), /must match/);
  }
});

test("v4 broker partitions A/B/unscoped and exact IDs cross scopes", { timeout: 20_000 }, async () => {
  await withBroker(async () => {
    const a1 = await connect("alpha", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", scopeA);
    const a2 = await connect("worker", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", scopeA);
    const b1 = await connect("worker", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", scopeB);
    const u1 = await connect("unscoped-one", "11111111-1111-4111-8111-111111111111");
    const u2 = await connect("unscoped-two", "22222222-2222-4222-8222-222222222222");
    assert.deepEqual((await a1.listSessions()).map((s) => s.id).sort(), [a1.sessionId, a2.sessionId].sort());
    assert.deepEqual((await b1.listSessions()).map((s) => s.id), [b1.sessionId]);
    assert.deepEqual((await u1.listSessions()).map((s) => s.id).sort(), [u1.sessionId, u2.sessionId].sort());
    assert.equal((await a1.send(b1.sessionId!, { text: "exact cross scope" })).delivered, true);
    assert.equal((await a1.send("worker", { text: "same scope name" })).delivered, true);
    assert.equal((await a1.send("bbbbbb", { text: "hidden prefix" })).code, "SESSION_NOT_FOUND");
    assert.equal((await a1.send("unscoped-one", { text: "hidden unscoped" })).code, "SESSION_NOT_FOUND");
    assert.equal((await u1.send(a1.sessionId!, { text: "unscoped exact" })).delivered, true);
    for (const session of await a1.listSessions()) assert.equal(Object.hasOwn(session as object, "scopeId"), false);
    await close(a1, a2, b1, u1, u2);
  });
});

test("v4 automatic spawn fails closed against an incompatible broker without terminating or forking", { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "piv3-"));
  const agentDir = join(home, "agent");
  const serverScript = join(home, "v3-broker.mjs");
  const script = `import net from "node:net"; import {mkdirSync,unlinkSync,writeFileSync} from "node:fs"; import {join} from "node:path"; const dir=${JSON.stringify(join(agentDir, "intercom"))}; mkdirSync(dir,{recursive:true}); const path=join(dir,"broker.sock"); try{unlinkSync(path)}catch{}; const server=net.createServer((socket)=>{let buffer=Buffer.alloc(0);socket.on("data",(data)=>{buffer=Buffer.concat([buffer,data]);if(buffer.length<4)return;const length=buffer.readUInt32BE(0);if(buffer.length<4+length)return;const request=JSON.parse(buffer.subarray(4,4+length));const response={type:"health_ok",requestId:request.requestId,protocol:"pi-intercom",version:3,endpoint:"local"};const payload=Buffer.from(JSON.stringify(response));const header=Buffer.alloc(4);header.writeUInt32BE(payload.length);socket.end(Buffer.concat([header,payload]));});});server.listen(path,()=>writeFileSync(join(dir,"broker.pid"),String(process.pid)));process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`;
  await import("node:fs/promises").then(({ writeFile }) => writeFile(serverScript, script));
  const broker = spawn(process.execPath, [serverScript], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "ignore", "pipe"] });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const pidPath = join(agentDir, "intercom", "broker.pid");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { readFileSync(pidPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    const { spawnBrokerIfNeeded } = await import(`../broker/spawn.ts?mismatch=${Date.now()}`);
    await assert.rejects(spawnBrokerIfNeeded(process.execPath, []), /Incompatible live intercom broker/);
    assert.equal(broker.exitCode, null);
    assert.equal(Number(readFileSync(pidPath, "utf8")), broker.pid);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

test("replacement orders old left before new joined and stale socket frames are discarded", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const observerA = await rawConnect(socketPath);
    observerA.send(rawRegistration("observer-a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10", scopeA));
    await observerA.waitFor((m) => m.type === "registered");
    const observerB = await rawConnect(socketPath);
    observerB.send(rawRegistration("observer-b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb10", scopeB));
    await observerB.waitFor((m) => m.type === "registered");
    const oldPeer = await rawConnect(socketPath);
    const stableId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    oldPeer.send(rawRegistration("replace-me", stableId, scopeA, "same-runtime"));
    await oldPeer.waitFor((m) => m.type === "registered");
    await observerA.waitFor((m) => m.type === "session_joined" && m.session.id === stableId);
    const newPeer = await rawConnect(socketPath);
    newPeer.send(rawRegistration("replace-me", stableId, scopeB, "same-runtime"));
    await newPeer.waitFor((m) => m.type === "registered");
    await observerA.waitFor((m) => m.type === "session_left" && m.sessionId === stableId);
    await observerB.waitFor((m) => m.type === "session_joined" && m.session.id === stableId);
    const aEvents = observerA.messages.filter((m) => m.sessionId === stableId || m.session?.id === stableId).map((m) => m.type);
    assert.deepEqual(aEvents, ["session_joined", "session_left"]);
    // Disabled (no observer) replacement must allocate zero replacement correlation
    // UUID: lifecycle wire frames carry canonical exact keys only.
    for (const frame of observerA.messages.filter((m) => m.type === "session_left" || m.type === "session_joined")) {
      assert.equal("correlation" in frame, false, `wire frame must not carry correlation: ${JSON.stringify(frame)}`);
      assert.equal("scopeId" in frame, false, `wire frame must not carry scopeId: ${JSON.stringify(frame)}`);
      if (frame.type === "session_left") assert.deepEqual(Object.keys(frame).sort(), ["sessionId", "type"]);
      if (frame.type === "session_joined") assert.deepEqual(Object.keys(frame).sort(), ["session", "type"]);
    }
    assert.equal(observerB.messages.some((m) => m.type === "session_left" && m.sessionId === stableId), false);
    oldPeer.send({ type: "presence", name: "stale-name" });
    oldPeer.send({ type: "list", requestId: "stale-list" });
    oldPeer.send({ type: "send", to: observerA.messages[0]?.session?.id ?? "missing", message: { id: "stale-send", timestamp: Date.now(), content: { text: "stale" } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(oldPeer.messages.some((m) => m.requestId === "stale-list" || m.messageId === "stale-send"), false);
    assert.equal(observerB.messages.some((m) => m.type === "presence_update" && m.session.name === "stale-name"), false);
    observerA.socket.destroy(); observerB.socket.destroy(); oldPeer.socket.destroy(); newPeer.socket.destroy();
  });
});

test("invalid scope fails before replacing an existing same-ID session", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const stableId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const existing = await rawConnect(socketPath);
    existing.send(rawRegistration("existing", stableId, scopeA, "same-runtime"));
    await existing.waitFor((m) => m.type === "registered");
    const invalid = await rawConnect(socketPath);
    invalid.send(rawRegistration("invalid", stableId, " invalid-scope", "same-runtime"));
    const error = await invalid.waitFor((m) => m.type === "error");
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.error, "Registration metadata is invalid");
    assert.doesNotMatch(JSON.stringify(error), /scope|AGENT_INTERCOM|\^\[A-Za-z/i);
    assert.equal(JSON.stringify(invalid.messages).includes("invalid-scope"), false);
    existing.send({ type: "list", requestId: "still-live" });
    const sessions = await existing.waitFor((m) => m.type === "sessions" && m.requestId === "still-live");
    assert.equal(sessions.sessions.some((session: any) => session.id === stableId), true);
    existing.socket.destroy(); invalid.socket.destroy();
  });
});
