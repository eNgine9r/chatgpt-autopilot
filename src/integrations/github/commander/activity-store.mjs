import fs from 'node:fs/promises';
import path from 'node:path';

const ACTIVITY_VERSION = 1;
export const COMMANDER_ACTIVITY_LIMIT = 40;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function commanderActivityFile(env = process.env) {
  const configured = String(env.COMMANDER_GITHUB_ACTIVITY_FILE || '').trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('commander_activity_file_must_be_absolute');
    return configured;
  }
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error('commander_uid_required');
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  if (!path.isAbsolute(runtimeDir)) throw new Error('invalid_xdg_runtime_dir');
  return path.join(runtimeDir, 'chatgpt-autopilot-commander', 'github-activity.json');
}

function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const issueNumber = Number(entry.issueNumber);
  const deviceId = String(entry.deviceId || '');
  const operation = String(entry.operation || '');
  const completedAt = String(entry.completedAt || '');
  if (!Number.isInteger(issueNumber) || issueNumber < 1) return null;
  if (!DEVICE_ID.test(deviceId) || !OPERATION.test(operation)) return null;
  if (!Number.isFinite(Date.parse(completedAt))) return null;
  return Object.freeze({
    issueNumber,
    deviceId,
    operation,
    ok: entry.ok === true,
    completedAt,
    ...(typeof entry.state === 'string' && entry.state.length <= 64 ? { state: entry.state } : {}),
    ...(Number.isInteger(entry.exitCode) ? { exitCode: entry.exitCode } : {}),
  });
}

async function readDocument(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || parsed.version !== ACTIVITY_VERSION || !Array.isArray(parsed.items)) return [];
    return parsed.items.map(sanitizeEntry).filter(Boolean).slice(0, COMMANDER_ACTIVITY_LIMIT);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    return [];
  }
}

export async function readCommanderActivity(file, limit = 12) {
  if (!path.isAbsolute(String(file || ''))) throw new Error('commander_activity_file_must_be_absolute');
  const bounded = Math.max(1, Math.min(Number(limit) || 12, COMMANDER_ACTIVITY_LIMIT));
  return (await readDocument(file)).slice(0, bounded);
}

export async function writeCommanderActivity(file, entry) {
  if (!path.isAbsolute(String(file || ''))) throw new Error('commander_activity_file_must_be_absolute');
  const safe = sanitizeEntry(entry);
  if (!safe) throw new Error('invalid_commander_activity_entry');
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const current = await readDocument(file);
  const items = [safe, ...current.filter((item) => item.issueNumber !== safe.issueNumber)]
    .slice(0, COMMANDER_ACTIVITY_LIMIT);
  const payload = JSON.stringify({ version: ACTIVITY_VERSION, items });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, payload, { mode: 0o600 });
  await fs.rename(temp, file);
  return items;
}
