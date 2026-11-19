#!/usr/bin/env node
'use strict';
// adrive 服务端：两段式上传 + 短期下载票，存储后端为蓝奏云。
// 零依赖，只用 Node 内置模块。
const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { Lanzou } = require('./lib/lanzou');
const { Store } = require('./lib/store');
const cfg = require('./lib/config').load();

const store = new Store();
const lz = new Lanzou(cfg.lanzou.username, cfg.lanzou.password);
const TOKEN = cfg.server.token;
const MAX = cfg.limits.max_bytes;
const CHUNK = cfg.limits.chunk_bytes || 95 * 1024 * 1024;

const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, 22);
const sign = (rid, exp, scope = 'public') => crypto.createHmac('sha256', TOKEN).update(`${rid}.${exp}.${scope}`).digest('hex').slice(0, 32);

/** 定长安全比较：长度不同直接 false，绝不让 timingSafeEqual 抛错把进程带走 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

const verify = (rid, exp, sig, scope) => exp > Math.floor(Date.now() / 1000)
  && safeEqual(sign(rid, exp, scope), sig);

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function auth(req) {
  const raw = req.headers.authorization || '';
  if (!raw.startsWith('Bearer ')) return false;
  return safeEqual(raw.slice(7), TOKEN);
}

function parseTtl(ttl) {
  if (!ttl) return 0;
  const m = String(ttl).match(/^(\d+)([smhd])$/);
  if (!m) return null;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  return Math.min(Number(m[1]) * mult, 7 * 86400);
}

function ticket(rec, scope = 'public') {
  const exp = Math.floor(Date.now() / 1000) + 900;
  const base = cfg.server.public_base.replace(/\/$/, '');
  return {
    url: `${base}/public/drive/${rec.id}/blob?exp=${exp}&sig=${sign(rec.id, exp, scope)}&scope=${scope}`,
    expires_at: new Date(exp * 1000).toISOString(),
    name: rec.name, kind: rec.kind || 'file', size: rec.size, sha256: rec.sha256,
    parts: Math.max(1, Math.ceil(rec.size / CHUNK)),
  };
}

/** 返回错误描述，合法则返回 null */
function validateName(name) {
  if (typeof name !== 'string' || !name.trim()) return 'name 不能为空';
  if (name.length > 255) return `name 太长（${name.length} > 255）`;
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'name 不能包含控制字符';
  if (name === '.' || name === '..') return 'name 不合法';
  if (name.includes('/') || name.includes('\\')) return 'name 不能包含路径分隔符';
  return null;
}

/** 统一的资源状态判定，返回 [状态码, 响应体] 或 null */
function stateError(rec) {
  if (!rec || rec.status === 'deleted') return [404, { code: 404, error_code: 'RESOURCE_NOT_FOUND', message: 'resource not found（或已删除）' }];
  if (rec.status === 'pending') return [409, { code: 409, error_code: 'RESOURCE_NOT_READY', message: '上传还没完成（commit 之前不可用）' }];
  return null;
}

const hasBlob = (rec) => Boolean(rec && ((rec.parts || []).length || rec.file_id));
const partsOf = (rec) => ((rec.parts || []).length
  ? rec.parts.slice().sort((a, b) => a.index - b.index)
  : (rec.file_id ? [{ index: 1, file_id: rec.file_id, share_url: rec.share_url }] : []));

const meta = (r, status) => ({
  resource_id: r.id, name: r.name, size: r.size, sha256: r.sha256, kind: r.kind || 'file',
  parts: (r.parts || []).length, status: status || r.status,
  anonymous_until: r.anonymous_until, created_at: r.created_at,
});

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/health$/, async () => ({ code: 0, data: { ok: true, backend: 'lanzou', version: '0.1.0' } }));

