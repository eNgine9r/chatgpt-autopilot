import test from "node:test";
import assert from "node:assert/strict";
import { candidateEligibility, newerDiscoveryCandidates, selectDiscoveryCandidate, selectManualDiscoveryCandidate } from "../src/chat-discovery.mjs";

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

test("ordered discovery considers only chats newer than the configured current chat", () => {
  const newer = `https://chatgpt.com/g/${id}/c/newer`;
  const older = `https://chatgpt.com/g/${id}/c/older`;
  const window = newerDiscoveryCandidates(project, [
    { url: newer, title: "BTC Radar newer" },
    { url: project.chatUrl, title: "BTC Radar current" },
    { url: older, title: "BTC Radar older" }
  ]);
  assert.equal(window.ready, true);
  assert.deepEqual(window.candidates.map((item) => item.url), [newer]);
  const result = selectDiscoveryCandidate(project, [
    { url: newer, title: "BTC Radar newer" },
    { url: project.chatUrl, title: "BTC Radar current" },
    { url: older, title: "BTC Radar older" }
  ]);
  assert.equal(result.candidate.url, newer);
});

test("discovery fails closed until the current chat is observed", () => {
  const result = selectDiscoveryCandidate(project, [
    { url: `https://chatgpt.com/g/${id}/c/newer`, title: "BTC Radar newer" }
  ]);
  assert.equal(result.candidate, null);
  assert.equal(result.reason, "current_not_observed");
  assert.equal(selectManualDiscoveryCandidate(project, [{ url: `https://chatgpt.com/g/${id}/c/newer` }]), null);
});

test("current newest chat never offers an older conversation for manual adoption", () => {
  const older = `https://chatgpt.com/g/${id}/c/older`;
  const ordered = [
    { url: project.chatUrl, title: "Current newest" },
    { url: older, title: "BTC Radar older" }
  ];
  const auto = selectDiscoveryCandidate(project, ordered);
  assert.equal(auto.candidate, null);
  assert.equal(auto.reason, "no_newer_candidate");
  assert.equal(selectManualDiscoveryCandidate(project, ordered), null);
});

test("manual selector permits a newer same-project candidate without auto signal", () => {
  const candidate = selectManualDiscoveryCandidate(project, [
    { url: `https://chatgpt.com/g/${id}/c/manual`, title: "Unclassified discussion" },
    { url: project.chatUrl, title: "Current" },
    { url: `https://chatgpt.com/g/${id}/c/older`, title: "Older" }
  ]);
  assert.equal(candidate.url, `https://chatgpt.com/g/${id}/c/manual`);
});
