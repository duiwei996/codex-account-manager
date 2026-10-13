import assert from "node:assert/strict";
import { test } from "node:test";
import { generateReleaseMetadata } from "../scripts/generate-release-metadata.mjs";

const version = "1.2.3";
function fixture() {
  const packages = [
    `Codex.Account.Manager_${version}_amd64.AppImage`,
    `Codex.Account.Manager_${version}_x64_en-US.msi`,
    `Codex.Account.Manager_${version}_x64-setup.exe`,
    `Codex.Account.Manager_${version}_aarch64.app.tar.gz`,
    `Codex.Account.Manager_${version}_x64.app.tar.gz`,
  ];
  const signatures = Object.fromEntries(packages.map((name, i) => [name + ".sig", `signature-${i}\n`]));
  return {
    release: {
      tagName: `v${version}`, isDraft: true, body: "Release notes", createdAt: "2026-10-12T09:00:00Z",
      assets: packages.flatMap(name => [{ name }, { name: name + ".sig" }]),
    },
    signatures,
  };
}
const generate = ({ release, signatures }) => generateReleaseMetadata(release, version, name => signatures[name]);

test("parallel completion order does not change the complete updater manifest", () => {
  const input = fixture();
  const result = generate(input);
  input.release.assets.reverse();
  assert.deepEqual(generate(input), result);
  assert.deepEqual(Object.keys(result.platforms).sort(), ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]);
  assert.match(result.platforms["windows-x86_64"].url, /x64-setup\.exe$/);
  assert.equal(result.platforms["windows-x86_64"].signature, "signature-2");
  assert.equal(result.platforms["darwin-aarch64"].signature, "signature-3");
  assert.equal(result.notes, "Release notes");
});

test("NSIS is supported when the release has no MSI", () => {
  const input = fixture();
  input.release.assets = input.release.assets.filter(asset => !asset.name.includes(".msi"));
  assert.match(generate(input).platforms["windows-x86_64"].url, /x64-setup\.exe$/);
});

test("an MSI-only release cannot silently replace the Windows NSIS update", () => {
  const input = fixture();
  input.release.assets = input.release.assets.filter(asset => !asset.name.includes("-setup.exe"));
  assert.throws(() => generate(input), /Expected exactly one updater package for windows-x86_64/);
});

test("incomplete platforms and missing or empty signatures stop publication", () => {
  for (const suffix of ["_amd64.AppImage", "_aarch64.app.tar.gz", "_x64.app.tar.gz", "_x64-setup.exe.sig"]) {
    const input = fixture();
    input.release.assets = input.release.assets.filter(asset => !asset.name.endsWith(suffix));
    assert.throws(() => generate(input));
  }
  const input = fixture();
  input.signatures[`Codex.Account.Manager_${version}_aarch64.app.tar.gz.sig`] = "  \n";
  assert.throws(() => generate(input), /Empty updater signature/);
});

test("published releases, wrong tags, invalid timestamps and unsafe filenames are rejected", () => {
  for (const change of [
    input => { input.release.isDraft = false; },
    input => { input.release.tagName = "v1.2.4"; },
    input => { input.release.createdAt = "invalid"; },
    input => { input.release.assets.push({ name: "../signature.sig" }); },
    input => { input.release.assets.push(input.release.assets[0]); },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => generate(input));
  }
});

test("another version's packages cannot populate the current manifest", () => {
  const input = fixture();
  input.release.assets = input.release.assets.map(asset => ({ name: asset.name.replace("1.2.3", "1.2.4") }));
  assert.throws(() => generate(input));
});