route('POST', /^\/drive\/init$/, async (ctx) => {
  const { size, sha256, name, kind } = ctx.body || {};
  const badName = validateName(name);
  if (badName) return [422, { code: 422, error_code: 'INVALID_NAME', message: badName }];
  if (!Number.isInteger(size) || size < 0) {
    return [422, { code: 422, error_code: 'INVALID_SIZE', message: 'size 必须是非负整数（字节）' }];
  }
  if (sha256 != null && !/^[0-9a-f]{64}$/i.test(String(sha256))) {
    return [422, { code: 422, error_code: 'INVALID_SHA256', message: 'sha256 必须是 64 位十六进制' }];
  }
  if (size > MAX) return [413, { code: 413, error_code: 'PACK_TOO_LARGE', message: `单资源上限 ${MAX} 字节` }];
  const id = newId();
  const ts = nowIso();
  const parts = Math.max(1, Math.ceil(size / CHUNK));
  store.put(id, {
    id, name, size, kind: kind || 'file', sha256: sha256 || null, status: 'pending',
    parts: [], anonymous_until: null, created_at: ts, updated_at: ts,
  });
  const base = cfg.server.public_base.replace(/\/$/, '');
  return { code: 0, data: {
    resource_id: id,
    upload: {
      mode: parts > 1 ? 'proxy-chunked' : 'proxy',
      url: `${base}/drive/${id}/blob`,
      method: 'PUT',
      content_type: 'application/octet-stream',
      parts,
      chunk_size: CHUNK,
      headers: { Authorization: `Bearer ${TOKEN}` },
      expires_in: 3600,
    },
  } };
});

route('PUT', /^\/drive\/([^/]+)\/blob$/, async (ctx) => {
  const rec = store.get(ctx.params[0]);
  if (!rec || rec.status === 'deleted') {
    return [404, { code: 404, error_code: 'RESOURCE_NOT_FOUND', message: 'resource not found（或已删除）' }];
  }
  if (rec.status !== 'pending') {
    return [409, { code: 409, error_code: 'ALREADY_COMMITTED', message: '资源已经 commit，不能继续上传' }];
  }
  // 先看 content-length，避免收完才发现超限（也避免连接被 reset）
  const declared = Number(ctx.req.headers['content-length'] || 0);
  if (declared > CHUNK) {
    return [413, { code: 413, error_code: 'CHUNK_TOO_LARGE', message: `单片上限 ${CHUNK} 字节（本片 ${declared}）` }];
  }
  let raw;
  try {
    raw = await readBody(ctx.req, CHUNK + 4096);
  } catch (e) {
    return [413, { code: 413, error_code: 'CHUNK_TOO_LARGE', message: `单片上限 ${CHUNK} 字节` }];
  }
  if (raw.length > CHUNK) return [413, { code: 413, error_code: 'CHUNK_TOO_LARGE', message: `单片上限 ${CHUNK} 字节` }];
  const total = Math.max(1, Math.ceil(rec.size / CHUNK));
  const rawPart = ctx.query.get('part') || '1';
  if (!/^\d+$/.test(rawPart)) {
    return [422, { code: 422, error_code: 'INVALID_PART', message: `part 必须是正整数，收到 ${rawPart}` }];
  }
  const part = Number(rawPart);
  if (part < 1 || part > total) {
    return [422, { code: 422, error_code: 'INVALID_PART', message: `part 越界（1..${total}），收到 ${part}` }];
  }

  // 分片命名：<id>.p<NNN>.bin（.bin 不在白名单，由存储层自动伪装）
  const partName = total > 1 ? `${rec.id}.p${String(part).padStart(3, '0')}.bin` : `${rec.id}.bin`;
  const info = await lz.upload(raw, partName);

  // 同一片重传：先把旧对象删掉，别留孤儿
  const old = (rec.parts || []).find((p) => p.index === part);
  if (old && old.file_id) { try { await lz.delete(old.file_id); } catch { /* 删不掉就算了 */ } }
  const parts = (rec.parts || []).filter((p) => p.index !== part);
  parts.push({ index: part, file_id: info.fileId, share_id: info.shareId, share_url: info.shareUrl, size: raw.length });
  parts.sort((a, b) => a.index - b.index);
  store.update(rec.id, { parts, updated_at: nowIso() });
  return { code: 0, data: { resource_id: rec.id, part, size: raw.length, parts_done: parts.length, parts_total: total } };
});

