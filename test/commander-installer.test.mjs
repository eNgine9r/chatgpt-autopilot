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
    assert.match(unit, /ProtectHome=read-only/);
    assert.match(unit, /UMask=0077/);
    assert.match(unit, /MemoryMax=192M/);
    assert.match(unit, /TasksMax=32/);
    assert.doesNotMatch(unit, /sudo/);
  }
  const agentEnv = await fs.readFile(path.join(configHome, 'chatgpt-autopilot-commander/agent.env'), 'utf8');
  assert.match(gatewayUnit, /RuntimeDirectory=chatgpt-autopilot-commander/);
  assert.match(gatewayUnit, /RuntimeDirectoryMode=0700/);
  const gatewayEnv = await fs.readFile(path.join(configHome, 'chatgpt-autopilot-commander/gateway.env'), 'utf8');
  assert.match(agentEnv, /COMMANDER_ENABLED=false/);
  assert.match(agentEnv, /COMMANDER_EXECUTION_ENABLED=false/);
  assert.match(agentEnv, /COMMANDER_WRITE_ENABLED=false/);
  assert.match(agentEnv, /COMMANDER_ADMIN_ENABLED=false/);
  assert.match(gatewayEnv, /COMMANDER_ENABLED=false/);
  assert.match(gatewayEnv, /COMMANDER_PRIVATE_BIND_ENABLED=false/);
  assert.match(gatewayEnv, /COMMANDER_EXECUTION_ENABLED=false/);
  assert.match(gatewayEnv, /COMMANDER_WRITE_ENABLED=false/);
  assert.match(gatewayEnv, /COMMANDER_ADMIN_ENABLED=false/);
  const readPolicyPath = path.join(configHome, 'chatgpt-autopilot-commander/read-policy.json');
  const readPolicy = JSON.parse(await fs.readFile(readPolicyPath, 'utf8'));
  assert.deepEqual(readPolicy, { version: 1, roots: [], repositories: [], services: [] });
  assert.equal((await fs.stat(readPolicyPath)).mode & 0o077, 0);
  const writePolicyPath = path.join(configHome, 'chatgpt-autopilot-commander/write-policy.json');
  const writePolicy = JSON.parse(await fs.readFile(writePolicyPath, 'utf8'));
  assert.deepEqual(writePolicy, { version: 1, roots: [], services: [], repositories: [] });
  assert.equal((await fs.stat(writePolicyPath)).mode & 0o077, 0);
  const script = await fs.readFile(path.join(repo, 'scripts/install-commander-systemd.sh'), 'utf8');
  assert.match(script, /XDG_RUNTIME_DIR=.*run\/user/);
  assert.match(script, /DBUS_SESSION_BUS_ADDRESS=.*unix:path/);
  assert.doesNotMatch(script, /systemctl\s+--user\s+(?:enable|start|restart)/);
});


test('Commander installer accepts explicit absolute Node binary for non-login shells', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-node-override-'));
  const fakeNode = path.join(root, 'node-v22');
  await fs.writeFile(fakeNode, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  await execFileAsync('bash', [path.join(repo, 'scripts/install-commander-systemd.sh')], {
    cwd: repo,
    env: {
      HOME: root,
      PATH: '/usr/bin:/bin',
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      COMMANDER_NODE_BIN: fakeNode,
      COMMANDER_INSTALL_SKIP_SYSTEMD_RELOAD: '1',
    },
  });
  const gatewayUnit = await fs.readFile(path.join(configHome, 'systemd/user/chatgpt-autopilot-commander-gateway.service'), 'utf8');
  assert.match(gatewayUnit, new RegExp(`ExecStart=${fakeNode.replaceAll('/', '\\/')}`));
});

test('Commander installer rejects a relative COMMANDER_NODE_BIN', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-node-relative-'));
  await assert.rejects(execFileAsync('bash', [path.join(repo, 'scripts/install-commander-systemd.sh')], {
    cwd: repo,
    env: { ...process.env, HOME: root, COMMANDER_NODE_BIN: './node', COMMANDER_INSTALL_SKIP_SYSTEMD_RELOAD: '1' },
  }), /absolute executable path/);
});
