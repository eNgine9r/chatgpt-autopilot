import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadCommanderRemoteMcpBearerToken(filePath) {
  if (!path.isAbsolute(String(filePath || ''))) throw new Error('remote_mcp_token_file_must_be_absolute');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('remote_mcp_token_path_not_file');
  if ((stat.mode & 0o077) !== 0) throw new Error('remote_mcp_token_permissions_too_open');
  const token = (await fs.readFile(filePath, 'utf8')).trim();
  const bytes = Buffer.byteLength(token);
  if (bytes < 32 || bytes > 512 || /\s/.test(token)) throw new Error('invalid_remote_mcp_bearer_token');
  return token;
}

export function commanderRemoteMcpBearerVerifier(expectedToken) {
  const expected = Buffer.from(String(expectedToken || ''));
  if (expected.length < 32 || expected.length > 512) throw new Error('invalid_remote_mcp_bearer_token');
  return (authorization) => {
    const match = /^Bearer\s+([^\s]+)$/i.exec(String(authorization || ''));
    if (!match) return false;
    const actual = Buffer.from(match[1]);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
}
