import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function fingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64url');
}

export function devicePublicKeyFingerprint(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || Buffer.byteLength(publicKeyPem) > 8192) throw new Error('invalid_device_public_key');
  return fingerprint(publicKeyPem);
}

function validate(value) {
  if (!value || value.version !== 1 || value.algorithm !== 'Ed25519') throw new Error('invalid_device_keypair');
  if (typeof value.privateKeyPem !== 'string' || typeof value.publicKeyPem !== 'string') throw new Error('invalid_device_keypair');
  if (Buffer.byteLength(value.privateKeyPem) > 8192 || Buffer.byteLength(value.publicKeyPem) > 8192) throw new Error('invalid_device_keypair');
  const derived = crypto.createPublicKey(crypto.createPrivateKey(value.privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
  if (derived !== value.publicKeyPem || fingerprint(value.publicKeyPem) !== value.fingerprint) throw new Error('device_keypair_mismatch');
  return value;
}

export async function loadOrCreateDeviceKeypair(filePath, { generateKeyPairSync = crypto.generateKeyPairSync, now = Date.now } = {}) {
  if (!path.isAbsolute(String(filePath || ''))) throw new Error('device_keypair_path_must_be_absolute');
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid_device_keypair_file');
    if ((stat.mode & 0o077) !== 0) throw new Error('device_keypair_permissions_too_open');
    return validate(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const value = validate({ version: 1, algorithm: 'Ed25519', privateKeyPem, publicKeyPem, fingerprint: fingerprint(publicKeyPem), createdAt: new Date(now()).toISOString() });
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  const temp = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return value;
}
