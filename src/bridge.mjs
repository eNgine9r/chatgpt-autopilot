import http from "node:http";
import { publicProjects } from "./config.mjs";

export const ALLOWED_EVENTS = new Set([
  "USER_ACTION_REQUIRED",
  "SESSION_ATTENTION_REQUIRED",
  "AUTOMATION_ERROR",
  "RECOVERED"
]);

export function eventMessage(project, event) {
  switch (event) {
    case "USER_ACTION_REQUIRED":
      return `⚠️ ${project.name}: потрібна ваша дія.\nAuto-Continue призупинено.\n${project.chatUrl}`;
    case "SESSION_ATTENTION_REQUIRED":
      return `🔴 ${project.name}: сесія ChatGPT потребує уваги.\nAuto-Continue не виконує дій.\n${project.chatUrl}`;
    case "AUTOMATION_ERROR":
      return `🔴 ${project.name}: Autopilot не може безпечно розпізнати або керувати поточним UI.\nАвтоматичне продовження призупинено.\n${project.chatUrl}`;
    case "RECOVERED":
      return `🟢 ${project.name}: Autopilot відновив безпечний робочий стан.`;
    default:
      throw new Error(`Unsupported event: ${event}`);
  }
}

function applyExtensionCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
}

async function readJson(req, limit = 4096) {
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

export function createBridgeServer({ host, port, projects, notifier, logger }) {
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
      if (req.method === "POST" && req.url === "/event") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          return json(res, 415, { error: "application_json_required" });
        }
        const payload = await readJson(req);
        const project = projectById.get(String(payload.projectId || ""));
        const event = String(payload.event || "");
        if (!project) return json(res, 404, { error: "unknown_project" });
        if (!ALLOWED_EVENTS.has(event)) return json(res, 400, { error: "unsupported_event" });

        const delivered = await notifier.send(eventMessage(project, event));
        logger.info("extension_event", { project: project.name, event, delivered });
        return json(res, 200, { ok: true, delivered });
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
