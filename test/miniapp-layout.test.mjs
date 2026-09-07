import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../web/miniapp/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../web/miniapp/styles.css", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../web/miniapp/app.js", import.meta.url), "utf8");

test("Mini App uses a compact mobile-first dashboard shell", () => {
  assert.match(html, /id="overview" class="overview-grid"/);
  assert.match(html, /id="filters" class="filter-bar"/);
  assert.match(html, /id="browserless" class="ai-card"/);
  assert.match(html, /class="maintenance-card"/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /overflow-x:hidden/);
  assert.match(css, /\.worker-line\{[^}]*text-overflow:ellipsis/s);
  assert.match(css, /-webkit-line-clamp:2/);
});

test("project cards keep dangerous and technical controls out of the primary row", () => {
  assert.match(app, /class="project-details"/);
  assert.match(app, /function technicalActions\(p, online, forceDisabled=false\)/);
  assert.match(app, /class="primary-actions"/);
  const cardBody = app.slice(app.indexOf("function card(p)"), app.indexOf("function matchesFilter"));
  const primary = cardBody.match(/<div class="primary-actions">([\s\S]*?)<\/div><\/div><details/)?.[1] || "";
  assert.doesNotMatch(primary, /data-action="restart"/);
  assert.doesNotMatch(primary, /data-action="rollover"/);
});

test("Mini App polish localizes operator chrome and cleans raw markdown previews", () => {
  assert.match(html, /Центр керування/);
  assert.match(html, /РЕЗЕРВ/);
  assert.match(html, /Резервний Chromium/);
  assert.match(app, /function|const cleanPreview/);
  assert.match(app, /\^\\s\{0,3\}#\{1,6\}/);
  assert.match(app, /Контрольна точка/);
  assert.match(app, /Самовідновлення/);
  assert.doesNotMatch(html, /Project Control|MAINTENANCE|Autopilot workers/);
});


test("Mini App makes Browserless telemetry primary and Chromium controls fallback-only", () => {
  assert.match(app, /function renderBrowserless\(data\)/);
  assert.match(app, /AI-АВТОПІЛОТ/);
  assert.match(app, /Browserless \+ Luna/);
  assert.match(app, /Luna виклики/);
  assert.match(app, /Вхідні токени/);
  assert.match(app, /Кеш/);
  assert.match(app, /Активні jobs/);
  assert.match(app, /Подієвий режим/);
  assert.match(app, /Резервний Chromium/);
  assert.match(app, /Резервний Chromium вимкнено/);
  assert.match(css, /\.ai-metrics\{[^}]*grid-template-columns:repeat\(3/s);
  assert.match(css, /@media\(max-width:520px\)[\s\S]*\.ai-metrics\{grid-template-columns:repeat\(2/s);
  assert.match(css, /\.budget-track/);
});
