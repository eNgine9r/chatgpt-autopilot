import test from "node:test";
import assert from "node:assert/strict";
import { candidateEligibility, selectDiscoveryCandidate, selectManualDiscoveryCandidate } from "../src/chat-discovery.mjs";

const id = "g-p-0123456789abcdef0123456789abcdef";
const project = {
  chatUrl: `https://chatgpt.com/g/${id}/c/current`,
  projectRootUrl: `https://chatgpt.com/g/${id}/project`,
  chatDiscovery: { enabled: true, autoAdopt: true, includeTitlePatterns: ["BTC Radar"] }
};

test("slugged same-project candidate is eligible by configured signal", () => {
  const result = candidateEligibility(project, {
    url: `https://chatgpt.com/g/${id}-bot-tg-bc/c/new?x=1`,
    title: "BTC Radar — continuation"
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "pattern");
  assert.equal(result.candidate.url, `https://chatgpt.com/g/${id}-bot-tg-bc/c/new`);
});

test("candidate from another ChatGPT Project is rejected", () => {
  const other = `g-p-fedcba9876543210fedcba9876543210`;
  const result = candidateEligibility(project, { url: `https://chatgpt.com/g/${other}/c/new`, title: "BTC Radar" });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "outside_project");
});

test("explicit Autopilot marker is eligible without title patterns", () => {
  const markerProject = { ...project, chatDiscovery: { enabled: true, autoAdopt: true, includeTitlePatterns: [] } };
  const result = candidateEligibility(markerProject, {
    url: `https://chatgpt.com/g/${id}/c/marker`,
    preview: "[AUTOPILOT] continue from durable checkpoint"
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "marker");
});

test("automatic selector skips current and unrelated chats", () => {
  const result = selectDiscoveryCandidate(project, [
    { url: project.chatUrl, title: "BTC Radar current" },
    { url: "https://chatgpt.com/g/g-p-fedcba9876543210fedcba9876543210/c/x", title: "BTC Radar" },
    { url: `https://chatgpt.com/g/${id}/c/newest`, title: "BTC Radar fresh" }
  ]);
  assert.equal(result.candidate.url, `https://chatgpt.com/g/${id}/c/newest`);
});

test("manual selector permits same-project candidate without auto signal", () => {
  const candidate = selectManualDiscoveryCandidate(project, [
    { url: `https://chatgpt.com/g/${id}/c/manual`, title: "Unclassified discussion" }
  ]);
  assert.equal(candidate.url, `https://chatgpt.com/g/${id}/c/manual`);
});
