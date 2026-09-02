import test from "node:test";
import assert from "node:assert/strict";
import { parseRpiConnectStatus, readinessDecision } from "../src/connect-preflight.mjs";

const idle = `Signed in: yes
Subscribed to events: yes
Screen sharing: allowed (0 sessions active)
Remote shell: allowed (0 sessions active)\n`;

test("parses Raspberry Pi Connect idle status", () => {
  assert.deepEqual(parseRpiConnectStatus(idle), {
    signedIn: true, subscribed: true, screenSharing: "allowed", screenSessions: 0,
    remoteShell: "allowed", shellSessions: 0
  });
});

test("parses active screen-sharing session", () => {
  const status = parseRpiConnectStatus(idle.replace("0 sessions active", "1 session active"));
  assert.equal(status.screenSessions, 1);
});

test("rejects incomplete or unknown status", () => {
  assert.equal(parseRpiConnectStatus("Signed in: yes\n"), null);
});

test("preflight blocks until Wayland and Connect are safe", () => {
  const status = parseRpiConnectStatus(idle);
  assert.equal(readinessDecision({ waylandReady: false, connectStatus: status }).reason, "wayland_not_ready");
  assert.equal(readinessDecision({ waylandReady: true, connectStatus: null }).reason, "connect_status_unknown");
  assert.equal(readinessDecision({ waylandReady: true, connectStatus: { ...status, signedIn: false } }).reason, "connect_not_signed_in");
  assert.equal(readinessDecision({ waylandReady: true, connectStatus: { ...status, subscribed: false } }).reason, "connect_not_subscribed");
  assert.equal(readinessDecision({ waylandReady: true, connectStatus: { ...status, screenSessions: 1 } }).reason, "screen_sharing_active");
  assert.equal(readinessDecision({ waylandReady: true, connectStatus: status }).ready, true);
});
