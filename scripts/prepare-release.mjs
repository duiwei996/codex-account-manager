import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

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
  const publicKey = (env.TAURI_UPDATER_PUBLIC_KEY || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey) || publicKey.length < 80) {
    throw new Error("Missing or invalid TAURI_UPDATER_PUBLIC_KEY GitHub Actions variable.");
  }
  const decoded = Buffer.from(publicKey, "base64").toString("utf8");
  if (!decoded.startsWith("untrusted comment: minisign public key:")) {
    throw new Error("Updater public key is not a Tauri minisign public key.");
  }
  const config = structuredClone(template);
  if (!config?.plugins?.updater || !config?.bundle?.createUpdaterArtifacts) {
    throw new Error("Invalid release-only Tauri updater overlay.");
  }
  const [endpoint] = config.plugins.updater.endpoints ?? [];
  if (endpoint !== "https://github.com/duiwei996/codex-account-manager/releases/latest/download/latest.json") {
    throw new Error("Updater endpoint must be this project's GitHub Releases.");
  }
  config.plugins.updater.pubkey = publicKey;
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
