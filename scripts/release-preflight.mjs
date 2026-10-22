import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function releasePreflight({ run, pnpmScript, auditBinary = "cargo-audit", full = false }) {
  if (!pnpmScript) throw new Error("Run through pnpm release:preflight so the pinned package manager is used.");
  const version = run(auditBinary, ["--version"], true).trim();
  if (version !== "cargo-audit 0.22.1") throw new Error(`Expected cargo-audit 0.22.1, got ${version}`);
  run(process.execPath, ["scripts/project-version.mjs", "--check"]);
  run("cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--all", "--", "--check"]);
  run(process.execPath, [pnpmScript, "audit", "--audit-level=low", "--registry=https://registry.npmjs.org/"]);
  run(auditBinary, ["audit", "--file", "src-tauri/Cargo.lock"]);
  if (full) {
    run(process.execPath, [pnpmScript, "build"]);
    run(process.execPath, [pnpmScript, "test"]);
    run("cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml"]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    releasePreflight({
      pnpmScript: process.env.npm_execpath,
      auditBinary: process.env.CARGO_AUDIT_BIN || "cargo-audit",
      full: process.argv.includes("--full"),
      run(command, args, capture = false) {
        console.log(`Preflight: ${command === process.execPath ? "node" : command} ${args.join(" ")}`);
        return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
      },
    });
    console.log(process.argv.includes("--full")
      ? "Local CI checks passed: version, Rust format, dependency audits, frontend build and tests, and host Rust tests. Other platforms still require CI."
      : "Version, Rust format and both dependency security audits passed. Build and behavior tests are separate checks.");
  } catch (error) {
    console.error("Release preflight failed: " + error.message);
    process.exitCode = 1;
  }
}
