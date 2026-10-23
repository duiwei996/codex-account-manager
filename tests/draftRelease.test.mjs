import assert from "node:assert/strict";
import { test } from "node:test";
import { createDraftRelease, readReleaseNotes } from "../scripts/create-draft-release.mjs";

const input = {
  version: "1.0.4", repository: "duiwei996/codex-account-manager",
  ref: "refs/heads/main", commit: "e6c96780344474fc20ddba2e08a1575fe6a88014",
};
function response() {
  return { id: 410457037, draft: true, tag_name: "v1.0.4", target_commitish: input.commit,
    html_url: "https://github.com/duiwei996/codex-account-manager/releases/tag/untagged-example" };
}

test("a draft with an untagged URL uses the creation response without a tag lookup", () => {
  const requests = [];
  const id = createDraftRelease(input, (endpoint, payload) => {
    requests.push({ endpoint, payload });
    if (endpoint.includes("/tags/")) throw new Error("Not Found (HTTP 404)");
    return response();
  });
  assert.equal(id, 410457037);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].endpoint, "repos/duiwei996/codex-account-manager/releases");
  assert.equal(requests[0].payload.tag_name, "v1.0.4");
  assert.equal(requests[0].payload.target_commitish, input.commit);
  assert.equal(requests[0].payload.draft, true);
});

test("invalid source context is rejected before any remote request", () => {
  for (const [key, value] of [
    ["repository", "example/other"], ["ref", "refs/heads/dev"],
    ["version", "1.0.4; invalid"], ["commit", "main"],
  ]) {
    let called = false;
    assert.throws(() => createDraftRelease({ ...input, [key]: value }, () => { called = true; return response(); }));
    assert.equal(called, false);
  }
});

test("invalid IDs, published releases and mismatched versions or commits are rejected", () => {
  for (const change of [
    { id: undefined }, { id: 0 }, { id: "RE_example" }, { draft: false },
    { tag_name: "v1.0.3" }, { target_commitish: "0".repeat(40) },
  ]) {
    assert.throws(() => createDraftRelease(input, () => ({ ...response(), ...change })));
  }
});

test("creation failures propagate without retrying or creating another draft", () => {
  let calls = 0;
  assert.throws(() => createDraftRelease(input, () => { calls++; throw new Error("HTTP 403"); }), /HTTP 403/);
  assert.equal(calls, 1);
});


test("draft release uses only the requested changelog entry", () => {
  const notes = readReleaseNotes("1.1.1", "# Changes\n\n## 1.1.1 · 2026-10-23\n\n- New sync.\n\n## 1.1.0\n\n- Old sync.");
  assert.equal(notes, "- New sync.");
  assert.throws(() => readReleaseNotes("1.1.2", "## 1.1.1\n- Note"), /Missing/);
  createDraftRelease({ ...input, notes }, (_endpoint, payload) => {
    assert.match(payload.body, /^- New sync\./);
    assert.doesNotMatch(payload.body, /Old sync/);
    return response();
  });
});
