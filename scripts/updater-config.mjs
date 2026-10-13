export const UPDATE_ENDPOINT = "https://github.com/duiwei996/codex-account-manager/releases/latest/download/latest.json";

// Shared by local installers and signed releases. Only public material is embedded.
export function createUpdaterConfig(template, publicKey, createUpdaterArtifacts = false) {
  const key = (publicKey || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key) || key.length < 80) {
    throw new Error("Missing or invalid TAURI_UPDATER_PUBLIC_KEY. Use the public key from this repository's Actions Variables.");
  }
  const decoded = Buffer.from(key, "base64").toString("utf8");
  if (!decoded.startsWith("untrusted comment: minisign public key:")) {
    throw new Error("Updater public key is not a Tauri minisign public key.");
  }
  const config = structuredClone(template);
  if (!config?.plugins?.updater || !config?.bundle) {
    throw new Error("Invalid Tauri updater overlay.");
  }
  if (config.plugins.updater.endpoints?.length !== 1 || config.plugins.updater.endpoints[0] !== UPDATE_ENDPOINT) {
    throw new Error("Updater endpoint must be this project's GitHub Releases.");
  }
  config.plugins.updater.pubkey = key;
  config.bundle.createUpdaterArtifacts = createUpdaterArtifacts;
  return config;
}
