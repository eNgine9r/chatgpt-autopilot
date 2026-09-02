import test from "node:test";
import assert from "node:assert/strict";
import { buildStartupPlan, validateStartupStaggerSeconds } from "../src/startup.mjs";

test("startup plan orders enabled projects by priority and staggers tabs", () => {
  const plan = buildStartupPlan([
    { id: "secondary", enabled: true, startupPriority: 100 },
    { id: "disabled", enabled: false, startupPriority: 0 },
    { id: "btc", enabled: true, startupPriority: 10 },
    { id: "same-priority", enabled: true, startupPriority: 100 }
  ], 20);
  assert.deepEqual(plan.map(({ project, delayMs }) => [project.id, delayMs]), [
    ["btc", 0],
    ["secondary", 20000],
    ["same-priority", 40000]
  ]);
});

test("startup plan keeps configuration order when priorities match", () => {
  const plan = buildStartupPlan([
    { id: "a", enabled: true, startupPriority: 100 },
    { id: "b", enabled: true, startupPriority: 100 }
  ], 10);
  assert.deepEqual(plan.map(({ project }) => project.id), ["a", "b"]);
});

test("startup stagger rejects unsafe values", () => {
  assert.equal(validateStartupStaggerSeconds(20), 20);
  assert.throws(() => validateStartupStaggerSeconds(0), /between 5 and 120/);
  assert.throws(() => validateStartupStaggerSeconds(121), /between 5 and 120/);
});
