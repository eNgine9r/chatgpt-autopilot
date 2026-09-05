#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadProjects } from "../src/config.mjs";
import { ProjectRuntimeStore } from "../src/runtime-store.mjs";
import { isFreshPausedIdleState, validateDedicatedV2Project, acceptsDedicatedV2Status, renderDedicatedWorkerUnits } from "../src/dedicated-cutover.mjs";
import { withExtensionsDeveloperMode } from "../src/chromium-profile.mjs";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDir = process.env.HOME || "";
const uid = process.getuid?.() ?? 0;
const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
const projectsFile = path.resolve(process.env.AUTOPILOT_DEV_PROJECTS_FILE || path.join(appDir, "runtime/projects-autopilot-dev-v2.json"));
const stateDir = path.resolve(process.env.AUTOPILOT_DEV_STATE_DIR || path.join(appDir, "state-autopilot-dev"));
const serviceDir = path.resolve(process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "systemd/user");
const bridgeService = path.join(serviceDir, "chatgpt-autopilot-dev-bridge.service");
const browserService = path.join(serviceDir, "chatgpt-autopilot-dev-browser.service");
const browserProfileDir = path.resolve(process.env.AUTOPILOT_DEV_BROWSER_PROFILE_DIR || path.join(appDir, "browser-profile-autopilot-dev"));
const browserPreferences = path.join(browserProfileDir, "Default", "Preferences");
const lockFile = path.join(appDir, "runtime/cutover-autopilot-dev-v2.lock");
const execute = process.argv.includes("--execute");
const idleTimeoutMs = Number(process.env.AUTOPILOT_DEV_IDLE_TIMEOUT_MS || 2 * 60 * 60 * 1000);
const acceptTimeoutMs = Number(process.env.AUTOPILOT_DEV_ACCEPT_TIMEOUT_MS || 120000);

