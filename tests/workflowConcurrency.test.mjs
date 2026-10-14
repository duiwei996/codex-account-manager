import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const validation = readFileSync(new URL("../.github/workflows/pull-request-validation.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const workflowName = source => source.match(/^name: (.+)$/m)[1];
const groupTemplate = source => source.match(/^concurrency:\n  group: (.+)$/m)[1];
const validationGroup = (workflow, ref, pr) => groupTemplate(validation).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
  if (expression === "github.workflow") return workflow;
  if (expression === "github.event.pull_request.number || github.ref") return pr || ref;
  throw new Error(`Unexpected concurrency expression: ${expression}`);
});

test("main push checks cannot cancel checks called by the release workflow", () => {
  const standalone = validationGroup(workflowName(validation), "refs/heads/main");
  const called = validationGroup(workflowName(release), "refs/heads/main");
  assert.notEqual(standalone, called);
  assert.notEqual(called, groupTemplate(release));
  assert.match(validation, /cancel-in-progress: true/);
  assert.match(release, /cancel-in-progress: false/);
});

test("new checks still replace old checks for the same workflow and ref or PR", () => {
  const name = workflowName(validation);
  assert.equal(validationGroup(name, "refs/heads/main"), validationGroup(name, "refs/heads/main"));
  assert.notEqual(validationGroup(name, "refs/heads/main"), validationGroup(name, "refs/heads/dev"));
  assert.equal(validationGroup(name, "refs/pull/7/merge", 7), validationGroup(name, "refs/pull/7/head", 7));
  assert.notEqual(validationGroup(name, "refs/pull/7/merge", 7), validationGroup(name, "refs/pull/8/merge", 8));
});
