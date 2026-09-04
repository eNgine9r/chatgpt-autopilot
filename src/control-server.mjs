import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { validateTelegramInitData } from "./telegram-webapp-auth.mjs";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.statusCode = status;
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

async function readJson(req, limit = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function authHeader(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("tma ") ? value.slice(4) : "";
}

export function createControlServer({
  host, port, projects, runtimeStore, progressWatchdog, logger,
  telegramBotToken, telegramOwnerUserId, miniappDir,
  onServiceRestart = null
}) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const staticFiles = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
  ]);

  function authenticate(req) {
    return validateTelegramInitData(authHeader(req), {
      botToken: telegramBotToken,
      ownerUserId: telegramOwnerUserId
    });
  }

  function statusPayload() {
    return {
      ok: true,
      generatedAt: Date.now(),
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        chatUrl: project.chatUrl,
        planVersion: project.planVersion,
        state: runtimeStore.snapshot(project.id),
        watchdog: progressWatchdog?.snapshot?.(project.id) || null
      }))
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname.replace(/^\/autopilot(?=\/|$)/, "") || "/";
      if (req.method === "GET" && pathname === "/health") {
        return json(res, 200, { ok: true, projects: projects.length });
      }
      if (req.method === "GET" && staticFiles.has(pathname)) {
        const [name, type] = staticFiles.get(pathname);
        return text(res, 200, fs.readFileSync(path.join(miniappDir, name), "utf8"), type);
      }
      if (pathname.startsWith("/api/")) {
        const auth = authenticate(req);
        if (!auth.ok) return json(res, auth.error === "forbidden_user" ? 403 : 401, { ok: false, error: auth.error });
      }
      if (req.method === "GET" && pathname === "/api/status") {
        return json(res, 200, statusPayload());
      }
      const match = pathname.match(/^\/api\/projects\/([a-z0-9_-]+)\/action$/i);
      if (req.method === "POST" && match) {
        const projectId = match[1];
        if (!projectById.has(projectId)) return json(res, 404, { ok: false, error: "unknown_project" });
        const { action } = await readJson(req);
        if (action === "pause") runtimeStore.setPaused(projectId, true);
        else if (action === "resume") runtimeStore.setPaused(projectId, false);
        else if (action === "restart") runtimeStore.bump(projectId, "restartGeneration");
        else if (action === "rollover") runtimeStore.bump(projectId, "rolloverGeneration");
        else return json(res, 400, { ok: false, error: "unsupported_action" });
        logger.info("control_action", { project: projectById.get(projectId).name, action });
        return json(res, 200, { ok: true, projectId, action, state: runtimeStore.snapshot(projectId) });
      }
      if (req.method === "POST" && pathname === "/api/service/restart") {
        await readJson(req).catch(() => ({}));
        logger.info("control_service_restart_requested", {});
        json(res, 202, { ok: true, restarting: true });
        setTimeout(() => onServiceRestart?.(), 250).unref();
        return;
      }
      return json(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      logger.error("control_request_failed", { error: String(error) });
      return json(res, 400, { ok: false, error: "bad_request" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
