import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRelease, normalizeReleaseMetadata } from "../scripts/verify-release.mjs";
const version = "1.2.3";
function fixture() {
  const filename = platform => platform.startsWith("windows-") ? `Codex.Account.Manager_${version}_${platform.endsWith("-msi") ? "x64_en-US.msi" : "x64-setup.exe"}` : platform + ".zip";
  const platforms = Object.fromEntries(["linux-x86_64", "windows-x86_64", "windows-x86_64-nsis", "windows-x86_64-msi", "darwin-aarch64", "darwin-x86_64"].map(platform => [platform, { signature: "signature", url: `https://github.com/duiwei996/codex-account-manager/releases/download/v${version}/${filename(platform)}` }]));
  return { metadata: { version, platforms }, assets: Object.keys(platforms).flatMap(platform => [filename(platform), filename(platform) + ".sig"]) };
}
test("a complete signed release includes all four platforms", () => {
  const { metadata, assets } = fixture();
  assert.equal(verifyRelease(metadata, assets, version), true);
});

test("MSI cannot replace the legacy EXE update even with matching signatures", () => {
  const { metadata, assets } = fixture();
  const msi = `Codex.Account.Manager_${version}_x64_en-US.msi`;
  assets.push(msi, msi + ".sig");
  metadata.platforms["windows-x86_64"].url = `https://github.com/duiwei996/codex-account-manager/releases/download/v${version}/${msi}`;
  assert.throws(() => verifyRelease(metadata, assets, version), /installer type/);
  assert.throws(() => normalizeReleaseMetadata(metadata, assets, version), /installer type/);
});

test("installer types cannot be swapped and bundle-specific entries cannot be missing", () => {
  for (const target of ["windows-x86_64-nsis", "windows-x86_64-msi"]) {
    const { metadata, assets } = fixture();
    const other = target.endsWith("-msi") ? "windows-x86_64-nsis" : "windows-x86_64-msi";
    metadata.platforms[target] = metadata.platforms[other];
    assert.throws(() => verifyRelease(metadata, assets, version), /installer type/);
    delete metadata.platforms[target];
    assert.throws(() => verifyRelease(metadata, assets, version), /Missing or invalid signed platform/);
  }
});

test("a different version's installer and an inconsistent legacy signature are rejected", () => {
  const { metadata, assets } = fixture();
  const wrong = "Codex.Account.Manager_1.2.4_x64_en-US.msi";
  assets.push(wrong, wrong + ".sig");
  metadata.platforms["windows-x86_64-msi"].url = `https://github.com/duiwei996/codex-account-manager/releases/download/v${version}/${wrong}`;
  assert.throws(() => verifyRelease(metadata, assets, version), /version or installer type/);
  const input = fixture();
  input.metadata.platforms["windows-x86_64"].signature = "different-signature";
  assert.throws(() => verifyRelease(input.metadata, input.assets, version), /Legacy Windows updates/);
});
test("reject partial releases, wrong versions and foreign download URLs", () => {
  const { metadata, assets } = fixture();
  assert.throws(() => verifyRelease(metadata, assets.slice(1), version));
  assert.throws(() => verifyRelease(metadata, assets, "1.2.4"));
  metadata.platforms["windows-x86_64"].url = "https://example.com/windows.zip";
  assert.throws(() => verifyRelease(metadata, assets, version));
});

test("draft API asset URLs become public downloads only for known release assets", () => {
  const { metadata, assets } = fixture();
  const releaseAssets = assets.map((name, id) => ({ name, apiUrl: `https://api.github.com/repos/duiwei996/codex-account-manager/releases/assets/${id}` }));
  metadata.platforms["linux-x86_64"].url = releaseAssets[0].apiUrl;
  const result = normalizeReleaseMetadata(metadata, releaseAssets, version);
  assert.match(result.platforms["linux-x86_64"].url, /releases\/download\/v1\.2\.3\/linux-x86_64.zip$/);
  assert.equal(metadata.platforms["linux-x86_64"].url, releaseAssets[0].apiUrl);
  metadata.platforms["linux-x86_64"].url = "https://api.github.com/repos/duiwei996/codex-account-manager/releases/assets/unknown";
  assert.throws(() => normalizeReleaseMetadata(metadata, releaseAssets, version));
});
