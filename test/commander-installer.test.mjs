import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentService } from '../src/commander/agent/service.mjs';
import { runGatewayService } from '../src/commander/gateway/service.mjs';

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('disabled service entrypoints exit without creating network or identity state', async () => {
  assert.equal(await runAgentService({ COMMANDER_ENABLED: 'false' }), null);
  assert.equal(await runGatewayService({ COMMANDER_ENABLED: 'false' }), null);
});

test('Commander installer stages hardened disabled user units only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-install-'));
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  const result = await execFileAsync('bash', [path.join(repo, 'scripts/install-commander-systemd.sh')], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      COMMANDER_INSTALL_SKIP_SYSTEMD_RELOAD: '1',
    },
  });
  assert.match(result.stdout, /NOT enabled or started/);
  const unitDir = path.join(configHome, 'systemd/user');
  const agentUnit = await fs.readFile(path.join(unitDir, 'chatgpt-autopilot-commander-agent.service'), 'utf8');
  const gatewayUnit = await fs.readFile(path.join(unitDir, 'chatgpt-autopilot-commander-gateway.service'), 'utf8');
  for (const unit of [agentUnit, gatewayUnit]) {
    assert.match(unit, /NoNewPrivileges=true/);
    assert.match(unit, /ProtectSystem=strict/);
    assert.match(unit, /UMask=0077/);
    assert.match(unit, /MemoryMax=192M/);
    assert.match(unit, /TasksMax=32/);
    assert.doesNotMatch(unit, /sudo/);
  }
  assert.match(await fs.readFile(path.join(configHome, 'chatgpt-autopilot-commander/agent.env'), 'utf8'), /COMMANDER_ENABLED=false/);
  assert.match(await fs.readFile(path.join(configHome, 'chatgpt-autopilot-commander/gateway.env'), 'utf8'), /COMMANDER_ENABLED=false/);
  const readPolicyPath = path.join(configHome, 'chatgpt-autopilot-commander/read-policy.json');
  const readPolicy = JSON.parse(await fs.readFile(readPolicyPath, 'utf8'));
  assert.deepEqual(readPolicy, { version: 1, roots: [], repositories: [], services: [] });
  assert.equal((await fs.stat(readPolicyPath)).mode & 0o077, 0);
  const script = await fs.readFile(path.join(repo, 'scripts/install-commander-systemd.sh'), 'utf8');
  assert.doesNotMatch(script, /systemctl\s+--user\s+(?:enable|start|restart)/);
});
