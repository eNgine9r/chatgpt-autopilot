import fs from 'node:fs/promises';
import path from 'node:path';

function safeName(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('unsafe_project_id');
  return id;
}

export class JsonStateStore {
  constructor(root) { this.root = root; }

  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  file(id) { return path.join(this.root, `${safeName(id)}.json`); }

  async load(id) {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(id, state) {
    await this.init();
    const target = this.file(id);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await fs.rename(temp, target);
  }

  async list() {
    await this.init();
    const names = (await fs.readdir(this.root)).filter((name) => name.endsWith('.json'));
    return Promise.all(names.map(async (name) => {
      return JSON.parse(await fs.readFile(path.join(this.root, name), 'utf8'));
    }));
  }
}
