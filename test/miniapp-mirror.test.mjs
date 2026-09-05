import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app=fs.readFileSync(new URL("../web/miniapp/app.js",import.meta.url),"utf8");
test("Mini App renders mirror sync telemetry without exposing control mutation",()=>{
  assert.match(app,/function mirrorBlock\(p\)/);
  assert.match(app,/Mirror sync:/);
  assert.match(app,/lastProbeAt/);
  assert.match(app,/lastRefreshAt/);
  assert.match(app,/mirrorBlock\(p\)/);
  assert.doesNotMatch(app,/data-action="mirror/);
});
