import test from "node:test";
import assert from "node:assert/strict";
import { releasePreflight } from "../scripts/release-preflight.mjs";

test("release preflight runs both CI security gates using the pinned auditor", () => {
  const calls = [];
  releasePreflight({ pnpmScript: "pinned-pnpm.cjs", run(command, args) {
    calls.push([command, args]);
    return "cargo-audit 0.22.1\n";
  } });
  assert.ok(calls.some(([, args]) => args.includes("--audit-level=low")));
  assert.ok(calls.some(([, args]) => args.includes("--registry=https://registry.npmjs.org/")));
  assert.ok(calls.some(([, args]) => args.join(" ") === "audit --file src-tauri/Cargo.lock"));
});

test("a failed dependency audit stops preflight and cannot become success", () => {
  const calls = [];
  assert.throws(() => releasePreflight({ pnpmScript: "pnpm.cjs", run(command, args) {
    calls.push(args);
    if (args.includes("--audit-level=low")) throw new Error("vulnerabilities found");
    return "cargo-audit 0.22.1";
  } }), /vulnerabilities found/);
  assert.ok(!calls.some(args => args.includes("--file")));
});

test("missing package-manager context and a mismatched auditor fail before checks", () => {
  assert.throws(() => releasePreflight({ run() { throw new Error("must not run"); } }), /pinned package manager/);
  assert.throws(() => releasePreflight({ pnpmScript: "pnpm.cjs", run() { return "cargo-audit 0.21.0"; } }), /Expected cargo-audit 0.22.1/);
});
