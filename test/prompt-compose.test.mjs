import test from "node:test";
import assert from "node:assert/strict";
import { composeContinuationPrompt, composeRolloverPrompt } from "../src/prompt-compose.mjs";

const project = {
  continuationPrompt: "Continue current task.",
  rolloverPrompt: "Resume in a new chat.",
  planVersion: "2026-09-04",
  planAnchor: "Follow the approved project plan; do not invent a new direction."
};

test("plan anchor is injected into every continuation", () => {
  const prompt = composeContinuationPrompt(project);
  assert.match(prompt, /PLAN ANCHOR/);
  assert.match(prompt, /2026-09-04/);
  assert.match(prompt, /approved project plan/);
});

test("rollover composes plan anchor, checkpoint and bounded tail", () => {
  const prompt = composeRolloverPrompt(project, "last conversation", { runtime: { status: "assistant", latestAssistantExcerpt: "done A, next B" } });
  assert.match(prompt, /approved project plan/);
  assert.match(prompt, /DURABLE CHECKPOINT/);
  assert.match(prompt, /done A, next B/);
  assert.match(prompt, /last conversation/);
});
