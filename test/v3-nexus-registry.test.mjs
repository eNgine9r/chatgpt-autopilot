import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultNexusConfig,
  eligibleProviders,
  nexusStatus,
  normalizeNexusConfig
} from "../src/v3/nexus-registry.mjs";

test("NEXUS defaults to zero paid API spend", () => {
  const config = defaultNexusConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.policy.paidApiEnabled, false);
  assert.equal(config.policy.dailyApiBudgetUsd, 0);
  assert.equal(config.policy.monthlyApiBudgetUsd, 0);
  assert.equal(config.policy.maxConcurrentAgents, 1);
  assert.equal(config.providers["openai-codex"].enabled, true);
  assert.equal(config.providers["anthropic-claude"].enabled, false);
});

test("non-zero API budget is rejected while paid API is disabled", () => {
  assert.throws(
    () => normalizeNexusConfig({ policy: { monthlyApiBudgetUsd: 1 } }),
    /budgets must remain zero/
  );
});

test("paid API provider cannot silently enable under zero-spend policy", () => {
  assert.throws(
    () => normalizeNexusConfig({
      providers: {
        deepseek: { enabled: true, access: "api" }
      }
    }),
    /paid API provider cannot be enabled/
  );
});

test("unknown providers fail closed", () => {
  assert.throws(
    () => normalizeNexusConfig({ providers: { mystery: { enabled: true } } }),
    /Unknown NEXUS provider/
  );
});

test("manual free providers stay disabled by default", () => {
  const config = normalizeNexusConfig({});
  for (const id of ["anthropic-claude", "deepseek", "xai-grok", "moonshot-kimi"]) {
    assert.equal(config.providers[id].enabled, false);
    assert.equal(config.providers[id].access, "manual_free");
  }
});

test("status exposes no secrets and requires a positive runtime probe", () => {
  const status = nexusStatus(defaultNexusConfig(), {
    "openai-codex": { available: true }
  });
  const codex = status.providers.find((provider) => provider.id === "openai-codex");
  assert.equal(codex.available, true);
  assert.equal(codex.reason, "available");
  assert.equal(status.spendUsd, 0);
  assert.equal(JSON.stringify(status).includes("apiKey"), false);
});

test("eligibleProviders selects enabled providers by role capability", () => {
  const config = normalizeNexusConfig({
    providers: {
      local: { enabled: true, access: "local", capabilities: ["review", "local-offline"] }
    }
  });
  assert.deepEqual(eligibleProviders(config, { role: "reviewer" }), [
    "openai-codex",
    "local"
  ]);
});

test("explicit paid API enablement still requires an explicit positive policy", () => {
  const config = normalizeNexusConfig({
    enabled: true,
    policy: {
      paidApiEnabled: true,
      dailyApiBudgetUsd: 1,
      monthlyApiBudgetUsd: 10,
      maxConcurrentAgents: 2
    },
    providers: {
      deepseek: { enabled: true, access: "api" }
    }
  });
  assert.equal(config.providers.deepseek.enabled, true);
  assert.equal(config.policy.monthlyApiBudgetUsd, 10);
});
