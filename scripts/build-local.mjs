import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createUpdaterConfig } from "./updater-config.mjs";
import { wrapWindowsInstaller } from "./wrap-windows-installer.mjs";
import { runPreflight } from "./release-preflight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keyFile = join(root, "src-tauri", "updater-public-key.txt");

export function checkedLocalBuild({ check, build }) {
  check();
  return build();
}

export function shouldWrapWindowsInstaller(args) {
  if (args.includes("--no-bundle")) return false;
  const inline = args.find(arg => arg.startsWith("--bundles="));
  if (inline) return inline.slice(10).split(",").includes("nsis");
  const index = args.findIndex(arg => arg === "--bundles" || arg === "-b");
  if (index < 0) return true;
  const bundles = [];
  for (const arg of args.slice(index + 1)) {
    if (arg.startsWith("-")) break;
    bundles.push(...arg.split(","));
  }
  return bundles.includes("nsis");
}

export function prepareLocalBuild(env, template, savedPublicKey = "", args = []) {
  // Keep the update channel and enabled flag consistent for both compiled runtimes.
  if (args.some(arg => arg === "-c" || arg.startsWith("-c=") || arg === "--config" || arg.startsWith("--config="))) {
    throw new Error("build:local owns the updater configuration; do not pass --config.");
  }
  const config = createUpdaterConfig(template, env.TAURI_UPDATER_PUBLIC_KEY || savedPublicKey);
  const childEnv = { ...env, VITE_UPDATER_ENABLED: "true" };
  // Receiving signed updates does not require generating or signing update artifacts.
  delete childEnv.TAURI_SIGNING_PRIVATE_KEY;
  delete childEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  return { config, env: childEnv, args: ["build", ...args, "--config", JSON.stringify(config)] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const template = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.release.conf.template.json"), "utf8"));
    const savedPublicKey = existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "";
    const prepared = prepareLocalBuild(process.env, template, savedPublicKey, process.argv.slice(2));
    console.log("Building a local installer with the official update channel enabled (public key only).");
    const result = checkedLocalBuild({
      check: () => runPreflight({ full: true, env: prepared.env }),
      build: () => spawnSync(process.execPath, [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), ...prepared.args], {
        cwd: root,
        env: prepared.env,
        stdio: "inherit",
      }),
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    if (result.status === 0 && process.platform === "win32" && shouldWrapWindowsInstaller(process.argv.slice(2))) {
      const targetIndex = process.argv.indexOf("--target");
      const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : process.argv.find(arg => arg.startsWith("--target="))?.slice(9) || "";
      wrapWindowsInstaller({ target, env: prepared.env });
    }
  } catch (error) {
    console.error("LOCAL BUILD BLOCKED: " + (error instanceof Error ? error.message : "unknown error"));
    process.exitCode = 1;
  }
}
