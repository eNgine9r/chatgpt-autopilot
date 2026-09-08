function ensureLocalBase(base) {
  const value = String(base ?? '');
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value)) {
    throw new Error('invalid_local_v3_base');
  }
  return value;
}

export function createTelegramClient({ token, fetchImpl = fetch }) {
  async function call(method, body) {
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(`telegram_${method}_transport_failed`);
    }
    const value = await response.json().catch(() => ({}));
    if (!response.ok || value.ok !== true) {
      throw new Error(`telegram_${method}_failed:${response.status}`);
    }
    return value.result;
  }
  return {
    async getUpdates(offset) {
      return call('getUpdates', {
        offset,
        timeout: 20,
        allowed_updates: ['message'],
      });
    },
    async sendMessage(chatId, text) {
      await call('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      });
      return true;
    },
  };
}

export function createLocalV3Client({ base = 'http://127.0.0.1:8780', fetchImpl = fetch } = {}) {
  const controlBase = ensureLocalBase(base);
  async function request(pathname, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${controlBase}${pathname}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      });
    } catch {
      throw new Error(`local_api_transport_failed:${pathname}`);
    }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`local_api_failed:${response.status}:${pathname}`);
    return value;
  }

  return {
    async getProjects() {
      const value = await request('/projects');
      if (!Array.isArray(value.projects)) throw new Error('invalid_projects_response');
      return value.projects;
    },
    async postEvent(event) {
      return request('/events', {
        method: 'POST',
        body: JSON.stringify(event),
      });
    },
  };
}
