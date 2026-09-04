import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/checkpoint-policy.js");
const { parse, strip } = globalThis.AutopilotCheckpointPolicy;

test("parses only a strict bounded checkpoint envelope", () => {
  const text = `progress\n[[AUTOPILOT_CHECKPOINT]]\n{"goal":"g","planVersion":"v1","stage":"active"}\n[[/AUTOPILOT_CHECKPOINT]]`;
  assert.deepEqual(parse(text), { goal:"g", planVersion:"v1", stage:"active" });
  assert.equal(parse("no checkpoint"), null);
  assert.equal(parse("[[AUTOPILOT_CHECKPOINT]]{bad}[[/AUTOPILOT_CHECKPOINT]]"), null);
});

test("uses the latest checkpoint envelope in a long assistant response", () => {
  const text = `[[AUTOPILOT_CHECKPOINT]]{"goal":"old"}[[/AUTOPILOT_CHECKPOINT]] x [[AUTOPILOT_CHECKPOINT]]{"goal":"new"}[[/AUTOPILOT_CHECKPOINT]]`;
  assert.equal(parse(text).goal, "new");
});

test("strips machine checkpoint envelopes from human handoff text", () => {
  const text=`Done implementation.\n[[AUTOPILOT_CHECKPOINT]]{"goal":"x"}[[/AUTOPILOT_CHECKPOINT]]\nNext paragraph.`;
  assert.equal(strip(text),"Done implementation.\n\nNext paragraph.");
});
