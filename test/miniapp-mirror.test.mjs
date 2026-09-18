import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../web/miniapp/app.js', import.meta.url), 'utf8');

test('Project Control Mini App excludes legacy mirror and Chromium controls', () => {
  assert.doesNotMatch(app, /function mirrorBlock\(p\)/);
  assert.doesNotMatch(app, /mirrorSync/);
  assert.doesNotMatch(app, /lastProbeAt|lastRefreshAt/);
  assert.doesNotMatch(app, /scan_chats|adopt_candidate|data-action="rollover"|data-action="restart"/);
  assert.match(app, /Commander/);
  assert.match(app, /Автопілот/);
  assert.doesNotMatch(app, /Control API|local-only/);
});
