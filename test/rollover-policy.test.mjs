import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/rollover-policy.js");
const { composeHandoff } = globalThis.AutopilotRolloverPolicy;

test("oversized rollover preserves bounded preamble and newest chat tail", () => {
  const preamble=`PLAN-${"p".repeat(20000)}`;
  const handoff=`OLD-${"x".repeat(6000)}-NEWEST`;
  const prompt=composeHandoff({preamble,handoff});
  assert.ok(prompt.length <= 20000);
  assert.match(prompt,/^PLAN-/);
  assert.match(prompt,/BOUNDED CHAT TAIL/);
  assert.match(prompt,/-NEWEST/);
  assert.doesNotMatch(prompt,/OLD-/);
});