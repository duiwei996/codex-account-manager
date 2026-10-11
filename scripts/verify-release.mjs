import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const expectedPlatforms = ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"];
export function normalizeReleaseMetadata(metadata, assets, version) {
  const normalized = structuredClone(metadata);
  const apiPrefix = "https://api.github.com/repos/duiwei996/codex-account-manager/releases/assets/";
  const downloadPrefix = `https://github.com/duiwei996/codex-account-manager/releases/download/v${version}/`;
  for (const entry of Object.values(normalized.platforms ?? {})) {
    if (typeof entry.url !== "string" || !entry.url.startsWith(apiPrefix)) continue;
    const asset = assets.find(asset => typeof asset === "object" &&
      (asset.apiUrl === entry.url || asset.url === entry.url || `${apiPrefix}${asset.id}` === entry.url));
    if (!asset?.name) throw new Error("Updater URL references an unknown release asset");
    entry.url = downloadPrefix + encodeURIComponent(asset.name);
  }
  verifyRelease(normalized, assets, version);
  return normalized;
}
export function verifyRelease(metadata, assets, version) {
  if (metadata.version !== version) throw new Error("Updater version does not match the project");
  const names = new Set(assets.map(asset => typeof asset === "string" ? asset : asset.name));
  const prefix = `https://github.com/duiwei996/codex-account-manager/releases/download/v${version}/`;
  for (const platform of expectedPlatforms) {
    const entry = metadata.platforms?.[platform];
    if (!entry?.signature || typeof entry.signature !== "string" || !entry.url?.startsWith(prefix)) throw new Error(`Missing or invalid signed platform: ${platform}`);
    const filename = decodeURIComponent(new URL(entry.url).pathname.split("/").at(-1));
    if (!names.has(filename) || !names.has(filename + ".sig")) throw new Error(`Missing updater package/signature for ${platform}`);
  }
  return true;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const metadata = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const release = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  if (!release.isDraft) throw new Error("Release must remain a draft until all platforms are verified");
  const normalized = normalizeReleaseMetadata(metadata, release.assets, version);
  writeFileSync(process.argv[2], JSON.stringify(normalized, null, 2) + "\n");
  console.log("All four updater platforms have matching versions, packages and signatures.");
}
