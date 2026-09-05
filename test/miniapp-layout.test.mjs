import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../web/miniapp/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../web/miniapp/styles.css", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../web/miniapp/app.js", import.meta.url), "utf8");

test("Mini App uses a compact mobile-first dashboard shell", () => {
  assert.match(html, /id="overview" class="overview-grid"/);
  assert.match(html, /id="filters" class="filter-bar"/);
  assert.match(html, /class="maintenance-card"/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /overflow-x:hidden/);
  assert.match(css, /\.worker-line\{[^}]*text-overflow:ellipsis/s);
  assert.match(css, /-webkit-line-clamp:2/);
});

test("project cards keep dangerous and technical controls out of the primary row", () => {
  assert.match(app, /class="project-details"/);
  assert.match(app, /function technicalActions\(p, online\)/);
  assert.match(app, /class="primary-actions"/);
  const cardBody = app.slice(app.indexOf("function card(p)"), app.indexOf("function matchesFilter"));
  const primary = cardBody.match(/<div class="primary-actions">([\s\S]*?)<\/div><\/div><details/)?.[1] || "";
  assert.doesNotMatch(primary, /data-action="restart"/);
  assert.doesNotMatch(primary, /data-action="rollover"/);
});

test("Mini App polish localizes operator chrome and cleans raw markdown previews", () => {
  assert.match(html, /Центр керування/);
  assert.match(html, /ОБСЛУГОВУВАННЯ/);
  assert.match(app, /function|const cleanPreview/);
  assert.match(app, /\^\\s\{0,3\}#\{1,6\}/);
  assert.match(app, /Контрольна точка/);
  assert.match(app, /Самовідновлення/);
  assert.doesNotMatch(html, /Project Control|MAINTENANCE|Autopilot workers/);
});
