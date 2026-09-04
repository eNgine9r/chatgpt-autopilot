import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCheckpoint, checkpointFingerprint, checkpointPromptContract,
  checkpointDisplayStatus, formatCheckpointBlock
} from "../src/checkpoint-ledger.mjs";

test("checkpoint normalization is bounded and plan-version locked", () => {
  const checkpoint = normalizeCheckpoint({
    goal: "g".repeat(2000), completed: Array.from({length:30},(_,i)=>`done-${i}`),
    currentTask: "task", decisions:["keep plan"], evidence:["commit abc"], blockers:[],
    nextAction:"next", doNotRepeat:["old task"], planVersion:"v7", stage:"complete", githubPr:67
  }, { planVersion:"v7" });
  assert.equal(checkpoint.goal.length, 1200);
  assert.equal(checkpoint.completed.length, 20);
  assert.equal(checkpoint.stage, "complete");
  assert.equal(checkpoint.githubPr, 67);
  assert.throws(() => normalizeCheckpoint({ planVersion:"v6" }, { planVersion:"v7" }), /plan_version_mismatch/);
});

test("checkpoint fingerprint is deterministic and completion status never overclaims", () => {
  const checkpoint = normalizeCheckpoint({ goal:"x", planVersion:"v1", stage:"complete" }, { planVersion:"v1" });
  assert.equal(checkpointFingerprint(checkpoint), checkpointFingerprint(checkpoint));
  assert.equal(checkpointDisplayStatus({ ...checkpoint, fingerprint:"x" }, { configured:false, ok:false }), "complete_claimed");
  assert.equal(checkpointDisplayStatus({ ...checkpoint, fingerprint:"x" }, { configured:true, ok:false }), "complete_pending_evidence");
  assert.equal(checkpointDisplayStatus({ ...checkpoint, fingerprint:"x" }, { configured:true, ok:true }), "complete_verified");
});
test("checkpoint prompt contract and rollover display preserve the approved plan", () => {
  const contract = checkpointPromptContract({ checkpointLedger:{enabled:true}, planVersion:"2026-09-04-v1" });
  assert.match(contract, /AUTOPILOT_CHECKPOINT/);
  assert.match(contract, /2026-09-04-v1/);
  assert.match(contract, /Не вигадуй evidence/);
  const block = formatCheckpointBlock({
    fingerprint:"abc", planVersion:"2026-09-04-v1", goal:"Ship v2", currentTask:"Issue 64",
    completed:["Issue 62","Issue 63"], decisions:["fail closed"], evidence:["PR #67"], blockers:[],
    nextAction:"finish ledger", doNotRepeat:["old browser hacks"], stage:"active", completionStatus:"active"
  });
  assert.match(block, /Ship v2/);
  assert.match(block, /Issue 62/);
  assert.match(block, /old browser hacks/);
});