import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppUpdater, type AppUpdate } from "../src/lib/appUpdater.ts";

function update(version = "1.0.2", downloadAndInstall: AppUpdate["downloadAndInstall"] = async () => {}) {
  let closed = 0;
  return {
    value: { version, body: "Release notes", downloadAndInstall, close: async () => { closed++; } },
    closed: () => closed,
  };
}

test("disabled builds never call the updater backend", async () => {
  const updater = createAppUpdater({ enabled: false, check: async () => { throw new Error("must not check"); }, relaunch: async () => { throw new Error("must not restart"); } });
  await updater.checkForUpdate();
  await updater.downloadAndInstall();
  await updater.restart();
  assert.equal(updater.getSnapshot().status.kind, "idle");
});

test("manual and automatic checks share one request and report the current version result", async () => {
  let calls = 0;
  let resolveCheck!: (result: null) => void;
  const updater = createAppUpdater({ enabled: true, check: () => { calls++; return new Promise(resolve => { resolveCheck = resolve; }); }, relaunch: async () => {} });
  const pending = updater.checkForUpdate();
  await updater.checkForUpdate();
  assert.equal(calls, 1);
  assert.equal(updater.getSnapshot().status.kind, "checking");
  resolveCheck(null);
  await pending;
  assert.equal(updater.getSnapshot().status.kind, "current");
});

test("check errors are visible and a manual retry clears the dismissed state", async () => {
  const available = update();
  let fail = true;
  const updater = createAppUpdater({ enabled: true, check: async () => { if (fail) throw new Error("Network unavailable"); return available.value; }, relaunch: async () => {} });
  await updater.checkForUpdate();
  assert.deepEqual(updater.getSnapshot().status, { kind: "error", phase: "check", message: "Network unavailable" });
  updater.dismiss();
  assert.equal(updater.getSnapshot().dismissed, true);
  fail = false;
  await updater.checkForUpdate();
  assert.equal(updater.getSnapshot().dismissed, false);
  assert.equal(updater.getSnapshot().status.kind, "available");
});

test("rechecking releases the previous backend resource", async () => {
  const first = update();
  const second = update("1.0.3");
  const results = [first.value, second.value, null];
  const updater = createAppUpdater({ enabled: true, check: async () => results.shift() ?? null, relaunch: async () => {} });
  await updater.checkForUpdate();
  await updater.checkForUpdate();
  assert.equal(first.closed(), 1);
  assert.equal(second.closed(), 0);
  await updater.checkForUpdate();
  assert.equal(second.closed(), 1);
});

test("checks and duplicate installs cannot interrupt download, installation or pending restart", async () => {
  let finishInstall!: () => void;
  let calls = 0;
  let installs = 0;
  const available = update("1.0.2", async onEvent => {
    installs++;
    onEvent?.({ event: "Started", data: { contentLength: 100 } });
    onEvent?.({ event: "Progress", data: { chunkLength: 50 } });
    await new Promise<void>(resolve => { finishInstall = resolve; });
    onEvent?.({ event: "Finished" });
  });
  const updater = createAppUpdater({ enabled: true, check: async () => { calls++; return available.value; }, relaunch: async () => {} });
  await updater.checkForUpdate();
  const installing = updater.downloadAndInstall();
  await updater.checkForUpdate();
  await updater.downloadAndInstall();
  assert.deepEqual(updater.getSnapshot().status, { kind: "downloading", downloaded: 50, total: 100 });
  assert.equal(calls, 1);
  assert.equal(installs, 1);
  finishInstall();
  await installing;
  assert.equal(updater.getSnapshot().status.kind, "ready");
  assert.equal(available.closed(), 1);
  await updater.checkForUpdate();
  assert.equal(updater.getSnapshot().status.kind, "ready");
  assert.equal(calls, 1);
});

test("failed installations never become ready and can be retried after a fresh check", async () => {
  const available = update("1.0.2", async () => { throw new Error("Installer failed"); });
  const updater = createAppUpdater({ enabled: true, check: async () => available.value, relaunch: async () => { throw new Error("must not restart"); } });
  await updater.checkForUpdate();
  await updater.downloadAndInstall();
  assert.deepEqual(updater.getSnapshot().status, { kind: "error", phase: "install", message: "Installer failed" });
  await updater.restart();
  assert.equal(updater.getSnapshot().status.kind, "error");
});

test("restart failures stay visible and retain the ability to retry restarting", async () => {
  const available = update();
  let restarts = 0;
  const updater = createAppUpdater({ enabled: true, check: async () => available.value, relaunch: async () => { restarts++; if (restarts === 1) throw new Error("Restart failed"); } });
  await updater.restart();
  assert.equal(restarts, 0);
  await updater.checkForUpdate();
  await updater.downloadAndInstall();
  await updater.restart();
  assert.deepEqual(updater.getSnapshot().status, { kind: "error", phase: "restart", message: "Restart failed" });
  await updater.checkForUpdate();
  assert.equal(updater.getSnapshot().status.kind, "error");
  await updater.restart();
  assert.equal(restarts, 2);
});
