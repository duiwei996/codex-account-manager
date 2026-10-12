import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const components = [
  "../src/App.tsx",
  "../src/TrayMenu.tsx",
  "../src/components/AccountCard.tsx",
  "../src/components/AccountUsageStats.tsx",
  "../src/components/AddAccountModal.tsx",
  "../src/components/ResetCreditsMenu.tsx",
  "../src/components/UsageBar.tsx",
  "../src/components/UpdateChecker.tsx",
];

test("translated JSX never contains bare attribute expressions", () => {
  for (const file of components) {
    const code = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(code, /[\w-]+=t\(/, file + " has invalid JSX syntax");
  }
});

test("frontend languages include Chinese plus English fallback", () => {
  const code = readFileSync(new URL("../src/lib/i18n.ts", import.meta.url), "utf8");
  assert.match(code, /"zh-CN"/);
  assert.match(code, /"en-US"/);
  assert.match(code, /function tr\(/);
  const chinese = readFileSync(new URL("../src/lib/locales/zh-CN.ts", import.meta.url), "utf8");
  const english = readFileSync(new URL("../src/lib/locales/en-US.ts", import.meta.url), "utf8");
  assert.match(chinese, /"All": "全部"/);
  assert.match(english, /"All": "All"/);
});

test("untrusted development builds never turn on the updater by default", () => {
  const cfg = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(cfg.bundle.createUpdaterArtifacts, false);
  assert.equal(cfg.plugins?.updater, undefined);
  const ui = readFileSync(new URL("../src/hooks/useAppUpdater.ts", import.meta.url), "utf8");
  assert.match(ui, /VITE_UPDATER_ENABLED/);
});
