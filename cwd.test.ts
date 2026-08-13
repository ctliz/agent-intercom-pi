import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCwd, sameCwd, sameWorkspace, workspaceKey } from "./cwd.ts";

test("canonical cwd handles lexical paths, symlinks, missing directories, and Windows case", () => {
  const base = mkdtempSync(join(tmpdir(), "intercom-cwd-"));
  const real = join(base, "real");
  const link = join(base, "link");
  try {
    mkdirSync(real);
    symlinkSync(real, link);
    assert.equal(sameCwd(link, real), true);
    assert.equal(normalizeCwd(join(base, "missing", "..", "missing")), join(base, "missing"));
    assert.equal(normalizeCwd("C:/Work/Repo", "win32"), normalizeCwd("c:/work/repo", "win32"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("workspace uses canonical git root and keeps repositories separate", () => {
  const base = mkdtempSync(join(tmpdir(), "intercom-workspaces-"));
  const first = join(base, "first");
  const nested = join(first, "packages", "api");
  const second = join(base, "second");
  try {
    mkdirSync(nested, { recursive: true });
    mkdirSync(second);
    assert.equal(spawnSync("git", ["init", "-q", first]).status, 0);
    assert.equal(spawnSync("git", ["init", "-q", second]).status, 0);
    assert.equal(workspaceKey(nested), realpathSync(first));
    assert.equal(sameWorkspace(first, nested), true);
    assert.equal(sameWorkspace(first, second), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("non-git workspace falls back to canonical cwd and refreshes after git init", async () => {
  const base = mkdtempSync(join(tmpdir(), "intercom-late-repo-"));
  const nested = join(base, "nested");
  try {
    mkdirSync(nested);
    assert.equal(workspaceKey(nested), realpathSync(nested));
    assert.equal(workspaceKey(nested, { ...process.env, PATH: "" }), realpathSync(nested));
    assert.equal(spawnSync("git", ["init", "-q", base]).status, 0);
    assert.equal(workspaceKey(nested), realpathSync(nested));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(workspaceKey(nested), realpathSync(base));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
