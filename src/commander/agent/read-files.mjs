import fs from 'node:fs/promises';
import path from 'node:path';

function params(value, required = [], optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('READ_PARAMS_INVALID');
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`READ_PARAMS_MISSING_${key.toUpperCase()}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`READ_PARAMS_UNKNOWN_${key.toUpperCase()}`);
}

function boundedInt(value, fallback, min, max, code) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(code);
  return number;
}

function fileType(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}

export async function readFileData(policy, input) {
  params(input, ['path'], ['maxBytes']);
  const target = await policy.assertPath(input.path);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('READ_PATH_NOT_FILE');
  const maxBytes = boundedInt(input.maxBytes, 32 * 1024, 1024, 64 * 1024, 'READ_INVALID_MAX_BYTES');
  const handle = await fs.open(target, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, 64 * 1024 + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const body = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    if (body.includes(0)) throw new Error('READ_BINARY_FILE_DENIED');
    return {
      path: target,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      content: body.toString('utf8'),
      truncated: stat.size > maxBytes,
    };
  } finally { await handle.close(); }
}

export async function listFileData(policy, input) {
  params(input, ['path'], ['limit']);
  const target = await policy.assertPath(input.path);
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error('READ_PATH_NOT_DIRECTORY');
  const limit = boundedInt(input.limit, 100, 1, 200, 'READ_INVALID_LIST_LIMIT');
  const entries = await fs.readdir(target, { withFileTypes: true });
  const visible = [];
  let truncated = false;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (visible.length >= limit) { truncated = true; break; }
    const candidate = path.join(target, entry.name);
    try {
      const canonical = await policy.assertPath(candidate);
      const itemStat = await fs.lstat(candidate);
      visible.push({ name: entry.name, path: canonical, type: fileType(itemStat) });
    } catch { /* denied entries are intentionally invisible */ }
  }
  return { path: target, entries: visible, truncated };
}

export async function fileInfoData(policy, input) {
  params(input, ['path']);
  const target = await policy.assertPath(input.path);
  const stat = await fs.stat(target);
  return {
    path: target,
    type: fileType(stat),
    size: stat.size,
    mode: stat.mode & 0o777,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}

function contentMatch(text, query, caseSensitive) {
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index < 0) return null;
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const lineText = text.split('\n')[line - 1] || '';
  return { line, snippet: lineText.slice(0, 240) };
}

export async function searchFileData(policy, input) {
  params(input, ['path', 'query'], ['mode', 'maxResults', 'maxDepth', 'caseSensitive']);
  const root = await policy.assertPath(input.path);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error('READ_PATH_NOT_DIRECTORY');
  if (typeof input.query !== 'string' || input.query.length < 1 || input.query.length > 128) throw new Error('READ_INVALID_SEARCH_QUERY');
  const mode = input.mode ?? 'name';
  if (!['name', 'content'].includes(mode)) throw new Error('READ_INVALID_SEARCH_MODE');
  const maxResults = boundedInt(input.maxResults, 50, 1, 100, 'READ_INVALID_SEARCH_LIMIT');
  const maxDepth = boundedInt(input.maxDepth, 5, 0, 8, 'READ_INVALID_SEARCH_DEPTH');
  const caseSensitive = input.caseSensitive === undefined ? false : input.caseSensitive;
  if (typeof caseSensitive !== 'boolean') throw new Error('READ_INVALID_CASE_FLAG');
  const query = caseSensitive ? input.query : input.query.toLowerCase();
  const queue = [{ dir: root, depth: 0 }];
  const results = [];
  let scannedFiles = 0;
  let truncated = false;

  while (queue.length && results.length < maxResults && scannedFiles < 1000) {
    const { dir, depth } = queue.shift();
    let entries = await fs.readdir(dir, { withFileTypes: true });
    entries = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxResults || scannedFiles >= 1000) { truncated = true; break; }
      const candidate = path.join(dir, entry.name);
      const linkStat = await fs.lstat(candidate).catch(() => null);
      if (!linkStat || linkStat.isSymbolicLink()) continue;
      let canonical;
      try { canonical = await policy.assertPath(candidate); } catch { continue; }
      if (linkStat.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: canonical, depth: depth + 1 });
        continue;
      }
      if (!linkStat.isFile()) continue;
      scannedFiles += 1;
      if (mode === 'name') {
        const value = caseSensitive ? entry.name : entry.name.toLowerCase();
        if (value.includes(query)) results.push({ path: canonical });
        continue;
      }
      if (linkStat.size > 256 * 1024) continue;
      const buffer = await fs.readFile(canonical);
      if (buffer.includes(0)) continue;
      const match = contentMatch(buffer.toString('utf8'), input.query, caseSensitive);
      if (match) results.push({ path: canonical, ...match });
    }
  }
  if (queue.length || scannedFiles >= 1000) truncated = true;
  return { path: root, mode, query: input.query, results, scannedFiles, truncated };
}
