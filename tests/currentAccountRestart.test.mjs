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
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
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

test("account cards copy the full email and keep the team label visible alongside login status", async (t) => {
  const email = "member@example.com";
  const copied = [];
  const clipboard = { writeText: async value => { copied.push(value); } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: clipboard });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis.navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(globalThis.navigator, "clipboard");
  });

  const account = { id: "team-email", name: "Team account", email, auth_mode: "chat_g_p_t",
    is_active: false, plan_type: "team", credentials_invalid: true };
  await withCard({ account }, async container => {
    assert.ok([...container.querySelectorAll("header span")].some(span => span.textContent === "team"));
    assert.match(container.textContent, /登录已失效/);
    const button = container.querySelector('button[aria-label="复制邮箱"]');
    assert.equal(button.previousElementSibling.textContent, email);
    await act(async () => button.click());
    assert.deepEqual(copied, [email]);
    assert.equal(button.title, "已复制");

    clipboard.writeText = async () => { throw new Error("Clipboard unavailable"); };
    await act(async () => button.click());
    assert.match(container.querySelector('[role="status"]').textContent, /请手动复制/);
  });
  await withCard({ account, masked: true }, async container => {
    assert.equal(container.querySelector('button[aria-label="复制邮箱"]').disabled, true);
  });
});

test("an expired team account accepts a manual display plan and can return to automatic", async () => {
  const plan = "self_serve_business_usage_based";
  const account = { id: "manual-plan", name: "Team account", auth_mode: "chat_g_p_t",
    is_active: false, plan_type: "team", credentials_invalid: true };

  for (const [current, next] of [[null, plan], [plan, null]]) {
    const changes = [];
    await withCard({
      account: { ...account, display_plan_override: current },
      onChangeDisplayPlan: async value => { changes.push(value); },
    }, async container => {
      assert.match(container.textContent, /登录已失效/);
      const button = container.querySelector('button[aria-label="更改显示套餐"]');
      assert.equal(button.textContent, "team");
      const [titleRow, detailsRow] = container.querySelector("header").children;
      assert.doesNotMatch(titleRow.textContent, /登录已失效|团队按量付费/);
      assert.match(detailsRow.textContent, /登录已失效/);
      if (current) {
        const label = [...detailsRow.querySelectorAll("span")].find(span => span.textContent === "团队按量付费（手动）");
        assert.ok(label?.classList.contains("whitespace-nowrap"));
      }
      await act(async () => button.click());
      const select = container.querySelector("select");
      assert.equal(select.value, current ?? "");
      select.value = next ?? "";
      await act(async () => select.dispatchEvent(new window.Event("change", { bubbles: true })));
      assert.deepEqual(changes, [next]);
      assert.equal(container.querySelector("select"), null);
    });
  }
  await withCard({
    account: { ...account, display_plan_override: plan, credentials_invalid: false, risk_controlled: true },
    onChangeDisplayPlan: async () => { assert.fail("Healthy accounts cannot edit their plan"); },
  }, async container => {
    assert.equal(container.querySelector('button[aria-label="更改显示套餐"]'), null);
    assert.doesNotMatch(container.textContent, /团队按量付费|手动/);
  });
});

test("a server-confirmed pay-as-you-go account can sign in again without showing expired credentials", async () => {
  const account = { id: "valid-payg", name: "Team account", email: "member@example.com",
    is_active: false, auth_mode: "chat_g_p_t", plan_type: "self_serve_business_usage_based" };
  let relogins = 0;
  await withCard({ account, onRelogin() { relogins++; } }, async container => {
    const [titleRow, detailsRow] = container.querySelector("header").children;
    assert.match(titleRow.textContent, /team$/);
    assert.doesNotMatch(titleRow.textContent, /团队按量付费/);
    assert.match(detailsRow.textContent, /member@example\.com.*团队按量付费/);
    assert.doesNotMatch(container.textContent, /登录已失效/);
    const login = [...container.querySelectorAll("button")].find(button => button.textContent === "重新登录");
    assert.ok(login && !login.disabled);
    await act(async () => login.click());
    assert.equal(relogins, 1);
    assert.equal(container.querySelector('[aria-label="刷新用量"]').disabled, false);
  });
});

test("invalid active and inactive accounts offer login instead of switch or restart", async () => {
  for (const is_active of [true, false]) {
    let logins = 0;
    let refreshes = 0;
    await withCard({account: {id: "invalid", name: "Invalid", is_active, auth_mode: "api_key", credentials_invalid: true},
      onRelogin: () => logins++, onRefresh: async () => { refreshes++; }}, async (container, calls) => {
      const buttons = [...container.querySelectorAll("button")];
      const login = buttons.find(button => button.textContent === "重新登录");
      assert.ok(login && !login.disabled);
      assert.match(container.firstElementChild.className, /border-red-500/);
      assert.match(container.textContent, /登录已失效/);
      if (is_active) assert.match(container.textContent, /当前/);
      assert.ok(!buttons.some(button => button.textContent === "切换" || button.textContent === "重启"));
      assert.equal(buttons.find(button => button.title === "刷新用量").disabled, false);
      await act(async () => buttons.find(button => button.title === "刷新用量").click());
      assert.equal(refreshes, 1);
      await act(async () => login.click());
      assert.equal(logins, 1);
      assert.deepEqual(calls, []);
    });
  }
});


test("account cards provide reversible risk controls", async () => {
  for (const risk_controlled of [false, true]) {
    let moved = 0;
    await withCard({
      account: { id: "risk-test", name: "Risk test", is_active: false, auth_mode: "api_key", risk_controlled },
      onToggleRisk: async () => { moved++; },
    }, async container => {
      const buttons = [...container.querySelectorAll("button")];
      const move = buttons.find(button => /Move to risk control|移入风控|Move out of risk control|移出风控/.test(button.getAttribute("aria-label") ?? button.textContent));
      assert.ok(move);
      assert.equal(move.textContent, "");
      assert.ok(move.querySelector("svg"));
      assert.match(move.getAttribute("aria-label"), risk_controlled ? /Move out|移出/ : /Move to|移入/);
      await act(async () => move.click());
      assert.equal(moved, 1);
    });
  }
});


test("display cache preserves risk isolation across reloads", async () => {
  const cache = await server.ssrLoadModule("/src/lib/accountCache.ts");
  const account = { id: "cached-risk", name: "Cached risk", is_active: false, auth_mode: "api_key", risk_controlled: true };
  cache.writeAccountCache([account]);
  assert.equal(cache.readAccountCache()[0]?.risk_controlled, true);
  cache.writeAccountCache([{ ...account, risk_controlled: false }]);
  assert.equal(cache.readAccountCache()[0]?.risk_controlled, false);
});
