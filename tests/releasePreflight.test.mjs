import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { releasePreflight, verifyNodeVersion, reviewFrontendAudit } from "../scripts/release-preflight.mjs";
import { checkedLocalBuild } from "../scripts/build-local.mjs";

function mockRun(calls = [], fail = () => false) {
  return (command, args) => {
    calls.push([command, args]);
    if (fail(command, args)) throw new Error("injected check failure");
    if (args.includes("--version")) {
      if (command === process.execPath) return "10.18.3\n";
      if (command === "cargo") return "cargo 1.94.0 (test)\n";
      return "cargo-audit 0.22.1\n";
    }
    if (args.includes("--json")) return JSON.stringify({ advisories: {} });
    return "";
  };
}

test("release preflight runs both CI security gates using the pinned auditor", () => {
  const calls = [];
  releasePreflight({ pnpmScript: "pinned-pnpm.cjs", run: mockRun(calls) });
  assert.ok(calls.some(([, args]) => args.includes("--audit-level=high")));
  assert.ok(calls.some(([, args]) => args.includes("--registry=https://registry.npmjs.org/")));
  assert.ok(calls.some(([, args]) => args.join(" ") === "audit --file src-tauri/Cargo.lock"));
});

test("a failed dependency audit stops preflight and cannot become success", () => {
  const calls = [];
  assert.throws(() => releasePreflight({ pnpmScript: "pnpm.cjs", run: mockRun(calls, (_, args) => args.includes("--audit-level=high")) }), /injected check failure/);
  assert.ok(!calls.some(([, args]) => args.includes("--file")));
});

test("missing package-manager context and a mismatched auditor fail before checks", () => {
  assert.throws(() => releasePreflight({ run() { throw new Error("must not run"); } }), /pinned package manager/);
  const validRun = mockRun();
  assert.throws(() => releasePreflight({ pnpmScript: "pnpm.cjs", run(command, args) {
    return command === "cargo-audit" && args[0] === "--version" ? "cargo-audit 0.21.0" : validRun(command, args);
  } }), /Expected cargo-audit 0.22.1/);
});

test("full CI checking includes compilation and both test suites and stops on failure", () => {
  const checks = [];
  releasePreflight({ pnpmScript: "pinned-pnpm.cjs", full: true, run: mockRun(checks) });
  assert.deepEqual(checks.slice(-3), [
    [process.execPath, ["pinned-pnpm.cjs", "build"]],
    [process.execPath, ["pinned-pnpm.cjs", "test"]],
    ["cargo", ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml"]],
  ]);
  const failedChecks = [];
  assert.throws(() => releasePreflight({ pnpmScript: "pinned-pnpm.cjs", full: true,
    run: mockRun(failedChecks, (command, args) => command === process.execPath && args[1] === "test"),
  }), /injected check failure/);
  assert.ok(!failedChecks.some(([command, args]) => command === "cargo" && args[0] === "test"));
});

test("frozen installation precedes auditing and failures prevent local packaging", () => {
  for (const stage of ["install", "audit", "build", "test"]) {
    const calls = [];
    let packaged = false;
    assert.throws(() => checkedLocalBuild({
      check: () => releasePreflight({ pnpmScript: "pnpm.cjs", full: true,
        run: mockRun(calls, (command, args) => command === process.execPath && args[1] === stage),
      }),
      build: () => { packaged = true; },
    }), /injected check failure/);
    assert.equal(packaged, false, stage);
    const installation = calls.findIndex(([, args]) => args.includes("--frozen-lockfile"));
    const audit = calls.findIndex(([, args]) => args.includes("--audit-level=high"));
    assert.ok(installation >= 0);
    if (stage !== "install") assert.ok(audit > installation);
  }
  const order = [];
  const result = checkedLocalBuild({ check: () => order.push("checks"), build: () => { order.push("package"); return { status: 0 }; } });
  assert.deepEqual(order, ["checks", "package"]);
  assert.equal(result.status, 0);
});

test("runtime and package-manager drift is rejected before installing or building", () => {
  verifyNodeVersion(readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim());
  for (const version of ["22.12.0", "24.21.0"]) assert.throws(() => verifyNodeVersion(version), /Expected Node.js/);
  const calls = [];
  assert.throws(() => releasePreflight({ pnpmScript: "pnpm.cjs", full: true, run(command, args) {
    calls.push(args);
    return "10.0.0";
  } }), /Expected pnpm 10.18.3/);
  assert.equal(calls.length, 1);
  const validRun = mockRun();
  assert.throws(() => releasePreflight({ pnpmScript: "pnpm.cjs", scope: "rust", run(command, args) {
    return command === "cargo" && args[0] === "--version" ? "cargo 1.93.0 (test)" : validRun(command, args);
  } }), /Expected cargo 1.94.0/);
});

test("CI scopes select the same frontend and Rust checks as the combined local gate", () => {
  const frontend = [], rust = [], all = [];
  for (const [scope, calls] of [["frontend", frontend], ["rust", rust], ["all", all]]) {
    releasePreflight({ pnpmScript: "pnpm.cjs", full: true, scope, run: mockRun(calls) });
  }
  assert.ok(!frontend.some(([command]) => command === "cargo" || command === "cargo-audit"));
  assert.ok(!rust.some(([, args]) => args.includes("--frozen-lockfile") || args.includes("--audit-level=high")));
  const serialize = calls => new Set(calls.map(call => JSON.stringify(call)));
  assert.deepEqual(serialize([...frontend, ...rust]), serialize(all));
  assert.throws(() => releasePreflight({ pnpmScript: "pnpm.cjs", scope: "", run: mockRun() }), /Unknown check scope/);
  const workflow = readFileSync(new URL("../.github/workflows/pull-request-validation.yml", import.meta.url), "utf8");
  assert.match(workflow, /run: pnpm check:frontend/);
  assert.match(workflow, /run: pnpm check:rust/);
});


test("low and moderate findings warn while high and critical findings block", () => {
  for (const severity of ["low", "moderate", "high", "critical"]) {
    const raw = JSON.stringify({ advisories: { sample: { severity, module_name: "fixture", title: "test advisory", url: "https://example.com/advisory" } } });
    if (["high", "critical"].includes(severity)) assert.throws(() => reviewFrontendAudit(raw), /High or critical/);
    else assert.equal(reviewFrontendAudit(raw)[severity], 1);
  }
  for (const invalid of ["not json", "{}", '{"error":"service unavailable"}']) assert.throws(() => reviewFrontendAudit(invalid));
});
