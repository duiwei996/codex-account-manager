import assert from "node:assert/strict";
import { after, test } from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const server = await createServer({ configFile: false, plugins: [react()],
  server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
const { AccountCard } = await server.ssrLoadModule("/src/components/AccountCard.tsx");
after(async () => { await server.close(); dom.window.close(); });

async function withCard(overrides, check) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const calls = [];
  const props = { account: { id: "saved", name: "Saved account", is_active: true, auth_mode: "api_key" },
    onSwitch: () => calls.push("switch"), onRestart: () => calls.push("restart"),
    onWarmup: async () => {}, onDelete: () => {}, onExport: () => {}, onRefresh: async () => {}, onRename: async () => {},
    ...overrides };
  try {
    await act(async () => root.render(createElement(AccountCard, props)));
    await check(container, calls);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

test("the current account can invoke restart while retaining its active indicator", async () => {
  await withCard({}, async (container, calls) => {
    const button = [...container.querySelectorAll("button")].find(button => button.textContent === "重启");
    assert.ok(button);
    assert.equal(button.disabled, false);
    assert.match(button.title, /重新应用此账号/);
    await act(async () => button.click());
    assert.deepEqual(calls, ["restart"]);
  });
});

test("restart cannot run while another switch is busy or desktop actions are unavailable", async () => {
  for (const overrides of [{ switching: true }, { switchDisabled: true }, { readOnly: true }, { desktopActions: false }]) {
    await withCard(overrides, async (container, calls) => {
      const button = [...container.querySelectorAll("button")].find(button => button.title.includes("重新应用此账号"));
      assert.equal(button.disabled, true);
      await act(async () => button.click());
      assert.deepEqual(calls, []);
    });
  }
});

test("other accounts keep their normal switch action", async () => {
  await withCard({ account: { id: "other", name: "Other account", is_active: false, auth_mode: "api_key" } }, async (container, calls) => {
    const button = [...container.querySelectorAll("button")].find(button => button.textContent === "切换");
    assert.ok(button);
    await act(async () => button.click());
    assert.deepEqual(calls, ["switch"]);
  });
});

test("invalid active and inactive accounts offer login instead of switch or restart", async () => {
  for (const is_active of [true, false]) {
    let logins = 0;
    await withCard({account: {id: "invalid", name: "Invalid", is_active, auth_mode: "api_key", credentials_invalid: true},
      onRelogin: () => logins++}, async (container, calls) => {
      const buttons = [...container.querySelectorAll("button")];
      const login = buttons.find(button => button.textContent === "重新登录");
      assert.ok(login && !login.disabled);
      assert.match(container.firstElementChild.className, /border-red-500/);
      assert.match(container.textContent, /登录已失效/);
      if (is_active) assert.match(container.textContent, /当前/);
      assert.ok(!buttons.some(button => button.textContent === "切换" || button.textContent === "重启"));
      assert.equal(buttons.find(button => button.title === "刷新用量").disabled, true);
      await act(async () => login.click());
      assert.equal(logins, 1);
      assert.deepEqual(calls, []);
    });
  }
});
