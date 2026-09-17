function baseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid_pairing_base_url'); }
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('pairing_base_url_must_be_https');
  return url.toString().replace(/\/$/, '');
}

export class CommanderPairingDeviceClient {
  constructor({ baseUrl: value, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl(value); this.fetchImpl = fetchImpl;
  }

  async create(input) { return this.#post('/api/device/pair', input, 201); }
  async status(input) { return this.#post('/api/device/status', input, 200); }

  async waitForDecision({ requestId, deviceCode, expiresAt, pollMs = 2_000, signal } = {}) {
    if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 30_000) throw new Error('invalid_pairing_poll_interval');
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) throw new Error('invalid_pairing_expiry');
    while (Date.now() < expiry) {
      if (signal?.aborted) throw new Error('pairing_cancelled');
      const current = await this.status({ requestId, deviceCode });
      if (current.status !== 'pending') return current;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(pollMs, Math.max(1, expiry - Date.now())));
        const abort = () => { clearTimeout(timer); reject(new Error('pairing_cancelled')); };
        signal?.addEventListener?.('abort', abort, { once: true });
      });
    }
    return this.status({ requestId, deviceCode });
  }

  async #post(path, input, expectedStatus) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(input),
    });
    let body = null; try { body = await response.json(); } catch {}
    if (response.status !== expectedStatus) throw new Error(body?.error || `pairing_http_${response.status}`);
    return body;
  }
}
