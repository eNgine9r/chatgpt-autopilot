#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../src/env.mjs";
import { loadRuntimeConfig, loadProjects } from "../src/config.mjs";
import { ProjectRuntimeStore } from "../src/runtime-store.mjs";
import { applyBrowserV2PolicyDocument, browserV2PolicySummary, parseProjectRepositories } from "../src/browser-v2-policy.mjs";
import { validateSharedTargets, validateSharedV2Projects, allFreshPausedIdle, acceptsSharedV2Status } from "../src/shared-promotion.mjs";

loadDotEnv();
const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadRuntimeConfig();
const execute = process.argv.includes("--execute");
const assignments = parseProjectRepositories(process.argv.slice(2).filter((value) => !value.startsWith("--")));
const targetIds = [...assignments.keys()];
const idleTimeoutMs = Number(process.env.SHARED_V2_IDLE_TIMEOUT_MS || 2 * 60 * 60 * 1000);
const acceptTimeoutMs = Number(process.env.SHARED_V2_ACCEPT_TIMEOUT_MS || 4 * 60 * 1000);
const lockFile = path.join(appDir, "runtime/shared-browser-v2.lock");
const evidenceFile = path.join(appDir, "runtime/shared-browser-v2.accepted.json");
if (config.bridgeHost !== "127.0.0.1") throw new Error("shared_bridge_must_be_loopback");
const bridgeBase = `http://127.0.0.1:${config.bridgePort}`;
function validateDocument(document) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-shared-v2-"));
  const file = path.join(dir, "projects.json");
  try {
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    return loadProjects(file);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
function writeAtomic(file, content, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}
async function systemctl(...args) {
  return execFileAsync("systemctl", ["--user", ...args], {
    env: { ...process.env, XDG_RUNTIME_DIR: config.xdgRuntimeDir, DBUS_SESSION_BUS_ADDRESS: config.dbusSessionBusAddress },
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
}
async function gitHead() {
  const { stdout } = await execFileAsync("git", ["-C", appDir, "rev-parse", "HEAD"], { timeout: 10000 });
  return stdout.trim();
}
async function operatorStatus() {
  const response = await fetch(`${bridgeBase}/operator/status`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`operator_status_http_${response.status}`);
  return response.json();
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new Error(`${label}_timeout${lastError ? `:${String(lastError.message || lastError)}` : ""}`);
}

if (!fs.existsSync(config.projectsFile)) throw new Error(`missing_projects_file:${config.projectsFile}`);
const originalText = fs.readFileSync(config.projectsFile, "utf8");
const originalDocument = JSON.parse(originalText);
const currentProjects = loadProjects(config.projectsFile);
const currentTargets = validateSharedTargets(currentProjects, targetIds);
const stagedDocument = applyBrowserV2PolicyDocument(originalDocument, assignments);
const stagedProjects = validateDocument(stagedDocument);
validateSharedV2Projects(stagedProjects, targetIds);
const store = new ProjectRuntimeStore({ stateDir: config.stateDir, projects: currentTargets });
const snapshot = () => Object.fromEntries(targetIds.map((id) => [id, store.snapshot(id)]));
const initial = snapshot();

if (!execute) {
  console.log(JSON.stringify({
    ok: true,
    mode: "dry-run",
    bridgeBase,
    projectsFile: config.projectsFile,
    targetIds,
    current: targetIds.map((id) => ({ id, paused: initial[id].control.paused, status: initial[id].runtime.status, progressKey: initial[id].runtime.progressKey })),
    stagedPolicy: browserV2PolicySummary(stagedDocument, targetIds)
  }, null, 2));
  process.exit(0);
}
let lockFd;
let configMutated = false;
let backup = "";
let rollbackAttempted = false;
try {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  lockFd = fs.openSync(lockFile, "wx", 0o600);
  for (const id of targetIds) store.setPaused(id, true);
  const idleStates = await waitFor(() => {
    const states = snapshot();
    return allFreshPausedIdle(states, targetIds) ? states : null;
  }, idleTimeoutMs, "shared_pre_promotion_idle");
  const beforeSeen = new Map(targetIds.map((id) => [id, Number(idleStates[id].runtime.lastSeenAt || 0)]));

  const currentText = fs.readFileSync(config.projectsFile, "utf8");
  if (currentText !== originalText) throw new Error("projects_config_changed_during_gate");
  const backupDir = path.join(appDir, "runtime/config-backups");
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  backup = path.join(backupDir, `projects-${Date.now()}-pre-shared-v2.json`);
  fs.writeFileSync(backup, originalText, { mode: 0o600 });
  writeAtomic(config.projectsFile, `${JSON.stringify(stagedDocument, null, 2)}\n`);
  configMutated = true;

  await systemctl("restart", "chatgpt-project-autopilot.service");
  const accepted = await waitFor(async () => {
    const payload = await operatorStatus();
    return acceptsSharedV2Status(payload, { targetIds, beforeSeen }) ? payload : null;
  }, acceptTimeoutMs, "shared_v2_acceptance");
  const byId = new Map(accepted.projects.map((project) => [project.id, project]));
  const evidence = {
    acceptedAt: Date.now(),
    head: await gitHead(),
    targetIds,
    backup,
    stagedPolicy: browserV2PolicySummary(stagedDocument, targetIds),
    projects: targetIds.map((id) => ({
      id,
      beforeSeen: beforeSeen.get(id),
      afterSeen: Number(byId.get(id).state.runtime.lastSeenAt || 0),
      state: {
        control: byId.get(id).state.control,
        runtime: byId.get(id).state.runtime,
        recovery: byId.get(id).state.recovery
      },
      features: {
        browserRecovery: byId.get(id).browserRecovery,
        checkpointLedger: byId.get(id).checkpointLedger,
        chatDiscovery: byId.get(id).chatDiscovery
      }
    })),
    projectsRemainPaused: true
  };
  writeAtomic(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, stage: "shared_v2_accepted", head: evidence.head, targetIds, backup, projectsRemainPaused: true }, null, 2));
} catch (error) {
  const states = snapshot();
  const canRollback = configMutated && allFreshPausedIdle(states, targetIds);
  if (canRollback) {
    rollbackAttempted = true;
    try {
      writeAtomic(config.projectsFile, originalText);
      await systemctl("restart", "chatgpt-project-autopilot.service");
    } catch (rollbackError) {
      console.error(`rollback_failed:${String(rollbackError.message || rollbackError)}`);
    }
  }
  console.error(JSON.stringify({
    ok: false,
    error: String(error.message || error),
    targetIds,
    configMutated,
    rollbackAttempted,
    projectsRemainPaused: true
  }, null, 2));
  process.exitCode = 1;
} finally {
  try { if (lockFd != null) fs.closeSync(lockFd); } catch {}
  try { fs.unlinkSync(lockFile); } catch {}
}
