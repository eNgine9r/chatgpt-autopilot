const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

export function parseProjectRepositories(values = []) {
  const result = new Map();
  for (const raw of values) {
    const text = String(raw || "").trim();
    const index = text.indexOf("=");
    const id = index > 0 ? text.slice(0, index) : "";
    const repository = index > 0 ? text.slice(index + 1) : "";
    if (!PROJECT_ID.test(id) || !REPO.test(repository)) throw new Error(`invalid_project_repository:${text}`);
    if (result.has(id)) throw new Error(`duplicate_project_repository:${id}`);
    result.set(id, repository);
  }
  if (!result.size) throw new Error("project_repository_required");
  return result;
}

export function applyBrowserV2PolicyDocument(document, repositoryByProject) {
  const source = document && typeof document === "object" && !Array.isArray(document) ? document : {};
  const projects = Array.isArray(source.projects) ? source.projects : [];
  const assignments = repositoryByProject instanceof Map ? repositoryByProject : new Map(Object.entries(repositoryByProject || {}));
  const found = new Set();
  const nextProjects = projects.map((project) => {
    const repository = assignments.get(String(project?.id || ""));
    if (!repository) return project;
    if (!REPO.test(repository)) throw new Error(`${project.id}:invalid_github_repository`);
    if ((project.backend || "browser") !== "browser" || project.enabled === false) throw new Error(`${project.id}:browser_project_required`);
    found.add(project.id);
    return {
      ...project,
      chatDiscovery: {
        ...(project.chatDiscovery || {}),
        enabled: true,
        autoAdopt: false,
        intervalSeconds: Number(project.chatDiscovery?.intervalSeconds || 300)
      },
      browserRecovery: {
        ...(project.browserRecovery || {}),
        enabled: true,
        staleHeartbeatSeconds: Number(project.browserRecovery?.staleHeartbeatSeconds || 90),
        mirrorSyncSeconds: Number(project.browserRecovery?.mirrorSyncSeconds || 120),
        allowSessionRestart: false
      },
      checkpointLedger: {
        ...(project.checkpointLedger || {}),
        enabled: true,
        evidenceCheckSeconds: Number(project.checkpointLedger?.evidenceCheckSeconds || 120),
        evidence: {
          ...(project.checkpointLedger?.evidence || {}),
          github: {
            ...(project.checkpointLedger?.evidence?.github || {}),
            repository,
            requireMergedPr: true,
            matchLocalHead: false
          }
        }
      }
    };
  });
  for (const id of assignments.keys()) if (!found.has(id)) throw new Error(`project_not_found:${id}`);
  return { ...source, projects: nextProjects };
}

export function browserV2PolicySummary(document, projectIds = []) {
  const wanted = new Set(projectIds.map(String));
  return (document?.projects || []).filter((project) => wanted.has(String(project.id))).map((project) => ({
    id: project.id,
    chatDiscovery: { enabled: project.chatDiscovery?.enabled === true, autoAdopt: project.chatDiscovery?.autoAdopt === true },
    browserRecovery: {
      enabled: project.browserRecovery?.enabled === true,
      mirrorSyncSeconds: Number(project.browserRecovery?.mirrorSyncSeconds || 120),
      allowSessionRestart: project.browserRecovery?.allowSessionRestart === true
    },
    checkpointLedger: {
      enabled: project.checkpointLedger?.enabled === true,
      repository: String(project.checkpointLedger?.evidence?.github?.repository || ""),
      requireMergedPr: project.checkpointLedger?.evidence?.github?.requireMergedPr === true,
      matchLocalHead: project.checkpointLedger?.evidence?.github?.matchLocalHead === true
    }
  }));
}