route('POST', /^\/drive\/commit$/, async (ctx) => {
  const rec = store.get(ctx.body?.resource_id);
  if (!rec || rec.status === 'deleted') {
    return [404, { code: 404, error_code: 'RESOURCE_NOT_FOUND', message: 'resource not found（或已删除）' }];
  }
  if (rec.status === 'active') return { code: 0, data: meta(rec) };   // 幂等
  const total = Math.max(1, Math.ceil(rec.size / CHUNK));
  const parts = (rec.parts || []).slice().sort((a, b) => a.index - b.index);
  const missing = [];
  for (let i = 1; i <= total; i++) if (!parts.find((p) => p.index === i)) missing.push(i);
  if (missing.length) {
    return [409, { code: 409, error_code: 'PARTS_INCOMPLETE', message: `分片未传完，缺 ${missing.join(',')}（共 ${total} 片）` }];
  }
  const bytes = parts.reduce((n, p) => n + (p.size || 0), 0);
  if (bytes !== rec.size) {
    return [409, { code: 409, error_code: 'SIZE_MISMATCH', message: `分片总字节 ${bytes} 与声明的 ${rec.size} 不一致` }];
  }
  store.update(rec.id, { status: 'active', updated_at: nowIso() });
  return { code: 0, data: meta(store.get(rec.id)) };
});

route('GET', /^\/drive$/, async (ctx) => {
  const limit = Math.max(1, Math.min(Number(ctx.query.get('limit') || 50), 500));
  const status = ctx.query.get('status') || 'active';
  const hits = store.list({ limit, status }).map((r) => meta(r));
  return { code: 0, data: { hits, total: hits.length } };
});

route('POST', /^\/drive\/ticket$/, async (ctx) => {
  const rec = store.get(ctx.body?.resource_id);
  const err = stateError(rec);
  if (err) return err;
  if (!hasBlob(rec)) return [404, { code: 404, error_code: 'RESOURCE_NOT_FOUND', message: 'resource not found' }];
  return { code: 0, data: ticket(rec, 'owner') };
});

route('POST', /^\/public\/drive\/ticket$/, async (ctx) => {
  const rec = store.get(ctx.body?.resource_id);
  const err = stateError(rec);
  if (err) return err;
  if (!hasBlob(rec)) return [404, { code: 404, error_code: 'RESOURCE_NOT_FOUND', message: 'resource not found' }];
  if (!rec.anonymous_until) {
    return [403, { code: 403, error_code: 'RESOURCE_NOT_SHARED', message: '未开放匿名下载' }];
  }
  if (rec.anonymous_until <= nowIso()) {
    return [403, { code: 403, error_code: 'SHARE_EXPIRED', message: `匿名下载已于 ${rec.anonymous_until} 过期` }];
  }
  return { code: 0, data: ticket(rec, 'public') };
});

route('PUT', /^\/drive\/([^/]+)\/anonymous$/, async (ctx) => {
  const rec = store.get(ctx.params[0]);
  const err = stateError(rec);
  if (err) return err;
  const ttl = parseTtl(ctx.body?.anonymous_ttl || '');
  if (ttl === null) return [400, { code: 400, message: 'bad anonymous_ttl' }];
  const until = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null;
  store.update(rec.id, { anonymous_until: until, updated_at: nowIso() });
  return { code: 0, data: { resource_id: rec.id, anonymous_until: until, ttl: ctx.body?.anonymous_ttl || '' } };
});

