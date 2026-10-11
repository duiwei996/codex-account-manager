import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRelease, normalizeReleaseMetadata } from "../scripts/verify-release.mjs";
const version = "1.2.3";
function fixture() {
  const platforms = Object.fromEntries(["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"].map(platform => [platform, { signature: "signature", url: `https://github.com/duiwei996/codex-account-manager/releases/download/v${version}/${platform}.zip` }]));
  return { metadata: { version, platforms }, assets: Object.keys(platforms).flatMap(platform => [platform + ".zip", platform + ".zip.sig"]) };
}
test("a complete signed release includes all four platforms", () => {
  const { metadata, assets } = fixture();
  assert.equal(verifyRelease(metadata, assets, version), true);
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
