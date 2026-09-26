import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const installerUrl = new URL('../scripts/install-primary-remote-mcp-tailscale.sh', import.meta.url);

test('primary Remote MCP systemd sandbox permits netlink interface discovery', async () => {
  const installer = await fs.readFile(installerUrl, 'utf8');
  assert.match(installer, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK/);
});
