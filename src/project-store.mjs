import fs from "node:fs";
import path from "node:path";
import { normalizeChatUrl, sameProjectChatUrl } from "./config.mjs";

export function persistProjectChatUrl(projectsFile, projectId, projectRootUrl, newChatUrl) {
  const normalized = normalizeChatUrl(newChatUrl);
  if (!sameProjectChatUrl(projectRootUrl, normalized)) {
    throw new Error("rollover_chat_outside_project");
  }

  const raw = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
  if (!Array.isArray(raw.projects)) throw new Error("config.projects must be an array");
  const project = raw.projects.find((item) => String(item?.id || "") === String(projectId));
  if (!project) throw new Error("unknown_project");
  project.chatUrl = normalized;

  const dir = path.dirname(projectsFile);
  const tmp = path.join(dir, `.${path.basename(projectsFile)}.${process.pid}.tmp`);
  const mode = fs.existsSync(projectsFile) ? (fs.statSync(projectsFile).mode & 0o777) : 0o600;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, projectsFile);
  return normalized;
}
