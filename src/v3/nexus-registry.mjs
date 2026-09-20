const ALLOWED_CAPABILITIES = new Set([
  "coding",
  "review",
  "architecture",
  "research",
  "long-context",
  "tool-use",
  "local-offline"
]);

const PROVIDER_DEFINITIONS = Object.freeze({
  "openai-codex": {
    label: "OpenAI Codex",
    access: "subscription_cli",
    runtime: "codex",
    capabilities: ["coding", "review", "architecture", "tool-use"]
  },
  "google-gemini": {
    label: "Google Gemini",
    access: "subscription_cli",
    runtime: "pending_probe",
    capabilities: ["coding", "review", "architecture", "research", "long-context", "tool-use"]
  },
  "anthropic-claude": {
    label: "Anthropic Claude",
    access: "manual_free",
    runtime: "unavailable",
    capabilities: ["coding", "review", "architecture", "research", "long-context"]
  },
  deepseek: {
    label: "DeepSeek",
    access: "manual_free",
    runtime: "unavailable",
    capabilities: ["coding", "review", "research"]
  },
  "xai-grok": {
    label: "xAI Grok",
    access: "manual_free",
    runtime: "unavailable",
    capabilities: ["coding", "review", "research", "tool-use"]
  },
  "moonshot-kimi": {
    label: "Moonshot Kimi",
    access: "manual_free",
    runtime: "unavailable",
    capabilities: ["coding", "review", "research", "long-context"]
  },
  local: {
    label: "Local model",
    access: "local",
    runtime: "pending_probe",
    capabilities: ["coding", "review", "research", "local-offline"]
  }
});

export const NEXUS_ROLES = Object.freeze({
  orchestrator: ["architecture", "tool-use"],
  planner: ["architecture"],
  coder: ["coding", "tool-use"],
  reviewer: ["review"],
  tester: ["coding", "tool-use"],
  researcher: ["research"]
});

function finiteNonNegative(value, name) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return number;
}

function normalizeCapabilities(value, providerId) {
  const list = value == null
    ? PROVIDER_DEFINITIONS[providerId].capabilities
    : value;
  if (!Array.isArray(list)) {
    throw new Error(`${providerId}: capabilities must be an array`);
  }
  const unique = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
  for (const capability of unique) {
    if (!ALLOWED_CAPABILITIES.has(capability)) {
      throw new Error(`${providerId}: unsupported capability ${capability}`);
    }
  }
  return unique;
}

export function defaultNexusConfig() {
  return {
    enabled: false,
    policy: {
      paidApiEnabled: false,
      dailyApiBudgetUsd: 0,
      monthlyApiBudgetUsd: 0,
      maxConcurrentAgents: 1
    },
    providers: Object.fromEntries(
      Object.entries(PROVIDER_DEFINITIONS).map(([id, definition]) => [
        id,
        {
          enabled: id === "openai-codex",
          access: definition.access,
          runtime: definition.runtime,
          capabilities: [...definition.capabilities]
        }
      ])
    )
  };
}

export function normalizeNexusConfig(raw = {}) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("nexus config must be an object");
  }

  const defaults = defaultNexusConfig();
  const policyRaw = raw.policy || {};
  const paidApiEnabled = policyRaw.paidApiEnabled === true;
  const dailyApiBudgetUsd = finiteNonNegative(policyRaw.dailyApiBudgetUsd, "nexus.policy.dailyApiBudgetUsd");
  const monthlyApiBudgetUsd = finiteNonNegative(policyRaw.monthlyApiBudgetUsd, "nexus.policy.monthlyApiBudgetUsd");
  const maxConcurrentAgents = Number(policyRaw.maxConcurrentAgents ?? 1);

  if (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < 1 || maxConcurrentAgents > 32) {
    throw new Error("nexus.policy.maxConcurrentAgents must be an integer between 1 and 32");
  }
  if (!paidApiEnabled && (dailyApiBudgetUsd !== 0 || monthlyApiBudgetUsd !== 0)) {
    throw new Error("nexus paid API budgets must remain zero while paidApiEnabled=false");
  }

  const rawProviders = raw.providers || {};
  if (rawProviders == null || typeof rawProviders !== "object" || Array.isArray(rawProviders)) {
    throw new Error("nexus.providers must be an object");
  }
  for (const providerId of Object.keys(rawProviders)) {
    if (!PROVIDER_DEFINITIONS[providerId]) {
      throw new Error(`Unknown NEXUS provider: ${providerId}`);
    }
  }

  const providers = {};
  for (const [providerId, definition] of Object.entries(PROVIDER_DEFINITIONS)) {
    const override = rawProviders[providerId] || {};
    const access = String(override.access || definition.access);
    if (!["subscription_cli", "manual_free", "api", "local"].includes(access)) {
      throw new Error(`${providerId}: unsupported access mode ${access}`);
    }
    const enabled = override.enabled ?? defaults.providers[providerId].enabled;
    if (enabled === true && access === "api" && !paidApiEnabled) {
      throw new Error(`${providerId}: paid API provider cannot be enabled while paidApiEnabled=false`);
    }
    providers[providerId] = {
      enabled: enabled === true,
      access,
      runtime: String(override.runtime || definition.runtime),
      capabilities: normalizeCapabilities(override.capabilities, providerId)
    };
  }

  return {
    enabled: raw.enabled === true,
    policy: {
      paidApiEnabled,
      dailyApiBudgetUsd,
      monthlyApiBudgetUsd,
      maxConcurrentAgents
    },
    providers
  };
}

export function nexusStatus(config, probes = {}) {
  const normalized = normalizeNexusConfig(config);
  return {
    enabled: normalized.enabled,
    policy: { ...normalized.policy },
    spendUsd: 0,
    providers: Object.entries(normalized.providers).map(([id, provider]) => {
      const probe = probes[id] || {};
      const available = provider.enabled && probe.available === true;
      return {
        id,
        label: PROVIDER_DEFINITIONS[id].label,
        enabled: provider.enabled,
        available,
        access: provider.access,
        runtime: provider.runtime,
        capabilities: [...provider.capabilities],
        reason: available
          ? "available"
          : String(probe.reason || (provider.enabled ? "not_verified" : "disabled"))
      };
    })
  };
}

export function eligibleProviders(config, { role, capability } = {}) {
  const normalized = normalizeNexusConfig(config);
  const required = capability
    ? String(capability)
    : NEXUS_ROLES[String(role || "")]?.[0];

  if (!required || !ALLOWED_CAPABILITIES.has(required)) {
    throw new Error("A supported role or capability is required");
  }

  return Object.entries(normalized.providers)
    .filter(([, provider]) => provider.enabled && provider.capabilities.includes(required))
    .map(([id]) => id);
}
