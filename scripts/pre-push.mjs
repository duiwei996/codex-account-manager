import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight } from "./release-preflight.mjs";

export function prePush({ input, head, dirty, check }) {
  const refs = input.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^[a-f0-9]{40}$/.test(fields[1])) throw new Error("Invalid push reference input");
    return fields[1];
  }).filter(sha => !/^0+$/.test(sha));
  if (!refs.length) return;
  if (refs.some(sha => sha !== head)) throw new Error("Push blocked: checkout the exact commit being pushed so its dependencies can be audited.");
  if (dirty.trim()) throw new Error("Push blocked: the working tree differs from the commit. Audit and push the same clean tree.");
  check();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    prePush({ input: readFileSync(0, "utf8"), head: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain", "--untracked-files=normal"]),
      check: () => {
        const auditor = spawnSync("git", ["config", "--local", "--get", "codex.auditPath"], { cwd: root, encoding: "utf8" });
        if (auditor.error || ![0, 1].includes(auditor.status)) throw new Error("Cannot read auditor configuration");
        runPreflight({ env: { ...process.env, npm_execpath: git(["config", "--local", "codex.pnpmPath"]),
          CARGO_AUDIT_BIN: process.env.CARGO_AUDIT_BIN || auditor.stdout.trim() || "cargo-audit" } });
      },
    });
  } catch (error) {
    console.error("PRE-PUSH BLOCKED: " + error.message);
    process.exitCode = 1;
  }
}
