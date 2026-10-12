import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyRelease } from "./verify-release.mjs";

export function generateReleaseMetadata(release, version, readSignature) {
  if (!release.isDraft) throw new Error("Release must remain a draft while generating update metadata");
  if (release.tagName !== `v${version}`) throw new Error("Release tag does not match the project version");
  if (!release.createdAt || !Number.isFinite(Date.parse(release.createdAt))) throw new Error("Missing release timestamp");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = `^Codex[ .]Account[ .]Manager_${escapedVersion}_`;
  const patterns = {
    "linux-x86_64": [new RegExp(prefix + "amd64\\.AppImage$")],
    // Match tauri-action's existing preference for MSI over NSIS.
    "windows-x86_64": [new RegExp(prefix + "x64_[A-Za-z-]+\\.msi$"), new RegExp(prefix + "x64-setup\\.exe$")],
    "darwin-aarch64": [new RegExp(prefix + "aarch64\\.app\\.tar\\.gz$")],
    "darwin-x86_64": [new RegExp(prefix + "x64\\.app\\.tar\\.gz$")],
  };
  const assets = release.assets;
  if (!Array.isArray(assets)) throw new Error("Missing release assets");
  const names = assets.map(asset => asset.name);
  if (names.some(name => typeof name !== "string" || basename(name) !== name || name.includes("\\")) || new Set(names).size !== names.length) {
    throw new Error("Invalid or duplicate release asset names");
  }
  const metadata = {
    version,
    notes: release.body ?? "",
    pub_date: new Date(release.createdAt).toISOString(),
    platforms: {},
  };
  for (const [platform, candidates] of Object.entries(patterns)) {
    let matches = [];
    for (const pattern of candidates) {
      matches = names.filter(name => pattern.test(name));
      if (matches.length) break;
    }
    if (matches.length !== 1) throw new Error(`Expected exactly one updater package for ${platform}`);
    const [name] = matches;
    if (!names.includes(name + ".sig")) throw new Error(`Missing updater signature for ${platform}`);
    const signature = readSignature(name + ".sig").trim();
    if (!signature) throw new Error(`Empty updater signature for ${platform}`);
    metadata.platforms[platform] = {
      signature,
      url: `https://github.com/duiwei996/codex-account-manager/releases/download/v${version}/${encodeURIComponent(name)}`,
    };
  }
  verifyRelease(metadata, assets, version);
  return metadata;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const release = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const metadata = generateReleaseMetadata(release, version, name => readFileSync(join(process.argv[3], name), "utf8"));
  writeFileSync(process.argv[4], JSON.stringify(metadata, null, 2) + "\n");
  console.log("Generated one complete updater manifest from all four platforms.");
}
