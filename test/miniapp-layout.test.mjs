import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../web/miniapp/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/miniapp/styles.css', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../web/miniapp/app.js', import.meta.url), 'utf8');

test('Mini App is a compact Autopilot v3 dashboard', () => {
  assert.match(html, /AUTOPILOT V3/);
  assert.match(html, /id="overview" class="overview-grid"/);
  assert.match(html, /id="services" class="ai-card"/);
  assert.match(html, /id="projects" class="projects"/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /overflow-x:hidden/);
});

test('Mini App renders only deterministic v3 infrastructure state', () => {
  assert.match(app, /GitHub webhook/);
  assert.match(app, /Telegram bridge/);
  assert.match(app, /Control API/);
  assert.match(app, /AI calls/);
  assert.match(app, /local-only/);
  assert.doesNotMatch(app, /Browserless \+ Luna/);
  assert.doesNotMatch(app, /Luna виклики/);
});
