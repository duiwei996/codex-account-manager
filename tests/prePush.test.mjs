import test from "node:test";
import assert from "node:assert/strict";
import { prePush } from "../scripts/pre-push.mjs";
const head = "a".repeat(40);
const input = `refs/heads/main ${head} refs/heads/main ${"b".repeat(40)}\n`;

test("every normal push runs fresh checks and audit failures block it", () => {
  let calls = 0;
  const check = () => { calls++; };
  for (let i = 0; i < 2; i++) prePush({ input, head, dirty: "", check });
  assert.equal(calls, 2);
  assert.throws(() => prePush({ input, head, dirty: "", check() { throw new Error("vulnerability found"); } }), /vulnerability found/);
});

test("uncommitted dependencies and other commits cannot pass by auditing the wrong tree", () => {
  const check = () => assert.fail("must not audit a different tree");
  assert.throws(() => prePush({ input, head, dirty: " M pnpm-lock.yaml", check }), /same clean tree/);
  assert.throws(() => prePush({ input, head: "c".repeat(40), dirty: "", check }), /exact commit/);
  assert.throws(() => prePush({ input: "invalid", head, dirty: "", check }), /Invalid push/);
});

test("deletion-only and empty pushes have no new dependencies to audit", () => {
  const check = () => assert.fail("nothing is being published");
  prePush({ input: "", head, dirty: "", check });
  prePush({ input: `delete ${"0".repeat(40)} refs/heads/old ${head}`, head, dirty: "", check });
});
