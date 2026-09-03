import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/lease-policy.js");
const { isLeaseStale } = globalThis.AutopilotLeasePolicy;

test("fresh browser lease stays exclusive", () => {
  assert.equal(isLeaseStale({ leaseAtMs: 1000, nowMs: 90000, ttlMs: 90000 }), false);
});

test("expired browser lease can be reclaimed", () => {
  assert.equal(isLeaseStale({ leaseAtMs: 1000, nowMs: 91001, ttlMs: 90000 }), true);
});

test("legacy lease without timestamp is stale", () => {
  assert.equal(isLeaseStale({ leaseAtMs: 0, nowMs: 91001, ttlMs: 90000 }), true);
});
