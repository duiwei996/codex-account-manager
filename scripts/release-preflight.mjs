import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeVersion = readFileSync(resolve(root, ".node-version"), "utf8").trim();
const packageManagerVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).packageManager.split("@")[1];
const rustVersion = readFileSync(resolve(root, "rust-toolchain.toml"), "utf8").match(/^channel\s*=\s*"([^"]+)"/m)[1];

export function verifyNodeVersion(actual = process.versions.node) {
  if (actual !== nodeVersion) throw new Error(`Expected Node.js ${nodeVersion} from .node-version, got ${actual}. Use the same runtime as CI.`);
}

export function reviewFrontendAudit(raw) {
  const report = JSON.parse(String(raw));
  if (!report.advisories || typeof report.advisories !== "object" || report.error) throw new Error("Invalid frontend audit report");
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const advisory of Object.values(report.advisories)) {
    if (!(advisory.severity in counts)) throw new Error("Unknown vulnerability severity");
    counts[advisory.severity]++;
    console.log(`Security ${advisory.severity}: ${advisory.module_name}: ${advisory.title} (${advisory.url})`);
  }
  console.log(`Frontend audit: ${JSON.stringify(counts)}; high and critical block, lower levels are warnings.`);
  if (counts.high || counts.critical) throw new Error("High or critical frontend vulnerabilities found");
  return counts;
}

export function releasePreflight({ run, pnpmScript, auditBinary = "cargo-audit", full = false, scope = "all" }) {
  if (!["all", "frontend", "rust"].includes(scope)) throw new Error(`Unknown check scope: ${scope}`);
  verifyNodeVersion();
  if (!pnpmScript) throw new Error("Run through pnpm release:preflight so the pinned package manager is used.");
  const pnpmVersion = run(process.execPath, [pnpmScript, "--version"], true).trim();
  if (pnpmVersion !== packageManagerVersion) throw new Error(`Expected pnpm ${packageManagerVersion}, got ${pnpmVersion}`);
  run(process.execPath, ["scripts/project-version.mjs", "--check"]);
  const frontend = scope !== "rust";
  const rust = scope !== "frontend";
  if (frontend) {
    if (full) run(process.execPath, [pnpmScript, "install", "--frozen-lockfile"]);
    let raw, failure;
    try {
      raw = run(process.execPath, [pnpmScript, "audit", "--json", "--audit-level=high", "--registry=https://registry.npmjs.org/"], true);
    } catch (error) {
      if (error.status !== 1 || !error.stdout) throw error;
      raw = error.stdout;
      failure = error;
    }
    reviewFrontendAudit(raw);
    if (failure) throw failure;
  }
  if (rust) {
    const cargoVersion = run("cargo", ["--version"], true).trim();
    if (!cargoVersion.startsWith(`cargo ${rustVersion} `)) throw new Error(`Expected cargo ${rustVersion}, got ${cargoVersion}`);
    const version = run(auditBinary, ["--version"], true).trim();
    if (version !== "cargo-audit 0.22.1") throw new Error(`Expected cargo-audit 0.22.1, got ${version}. Install with cargo install cargo-audit --locked --version 0.22.1 or set CARGO_AUDIT_BIN.`);
    run("cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--all", "--", "--check"]);
    run(auditBinary, ["audit", "--file", "src-tauri/Cargo.lock"]);
  }
  if (full) {
    if (frontend) {
      run(process.execPath, [pnpmScript, "build"]);
      run(process.execPath, [pnpmScript, "test"]);
    }
    if (rust) run("cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml"]);
  }
}

export function runPreflight({ full = false, scope = "all", env = process.env } = {}) {
  releasePreflight({
    pnpmScript: env.npm_execpath,
    auditBinary: env.CARGO_AUDIT_BIN || "cargo-audit",
    full,
    scope,
    run(command, args, capture = false) {
      console.log(`Preflight: ${command === process.execPath ? "node" : command} ${args.join(" ")}`);
      return execFileSync(command, args, { cwd: root, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
    },
  });
  console.log(`Checks passed (${scope}${full ? ", full" : ", audits and metadata"}). Other platforms and signed release packaging still require CI.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const scopeIndex = process.argv.indexOf("--scope");
    runPreflight({
      full: process.argv.includes("--full"),
      scope: scopeIndex < 0 ? "all" : process.argv[scopeIndex + 1] ?? "",
    });
  } catch (error) {
    console.error("Release preflight failed: " + error.message);
    process.exitCode = 1;
  }
}
