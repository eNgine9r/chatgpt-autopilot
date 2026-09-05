import test from "node:test";
import assert from "node:assert/strict";
import { validateRestartServices, restartWorkerServices } from "../src/worker-restart.mjs";

test("worker restart only accepts Autopilot systemd services", () => {
  assert.deepEqual(validateRestartServices(["chatgpt-project-autopilot.service", "chatgpt-autopilot-dev-browser.service"]), ["chatgpt-project-autopilot.service", "chatgpt-autopilot-dev-browser.service"]);
  assert.throws(() => validateRestartServices(["ssh.service"]), /unsafe_restart_service/);
  assert.throws(() => validateRestartServices(["chatgpt-autopilot-control-hub.service"]), /unsafe_restart_service/);
  assert.throws(() => validateRestartServices(["chatgpt-autopilot-dev-cutover-v2.service"]), /unsafe_restart_service/);
  assert.throws(() => validateRestartServices([]), /not_configured/);
});

test("worker restart preserves configured service order", async () => {
  const calls = [];
  const worker = { id: "dev", restartServices: ["chatgpt-autopilot-dev-bridge.service", "chatgpt-autopilot-dev-browser.service"] };
  await restartWorkerServices(worker, { execFileImpl: async (file, args) => calls.push([file, args]) });
  assert.deepEqual(calls, [
    ["systemctl", ["--user", "restart", "chatgpt-autopilot-dev-bridge.service"]],
    ["systemctl", ["--user", "restart", "chatgpt-autopilot-dev-browser.service"]]
  ]);
});
