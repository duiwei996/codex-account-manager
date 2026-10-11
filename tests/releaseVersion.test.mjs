import assert from "node:assert/strict";
import test from "node:test";
import { nextReleaseVersion } from "../scripts/next-release-version.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("release version advances beyond the source and existing release tags", () => {
  assert.equal(nextReleaseVersion("1.0.0", []), "1.0.0");
  assert.equal(nextReleaseVersion("1.0.0", ["v0.2.21"]), "1.0.0");
  assert.equal(nextReleaseVersion("1.0.0", ["v1.0.0"]), "1.0.1");
  assert.equal(nextReleaseVersion("0.2.20", ["v0.2.22", "v0.2.9", "v1.0.3", "personal-unsigned-12", "v9.0.0-beta"]), "1.0.4");
  assert.equal(nextReleaseVersion("2.0.0", ["v1.9.9"]), "2.0.0");
});

test("release versions reject invalid numbers and overflow", () => {
  assert.throws(() => nextReleaseVersion("invalid", []));
  assert.throws(() => nextReleaseVersion("1.0.4294967295", ["v1.0.4294967295"]));
  assert.throws(() => nextReleaseVersion("1.0.0", ["v999999999999999999.0.0"]));
});

test("release preparation synchronizes every version file with Windows line endings", t => {
  const directory = mkdtempSync(join(tmpdir(), "codex-release-version-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "src-tauri"));
  const files = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
  for (const file of files) {
    const contents = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    writeFileSync(join(directory, file), contents.replace(/\r?\n/g, "\r\n"));
  }
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/bump-version.mjs", import.meta.url)), "1.2.3"], { cwd: directory });
  assert.equal(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version, "1.2.3");
  assert.equal(JSON.parse(readFileSync(join(directory, "src-tauri/tauri.conf.json"), "utf8")).version, "1.2.3");
  assert.match(readFileSync(join(directory, "src-tauri/Cargo.toml"), "utf8"), /^version = "1.2.3"/m);
  assert.match(readFileSync(join(directory, "src-tauri/Cargo.lock"), "utf8"), /name = "codex-switcher"\r?\nversion = "1.2.3"/);
});
