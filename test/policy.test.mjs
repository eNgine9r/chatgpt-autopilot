import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/policy.js");
const { decideAction, normalizeChatUrl, fingerprint } = globalThis.AutopilotPolicy;

const base = {
  enabled: true,
  generating: false,
  pausedForUser: false,
  latestTurnRole: "assistant",
  latestAssistantText: "done",
  gateMarker: "[[USER_ACTION_REQUIRED]]",
  nowMs: 2000,
  dueAtMs: 1000
};

test("generation is never interrupted", () => {
  assert.equal(decideAction({ ...base, generating: true }), "wait_generating");
});

test("explicit gate pauses before any timer send", () => {
  assert.equal(decideAction({ ...base, latestAssistantText: `Need input\n${base.gateMarker}` }), "pause_for_user");
});

test("paused project resumes only after a newer user turn", () => {
  assert.equal(decideAction({ ...base, pausedForUser: true }), "paused_for_user");
  assert.equal(decideAction({ ...base, pausedForUser: true, latestTurnRole: "user" }), "resume_from_user");
});

test("unknown or empty assistant state fails closed", () => {
  assert.equal(decideAction({ ...base, latestTurnRole: "unknown" }), "fail_closed");
  assert.equal(decideAction({ ...base, latestAssistantText: "" }), "fail_closed");
});

test("send requires due timer and assistant as latest turn", () => {
  assert.equal(decideAction(base), "send_continue");
  assert.equal(decideAction({ ...base, dueAtMs: 3000 }), "wait_timer");
  assert.equal(decideAction({ ...base, latestTurnRole: "user" }), "fail_closed");
});

test("chat URL normalization is stable", () => {
  assert.equal(normalizeChatUrl("https://chatgpt.com/c/abc/?x=1#y"), "https://chatgpt.com/c/abc");
});

test("fingerprint is deterministic", () => {
  assert.equal(fingerprint("abc"), fingerprint("abc"));
  assert.notEqual(fingerprint("abc"), fingerprint("abd"));
});
