import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCommanderStagePreflight } from '../scripts/commander-phase8-preflight.mjs';

const head = '2'.repeat(40);
const units = {
  'chatgpt-autopilot-commander-gateway.service': { enabled: 'disabled', active: 'inactive' },
  'chatgpt-autopilot-commander-agent.service': { enabled: 'disabled', active: 'inactive' },
};

function ready(overrides = {}) {
  return {
    nodeMajor: 22,
    head,
    expectedHead: head,
    dirty: false,
    tailscaleAddresses: ['100.72.160.97'],
    expectedTailscaleIp: '100.72.160.97',
    units,
    listenerKnown: true,
    listenerCount: 0,
    processListKnown: true,
    fallbackProcessCount: 1,
    configPrivate: true,
    configDisabled: true,
    ...overrides,
  };
}

test('Phase 8 Stage 1 preflight accepts only the fully staged fail-closed state', () => {
  const result = evaluateCommanderStagePreflight(ready());
  assert.equal(result.ok, true);
  assert.equal(Object.values(result.checks).every(Boolean), true);
});

test('preflight rejects wrong source, dirty source, old Node and missing Tailscale assignment', () => {
  for (const overrides of [
    { head: '3'.repeat(40) },
    { dirty: true },
    { dirty: null },
    { nodeMajor: 20 },
    { tailscaleAddresses: ['100.64.0.99'] },
  ]) assert.equal(evaluateCommanderStagePreflight(ready(overrides)).ok, false);
});

test('preflight rejects active/enabled Commander, occupied port, missing fallback or unsafe config', () => {
  const cases = [
    { units: { ...units, 'chatgpt-autopilot-commander-agent.service': { enabled: 'enabled', active: 'inactive' } } },
    { units: { ...units, 'chatgpt-autopilot-commander-gateway.service': { enabled: 'disabled', active: 'active' } } },
    { listenerCount: 1 },
    { listenerKnown: false },
    { fallbackProcessCount: 0 },
    { processListKnown: false },
    { configPrivate: false },
    { configDisabled: false },
  ];
  for (const overrides of cases) assert.equal(evaluateCommanderStagePreflight(ready(overrides)).ok, false);
});
