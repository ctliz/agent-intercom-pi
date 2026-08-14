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
  assert.ok(paths.includes("broker/protected-service.ts"));
  assert.ok(paths.includes("provider/provider.mjs"));
  assert.equal(paths.includes("provider/entry.ts"), false);
  assert.equal(paths.includes("scripts/build-protected-provider.mjs"), false);
  assert.ok(paths.includes("inbound-inbox.ts"));
  assert.ok(paths.includes("outbound-outbox.ts"));
  assert.ok(paths.includes("durable-json.ts"));
  assert.equal(paths.some(path => path.endsWith(".test.ts")), false);
});

test("protected provider is a packaged artifact, not an extension or executable", () => {
  const root = new URL("..", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as Record<string, any>;
  const extension = readFileSync(new URL("index.ts", root), "utf8");

  assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);
  assert.equal(manifest.bin, undefined);
  assert.doesNotMatch(extension, /provider\/provider\.mjs|protected-service/);
});

test("packed runtime installs the exact Core build without an SSH dependency", () => {
  const root = new URL("..", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as Record<string, any>;
  const lock = readFileSync(new URL("package-lock.json", root), "utf8");

  assert.equal(manifest.engines?.node, ">=22.19.0");
  assert.equal(manifest.peerDependencies?.["@ctliz/agent-intercom-core"], undefined);
  assert.equal(
    manifest.dependencies?.["@ctliz/agent-intercom-core"],
    "git+https://github.com/ctliz/agent-intercom-core.git#37e074970e2a9de32a16fc325607c3b476b0bd45",
  );
  assert.equal(manifest.devDependencies?.["@ctliz/agent-intercom-core"], undefined);
  // The legacy namespace must not reappear as a dependency under any field.
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    assert.equal(manifest[field]?.[`@${"dataforxyz"}/agent-intercom-core`], undefined);
  }

  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    assert.notEqual(manifest.dependencies?.[name], undefined);
    assert.equal(manifest.peerDependencies?.[name], undefined);
    assert.equal(manifest.devDependencies?.[name], undefined);
  }

  const lockData = JSON.parse(lock) as { packages: Record<string, Record<string, unknown>> };
  const coreEntry = lockData.packages["node_modules/@ctliz/agent-intercom-core"];
  assert.ok(coreEntry, "Core package entry missing from lockfile");
  assert.equal(
    coreEntry.resolved,
    "git+https://github.com/ctliz/agent-intercom-core.git#37e074970e2a9de32a16fc325607c3b476b0bd45",
  );
  assert.equal(
    coreEntry.integrity,
    "sha512-b5MXnfKh/RCjKoVor0tsFO+NKAqPROWgkgbHt7jiHxhdVbSh7gWvOdnVUtpSdPwJLYKSQrYXT+TJl7QocdJEPA==",
  );
  assert.equal(lock.includes("git+ssh://git@github.com/ctliz/agent-intercom-core"), false);
  assert.equal(lock.includes(`git+ssh://git@github.com/${"dataforxyz"}/agent-intercom-core`), false);
  // connect.1 Core commits must not survive anywhere in the lock.
  assert.equal(lock.includes("aad1985e125516b318181560293145bf2507cc6d"), false);
  assert.equal(lock.includes("8316cbab548f422ad11c78ed887fabeef94817c1"), false);
  // The isolated mirror used to resolve an unpushed Core must never leak in.
  assert.doesNotMatch(lock, /file:\/\//);
  assert.equal(lock.includes("core-c2-mirror"), false);
  assert.equal(lock.includes(`@${"dataforxyz"}/agent-intercom-core`), false);
});
