import fs from "node:fs";
import { loadDotEnv } from "./env.mjs";
import { loadRuntimeConfig, loadProjects } from "./config.mjs";
import { StateStore } from "./state.mjs";
import { createLogger } from "./logger.mjs";
import { TelegramNotifier } from "./notifier.mjs";
import { decideAction } from "./policy.mjs";
import {
  launchBrowser,
  openProjectPage,
  isGenerating,
  readLatestTurn,
  isAuthenticatedConversation,
  sendPrompt
} from "./browser.mjs";

loadDotEnv();
const config = loadRuntimeConfig();
const logger = createLogger(config.logDir);
const state = new StateStore(config.stateDir);
const notifier = new TelegramNotifier({
  token: config.telegramBotToken,
  chatId: config.telegramChatId,
  logger
});

if (!fs.existsSync(config.projectsFile)) {
  throw new Error(`Missing ${config.projectsFile}. Copy config/projects.example.json to config/projects.json`);
}

const projects = loadProjects(config.projectsFile).filter((project) => project.enabled);
if (!projects.length) throw new Error("No enabled projects in config/projects.json");

let context;
const runtimes = new Map();
let shuttingDown = false;

async function alertOnce(project, key, text) {
  const current = state.get(project.id);
  if (current.lastAlertKey === key) return;
  state.set(project.id, { lastAlertKey: key });
  await notifier.send(text);
}

async function setup() {
  context = await launchBrowser(config.browserProfileDir, config.headless);

  for (const project of projects) {
    const page = await openProjectPage(context, project);
    const saved = state.get(project.id);
    runtimes.set(project.id, {
      page,
      failures: 0,
      dueAtMs: saved.dueAtMs || (Date.now() + project.continueAfterSeconds * 1000)
    });
  }

  logger.info("autopilot_started", {
    projects: projects.map((project) => project.name),
    headless: config.headless,
    telegram: notifier.enabled
  });
}

async function tickProject(project) {
  const runtime = runtimes.get(project.id);
  const saved = state.get(project.id);

  try {
    if (runtime.page.isClosed()) runtime.page = await openProjectPage(context, project);

    if (!await isAuthenticatedConversation(runtime.page)) {
      runtime.failures++;
      state.set(project.id, { status: "session_attention_required" });
      if (runtime.failures >= config.errorNotifyAfter) {
        await alertOnce(
          project,
          "session_attention_required",
          `🔴 ${project.name}: ChatGPT session requires attention.\nAuto-Continue is paused. Re-authenticate the standalone browser profile on Raspberry Pi.`
        );
      }
      return;
    }

    const generating = await isGenerating(runtime.page);
    const latest = await readLatestTurn(runtime.page);

    const action = decideAction({
      enabled: true,
      generating,
      pausedForUser: Boolean(saved.pausedForUser),
      latestTurnRole: latest.role,
      latestAssistantText: latest.role === "assistant" ? latest.text : "",
      gateMarker: project.userGateMarker,
      nowMs: Date.now(),
      dueAtMs: runtime.dueAtMs
    });

    if (action === "ui_unrecognized") {
      throw new Error("ChatGPT message-role DOM is unrecognized; refusing to auto-send");
    }

    if (action === "pause_for_user") {
      state.set(project.id, {
        pausedForUser: true,
        status: "user_action_required",
        lastGateAt: new Date().toISOString()
      });
      await alertOnce(
        project,
        `gate:${latest.text.slice(-160)}`,
        `⚠️ ${project.name}: потрібна ваша дія.\nAuto-Continue призупинено. Відкрийте відповідний чат ChatGPT і виконайте запитану дію.`
      );
      logger.warn("user_action_required", { project: project.name });
      return;
    }

    if (action === "resume_from_user") {
      runtime.dueAtMs = Date.now() + project.continueAfterSeconds * 1000;
      state.set(project.id, {
        pausedForUser: false,
        status: "resumed_after_user",
        dueAtMs: runtime.dueAtMs,
        lastAlertKey: null
      });
      logger.info("resumed_after_user", { project: project.name });
      return;
    }

    if (action === "send_continue") {
      if (!project.continuationPrompt) throw new Error("continuationPrompt is empty");
      await sendPrompt(runtime.page, project.continuationPrompt);
      runtime.dueAtMs = Date.now() + project.continueAfterSeconds * 1000;
      state.set(project.id, {
        status: "continue_sent",
        dueAtMs: runtime.dueAtMs,
        sentCount: Number(saved.sentCount || 0) + 1,
        lastContinueAt: new Date().toISOString(),
        lastAlertKey: null
      });
      logger.info("continue_sent", { project: project.name });
      return;
    }

    if (action === "wait_generating") {
      state.set(project.id, { status: "working" });
    } else if (action === "paused_for_user") {
      state.set(project.id, { status: "user_action_required" });
    } else if (action === "wait_for_assistant") {
      state.set(project.id, { status: "awaiting_assistant" });
    } else {
      state.set(project.id, { status: "armed", dueAtMs: runtime.dueAtMs });
    }

    if (runtime.failures > 0 && config.recoveryNotify) {
      await notifier.send(`🟢 ${project.name}: ChatGPT Auto-Continue recovered.`);
    }
    runtime.failures = 0;
  } catch (error) {
    runtime.failures++;
    logger.error("project_tick_failed", {
      project: project.name,
      failures: runtime.failures,
      error: String(error)
    });

    if (runtime.failures >= config.errorNotifyAfter) {
      state.set(project.id, { status: "error" });
      await alertOnce(
        project,
        `error:${String(error).slice(0, 120)}`,
        `🔴 ${project.name}: Auto-Continue error after ${runtime.failures} checks.\n${String(error).slice(0, 500)}`
      );
    }
  }
}

async function mainLoop() {
  await setup();
  while (!shuttingDown) {
    for (const project of projects) await tickProject(project);
    await new Promise((resolve) => setTimeout(resolve, config.checkIntervalMs));
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown", { signal });
  try { await context?.close(); } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

mainLoop().catch(async (error) => {
  logger.error("fatal", { error: String(error) });
  await notifier.send(`🔴 ChatGPT Project Autopilot fatal error:\n${String(error).slice(0, 800)}`);
  process.exit(1);
});
