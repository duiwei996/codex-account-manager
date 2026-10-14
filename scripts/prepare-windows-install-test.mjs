import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
// Use the public config interface, never rewrite a third-party template for tests.
const [testName, testRoot, testHooks] = process.argv.slice(2);
if (!/^CodexInstallerRegression-[a-f0-9]+$/.test(testName || "")) throw new Error("Invalid fixture identity");
const root = process.cwd();
if (!resolve(testRoot).startsWith(resolve(root, ".tmp") + "\\")) throw new Error("Fixture output must stay in .tmp");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
copyFileSync("src-tauri/target/release/codex-account-manager.exe", "src-tauri/target/release/fixture-manager.exe");
const config = {
  productName: testName, mainBinaryName: "fixture-manager", identifier: "com.duiwei996.installer-regression",
  bundle: { createUpdaterArtifacts: false, windows: { nsis: { installerHooks: testHooks } } },
};
const result = spawnSync(process.execPath, ["node_modules/@tauri-apps/cli/tauri.js", "bundle", "--ci", "--bundles", "nsis", "--config", JSON.stringify(config)], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.status !== 0) throw new Error("Fixture bundling failed");
const payload = join(root, "src-tauri", "target", "release", "bundle", "nsis", `${testName}_${version}_x64-setup.exe`);
if (!existsSync(payload)) throw new Error("Fixture installer missing");
copyFileSync(payload, join(testRoot, "official-test-setup.exe"));
