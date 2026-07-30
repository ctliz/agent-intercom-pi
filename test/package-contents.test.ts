import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("published package includes presentation assets and excludes tests", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  const paths = pack.files.map(file => file.path);

  assert.ok(paths.includes("banner.png"));
  assert.ok(paths.includes("broker/broker.ts"));
  assert.ok(paths.includes("broker/registration.ts"));
  assert.ok(paths.includes("inbound-inbox.ts"));
  assert.ok(paths.includes("outbound-outbox.ts"));
  assert.ok(paths.includes("durable-json.ts"));
  assert.equal(paths.some(path => path.endsWith(".test.ts")), false);
});

test("packed runtime declares the Core Node floor without an SSH runtime dependency", () => {
  const root = new URL("..", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as Record<string, any>;
  const lock = readFileSync(new URL("package-lock.json", root), "utf8");

  assert.equal(manifest.engines?.node, ">=22.19.0");
  assert.equal(manifest.peerDependencies?.["@dataforxyz/agent-intercom-core"], "0.1.0");
  assert.equal(manifest.dependencies?.["@dataforxyz/agent-intercom-core"], undefined);
  assert.match(manifest.devDependencies?.["@dataforxyz/agent-intercom-core"] ?? "", /^git\+https:\/\//);
  assert.equal(lock.includes("git+ssh://git@github.com/dataforxyz/agent-intercom-core"), false);
});
