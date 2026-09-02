export function validateStartupStaggerSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120) {
    throw new Error("PROJECT_STARTUP_STAGGER_SECONDS must be between 5 and 120");
  }
  return seconds;
}

export function buildStartupPlan(projects, staggerSeconds) {
  const seconds = validateStartupStaggerSeconds(staggerSeconds);
  return projects
    .filter((project) => project.enabled !== false)
    .map((project, originalIndex) => ({ project, originalIndex }))
    .sort((a, b) => {
      const priority = Number(a.project.startupPriority ?? 100) - Number(b.project.startupPriority ?? 100);
      return priority || a.originalIndex - b.originalIndex;
    })
    .map(({ project }, index) => ({
      project,
      delayMs: index * seconds * 1000
    }));
}
