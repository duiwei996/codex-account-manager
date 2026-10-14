import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { nsisValue } from "../scripts/wrap-windows-installer.mjs";
import { shouldWrapWindowsInstaller } from "../scripts/build-local.mjs";

test("Windows uses official dependencies and installer hooks, without a source override", () => {
  const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
  const config = JSON.parse(readFileSync("src-tauri/tauri.windows.conf.json", "utf8"));
  assert.doesNotMatch(cargo, /\[patch\.crates-io\]|vendor\/tauri-plugin-updater/);
  assert.equal(config.bundle.windows.nsis.template, undefined);
  assert.equal(config.bundle.windows.nsis.installerHooks, "windows/installer-hooks.nsh");
});

test("NSIS defines reject source-line injection and preserve dollars and quotes", () => {
  assert.equal(nsisValue('C:\\用户\\$folder\\"file"'), 'C:\\用户\\$$folder\\$\\"file$\\"');
  for (const value of ["bad\nFile evil", "bad\r", "bad\0"]) assert.throws(() => nsisValue(value));
});

test("local builds wrap only a newly requested NSIS bundle", () => {
  for (const args of [[], ["--bundles", "nsis"], ["-b", "msi,nsis"], ["--bundles=nsis"]]) assert.equal(shouldWrapWindowsInstaller(args), true);
  for (const args of [["--no-bundle"], ["--bundles", "msi"], ["--bundles=msi"]]) assert.equal(shouldWrapWindowsInstaller(args), false);
});
