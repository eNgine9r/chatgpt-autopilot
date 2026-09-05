import fs from "node:fs";
import path from "node:path";

export function withExtensionsDeveloperMode(preferences = {}) {
  const source = preferences && typeof preferences === "object" && !Array.isArray(preferences) ? preferences : {};
  return {
    ...source,
    extensions: {
      ...(source.extensions || {}),
      ui: { ...(source.extensions?.ui || {}), developer_mode: true }
    }
  };
}

export function chromiumPreferencesPath(profileDir) {
  const base = path.resolve(String(profileDir || ""));
  if (!profileDir) throw new Error("browser_profile_dir_required");
  return path.join(base, "Default", "Preferences");
}

export function ensureChromiumDeveloperMode(profileDir, { fsImpl = fs } = {}) {
  const file = chromiumPreferencesPath(profileDir);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let current = {};
  if (fsImpl.existsSync(file)) current = JSON.parse(fsImpl.readFileSync(file, "utf8"));
  if (current.extensions?.ui?.developer_mode === true) return { file, changed: false };
  const next = withExtensionsDeveloperMode(current);
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  fsImpl.renameSync(tmp, file);
  return { file, changed: true };
}
