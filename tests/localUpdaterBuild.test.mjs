import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prepareLocalBuild } from "../scripts/build-local.mjs";
import { UPDATE_ENDPOINT } from "../scripts/updater-config.mjs";

const template = JSON.parse(readFileSync(new URL("../src-tauri/tauri.release.conf.template.json", import.meta.url), "utf8"));
const key = readFileSync(new URL("../src-tauri/updater-public-key.txt", import.meta.url), "utf8").trim();

test("local installer receives official updates without a release environment or private key", () => {
  const prepared = prepareLocalBuild({ VITE_UPDATER_ENABLED: "false" }, template, key, ["--target", "x86_64-pc-windows-msvc"]);
  assert.equal(prepared.env.VITE_UPDATER_ENABLED, "true");
  assert.equal(prepared.config.plugins.updater.pubkey, key);
  assert.deepEqual(prepared.config.plugins.updater.endpoints, [UPDATE_ENDPOINT]);
  assert.equal(prepared.config.plugins.updater.windows?.installerArgs, undefined);
  assert.equal(prepared.config.bundle.createUpdaterArtifacts, false);
  assert.deepEqual(prepared.args.slice(0, 3), ["build", "--target", "x86_64-pc-windows-msvc"]);
  assert.deepEqual(JSON.parse(prepared.args.at(-1)), prepared.config);
  assert.equal(template.plugins.updater.pubkey, "__TAURI_UPDATER_PUBLIC_KEY__");
  assert.equal(template.bundle.createUpdaterArtifacts, true);
});

test("local build omits signing secrets and accepts an explicit public key", () => {
  const prepared = prepareLocalBuild({ TAURI_UPDATER_PUBLIC_KEY: key, TAURI_SIGNING_PRIVATE_KEY: "private-test", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "password-test" }, template);
  assert.equal(prepared.env.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(prepared.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined);
  assert.equal(JSON.stringify(prepared.config).includes("private-test"), false);
});

test("local build rejects absent keys, invalid keys and channel overrides", () => {
  for (const invalidKey of ["", "not-a-public-key", Buffer.from("x".repeat(120)).toString("base64")]) {
    assert.throws(() => prepareLocalBuild({}, template, invalidKey));
  }
  for (const args of [["--config", "other.json"], ["--config=other.json"], ["-c", "other.json"]]) {
    assert.throws(() => prepareLocalBuild({}, template, key, args));
  }
  const otherChannel = structuredClone(template);
  otherChannel.plugins.updater.endpoints = ["https://example.com/latest.json"];
  assert.throws(() => prepareLocalBuild({}, otherChannel, key));
});

test("saved official public key contains a minisign Ed25519 key", () => {
  const [comment, payload] = Buffer.from(key, "base64").toString("utf8").trim().split(/\r?\n/);
  assert.match(comment, /^untrusted comment: minisign public key: /);
  const bytes = Buffer.from(payload, "base64");
  assert.equal(bytes.length, 42);
  assert.equal(bytes.subarray(0, 2).toString("ascii"), "Ed");
});
