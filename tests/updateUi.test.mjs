import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const server = await createServer({
  configFile: false,
  plugins: [react()],
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: "custom",
});
after(() => server.close());
const { UpdateSettings } = await server.ssrLoadModule("/src/components/UpdateSettings.tsx");
const { UpdateChecker } = await server.ssrLoadModule("/src/components/UpdateChecker.tsx");

function updater(status, overrides = {}) {
  return {
    enabled: true, version: "1.0.2", status, dismissed: false,
    checkForUpdate: async () => {}, downloadAndInstall: async () => {}, restart: async () => {}, dismiss: () => {},
    ...overrides,
  };
}
const renderSettings = value => renderToStaticMarkup(createElement(UpdateSettings, { updater: value }));

test("settings show the current version and a usable manual check button", () => {
  const html = renderSettings(updater({ kind: "idle" }));
  assert.match(html, /当前版本/);
  assert.match(html, /v1\.0\.2/);
  assert.match(html, /检查更新/);
  assert.doesNotMatch(html, /\sdisabled(?:=|\s|>)/);
});

test("settings distinguish checking, up-to-date and unavailable builds", () => {
  assert.match(renderSettings(updater({ kind: "checking" })), /正在检查更新/);
  assert.match(renderSettings(updater({ kind: "checking" })), /\sdisabled(?:=|\s|>)/);
  assert.match(renderSettings(updater({ kind: "current" })), /当前已是最新版本/);
  const disabled = renderSettings(updater({ kind: "idle" }, { enabled: false }));
  assert.match(disabled, /网页版不支持桌面应用更新/);
  assert.match(disabled, /\sdisabled(?:=|\s|>)/);
  assert.doesNotMatch(disabled, /当前已是最新版本/);
});

test("settings show release notes as text and make an available update actionable", () => {
  const html = renderSettings(updater({ kind: "available", update: { version: "1.0.3", body: "<script>unsafe()</script>" } }));
  assert.match(html, /发现新版本：v1\.0\.3/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, />更新<\/button>/);
});

test("download and installation feedback prevent another check", () => {
  const download = renderSettings(updater({ kind: "downloading", downloaded: 50, total: 100 }));
  assert.match(download, /50%/);
  assert.match(download, /<progress/);
  assert.match(download, /\sdisabled(?:=|\s|>)/);
  assert.match(renderSettings(updater({ kind: "installing" })), /正在安装更新/);
  assert.match(renderSettings(updater({ kind: "ready" })), />重新启动<\/button>/);
});

test("check errors are visible and restart failures keep the restart action", () => {
  const error = renderSettings(updater({ kind: "error", phase: "check", message: "Network unavailable" }));
  assert.match(error, /role="alert"/);
  assert.match(error, /Network unavailable/);
  assert.match(renderSettings(updater({ kind: "error", phase: "restart", message: "Restart failed" })), />重新启动<\/button>/);
});

test("the automatic update notice is hidden while settings are open and reappears on close", () => {
  const value = updater({ kind: "available", update: { version: "1.0.3" } });
  assert.equal(renderToStaticMarkup(createElement(UpdateChecker, { updater: value, settingsOpen: true })), "");
  assert.match(renderToStaticMarkup(createElement(UpdateChecker, { updater: value, settingsOpen: false })), /发现新版本/);
});
