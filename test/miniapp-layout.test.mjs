import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../web/miniapp/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/miniapp/styles.css', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../web/miniapp/app.js', import.meta.url), 'utf8');

test('Mini App is a Ukrainian four-section Project Control Center', () => {
  assert.match(html, /ЦЕНТР КЕРУВАННЯ/);
  assert.match(html, /Керування проєктами/);
  assert.match(html, /data-view-target="overview"/);
  assert.match(html, /data-view-target="commander"/);
  assert.match(html, /data-view-target="autopilot"/);
  assert.match(html, /data-view-target="system"/);
  assert.match(html, />Огляд</);
  assert.match(html, />Commander</);
  assert.match(html, />Автопілот</);
  assert.match(html, />Система</);
  assert.doesNotMatch(html, /AUTOPILOT V3/);
});

test('Mini App keeps mobile layout bounded and Telegram safe-area aware', () => {
  assert.match(css, /overflow-x:hidden/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /bottom-nav/);
  assert.match(css, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:430px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('Mini App exposes separated Commander Autopilot and System information', () => {
  assert.match(app, /Віддалене керування/);
  assert.match(app, /Автоматизація проєктів/);
  assert.match(app, /Інфраструктура/);
  assert.match(app, /NoNewPrivs/);
  assert.match(app, /GitHub Bridge/);
  assert.match(app, /Remote Desktop Commander/);
  assert.match(app, /Виклики ШІ/);
  assert.doesNotMatch(app, /\bRetry\b/);
  assert.doesNotMatch(app, /AI calls/);
  assert.doesNotMatch(app, /Deterministic control plane/);
  assert.doesNotMatch(app, /local-only/);
});
