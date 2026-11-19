'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(process.env.HOME || process.cwd(), '.local', 'share', 'adrive');
const DB_PATH = path.join(DATA_DIR, 'resources.json');

class Store {
  constructor(file = DB_PATH) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) return { resources: {} };
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || !data.resources || typeof data.resources !== 'object' || Array.isArray(data.resources)) {
        throw new Error('结构不对：缺少 resources 对象');
      }
      return data;
    } catch (e) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, backup);
      console.error(`[adrive] 资源库损坏（${e.message}）`);
      console.error(`[adrive] 原文件已备份为 ${backup}`);
      console.error('[adrive] 以空库启动：蓝奏云上的旧文件不会被自动清理，需要时按前缀手工删');
      return { resources: {} };
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.data, null, 2));
      fs.fsyncSync(fd);            // 断电也不丢最后一次写
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  get(id) { return this.data.resources[id] || null; }

  put(id, rec) { this.data.resources[id] = rec; this.save(); return rec; }

  update(id, patch) { return this.put(id, { ...this.get(id), ...patch }); }

  count(status = 'active') {
    return Object.values(this.data.resources)
      .filter((r) => !status || status === 'all' || r.status === status).length;
  }

  list({ limit = 50, status = 'active' } = {}) {
    return Object.values(this.data.resources)
      .filter((r) => !status || status === 'all' || r.status === status)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }

  clear(id) { delete this.data.resources[id]; this.save(); }
}

module.exports = { Store, DB_PATH, DATA_DIR };
