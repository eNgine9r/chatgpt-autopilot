import { normalizeChatUrl, sameProjectChatUrl } from "./config.mjs";

export const AUTOPILOT_DISCOVERY_MARKER = "[AUTOPILOT]";

export function sanitizeDiscoveryCandidate(candidate = {}) {
  let url = "";
  try { url = normalizeChatUrl(String(candidate.url || "")); } catch {}
  return {
    url,
    title: String(candidate.title || "").replace(/\s+/g, " ").trim().slice(0, 300),
    preview: String(candidate.preview || "").replace(/\s+/g, " ").trim().slice(0, 800)
  };
}

export function candidateIsSameProject(project, candidate) {
  const value = sanitizeDiscoveryCandidate(candidate);
  return Boolean(project?.projectRootUrl && value.url && sameProjectChatUrl(project.projectRootUrl, value.url));
}

export function candidateEligibility(project, candidate) {
  const value = sanitizeDiscoveryCandidate(candidate);
  if (!candidateIsSameProject(project, value)) return { eligible: false, reason: "outside_project", candidate: value };
  if (value.url === normalizeChatUrl(project.chatUrl)) return { eligible: false, reason: "current_chat", candidate: value };
  const surface = `${value.title}\n${value.preview}`.toLowerCase();
  const marker = surface.includes(AUTOPILOT_DISCOVERY_MARKER.toLowerCase());
  const patterns = project?.chatDiscovery?.includeTitlePatterns || [];
  const pattern = patterns.some((item) => surface.includes(String(item).toLowerCase()));
  return { eligible: marker || pattern, reason: marker ? "marker" : (pattern ? "pattern" : "no_signal"), candidate: value };
}

export function selectDiscoveryCandidate(project, candidates = []) {
  for (const raw of candidates.slice(0, 40)) {
    const result = candidateEligibility(project, raw);
    if (result.eligible) return result;
  }
  return { eligible: false, reason: "no_candidate", candidate: null };
}

export function selectManualDiscoveryCandidate(project, candidates = []) {
  for (const raw of candidates.slice(0, 40)) {
    const candidate = sanitizeDiscoveryCandidate(raw);
    if (!candidateIsSameProject(project, candidate)) continue;
    if (candidate.url === normalizeChatUrl(project.chatUrl)) continue;
    return candidate;
  }
  return null;
}
