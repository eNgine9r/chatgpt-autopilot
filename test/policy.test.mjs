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

test("sends only when timer is due", () => {
  assert.equal(decideAction(base), "send_continue");
  assert.equal(decideAction({ ...base, dueAtMs: 3000 }), "wait_timer");
});
