'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_PATH = path.join(os.homedir(), '.config', 'adrive', 'config.json');

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 8787, public_base: 'http://127.0.0.1:8787' },
  lanzou: { username: '', password: '' },
  limits: { max_bytes: 2 * 1024 * 1024 * 1024, chunk_bytes: 95 * 1024 * 1024 },
};

function load() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  if (fs.existsSync(CONFIG_PATH)) Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  cfg.server = { ...DEFAULTS.server, ...(cfg.server || {}) };
  cfg.lanzou = { ...DEFAULTS.lanzou, ...(cfg.lanzou || {}) };
  cfg.limits = { ...DEFAULTS.limits, ...(cfg.limits || {}) };
  cfg.server.token = cfg.server.token || process.env.ADRIVE_TOKEN || '';
  if (!cfg.server.token) {
    // 只读场景（比如接收方 get）不要凭空写配置：用临时 token，需要时由 init 落盘
    cfg.server.token = crypto.randomBytes(24).toString('base64url');
    cfg.__ephemeralToken = true;
  }
  return cfg;
}

function save(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
}

module.exports = { load, save, CONFIG_PATH, DEFAULTS };
