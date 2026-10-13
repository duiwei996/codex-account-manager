import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { createUpdaterConfig } from "./updater-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateFile = join(root, "src-tauri", "tauri.release.conf.template.json");
const outputFile = join(root, "src-tauri", "tauri.release.conf.json");

// A signer private key is never written, logged, or embedded in release metadata.
export function prepareRelease(env, template) {
  if (env.GITHUB_REPOSITORY !== "duiwei996/codex-account-manager") {
    throw new Error("Release is restricted to the project repository.");
  }
  if (env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Release must originate from the audited main branch.");
  }
  const privateKey = env.TAURI_SIGNING_PRIVATE_KEY || "";
  if (!privateKey.trim()) {
    throw new Error("Missing TAURI_SIGNING_PRIVATE_KEY GitHub Actions secret.");
  }
  if (!template?.bundle?.createUpdaterArtifacts) {
    throw new Error("Invalid release-only Tauri updater overlay.");
  }
  const config = createUpdaterConfig(template, env.TAURI_UPDATER_PUBLIC_KEY, true);
  // Require one source version across package metadata and both Tauri configs.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const tauri = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const cargo = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.version !== tauri.version || pkg.version !== cargoVersion) {
    throw new Error("Release versions disagree across package.json, Cargo.toml, and Tauri config.");
  }
  if (tauri.identifier !== "com.duiwei996.codex-switcher-cn") {
    throw new Error("Unexpected project application identifier.");
  }
  return { config, version: pkg.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const template = JSON.parse(readFileSync(templateFile, "utf8"));
    const prepared = prepareRelease(process.env, template);
    writeFileSync(outputFile, JSON.stringify(prepared.config, null, 2) + "\n", { flag: "w", mode: 0o600 });
    console.log("Release updater overlay configured for v" + prepared.version + " (public key only).");
  } catch (error) {
    console.error("RELEASE BLOCKED: " + (error instanceof Error ? error.message : "unknown error"));
    process.exitCode = 1;
  }
}