function assertFile(file, label = file) {
  if (!fs.existsSync(file)) throw new Error(`missing:${label}`);
}
function writeAtomic(file, content, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}
async function systemctl(...args) {
  return execFileAsync("systemctl", ["--user", ...args], {
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus` },
    timeout: 30000, maxBuffer: 1024 * 1024
  });
}
async function gitHead() {
  const { stdout } = await execFileAsync("git", ["-C", appDir, "rev-parse", "HEAD"], { timeout: 10000 });
  return stdout.trim();
}
async function readOperatorStatus() {
  const response = await fetch("http://127.0.0.1:8767/operator/status", { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`operator_status_http_${response.status}`);
  return response.json();
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch (error) { lastError = error; }
    await sleep(1000);
  }
  throw new Error(`${label}_timeout${lastError ? `:${String(lastError.message || lastError)}` : ""}`);
}

if (uid === 0) throw new Error("run_as_normal_autopilot_user");
if (!homeDir) throw new Error("HOME_required");
assertFile(projectsFile, "v2_projects_file");
assertFile(path.join(appDir, "src/browser-worker.mjs"), "dedicated_bridge_launcher");
assertFile(path.join(appDir, "extension/manifest.json"), "canonical_extension");
assertFile(bridgeService, "existing_bridge_service");
assertFile(browserService, "existing_browser_service");
assertFile(path.join(runtimeDir, "bus"), "user_systemd_bus");

const projects = loadProjects(projectsFile);
const project = validateDedicatedV2Project(projects.find((item) => item.id === "autopilot-development"));
const store = new ProjectRuntimeStore({ stateDir, projects: [project] });
const units = renderDedicatedWorkerUnits({ appDir, nodeBin: process.execPath, projectsFile, stateDir, homeDir, runtimeDir, chatUrl: project.chatUrl });
let browserPreferencesParsed = {};
try {
  if (fs.existsSync(browserPreferences)) browserPreferencesParsed = JSON.parse(fs.readFileSync(browserPreferences, "utf8"));
} catch (error) {
  throw new Error(`invalid_browser_preferences:${String(error.message || error)}`);
}
const preflight = {
  ok: true, mode: execute ? "execute" : "dry-run", projectId: project.id,
  projectsFile, stateDir, bridgeService, browserService, browserProfileDir, browserPreferences,
  policy: { browserRecovery: project.browserRecovery, checkpointLedgerEnabled: project.checkpointLedger.enabled, chatDiscovery: project.chatDiscovery },
  currentStateSafe: isFreshPausedIdleState(store.snapshot(project.id)),
  browserDeveloperMode: browserPreferencesParsed.extensions?.ui?.developer_mode === true
};
if (!execute) {
  console.log(JSON.stringify(preflight, null, 2));
  process.exit(0);
}

let lockFd;
let mutated = false;
let previousBridge = "";
let previousBrowser = "";
let previousPreferences = "";
let preferencesExisted = false;
let backupDir = "";
try {
  lockFd = fs.openSync(lockFile, "wx", 0o600);
  store.setPaused(project.id, true);
  const idleState = await waitFor(() => {
    const current = store.snapshot(project.id);
    return isFreshPausedIdleState(current) ? current : null;
  }, idleTimeoutMs, "pre_cutover_idle");
  const beforeSeen = Number(idleState.runtime.lastSeenAt || 0);

  previousBridge = fs.readFileSync(bridgeService, "utf8");
  previousBrowser = fs.readFileSync(browserService, "utf8");
  backupDir = path.join(appDir, "runtime", `cutover-backup-${Date.now()}`);
  fs.mkdirSync(backupDir, { mode: 0o700 });
  fs.writeFileSync(path.join(backupDir, path.basename(bridgeService)), previousBridge, { mode: 0o600 });
  fs.writeFileSync(path.join(backupDir, path.basename(browserService)), previousBrowser, { mode: 0o600 });
  preferencesExisted = fs.existsSync(browserPreferences);
  if (preferencesExisted) {
    previousPreferences = fs.readFileSync(browserPreferences, "utf8");
    JSON.parse(previousPreferences);
    fs.writeFileSync(path.join(backupDir, "browser-Preferences.json"), previousPreferences, { mode: 0o600 });
  }

  // First production mutation happens only after a fresh paused-idle heartbeat.
  writeAtomic(bridgeService, units.bridge);
  writeAtomic(browserService, units.browser);
  mutated = true;
  await systemctl("daemon-reload");
  await systemctl("restart", "chatgpt-autopilot-dev-bridge.service");
  await waitFor(async () => {
    const response = await fetch("http://127.0.0.1:8767/health", { signal: AbortSignal.timeout(3000) });
    return response.ok;
  }, 30000, "bridge_health");

  // Chromium 131+ can disable unpacked extensions while profile Developer Mode is off.
  // Stop the dedicated browser first so Preferences can be updated atomically without a write race.
  await systemctl("stop", "chatgpt-autopilot-dev-browser.service");
  fs.mkdirSync(path.dirname(browserPreferences), { recursive: true, mode: 0o700 });
  const currentPreferences = fs.existsSync(browserPreferences)
    ? JSON.parse(fs.readFileSync(browserPreferences, "utf8"))
    : {};
  writeAtomic(browserPreferences, `${JSON.stringify(withExtensionsDeveloperMode(currentPreferences))}\n`, 0o600);
  await systemctl("start", "chatgpt-autopilot-dev-browser.service");

  const accepted = await waitFor(async () => {
    const payload = await readOperatorStatus();
    return acceptsDedicatedV2Status(payload, { beforeSeen }) ? payload : null;
  }, acceptTimeoutMs, "v2_acceptance");
  const acceptedProject = accepted.projects.find((item) => item.id === project.id);
  const evidence = {
    acceptedAt: Date.now(), head: await gitHead(), projectId: project.id, beforeSeen,
    afterSeen: Number(acceptedProject.state.runtime.lastSeenAt || 0),
    state: { control: acceptedProject.state.control, runtime: acceptedProject.state.runtime, recovery: acceptedProject.state.recovery },
    features: { browserRecovery: acceptedProject.browserRecovery, checkpointLedger: acceptedProject.checkpointLedger, chatDiscovery: acceptedProject.chatDiscovery },
    backupDir, projectRemainsPaused: true
  };
  writeAtomic(path.join(appDir, "runtime/cutover-autopilot-dev-v2.accepted.json"), `${JSON.stringify(evidence, null, 2)}\n`, 0o600);
  console.log(JSON.stringify({ ok: true, stage: "v2_boot_accepted", projectRemainsPaused: true, head: evidence.head, backupDir }, null, 2));
} catch (error) {
  const current = store.snapshot(project.id);
  const canRollback = mutated && isFreshPausedIdleState(current);
  if (canRollback) {
    try {
      await systemctl("stop", "chatgpt-autopilot-dev-browser.service");
      writeAtomic(bridgeService, previousBridge);
      writeAtomic(browserService, previousBrowser);
      if (preferencesExisted) writeAtomic(browserPreferences, previousPreferences, 0o600);
      else { try { fs.unlinkSync(browserPreferences); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; } }
      await systemctl("daemon-reload");
      await systemctl("restart", "chatgpt-autopilot-dev-bridge.service");
      await systemctl("start", "chatgpt-autopilot-dev-browser.service");
    } catch (rollbackError) {
      console.error(`rollback_failed:${String(rollbackError.message || rollbackError)}`);
    }
  }
  console.error(JSON.stringify({ ok: false, error: String(error.message || error), mutated, rollbackAttempted: canRollback, projectRemainsPaused: true }, null, 2));
  process.exitCode = 1;
} finally {
  try { if (lockFd != null) fs.closeSync(lockFd); } catch {}
  try { fs.unlinkSync(lockFile); } catch {}
}
