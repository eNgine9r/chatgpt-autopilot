import http from "node:http";
import { publicProjects, normalizeChatUrl, sameProjectChatUrl } from "./config.mjs";
import { persistProjectChatUrl } from "./project-store.mjs";
import { telegramEventMessage } from "./messages.uk.mjs";
import { candidateEligibility, selectDiscoveryCandidate, selectManualDiscoveryCandidate } from "./chat-discovery.mjs";

export const ALLOWED_EVENTS = new Set([
  "USER_ACTION_REQUIRED",
  "SESSION_ATTENTION_REQUIRED",
  "AUTOMATION_ERROR",
  "AUTOMATION_STALLED",
  "RECOVERED",
  "CONVERSATION_ROLLED_OVER",
  "CHAT_ADOPTED",
  "RECOVERY_FAILED"
]);

export const eventMessage = telegramEventMessage;

function applyExtensionCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
}

async function readJson(req, limit = 16384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function createBridgeServer({
  host, port, projects, projectsFile, notifier, logger, progressWatchdog = null, runtimeStore = null, onBrowserRestart = null
}) {
  const projectById = new Map(projects.filter((p) => p.enabled).map((p) => [p.id, p]));

  const server = http.createServer(async (req, res) => {
    applyExtensionCors(req, res);
    if (req.method === "OPTIONS") return json(res, 204, {});

    try {
      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, { ok: true, projects: projectById.size, telegram: notifier.enabled });
      }
      if (req.method === "GET" && req.url === "/config") {
        return json(res, 200, { projects: publicProjects(projects, runtimeStore) });
      }
      if (req.method === "POST" && req.url === "/heartbeat") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          return json(res, 415, { error: "application_json_required" });
        }
        const payload = await readJson(req);
        const projectId = String(payload.projectId || "");
        if (!projectById.has(projectId)) return json(res, 404, { error: "unknown_project" });
        if (!progressWatchdog) return json(res, 503, { error: "watchdog_unavailable" });
        const detail = {
          progressKey: String(payload.progressKey || ""),
          status: String(payload.status || ""),
          lastTurnRole: String(payload.lastTurnRole || ""),
          lastTurnId: String(payload.lastTurnId || ""),
          latestAssistantExcerpt: String(payload.latestAssistantExcerpt || ""),
          latestUserExcerpt: String(payload.latestUserExcerpt || "")
        };
        const result = progressWatchdog.observe(projectId, detail);
        runtimeStore?.observe(projectId, detail);
        return json(res, 200, result);
      }
      if (req.method === "POST" && req.url === "/event") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          return json(res, 415, { error: "application_json_required" });
        }
        const payload = await readJson(req);
        const project = projectById.get(String(payload.projectId || ""));
        const event = String(payload.event || "");
        if (!project) return json(res, 404, { error: "unknown_project" });
        if (!ALLOWED_EVENTS.has(event)) return json(res, 400, { error: "unsupported_event" });

        if (event === "AUTOMATION_STALLED" && progressWatchdog) {
          const result = await progressWatchdog.notifyStall(project.id, "extension_watchdog");
          logger.info("extension_event", { project: project.name, event, delivered: result.delivered, suppressed: result.suppressed });
          return json(res, 200, result);
        }
        const delivered = await notifier.send(eventMessage(project, event));
        logger.info("extension_event", { project: project.name, event, delivered });
        return json(res, 200, { ok: true, delivered });
      }
      if (req.method === "POST" && req.url === "/recovery-report") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          return json(res, 415, { error: "application_json_required" });
        }
        const payload = await readJson(req);
        const project = projectById.get(String(payload.projectId || ""));
        if (!project) return json(res, 404, { error: "unknown_project" });
        if (!runtimeStore) return json(res, 503, { error: "runtime_store_unavailable" });
        const allowedStages = new Set(["idle", "soft_reload", "tab_recreate", "browser_restart", "blocked", "failed"]);
        const stage = String(payload.stage || "");
        if (!allowedStages.has(stage)) return json(res, 400, { error: "invalid_recovery_stage" });
        const current = runtimeStore.snapshot(project.id).recovery || {};
        const patch = {
          stage,
          reason: String(payload.reason || current.reason || "").slice(0, 128),
          attempts: Math.max(0, Number(payload.attempts ?? current.attempts ?? 0)),
          softReloads: Math.max(0, Number(payload.softReloads ?? current.softReloads ?? 0)),
          tabRecreates: Math.max(0, Number(payload.tabRecreates ?? current.tabRecreates ?? 0)),
          browserRestarts: Math.max(0, Number(payload.browserRestarts ?? current.browserRestarts ?? 0)),
          lastAttemptAt: Math.max(0, Number(payload.lastAttemptAt ?? current.lastAttemptAt ?? 0)),
          nextCheckAt: Math.max(0, Number(payload.nextCheckAt ?? current.nextCheckAt ?? 0)),
          cooldownUntil: Math.max(0, Number(payload.cooldownUntil ?? current.cooldownUntil ?? 0)),
          alerted: Boolean(payload.alerted ?? current.alerted),
          lastError: String(payload.lastError || "").slice(0, 512)
        };
        const state = runtimeStore.recordRecovery(project.id, patch);
        logger.info("browser_recovery_state", { project: project.name, stage, reason: patch.reason, attempts: patch.attempts });
        return json(res, 200, { ok: true, recovery: state.recovery });
      }
      if (req.method === "POST" && req.url === "/recovery-clear") {
        const payload = await readJson(req);
        const project = projectById.get(String(payload.projectId || ""));
        if (!project) return json(res, 404, { error: "unknown_project" });
        if (!runtimeStore) return json(res, 503, { error: "runtime_store_unavailable" });
        const state = runtimeStore.clearRecovery(project.id);
        logger.info("browser_recovery_complete", { project: project.name });
        return json(res, 200, { ok: true, recovery: state.recovery });
      }
      if (req.method === "POST" && req.url === "/recovery-failed") {
        const payload = await readJson(req);
        const project = projectById.get(String(payload.projectId || ""));
        if (!project) return json(res, 404, { error: "unknown_project" });
        if (!runtimeStore) return json(res, 503, { error: "runtime_store_unavailable" });
        const current = runtimeStore.snapshot(project.id).recovery || {};
        if (current.alerted && Number(current.cooldownUntil || 0) > Date.now()) {
          return json(res, 200, { ok: true, delivered: false, suppressed: true, recovery: current });
        }
        const cooldownUntil = Math.max(Date.now() + 300000, Number(payload.cooldownUntil || 0));
        const state = runtimeStore.recordRecovery(project.id, {
          stage: "failed", alerted: true, cooldownUntil, nextCheckAt: 0,
          reason: String(payload.reason || current.reason || "unknown").slice(0, 128),
          lastError: String(payload.lastError || current.lastError || "").slice(0, 512)
        });
        const delivered = await notifier.send(eventMessage(project, "RECOVERY_FAILED"));
        logger.info("browser_recovery_failed", { project: project.name, delivered, cooldownUntil });
        return json(res, 200, { ok: true, delivered, suppressed: false, recovery: state.recovery });
      }
      if (req.method === "POST" && req.url === "/browser-restart-request") {
        const payload = await readJson(req);
        const project = projectById.get(String(payload.projectId || ""));
        if (!project) return json(res, 404, { error: "unknown_project" });
        if (!onBrowserRestart) return json(res, 503, { error: "browser_restart_unavailable" });
        logger.info("browser_recovery_restart_requested", { project: project.name, reason: String(payload.reason || "") });
        json(res, 202, { ok: true, restarting: true });
        setTimeout(() => onBrowserRestart({ projectId: project.id, reason: String(payload.reason || "") }), 250).unref();
        return;
      }
      if (req.method === "POST" && req.url === "/discovery-candidates") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          return json(res, 415, { error: "application_json_required" });
        }
        const payload = await readJson(req);
        const project = projectById.get(String(payload.projectId || ""));
        if (!project) return json(res, 404, { error: "unknown_project" });
        if (!project.chatDiscovery?.enabled || !project.projectRootUrl) {
          return json(res, 409, { error: "chat_discovery_disabled" });
        }
        const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
        const auto = selectDiscoveryCandidate(project, candidates);
        const manual = auto.candidate || selectManualDiscoveryCandidate(project, candidates);
        runtimeStore?.recordDiscovery(project.id, manual, { eligible: auto.eligible, reason: auto.reason });
        logger.info("chat_discovery_scan", {
          project: project.name, candidateUrl: manual?.url || "", eligible: Boolean(auto.eligible), reason: auto.reason
        });
        return json(res, 200, {
          ok: true, candidate: manual, autoEligible: Boolean(auto.eligible), reason: auto.reason,
          shouldAdopt: Boolean(auto.eligible && project.chatDiscovery.autoAdopt)
        });
      }
      if (req.method === "POST" && req.url === "/adopt-chat") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          return json(res, 415, { error: "application_json_required" });
        }
        const payload = await readJson(req);
        const project = projectById.get(String(payload.projectId || ""));
        if (!project) return json(res, 404, { error: "unknown_project" });
        if (!project.chatDiscovery?.enabled || !project.projectRootUrl) {
          return json(res, 409, { error: "chat_discovery_disabled" });
        }
        const mode = String(payload.mode || "manual");
        if (!["manual", "auto"].includes(mode)) return json(res, 400, { error: "invalid_adoption_mode" });
        const candidate = { url: String(payload.chatUrl || ""), title: String(payload.title || ""), preview: String(payload.preview || "") };
        const eligibility = candidateEligibility(project, candidate);
        if (!eligibility.candidate?.url || !sameProjectChatUrl(project.projectRootUrl, eligibility.candidate.url)) {
          return json(res, 400, { error: "adoption_chat_outside_project" });
        }
        const stateCandidate = runtimeStore?.snapshot(project.id)?.discovery?.candidateUrl || "";
        if (!stateCandidate || normalizeChatUrl(stateCandidate) !== eligibility.candidate.url) {
          return json(res, 409, { error: "adoption_candidate_not_confirmed" });
        }
        if (mode === "auto" && (!project.chatDiscovery.autoAdopt || !eligibility.eligible)) {
          return json(res, 409, { error: "auto_adoption_not_eligible" });
        }
        const persisted = persistProjectChatUrl(projectsFile, project.id, project.projectRootUrl, eligibility.candidate.url);
        project.chatUrl = persisted;
        runtimeStore?.recordAdoption(project.id, { url: persisted, title: eligibility.candidate.title, mode });
        const delivered = await notifier.send(eventMessage(project, "CHAT_ADOPTED"));
        logger.info("chat_adopted", { project: project.name, chatUrl: persisted, mode, delivered });
        return json(res, 200, { ok: true, chatUrl: persisted, mode, delivered });
      }
      if (req.method === "POST" && req.url === "/rollover-complete") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          return json(res, 415, { error: "application_json_required" });
        }
        const payload = await readJson(req);
        const project = projectById.get(String(payload.projectId || ""));
        if (!project) return json(res, 404, { error: "unknown_project" });
        if (!project.autoRollover || !project.projectRootUrl) {
          return json(res, 409, { error: "rollover_disabled" });
        }
        const newChatUrl = normalizeChatUrl(String(payload.chatUrl || ""));
        if (!sameProjectChatUrl(project.projectRootUrl, newChatUrl)) {
          return json(res, 400, { error: "rollover_chat_outside_project" });
        }
        const persisted = persistProjectChatUrl(projectsFile, project.id, project.projectRootUrl, newChatUrl);
        project.chatUrl = persisted;
        const delivered = await notifier.send(eventMessage(project, "CONVERSATION_ROLLED_OVER"));
        logger.info("conversation_rolled_over", {
          project: project.name,
          chatUrl: persisted,
          delivered
        });
        return json(res, 200, { ok: true, chatUrl: persisted, delivered });
      }
      return json(res, 404, { error: "not_found" });
    } catch (error) {
      logger.error("bridge_request_failed", { error: String(error) });
      return json(res, 400, { error: "bad_request" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
