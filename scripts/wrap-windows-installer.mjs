import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProjectVersion } from "./project-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function run(file, args, env) {
  const result = spawnSync(file, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Installer tool failed (${result.status}): ${file}`);
}
// CLI defines are NSIS source strings. Reject line breaks and escape source metacharacters.
export function nsisValue(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid NSIS define");
  return value.replaceAll("$", () => "$$").replaceAll('"', '$\\"');
}

export function wrapWindowsInstaller({ target = "", sign = false, upload = false, env = process.env } = {}) {
  if (process.platform !== "win32") throw new Error("Windows installer wrapping requires Windows");
  if (upload && !sign) throw new Error("Uploading a Windows update requires its signature");
  if (sign && !env.TAURI_SIGNING_PRIVATE_KEY) throw new Error("Missing updater signing key");
  if (target && !/^[a-z0-9_-]+$/.test(target)) throw new Error("Invalid build target");
  const version = verifyProjectVersion(root);
  const targetDirectory = env.CARGO_TARGET_DIR ? resolve(root, env.CARGO_TARGET_DIR) : join(root, "src-tauri", "target");
  const outputDirectory = join(targetDirectory, ...(target ? [target] : []), "release", "bundle", "nsis");
  const productName = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).productName;
  const files = readdirSync(outputDirectory).filter(name => name === `${productName}_${version}_x64-setup.exe`);
  if (files.length !== 1) throw new Error("Expected one current-version x64 NSIS installer");
  const installer = join(outputDirectory, files[0]);
  const compiler = join(targetDirectory, ".tauri", "NSIS", "makensis.exe");
  if (!existsSync(compiler)) throw new Error("Build the official Windows installer first");
  const temporary = join(root, ".tmp", "windows-install-wrapper", `${version}-${target || "host"}`);
  mkdirSync(temporary, { recursive: true });
  const payload = join(temporary, "official-setup.exe");
  const wrapped = join(temporary, "wrapped-setup.exe");
  // Each call follows a fresh Tauri build. Preserve the official payload for inspection.
  copyFileSync(installer, payload);
  run(compiler, ["/V2", "/INPUTCHARSET", "UTF8", `/DAPP_VERSION=${version}`, `/DPAYLOAD_FILE=${nsisValue(payload)}`, `/DOUTPUT_FILE=${nsisValue(wrapped)}`, join(root, "src-tauri", "windows", "setup-launcher.nsi")], env);
  if (sign) {
    run(process.execPath, [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), "signer", "sign", "--app-version", version, wrapped], env);
    if (!existsSync(wrapped + ".sig")) throw new Error("Wrapped installer signature was not generated");
  }
  copyFileSync(wrapped, installer);
  if (sign) copyFileSync(wrapped + ".sig", installer + ".sig");
  if (upload) {
    // tauri-action publishes names with dots in place of spaces.
    const published = join(temporary, files[0].replaceAll(" ", "."));
    copyFileSync(installer, published);
    copyFileSync(installer + ".sig", published + ".sig");
    run("gh", ["release", "upload", `v${version}`, published, published + ".sig", "--clobber"], env);
  }
  writeFileSync(join(temporary, "result.json"), JSON.stringify({ version, installer, payload, sign }, null, 2) + "\n");
  console.log(`Project-owned Windows installer ready: ${installer}`);
  return installer;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { wrapWindowsInstaller({ target: process.argv.slice(2).find(arg => !arg.startsWith("--")) || "", sign: process.argv.includes("--sign"), upload: process.argv.includes("--upload") }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
