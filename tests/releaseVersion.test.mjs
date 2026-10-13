import assert from "node:assert/strict";
import test from "node:test";
import { nextReleaseVersion } from "../scripts/next-release-version.mjs";
import { verifyProjectVersion, synchronizeProjectVersion } from "../scripts/project-version.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const files = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
function fixture() {
  const temporaryRoot = fileURLToPath(new URL("../.tmp/", import.meta.url));
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, "version-source-"));
  mkdirSync(join(directory, "src-tauri"));
  for (const file of [...files, "VERSION"]) {
    const contents = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    writeFileSync(join(directory, file), contents.replace(/\r?\n/g, "\r\n"));
  }
  return directory;
}

test("release uses the explicit VERSION and skips reserved versions without incrementing", () => {
  assert.equal(nextReleaseVersion("1.0.4", []), "1.0.4");
  assert.equal(nextReleaseVersion("1.0.4", ["v1.0.3", "personal-unsigned-12", "v9.0.0-beta"]), "1.0.4");
  assert.equal(nextReleaseVersion("1.0.4", ["v1.0.4"]), null);
  assert.equal(nextReleaseVersion("2.0.0", ["v1.9.9"]), "2.0.0");
  assert.throws(() => nextReleaseVersion("1.0.4", ["v1.0.5"]), /older than existing/);
});

test("invalid version numbers fail without being normalized or incremented", () => {
  for (const version of ["invalid", "01.0.0", "1.0", "1.0.0-beta", "1.0.4294967296"]) {
    assert.throws(() => nextReleaseVersion(version, []));
  }
  assert.throws(() => nextReleaseVersion("1.0.4", ["v999999999999999999.0.0"]));
});

test("explicit version update synchronizes VERSION and every derived file with Windows line endings", () => {
  const directory = fixture();
  const oldLock = readFileSync(join(directory, "src-tauri/Cargo.lock"), "utf8");
  const oldVersion = readFileSync(join(directory, "VERSION"), "utf8").trim();
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/bump-version.mjs", import.meta.url)), "1.2.3"], { cwd: directory });
  assert.equal(readFileSync(join(directory, "VERSION"), "utf8"), "1.2.3\n");
  assert.equal(verifyProjectVersion(directory), "1.2.3");
  assert.match(readFileSync(join(directory, "src-tauri/Cargo.lock"), "utf8"), /name = "codex-switcher"\r?\nversion = "1.2.3"/);
  assert.equal(readFileSync(join(directory, "src-tauri/Cargo.lock"), "utf8").replace(/name = "codex-switcher"\r?\nversion = "1.2.3"/, `name = "codex-switcher"\r\nversion = "${oldVersion}"`), oldLock);
});

test("editing VERSION requires synchronization; validation detects mismatch and wrong release version", () => {
  const directory = fixture();
  writeFileSync(join(directory, "VERSION"), "2.3.4\r\n");
  assert.throws(() => verifyProjectVersion(directory), /version:sync/);
  synchronizeProjectVersion(directory);
  assert.equal(verifyProjectVersion(directory, "2.3.4"), "2.3.4");
  assert.throws(() => verifyProjectVersion(directory, "2.3.5"), /does not match release/);
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/bump-version.mjs", import.meta.url)), "patch"], { cwd: directory });
  assert.equal(verifyProjectVersion(directory), "2.3.5");
});

test("invalid input or malformed derived metadata changes no version files", () => {
  const directory = fixture();
  const before = readFileSync(join(directory, "package.json"), "utf8");
  assert.throws(() => synchronizeProjectVersion(directory, "1.0.0-beta"));
  assert.equal(readFileSync(join(directory, "package.json"), "utf8"), before);
  const version = readFileSync(join(directory, "VERSION"), "utf8");
  writeFileSync(join(directory, "src-tauri/Cargo.lock"), "invalid");
  assert.throws(() => synchronizeProjectVersion(directory, "2.0.0"), /Missing project version/);
  assert.equal(readFileSync(join(directory, "package.json"), "utf8"), before);
  assert.equal(readFileSync(join(directory, "VERSION"), "utf8"), version);
});

test("cloud workflow verifies VERSION and gates both build and publish on the reservation result", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.ok(!workflow.includes("node scripts/bump-version.mjs"));
  assert.equal(workflow.match(/needs\.preflight\.outputs\.publish == 'true'/g).length, 2);
  assert.equal(workflow.match(/node scripts\/project-version\.mjs --check/g).length, 2);
});


test("cloud selection CLI emits an empty version for a reserved release and fails on an older source", () => {
  const directory = fixture();
  const script = fileURLToPath(new URL("../scripts/next-release-version.mjs", import.meta.url));
  const tags = join(directory, "version-tags.txt");
  synchronizeProjectVersion(directory, "1.0.4");
  writeFileSync(tags, "v1.0.4\n");
  assert.equal(execFileSync(process.execPath, [script, tags], { cwd: directory, encoding: "utf8" }), "\n");
  writeFileSync(tags, "v1.0.3\n");
  assert.equal(execFileSync(process.execPath, [script, tags], { cwd: directory, encoding: "utf8" }), "1.0.4\n");
  writeFileSync(tags, "v1.0.5\n");
  assert.throws(() => execFileSync(process.execPath, [script, tags], { cwd: directory, stdio: "pipe" }), error => error.status === 1);
});
