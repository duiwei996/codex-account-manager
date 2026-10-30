import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bash = process.platform === "win32"
  ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../..", "bin/bash.exe") : "bash";

function installFixture({ version = "0.22.2", broken = false, failure = false } = {}) {
  mkdirSync(resolve(root, ".tmp"), { recursive: true });
  const dir = mkdtempSync(resolve(root, ".tmp/auditor-test-"));
  writeFileSync(resolve(dir, "version"), version);
  writeFileSync(resolve(dir, "cargo-audit"), '#!/bin/sh\ncat "$AUDIT_FIXTURE/version"\n');
  writeFileSync(resolve(dir, "cargo"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$AUDIT_FIXTURE/install-args"\n[ "$FAIL_INSTALL" = 0 ] || exit 7\n[ "$BROKEN_INSTALL" = 1 ] || printf "cargo-audit 0.22.1\\n" > "$AUDIT_FIXTURE/version"\n');
  for (const name of ["cargo", "cargo-audit"]) chmodSync(resolve(dir, name), 0o755);
  const env = { ...process.env, AUDIT_FIXTURE: dir.replaceAll("\\", "/"), BROKEN_INSTALL: broken ? "1" : "0", FAIL_INSTALL: failure ? "1" : "0" };
  // Set the fixture path inside Bash so Git Bash performs Windows path conversion.
  const command = `${process.platform === "win32" ? 'AUDIT_FIXTURE="$(cygpath -u "$AUDIT_FIXTURE")"; export AUDIT_FIXTURE; ' : ''}export PATH="$AUDIT_FIXTURE:$PATH"; test "$(command -v cargo)" = "$AUDIT_FIXTURE/cargo" || exit 99; bash scripts/ensure-cargo-audit.sh`;
  const result = spawnSync(bash, ["-c", command], { cwd: root, env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined);
  return { result, args: existsSync(resolve(dir, "install-args")) ? readFileSync(resolve(dir, "install-args"), "utf8").trim() : null };
}

test("cached binary version overrides stale installation metadata and forces reinstall", () => {
  const { result, args } = installFixture({ version: "cargo-audit 0.22.2" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(args, "install cargo-audit --locked --version 0.22.1 --force");
  assert.match(result.stdout, /Verified cargo-audit 0.22.1/);
});

test("matching binary avoids recompilation", () => {
  const { result, args } = installFixture({ version: "cargo-audit 0.22.1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(args, null);
});

test("install failure or a still-mismatched binary stops the job", () => {
  assert.notEqual(installFixture({ failure: true }).result.status, 0);
  const { result } = installFixture({ broken: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed verification/);
});
