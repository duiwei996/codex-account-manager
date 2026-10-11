import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prepareRelease } from "../scripts/prepare-release.mjs";

const overlay = JSON.parse(readFileSync(new URL("../src-tauri/tauri.release.conf.template.json", import.meta.url), "utf8"));
const pubkey = Buffer.from("untrusted comment: minisign public key: DEMO\nRWTSafeNotARealSigningKey" + "x".repeat(72)).toString("base64");
const env = {
  GITHUB_REPOSITORY: "duiwei996/codex-account-manager",
  GITHUB_REF: "refs/heads/main",
  TAURI_SIGNING_PRIVATE_KEY: "test-only-private-key",
  TAURI_UPDATER_PUBLIC_KEY: pubkey,
};

test("release overlay installs only our endpoint and public key", () => {
  const { config, version } = prepareRelease(env, overlay);
  assert.ok(/^\d+\.\d+\.\d+$/.test(version));
  assert.equal(config.plugins.updater.pubkey, pubkey);
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/duiwei996/codex-account-manager/releases/latest/download/latest.json",
  ]);
  assert.equal(JSON.stringify(config).includes("test-only-private-key"), false);
});

test("release fails closed with wrong repository, branch or missing signing configuration", () => {
  for (const [field, replacement] of [
    ["GITHUB_REPOSITORY", "example/other-project"],
    ["GITHUB_REF", "refs/heads/dev"],
    ["TAURI_SIGNING_PRIVATE_KEY", ""],
    ["TAURI_UPDATER_PUBLIC_KEY", ""],
  ]) {
    assert.throws(() => prepareRelease({ ...env, [field]: replacement }, overlay), field);
  }
});

test("release rejects endpoint hijacking", () => {
  const evil = structuredClone(overlay);
  evil.plugins.updater.endpoints = ["https://github.com/example/other-project/releases/latest/download/latest.json"];
  assert.throws(() => prepareRelease(env, evil));
});
