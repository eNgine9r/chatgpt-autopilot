#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadProjects, sameProjectChatUrl } from "./config.mjs";
import { validateDedicatedV2Project } from "./dedicated-cutover.mjs";
import { ensureChromiumDeveloperMode } from "./chromium-profile.mjs";
import { buildChromiumEnvironment, chromiumPlatformArgs } from "./chromium-session.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(moduleFile);
const defaultAppDir = path.resolve(moduleDir, "..");

export function loadDedicatedBrowserProject(projectsFile) {
  const projects = loadProjects(path.resolve(projectsFile));
  const matches = projects.filter((item) => item.id === "autopilot-development");
  if (matches.length !== 1) throw new Error("dedicated_autopilot_project_required");
  const project = validateDedicatedV2Project(matches[0]);
  if (!project.projectRootUrl || !sameProjectChatUrl(project.projectRootUrl, project.chatUrl)) {
    throw new Error("dedicated_chat_must_match_project_root");
  }
  return project;
}
export function buildDedicatedChromiumArgs({ project, appDir, profileDir, runtimeConfig }) {
  return [
    "--force-renderer-accessibility",
    "--enable-gpu-rasterization",
    "--disable-dev-shm-usage",
    ...chromiumPlatformArgs(runtimeConfig),
    "--use-angle=gles",
    `--user-data-dir=${profileDir}`,
    `--load-extension=${path.join(appDir, "extension")}`,
    `--disable-extensions-except=${path.join(appDir, "extension")}`,
    "--no-first-run",
    "--disable-session-crashed-bubble",
    "--new-window",
    project.chatUrl
  ];
}

export function resolveDedicatedBrowserLaunch({ appDir = defaultAppDir, env = process.env } = {}) {
  const resolvedAppDir = path.resolve(appDir);
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const projectsFile = path.resolve(env.PROJECTS_FILE || path.join(resolvedAppDir, "runtime/projects-autopilot-dev-v2.json"));
  const profileDir = path.resolve(env.BROWSER_PROFILE_DIR || path.join(resolvedAppDir, "browser-profile-autopilot-dev"));
  const runtimeConfig = {
    chromiumOzonePlatform: env.CHROMIUM_OZONE_PLATFORM || "wayland",
    display: env.DISPLAY || ":0",
    xdgRuntimeDir: runtimeDir,
    waylandDisplay: env.WAYLAND_DISPLAY || "wayland-0",
    dbusSessionBusAddress: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
    xauthority: env.XAUTHORITY || ""
  };
  const project = loadDedicatedBrowserProject(projectsFile);
  const executable = env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium";
  return {
    project,
    projectsFile,
    profileDir,
    executable,
    args: buildDedicatedChromiumArgs({ project, appDir: resolvedAppDir, profileDir, runtimeConfig }),
    env: buildChromiumEnvironment(runtimeConfig, env)
  };
}

export async function runDedicatedBrowser(options = {}) {
  const launch = resolveDedicatedBrowserLaunch(options);
  if (!fs.existsSync(launch.executable)) throw new Error("chromium_executable_missing");
  ensureChromiumDeveloperMode(launch.profileDir);
  const child = (options.spawnImpl || spawn)(launch.executable, launch.args, {
    env: launch.env,
    stdio: "inherit"
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(signal, () => { try { child.kill(signal); } catch {} });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: Number(code ?? 1), signal: signal || "" }));
  });
}

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === moduleFile);
if (isMain) {
  runDedicatedBrowser()
    .then(({ code, signal }) => {
      if (signal) console.error(`dedicated_browser_exited_signal:${signal}`);
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`dedicated_browser_launch_failed:${String(error?.message || error)}`);
      process.exitCode = 1;
    });
}
