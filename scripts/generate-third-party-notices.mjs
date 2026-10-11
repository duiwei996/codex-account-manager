import { execFileSync, execSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
const target = process.argv[2] ?? process.env.CODEX_SWITCHER_BUILD_TARGET ?? execFileSync("rustc", ["-vV"], options).match(/^host: (.+)$/m)?.[1];
if (!target || !/^[a-z0-9_-]+$/.test(target)) throw new Error("Invalid build target");
const npm = JSON.parse(execSync("pnpm licenses list --json", options));
const cargo = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", "src-tauri/Cargo.toml", "--filter-platform", target], options));
const resolved = new Set(cargo.resolve.nodes.map(node => node.id));
const inventory = [];
const sections = [];
const missing = [];
function record(ecosystem, name, version, license, directory, source) {
  const base = realpathSync(directory);
  const texts = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(licen[cs]e|notice|copying|copyright)([._-]|$)/i.test(entry.name)) continue;
    const filename = realpathSync(join(base, entry.name));
    if (!filename.startsWith(base + sep)) throw new Error("License file escapes its package");
    texts.push(`### ${entry.name}\n\n${readFileSync(filename, "utf8")}`);
  }
  if (!license) throw new Error(`Missing declared license: ${name}@${version}`);
  if (!texts.length) missing.push(`${ecosystem}:${name}@${version} (${license})`);
  inventory.push({ ecosystem, name, version, license, source: source ?? null, licenseFilesIncluded: texts.length });
  sections.push(`## ${ecosystem}: ${name}@${version}\n\nDeclared license: ${license}\n\n${source ? `Source: ${source}\n\n` : ""}${texts.join("\n\n") || "No standalone license file was shipped in this dependency package. Consult its source distribution and declared SPDX license."}`);
}
for (const [license, packages] of Object.entries(npm)) {
  for (const pkg of packages) for (let i = 0; i < pkg.versions.length; i++) {
    record("npm", pkg.name, pkg.versions[i], pkg.license ?? license, pkg.paths[Math.min(i, pkg.paths.length - 1)], pkg.homepage);
  }
}
for (const pkg of cargo.packages) {
  if (pkg.id === cargo.resolve.root || !resolved.has(pkg.id)) continue;
  record("cargo", pkg.name, pkg.version, pkg.license, dirname(pkg.manifest_path), pkg.repository);
}
const output = join(root, "src-tauri", "resources", "third-party");
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "inventory.json"), JSON.stringify({ target, dependencies: inventory, missingStandaloneLicenseFiles: missing }, null, 2) + "\n");
writeFileSync(join(output, "THIRD-PARTY-NOTICES.txt"), `Third-party dependency notices\n\nGenerated from the frozen npm installation and Cargo.lock for ${target}. Includes build dependencies conservatively. This inventory does not relicense the application.\n\n${sections.join("\n\n")}`);
console.log(`Collected ${inventory.length} dependencies; ${missing.length} packages have no standalone license file. See inventory.json.`);
