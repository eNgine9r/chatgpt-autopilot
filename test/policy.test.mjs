import test from "node:test";
import assert from "node:assert/strict";
import { decideAction } from "../src/policy.mjs";

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

test("does not interrupt active generation", () => {
  assert.equal(decideAction({ ...base, generating: true }), "wait_generating");
});

test("pauses on explicit user gate", () => {
  assert.equal(
    decideAction({
      ...base,
      latestAssistantText: "Need reboot\n[[USER_ACTION_REQUIRED]]"
    }),
    "pause_for_user"
  );
});

test("stays paused until a newer user turn appears", () => {
  assert.equal(decideAction({ ...base, pausedForUser: true }), "paused_for_user");
});

test("resumes when user returns to the conversation", () => {
  assert.equal(
    decideAction({
      ...base,
      pausedForUser: true,
      latestTurnRole: "user",
      latestAssistantText: ""
    }),
    "resume_from_user"
  );
});

test("never auto-sends when the latest turn is the user", () => {
  assert.equal(
    decideAction({
      ...base,
      latestTurnRole: "user",
      latestAssistantText: ""
    }),
    "wait_for_assistant"
  );
});

test("fails closed when message roles are not recognized", () => {
  assert.equal(
    decideAction({
      ...base,
      latestTurnRole: "unknown",
      latestAssistantText: ""
    }),
    "ui_unrecognized"
  );
});

test("does not auto-send for an empty assistant turn", () => {
  assert.equal(
    decideAction({ ...base, latestAssistantText: "" }),
    "wait_for_assistant"
  );
});

test("sends only when timer is due and assistant is latest", () => {
  assert.equal(decideAction(base), "send_continue");
  assert.equal(decideAction({ ...base, dueAtMs: 3000 }), "wait_timer");
});
