import test from "node:test";
import assert from "node:assert/strict";
import { BrowserlessStatusReader } from "../src/browserless-status.mjs";

test("Browserless status merges cached telemetry with fresh service health", async () => {
  let telemetryCalls = 0;
  let now = 100000;
  const reader = new BrowserlessStatusReader({
    dbFile:"unused.sqlite3", now:()=>now, cacheMs:10000,
    telemetryImpl: async () => {
      telemetryCalls += 1;
      return { available:true, mode:"event-driven", model:"gpt-5.6-luna", budget:{monthCostUsd:1}, projects:[] };
    },
    fetchImpl: async () => ({ ok:true, status:200, json:async()=>({ok:true,mode:"browserless_ingress"}) })
  });
  const first = await reader.status();
  now += 5000;
  const second = await reader.status();
  assert.equal(first.available, true);
  assert.equal(first.service.online, true);
  assert.equal(first.service.mode, "browserless_ingress");
  assert.equal(second.generatedAt, 105000);
  assert.equal(telemetryCalls, 1);
});

test("Browserless status fails soft when telemetry and health are unavailable", async () => {
  const reader = new BrowserlessStatusReader({
    dbFile:"unused.sqlite3", now:()=>100000,
    telemetryImpl: async () => { throw new Error("db_unavailable"); },
    fetchImpl: async () => ({ ok:false, status:503, json:async()=>({}) })
  });
  const status = await reader.status();
  assert.equal(status.available, false);
  assert.equal(status.service.online, false);
  assert.match(status.error, /db_unavailable/);
  assert.deepEqual(status.projects, []);
});
