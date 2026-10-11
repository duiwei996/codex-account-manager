import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import zh from "../src/lib/locales/zh-CN.ts";
import en from "../src/lib/locales/en-US.ts";
import { localizeError } from "../src/lib/errors.ts";
import { mergeUsageResult } from "../src/lib/usageDisplay.ts";
import type { UsageInfo } from "../src/types";

test("language catalogs cover every static UI translation and share keys", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const paths = ["src/App.tsx", ...readdirSync("src/components").filter(name => name.endsWith(".tsx")).map(name => `src/components/${name}`)];
  for (const path of paths) {
    for (const match of readFileSync(path, "utf8").matchAll(/\bt\("([^"\n]+)"\)/g)) {
      assert.ok(zh[match[1]], `${path}: missing Chinese text for ${match[1]}`);
    }
  }
  assert.equal(zh.off, "已关闭");
  assert.equal(en.off, "off");
  assert.ok(!Object.values(en).some(text => /[\u4e00-\u9fff]/.test(text)));
});

test("authentication, network and import errors follow the selected language", () => {
  assert.match(localizeError("Account name must contain 1–120 characters and no control characters", "zh-CN"), /账号名称/);
  assert.match(localizeError("API error: 401 Unauthorized", "zh-CN"), /登录验证失败/);
  assert.match(localizeError("API error: 403 Forbidden", "zh-CN"), /请求被拒绝/);
  assert.match(localizeError("error sending request", "zh-CN"), /网络请求失败/);
  assert.equal(localizeError("不是有效的 JSON 文件", "en-US"), "The file is not valid JSON");
  assert.match(localizeError("Account store is busy; retry after the other operation finishes", "en-US"), /busy/);
});

test("refresh failure retains last known usage with an explicit stale error", () => {
  const previous = {account_id:"a",plan_type:"team",primary_used_percent:25,secondary_used_percent:60,primary_resets_at:1900000000,secondary_resets_at:1900100000,credits_balance:"20",recorded_at:"2026-10-11T03:00:00Z",error:null} as UsageInfo;
  const failed = {account_id:"a",primary_used_percent:null,secondary_used_percent:null,error:"network unavailable"} as UsageInfo;
  const stale = mergeUsageResult(previous, failed);
  assert.equal(stale.primary_used_percent,25);
  assert.equal(stale.secondary_used_percent,60);
  assert.equal(stale.error,failed.error);
  assert.equal(stale.primary_resets_at,previous.primary_resets_at);
  assert.equal(stale.secondary_resets_at,previous.secondary_resets_at);
  assert.equal(stale.plan_type,"team");
  assert.equal(stale.credits_balance,"20");
  assert.equal(stale.recorded_at,previous.recorded_at);
  assert.equal(mergeUsageResult(stale,failed).recorded_at,previous.recorded_at);
  assert.equal(previous.error,null);
  assert.equal(mergeUsageResult(undefined,failed),failed);
  const recovered = {...previous, primary_used_percent:30};
  assert.deepEqual(mergeUsageResult(stale,recovered),recovered);
});

test("partial account details survive errors and never migrate to another account", () => {
  const previous = {account_id:"a",plan_type:"plus",credits_balance:"12",error:null} as UsageInfo;
  const failed = {account_id:"a",error:"failed"} as UsageInfo;
  assert.equal(mergeUsageResult(previous,failed).credits_balance,"12");
  assert.equal(mergeUsageResult(previous,{...failed,account_id:"b"}).credits_balance,undefined);
  const fresh = mergeUsageResult(undefined,previous);
  assert.ok(fresh.recorded_at && Number.isFinite(Date.parse(fresh.recorded_at)));
});
