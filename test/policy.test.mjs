import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/policy.js");
const {
  decideAction,
  normalizeChatUrl,
  fingerprint,
  shouldResumeFromTurns,
  shouldResumeFromLatestAssistant,
  isConversationCapacityReached,
  isStartupGraceActive,
  refreshedWatchdogAt,
  recoveryWatchdogDeadline,
  shouldCheckRecoveryWatchdog,
  shouldAutoRolloverForStall
} = globalThis.AutopilotPolicy;

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



test("paused recovery accepts a newer assistant turn after user intervention", () => {
  const gateMarker = "[[USER_ACTION_REQUIRED]]";
  const baseResume = { pausedForUser: true, gateTurnId: "gate", latestTurnRole: "assistant", latestTurnId: "new-assistant", latestAssistantText: "Safe work continues", gateMarker };
  assert.equal(shouldResumeFromLatestAssistant(baseResume), true);
  assert.equal(shouldResumeFromLatestAssistant({ ...baseResume, latestTurnId: "gate" }), false);
  assert.equal(shouldResumeFromLatestAssistant({ ...baseResume, latestAssistantText: `Still blocked ${gateMarker}` }), false);
  assert.equal(shouldResumeFromLatestAssistant({ ...baseResume, latestTurnRole: "user" }), false);
  assert.equal(shouldResumeFromLatestAssistant({ ...baseResume, pausedForUser: false }), false);
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


test("state-driven mode waits for the assistant instead of using a timer", () => {
  const stateDriven = { ...base, autoContinueMode: "on_completion", latestTurnRole: "user" };
  assert.equal(decideAction(stateDriven), "wait_assistant");
  assert.equal(decideAction({ ...stateDriven, latestTurnRole: "assistant", assistantFinished: false }), "wait_completion");
});

test("state-driven mode requires an explicit finished assistant status", () => {
  const stateDriven = {
    ...base,
    autoContinueMode: "on_completion",
    assistantFinished: null,
    latestTurnKey: "a1"
  };
  assert.equal(decideAction(stateDriven), "fail_closed");
  assert.equal(decideAction({ ...stateDriven, assistantFinished: false }), "wait_completion");
});

test("state-driven mode observes, settles, sends once, then waits for a new turn", () => {
  const stateDriven = {
    ...base,
    autoContinueMode: "on_completion",
    assistantFinished: true,
    latestTurnKey: "a1",
    lastContinuedTurnKey: "",
    completionObservedTurnKey: "",
    completionObservedAtMs: 0,
    completionSettleMs: 10000,
    nowMs: 20000
  };
  assert.equal(decideAction(stateDriven), "observe_completion");
  assert.equal(decideAction({
    ...stateDriven,
    completionObservedTurnKey: "a1",
    completionObservedAtMs: 15000
  }), "wait_settle");
  assert.equal(decideAction({
    ...stateDriven,
    completionObservedTurnKey: "a1",
    completionObservedAtMs: 9000
  }), "send_continue");
  assert.equal(decideAction({
    ...stateDriven,
    lastContinuedTurnKey: "a1",
    completionObservedTurnKey: "a1",
    completionObservedAtMs: 9000
  }), "wait_next_turn");
});

test("generation remains the absolute blocker in state-driven mode", () => {
  assert.equal(decideAction({
    ...base,
    autoContinueMode: "on_completion",
    generating: true,
    assistantFinished: true,
    latestTurnKey: "a1"
  }), "wait_generating");
});


test("startup grace is bounded and expires deterministically", () => {
  assert.equal(isStartupGraceActive(10_000, 1_000, 30_000), true);
  assert.equal(isStartupGraceActive(30_999, 1_000, 30_000), true);
  assert.equal(isStartupGraceActive(31_000, 1_000, 30_000), false);
  assert.equal(isStartupGraceActive(999, 1_000, 30_000), false);
  assert.equal(isStartupGraceActive(10_000, 0, 30_000), false);
  assert.equal(isStartupGraceActive(10_000, 1_000, 0), false);
});

test("watchdog deadline moves only when real progress changes", () => {
  assert.equal(refreshedWatchdogAt({
    watchdogAtMs: 30_000, previousProgressKey: "a", currentProgressKey: "a", nowMs: 10_000, watchdogMs: 20_000
  }), 30_000);
  assert.equal(refreshedWatchdogAt({
    watchdogAtMs: 30_000, previousProgressKey: "a", currentProgressKey: "b", nowMs: 10_000, watchdogMs: 20_000
  }), 30_000);
  assert.equal(refreshedWatchdogAt({
    watchdogAtMs: 30_000, previousProgressKey: "a", currentProgressKey: "b", nowMs: 12_000, watchdogMs: 20_000
  }), 32_000);
  assert.equal(refreshedWatchdogAt({
    watchdogAtMs: 0, previousProgressKey: "a", currentProgressKey: "b", nowMs: 12_000, watchdogMs: 20_000
  }), 0);
});

test("stalled Project chat rolls over only after deadline and never across a user gate", () => {
  const baseRollover = {
    autoRollover: true, pausedForUser: false, rolloverInProgress: false, nowMs: 30_000, watchdogAtMs: 30_000
  };
  assert.equal(shouldAutoRolloverForStall(baseRollover), true);
  assert.equal(shouldAutoRolloverForStall({ ...baseRollover, nowMs: 29_999 }), false);
  assert.equal(shouldAutoRolloverForStall({ ...baseRollover, pausedForUser: true }), false);
  assert.equal(shouldAutoRolloverForStall({ ...baseRollover, rolloverInProgress: true }), false);
  assert.equal(shouldAutoRolloverForStall({ ...baseRollover, autoRollover: false }), false);
});

test("recovery watchdog covers post-continuation and fail-closed stalls", () => {
  for (const action of [
    "wait_generating",
    "wait_assistant",
    "wait_completion",
    "wait_next_turn",
    "fail_closed"
  ]) {
    assert.equal(shouldCheckRecoveryWatchdog(action), true, action);
  }
  for (const action of ["wait_settle", "paused_for_user", "send_continue", "disabled"]) {
    assert.equal(shouldCheckRecoveryWatchdog(action), false, action);
  }
});

test("missing recovery deadline is rebuilt from last real progress", () => {
  assert.equal(recoveryWatchdogDeadline({
    watchdogAtMs: 0, lastProgressAtMs: 10_000, nowMs: 50_000, watchdogMs: 20_000
  }), 30_000);
  assert.equal(recoveryWatchdogDeadline({
    watchdogAtMs: 0, lastProgressAtMs: 0, nowMs: 50_000, watchdogMs: 20_000
  }), 70_000);
  assert.equal(recoveryWatchdogDeadline({
    watchdogAtMs: 99_000, lastProgressAtMs: 10_000, nowMs: 50_000, watchdogMs: 20_000
  }), 99_000);
});