route('DELETE', /^\/drive\/([^/]+)$/, async (ctx) => {
  const rec = store.get(ctx.params[0]);
  if (!rec) return [404, { code: 404, message: 'resource not found' }];
  // 分片资源要逐片删，老记录可能只有单个 file_id
  const fileIds = [...new Set([...(rec.parts || []).map((p) => p.file_id), rec.file_id].filter(Boolean))];
  let removed = fileIds.length > 0;
  for (const fid of fileIds) {
    try { await lz.delete(fid); } catch { removed = false; }
  }
  // 兜底：上传中断会留下「库里有记录但没进 parts」的幽灵片，按 <id>. 前缀扫一遍
  try {
    const all = await lz.files();
    for (const f of all) {
      if (String(f.name_all || '').startsWith(rec.id + '.')) {
        try { await lz.delete(f.id); } catch { removed = false; }
      }
    }
  } catch { /* 扫不到就算了，别让删除失败 */ }
  store.update(rec.id, { status: 'deleted', updated_at: nowIso() });
  return { code: 0, data: { resource_id: rec.id, name: rec.name, deleted: true, object_removed: removed } };
});

process.on('uncaughtException', (e) => console.error('[adrive] uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('[adrive] unhandledRejection', e));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 签名下载（无 Bearer，靠 URL 签名）
  const dl = url.pathname.match(/^\/public\/drive\/([^/]+)\/blob$/);
  if (dl && req.method === 'GET') {
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig') || '';
    const scope = url.searchParams.get('scope') === 'owner' ? 'owner' : 'public';
    if (!exp || !verify(dl[1], exp, sig, scope)) return json(res, 403, { code: 403, message: 'bad signature' });
    const rec = store.get(dl[1]);
    if (!rec || rec.status === 'deleted' || !hasBlob(rec)) {
      return json(res, 404, { code: 404, error_code: 'RESOURCE_NOT_FOUND', message: 'resource not found' });
    }
    // 匿名链接在分享过期后必须立即失效（票有 15 分钟，但分享可能更短）
    if (scope === 'public' && (!rec.anonymous_until || rec.anonymous_until <= nowIso())) {
      return json(res, 403, { code: 403, error_code: 'SHARE_EXPIRED', message: '匿名下载已过期' });
    }
    try {
      const parts = partsOf(rec);
      const chunks = [];
      for (const p of parts) chunks.push(await lz.download(p.share_url));
      const data = Buffer.concat(chunks);
      if (rec.sha256) {
        const got = crypto.createHash('sha256').update(data).digest('hex');
        if (got !== rec.sha256) {
          return json(res, 502, { code: 502, error_code: 'SHA_MISMATCH', message: '拼接后 sha256 不一致' });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(rec.name)}"` });
      return res.end(data);
    } catch (e) {
      return json(res, 502, { code: 502, error_code: 'LANZOU_DOWNLOAD_FAILED', message: e.message });
    }
  }

  const isPublic = url.pathname.startsWith('/public/') || url.pathname === '/health';
  if (!isPublic && !auth(req)) return json(res, 401, { code: 401, error_code: 'UNAUTHORIZED' });

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    const ctx = { req, res, params: m.slice(1), query: url.searchParams, body: null };
    try {
      const rawRoute = req.method === 'PUT' && /^\/drive\/[^/]+\/blob$/.test(url.pathname);
      if (req.method !== 'GET' && req.method !== 'DELETE' && !rawRoute) {
        const raw = req.__rawBody || (await readBody(req, MAX + 1024));
        ctx.body = raw.length ? JSON.parse(raw.toString()) : {};
      }
    } catch (e) {
      return json(res, e.code || 400, { code: e.code || 400, message: e.message });
    }
    try {
      const out = await r.handler(ctx);
      if (Array.isArray(out)) return json(res, out[0], out[1]);
      return json(res, 200, out);
    } catch (e) {
      console.error('[adrive]', url.pathname, e);
      return json(res, 500, { code: 500, message: e.message });
    }
  }
  url.pathname.startsWith('/public/') ? json(res, 404, { code: 404 }) : json(res, 404, { code: 404, message: 'no route' });
});

if (require.main === module) {
  server.listen(cfg.server.port, cfg.server.host, () => {
    console.log(`adrive listening on http://${cfg.server.host}:${cfg.server.port}  (backend: lanzou)`);
  });
}

module.exports = { server, app: { store, lz } };
