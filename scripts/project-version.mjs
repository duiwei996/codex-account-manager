import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export function parseVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid version: ${value}`);
  const parts = value.split(".").map(Number);
  if (parts.some(part => !Number.isSafeInteger(part) || part > 4294967295)) throw new Error("Version component overflow");
  return parts;
}

export function readProjectVersion(root = process.cwd()) {
  const version = readFileSync(join(root, "VERSION"), "utf8").trim();
  parseVersion(version);
  return version;
}

function versionFiles(root) {
  const files = [
    ["package.json", /("version"\s*:\s*")([^"\r\n]+)(")/],
    ["src-tauri/tauri.conf.json", /("version"\s*:\s*")([^"\r\n]+)(")/],
    ["src-tauri/Cargo.toml", /(^version\s*=\s*")([^"\r\n]+)(")/m],
    ["src-tauri/Cargo.lock", /(\[\[package\]\]\r?\nname = "codex-switcher"\r?\nversion = ")([^"\r\n]+)(")/],
  ];
  return files.map(([file, pattern]) => {
    const contents = readFileSync(join(root, file), "utf8");
    const match = pattern.exec(contents);
    if (!match) throw new Error(`Missing project version in ${file}`);
    parseVersion(match[2]);
    return { file, contents, pattern, version: match[2] };
  });
}

export function verifyProjectVersion(root = process.cwd(), expected) {
  const version = readProjectVersion(root);
  if (expected !== undefined && version !== expected) throw new Error(`VERSION ${version} does not match release ${expected}`);
  for (const entry of versionFiles(root)) {
    if (entry.version !== version) throw new Error(`${entry.file} is ${entry.version}, VERSION is ${version}. Run pnpm version:sync.`);
  }
  return version;
}

export function synchronizeProjectVersion(root = process.cwd(), requested) {
  const version = requested ?? readProjectVersion(root);
  parseVersion(version);
  // Validate every input before changing any file. Dependency versions stay intact.
  const entries = versionFiles(root);
  for (const entry of entries) {
    if (entry.version !== version) writeFileSync(join(root, entry.file), entry.contents.replace(entry.pattern, (_match, prefix, _old, suffix) => `${prefix}${version}${suffix}`));
  }
  if (requested !== undefined) writeFileSync(join(root, "VERSION"), `${version}\n`);
  return version;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const mode = process.argv[2];
    if (mode === "--sync") console.log(`Version synchronized: ${synchronizeProjectVersion()}`);
    else if (mode === "--check") console.log(`Project version verified: ${verifyProjectVersion(process.cwd(), process.argv[3])}`);
    else throw new Error("Usage: node scripts/project-version.mjs <--sync|--check [expected]>");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
