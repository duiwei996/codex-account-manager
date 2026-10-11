import assert from "node:assert/strict";
import { test } from "node:test";
import { maskAccountJson } from "../src/lib/accountTransfer.ts";

test("preview masks nested official and flat CPA credentials without changing source JSON", () => {
  for (const source of [{tokens:{access_token:"synthetic-access-token",refresh_token:"synthetic-refresh-token",account_id:"private-account"},OPENAI_API_KEY:null},
    {type:"codex",email:"private@example.com",id_token:"synthetic-id-token",access_token:"synthetic-access-token",expired:"2033-05-18T03:33:20Z"}]) {
    const full = JSON.stringify(source);
    const preview = maskAccountJson(full);
    assert.ok(preview.includes("***"));
    assert.ok(!preview.includes("synthetic-access-token"));
    assert.equal(JSON.stringify(source),full);
    if ("type" in source) assert.equal(JSON.parse(preview).type,"codex");
  }
  assert.equal(JSON.parse(maskAccountJson('{"OPENAI_API_KEY":"short"}')).OPENAI_API_KEY,"***");
});
