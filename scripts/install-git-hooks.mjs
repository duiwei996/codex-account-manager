import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNodeVersion } from "./release-preflight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.CI) {
  verifyNodeVersion();
  if (!process.env.npm_execpath) throw new Error("Run pnpm hooks:install to use the pinned package manager.");
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const result = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
  if (result.error || ![0, 1].includes(result.status)) throw new Error("Cannot read existing hook configuration");
  const existing = result.stdout.trim();
  if (existing && existing !== ".githooks") throw new Error("Existing hooksPath belongs to another setup; refusing to replace it.");
  const oldHook = resolve(root, git(["rev-parse", "--git-path", "hooks/pre-push"]));
  if (!existing.trim() && existsSync(oldHook)) throw new Error("An existing pre-push hook must be integrated before installation.");
  git(["config", "--local", "codex.nodePath", process.execPath]);
  git(["config", "--local", "codex.pnpmPath", process.env.npm_execpath]);
  if (process.env.CARGO_AUDIT_BIN) git(["config", "--local", "codex.auditPath", process.env.CARGO_AUDIT_BIN]);
  if (process.platform !== "win32") chmodSync(resolve(root, ".githooks/pre-push"), 0o755);
  git(["config", "--local", "core.hooksPath", ".githooks"]);
  console.log("Installed repository-local pre-push security checks using the current pinned toolchain.");
}
