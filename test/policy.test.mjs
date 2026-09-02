import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/policy.js");
const { decideAction, normalizeChatUrl, fingerprint, shouldResumeFromTurns, isConversationCapacityReached } = globalThis.AutopilotPolicy;

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

test("paused project resumes when latest turn is user", () => {
  assert.equal(decideAction({ ...base, pausedForUser: true }), "paused_for_user");
  assert.equal(decideAction({ ...base, pausedForUser: true, latestTurnRole: "user" }), "resume_from_user");
});

test("paused recovery detects a user turn after the stored gate", () => {
  const turns = [
    { turnId: "u1", role: "user" },
    { turnId: "gate", role: "assistant" },
    { turnId: "u2", role: "user" },
    { turnId: "a2", role: "assistant" }
  ];
  assert.equal(shouldResumeFromTurns(turns, "gate"), true);
  assert.equal(shouldResumeFromTurns(turns.slice(0, 2), "gate"), false);
  assert.equal(shouldResumeFromTurns(turns, "missing"), false);
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


test("capacity detection accepts only strong explicit platform-style signals", () => {
  assert.equal(isConversationCapacityReached("You’ve reached the maximum length for this conversation."), true);
  assert.equal(isConversationCapacityReached("Ця розмова досягла максимальної довжини. Розпочніть новий чат."), true);
  assert.equal(isConversationCapacityReached("Достигнута максимальная длина этого чата."), true);
  assert.equal(isConversationCapacityReached("We should probably start a new chat sometime."), false);
  assert.equal(isConversationCapacityReached("Context windows are an interesting topic."), false);
});
