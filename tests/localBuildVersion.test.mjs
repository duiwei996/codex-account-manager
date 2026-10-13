import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyLocalBuildVersion } from "../scripts/verify-local-build-version.mjs";

test("local installers allow upgrades and repairs but reject accidental downgrades", () => {
  assert.doesNotThrow(() => verifyLocalBuildVersion("1.0.3", ["1.0.2"]));
  assert.doesNotThrow(() => verifyLocalBuildVersion("1.0.3", ["1.0.3"]));
  assert.doesNotThrow(() => verifyLocalBuildVersion("1.0.3", []));
  assert.throws(() => verifyLocalBuildVersion("1.0.1", ["1.0.2"]), /older than installed version/);
  assert.throws(() => verifyLocalBuildVersion("1.9.9", ["2.0.0"]), /older than installed version/);
  assert.throws(() => verifyLocalBuildVersion("1.0.3", ["1.0.2", "1.0.4"]), /older than installed version/);
});

test("invalid version metadata stops the check", () => {
  assert.throws(() => verifyLocalBuildVersion("unknown", []), /Invalid version/);
  assert.throws(() => verifyLocalBuildVersion("1.0.3", ["unknown"]), /Invalid version/);
});
