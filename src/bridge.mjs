import http from "node:http";
import { publicProjects, normalizeChatUrl, sameProjectChatUrl } from "./config.mjs";
import { persistProjectChatUrl } from "./project-store.mjs";
import { telegramEventMessage } from "./messages.uk.mjs";

export const ALLOWED_EVENTS = new Set([
  "USER_ACTION_REQUIRED",
  "SESSION_ATTENTION_REQUIRED",
  "AUTOMATION_ERROR",
  "AUTOMATION_STALLED",
  "RECOVERED",
  "CONVERSATION_ROLLED_OVER"
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

export function createBridgeServer({ host, port, projects, projectsFile, notifier, logger, progressWatchdog = null }) {
  const projectById = new Map(projects.filter((p) => p.enabled).map((p) => [p.id, p]));

  const server = http.createServer(async (req, res) => {
    applyExtensionCors(req, res);
    if (req.method === "OPTIONS") return json(res, 204, {});

    try {
      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, { ok: true, projects: projectById.size, telegram: notifier.enabled });
      }
      if (req.method === "GET" && req.url === "/config") {
        return json(res, 200, { projects: publicProjects(projects) });
      }
      if (req.method === "POST" && req.url === "/heartbeat") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          return json(res, 415, { error: "application_json_required" });
        }
        const payload = await readJson(req);
        const projectId = String(payload.projectId || "");
        if (!projectById.has(projectId)) return json(res, 404, { error: "unknown_project" });
        if (!progressWatchdog) return json(res, 503, { error: "watchdog_unavailable" });
        const result = progressWatchdog.observe(projectId, {
          progressKey: String(payload.progressKey || ""),
          status: String(payload.status || "")
        });
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
