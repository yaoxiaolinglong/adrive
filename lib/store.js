'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(process.env.HOME || process.cwd(), '.local', 'share', 'adrive');
const DB_PATH = path.join(DATA_DIR, 'resources.json');

class Store {
  constructor(file = DB_PATH) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { resources: {} };
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(id) { return this.data.resources[id] || null; }

  put(id, rec) { this.data.resources[id] = rec; this.save(); return rec; }

  update(id, patch) { return this.put(id, { ...this.get(id), ...patch }); }

  list({ limit = 50, status = 'active' } = {}) {
    return Object.values(this.data.resources)
      .filter((r) => !status || status === 'all' || r.status === status)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }

  clear(id) { delete this.data.resources[id]; this.save(); }
}

module.exports = { Store, DB_PATH, DATA_DIR };
