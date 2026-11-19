#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createZip, readZip } = require('../lib/zip');
const config = require('../lib/config');

const cfg = config.load();
const AUTH = { Authorization: `Bearer ${cfg.server.token}` };

/** 服务地址优先级：--server > ADRIVE_SERVER > 配置文件 > 本机默认 */
function resolveBase(override) {
  const raw = override || process.env.ADRIVE_SERVER || (cfg.server && cfg.server.public_base) || 'http://127.0.0.1:8787';
  return String(raw).replace(/\/$/, '');
}

/** 统一的网络请求：连不上时给人话，而不是裸 fetch failed */
async function net(url, opts = {}) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    const origin = (() => { try { return new URL(url).origin; } catch { return url; } })();
    throw new Error(`连不上 ${origin}（${e.cause?.code || e.message}）\n`
      + `  · 服务起来了吗？  adrive-server\n`
      + `  · 地址对不对？  用 --server 或环境变量 ADRIVE_SERVER 指定`);
  }
}

function die(msg, code = 1) { console.error(msg); process.exit(code); }

/** 先写 .part 再 rename：写失败不会留下「看起来完整」的半截文件 */
function writeAtomic(dest, buf) {
  const tmp = `${dest}.adrive-part`;
  try {
    fs.writeFileSync(tmp, buf);                 // 内部处理短写，出错会抛
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const size = fs.statSync(tmp).size;
    if (size !== buf.length) throw Object.assign(new Error(`写入不完整 ${size}/${buf.length}`), { code: 'SHORT_WRITE' });
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    die(`写入失败（${e.code || e.message}），没有落下任何文件`);
  }
}

function collect(p, opts = {}) {
  const entries = [];
  const st = fs.lstatSync(p);
  if (st.isFile()) {
    entries.push({ name: path.basename(p), data: fs.readFileSync(p) });
  } else {
    const root = path.basename(path.resolve(p));
    const walk = (dir) => {
      const names = fs.readdirSync(dir);
      if (!names.length && dir !== p) {
        entries.push({ name: path.posix.join(root, path.relative(p, dir)), dir: true });
        return;
      }
      for (const name of names) {
        const full = path.join(dir, name);
        let s;
        try {
          s = fs.lstatSync(full);
        } catch (e) {
          console.error(`  跳过读不了的文件：${name}（${e.code || e.message}）`);
          continue;
        }
        if (s.isSymbolicLink()) {
          if (!opts.followSymlinks) {
            console.error(`  跳过软链：${path.relative(p, full)}`);
            continue;
          }
          const real = fs.statSync(full);
          if (real.isFile()) entries.push({ name: path.posix.join(root, path.relative(p, full)), data: fs.readFileSync(full) });
          continue;
        }
        if (s.isFile()) {
          try {
            entries.push({ name: path.posix.join(root, path.relative(p, full)), data: fs.readFileSync(full) });
          } catch (e) {
            console.error(`  跳过读不了的文件：${path.relative(p, full)}（${e.code || e.message}）`);
          }
        }
        else if (s.isDirectory()) walk(full);
      }
    };
    walk(p);
  }
  return entries;
}

async function cmdInit(args) {
  const cur = fs.existsSync(config.CONFIG_PATH) ? JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8')) : {};
  const next = { ...cur, server: { ...(cur.server || {}) }, lanzou: { ...(cur.lanzou || {}) } };
  if (args.username) next.lanzou.username = args.username;
  if (args.password) next.lanzou.password = args.password;
  if (args.host) next.server.host = args.host;
  if (args.port) next.server.port = Number(args.port);
  if (args['public-base']) {
    next.server.public_base = args['public-base'];
  } else if (args.port || args.host) {
    // 端口/监听地址变了，服务地址跟着变，否则发送方会把请求打到旧端口
    const host = next.server.host || '127.0.0.1';
    const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
    next.server.public_base = `http://${shown}:${next.server.port}`;
  }
  if (!next.server.token) next.server.token = crypto.randomBytes(24).toString('base64url');
  config.save(next);

  const cfg2 = config.load();
  console.log(`配置已写入 ${config.CONFIG_PATH}（权限 600，含蓝奏云密码明文，注意备份方式）`);
  console.log('改动监听地址/端口/服务地址后，需要重启 adrive-server 才生效');
  console.log(`监听：${cfg2.server.host}:${cfg2.server.port}   服务地址：${cfg2.server.public_base}`);
  if (cfg2.server.host === '0.0.0.0') {
    console.log('  提示：0.0.0.0 是对外监听，接收方要用你的局域网 IP 访问；');
    console.log('        如果 public_base 还是 127.0.0.1，请用 --public-base http://<你的IP>:<端口> 指定');
  }
  console.log(`API token: ${cfg2.server.token}`);
  console.log('  HTTP 接口用它：Authorization: Bearer <上面的 token>');

  if (args['no-verify']) return;
  if (!cfg2.lanzou.username || !cfg2.lanzou.password) {
    console.log('\n跳过登录校验：还没填 --username/--password');
    return;
  }
  process.stdout.write('\n校验蓝奏云登录… ');
  try {
    const { Lanzou } = require('../lib/lanzou');
    const lz = new Lanzou(cfg2.lanzou.username, cfg2.lanzou.password);
    await lz.login();
    console.log(`成功（uid ${lz.uid}）`);
  } catch (e) {
    console.log('失败');
    die(`\n登录蓝奏云失败：${e.message}\n`
      + '  · 账号密码对不对？（手机号 11 位，密码区分大小写）\n'
      + '  · 连续失败可能触发风控，等几分钟再试\n'
      + '  · 只想先写配置不校验：加 --no-verify');
  }
}

async function cmdPut(args) {
  const target = args._[0];
  if (!target || !fs.existsSync(target)) die(`路径不存在：${target}`);
  const st = fs.statSync(target);
  const kind = st.isFile() ? 'file' : 'dir';
  const name = args.name || path.basename(path.resolve(target));

  // 单文件直传（不打 zip，省流量也避免大 zip 占内存）；目录才打包
  const payload = kind === 'file' ? fs.readFileSync(target) : createZip(collect(target, { followSymlinks: !!args['follow-symlinks'] }));
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

  const BASE = resolveBase(args.server);
  const initRes = await net(`${BASE}/drive/init`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: payload.length, sha256, name, kind }),
  });
  const init = await initRes.json();
  if (initRes.status !== 200) die(`init 失败 ${initRes.status}: ${JSON.stringify(init)}`);

  const { resource_id: rid, upload } = init.data;
  const chunk = upload.chunk_size || payload.length;
  const total = upload.parts || 1;

  for (let i = 1; i <= total; i++) {
    const slice = payload.subarray((i - 1) * chunk, Math.min(i * chunk, payload.length));
    const url = total > 1 ? `${upload.url}?part=${i}` : upload.url;
    let r;
    try {
      r = await net(url, { method: upload.method, headers: upload.headers, body: slice });
    } catch (e) {
      die(`第 ${i}/${total} 片上传中断\n`
        + `  resource_id: ${rid}\n`
        + `  已上传的片留在蓝奏云里，清理：adrive rm ${rid}（会连残留对象一起删）`);
    }
    if (r.status !== 200) {
      die(`第 ${i}/${total} 片上传失败 ${r.status}: ${await r.text()}\n`
        + `  resource_id: ${rid}\n`
        + `  清理：adrive rm ${rid}`);
    }
    if (total > 1) console.error(`  分片 ${i}/${total} 完成（${(slice.length / 1048576).toFixed(1)} MB，${Math.round(i / total * 100)}%）`);
  }

  const commitRes = await net(`${BASE}/drive/commit`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource_id: rid }),
  });
  const commit = await commitRes.json();
  if (commitRes.status !== 200) die(`commit 失败 ${commitRes.status}: ${JSON.stringify(commit)}`);

  if (args.json) return console.log(JSON.stringify({ code: 0, data: commit.data }));
  console.log(`资源已创建：${commit.data.name}${kind === 'dir' ? '（目录）' : ''}`);
  console.log(`resource_id：${rid}`);
  console.log(`大小：${commit.data.size} 字节${total > 1 ? `（${total} 片）` : ''}`);
  console.log('有效期至：永久（仅你的账号可见）');
  console.log(`\n要交给别的 agent，先开放匿名下载：\n  adrive share ${rid} --ttl 7d`);
}

async function cmdShare(args) {
  const rid = args._[0];
  if (!rid) { console.log(USAGE); return; }
  if (args.off && args.ttl) die('--off 和 --ttl 只能选一个');
  let ttl = args.off ? '' : String(args.ttl || '7d');
  if (ttl) {
    const m = ttl.match(/^(\d+)([smhd])$/);
    if (!m) die(`--ttl 写法不对：${ttl}\n  可选：30m / 24h / 7d（上限 7d）`);
    const sec = Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
    if (sec > 7 * 86400) { console.error(`提示：--ttl ${ttl} 超过上限，已按 7d 处理`); ttl = '7d'; }
  }
  const BASE = resolveBase(args.server);
  const res = await net(`${BASE}/drive/${rid}/anonymous`, {
    method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ anonymous_ttl: ttl }),
  });
  const j = await res.json();
  if (res.status !== 200) die(`分享失败 ${res.status}: ${JSON.stringify(j)}`);
  if (!j.data.anonymous_until) return console.log('已关闭匿名下载');
  console.log(`已开放匿名下载，到期：${j.data.anonymous_until}\n`);
  console.log('把下面这段发给接收方（原样，别改写）：\n');
  console.log(`我用 agent 网盘给你传了一个资源：${rid}\n`);
  console.log('请执行这条命令取回：');
  console.log(`adrive get ${rid} --server ${BASE}\n`);
  console.log('如果提示找不到 adrive，先按仓库 README 安装，再重试。');
  console.log('取回后请告诉我文件放在了哪里、里面有什么，等我确认后再使用。');
}

async function cmdGet(args) {
  const rid = args._[0];
  const out = args.o || args.output || '.';
  const BASE = resolveBase(args.server);
  const body = JSON.stringify({ resource_id: rid });

  // 先走匿名票；403 时如果本机有 token，就退回「本人票」——自己的资源不必先 share
  let res = await net(`${BASE}/public/drive/ticket`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  let usedOwner = false;
  if (res.status === 403) {
    const own = await net(`${BASE}/drive/ticket`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body,
    });
    if (own.status === 200) { res = own; usedOwner = true; }
  }
  const j = await res.json();
  if (res.status === 403) {
    const code = j.error_code || '';
    if (code === 'SHARE_EXPIRED') {
      die(`匿名下载已经过期（${j.message || ''}）。\n`
        + `  · 让发布方重新开一下：adrive share ${rid} --ttl 7d`);
    }
    die(`这个资源没有开放匿名下载。\n`
      + `  · 你是发布者？在发布方机器上执行：adrive share ${rid} --ttl 7d\n`
      + `  · 你是接收方？让对方开一下匿名下载（默认不开）`);
  }
  if (res.status === 409) {
    die(`资源 ${rid} 还没上传完成（${j.message || 'pending'}），不能取。`);
  }
  if (res.status === 404) {
    die(`在 ${BASE} 上找不到资源 ${rid}\n`
      + `  · 服务地址对吗？用 --server 或 ADRIVE_SERVER 指定对方的地址\n`
      + `  · 也可能资源已被发布方删除（删除不可恢复）`);
  }
  if (res.status !== 200) die(`取票失败 ${res.status}: ${JSON.stringify(j)}`);
  const info = j.data;
  if (usedOwner) {
    console.error('提示：本机有发布方凭据，走的是「本人票据」——匿名下载是否可用未验证。\n'
      + '      要验收交接效果，请在接收方机器上（或干净 HOME）跑一次。');
  }

  const dl = await net(info.url);
  if (dl.status !== 200) die(`下载失败 ${dl.status}: ${await dl.text()}`);

  // 带进度地把 body 读完（大文件几十秒静默会被当成卡死）
  const total = Number(dl.headers.get('content-length') || 0);
  const chunks = [];
  let got = 0;
  let lastPct = -10;
  if (dl.body && dl.body.getReader) {
    const reader = dl.body.getReader();
    try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
      if (total > 5 * 1024 * 1024) {
        const pct = Math.floor((got / total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          console.error(`  下载中 ${pct}%（${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB）`);
        }
      }
    }
    } catch (e) {
      die(`下载中断（${e.cause?.code || e.message}），没有写入任何文件，可以直接重试`);
    }
  } else {
    chunks.push(Buffer.from(await dl.arrayBuffer()));
  }
  const buf = Buffer.concat(chunks);

  if (info.sha256) {
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== info.sha256) die(`sha256 校验失败（期望 ${info.sha256.slice(0, 12)}…，实得 ${got.slice(0, 12)}…）`);
  }

  fs.mkdirSync(out, { recursive: true });
  const root = path.resolve(out);

  if ((info.kind || 'file') === 'file') {
    const dest = path.resolve(root, info.name);
    if (!dest.startsWith(root + path.sep)) die('非法文件名');
    if (fs.existsSync(dest) && !args.force) {
      die(`本地已存在 ${dest}，没有覆盖。\n  确认要覆盖就加 --force（或换 -o 目录）`);
    }
    writeAtomic(dest, buf);
    console.log(`已取回 1 个文件到 ${dest}（${buf.length} 字节，sha256 已校验）`);
    return;
  }

  const files = readZip(buf);
  const clashes = files.filter((f) => !f.dir && fs.existsSync(path.resolve(root, f.name)));
  if (clashes.length && !args.force) {
    die(`本地已有同名文件（${clashes.length} 个），没有覆盖：\n  ${clashes.slice(0, 5).map((f) => f.name).join('\n  ')}\n  确认要覆盖就加 --force（或换 -o 目录）`);
  }
  const stage = fs.mkdtempSync(path.join(root, '.adrive-tmp-'));
  try {
    for (const f of files) {
      const dest = path.resolve(stage, f.name);
      if (!dest.startsWith(stage + path.sep)) die(`压缩包含不安全路径：${f.name}`);
      if (f.dir) { fs.mkdirSync(dest, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data);
      if (fs.statSync(dest).size !== f.data.length) throw new Error(`写入不完整：${f.name}`);
    }
    // 全部写成功后再搬到最终位置，避免半棵树
    for (const f of files) {
      const from = path.resolve(stage, f.name);
      const to = path.resolve(root, f.name);
      if (f.dir) { fs.mkdirSync(to, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    die(`写入失败（${e.code || e.message}），没有落下任何文件`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  console.log(`已取回 ${files.length} 个文件到 ${root}（sha256 已校验）`);
  for (const f of files.slice(0, 10)) console.log(' -', f.name);
  if (files.length > 10) console.log(` ... 共 ${files.length} 个`);
}

async function cmdLs(args) {
  const BASE = resolveBase(args.server);
  const status = args.all ? 'all' : (args.status || 'active');
  const res = await net(`${BASE}/drive?limit=${Number(args.limit || 50)}&status=${encodeURIComponent(status)}`, { headers: AUTH });
  const j = await res.json();
  if (res.status !== 200) die(`列出失败 ${res.status}: ${JSON.stringify(j)}`);
  if (!j.data.hits.length) return console.log('（空）');
  for (const h of j.data.hits) {
    const anon = h.anonymous_until
      ? (h.anonymous_until <= new Date().toISOString() ? `  匿名已过期(${h.anonymous_until})` : `  匿名至 ${h.anonymous_until}`)
      : '';
    console.log(`${h.resource_id}  ${String(h.size).padStart(10)}  ${h.status.padEnd(8)} ${h.name}${anon}`);
  }
}

async function cmdGc(args) {
  const BASE = resolveBase(args.server);
  const res = await net(`${BASE}/gc`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dry_run: !!args['dry-run'] }),
  });
  const j = await res.json();
  if (res.status !== 200) die(`回收失败 ${res.status}: ${JSON.stringify(j)}`);
  const d = j.data;
  const tag = d.dry_run ? '（演练，未实际删除）' : '';
  console.log(`超时 pending：${d.pending.length} 条${tag}`);
  for (const p of d.pending) console.log(`  ${p.id}  停在上传 ${p.age_h} 小时`);
  console.log(`过期墓碑：${d.tombstones.length} 条${tag}`);
}

async function cmdRm(args) {
  const rid = args._[0];
  const BASE = resolveBase(args.server);
  const res = await net(`${BASE}/drive/${rid}`, { method: 'DELETE', headers: AUTH });
  const j = await res.json();
  if (res.status !== 200) die(`删除失败 ${res.status}: ${JSON.stringify(j)}`);
  console.log(`已删除 ${j.data.resource_id}（蓝奏云对象${j.data.object_removed ? '已删' : '未删'}）`);
}

const USAGE = `adrive — agent 网盘（存储：蓝奏云）

用法:
  adrive init --username <账号> --password <密码> [--host 0.0.0.0] [--port 8787] [--public-base URL] [--no-verify]
  adrive put <文件或目录> [--name 展示名] [--server URL] [--json]
  adrive share <resource_id> [--ttl 7d] [--off]
  adrive get <resource_id> [--server URL] [-o 目录] [--force]
  adrive ls [--status active|pending|deleted|all] [--limit 50]
  adrive gc [--dry-run]          回收超时的未完成上传与过期墓碑
  adrive rm <resource_id>
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') args.o = argv[++i];
    else if (a.startsWith('--')) {
      const body = a.slice(2);
      if (body.includes('=')) {
        const [k, ...rest] = body.split('=');
        args[k] = rest.join('=');
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { args[body] = next; i++; } else args[body] = true;
      }
    } else args._.push(a);
  }
  return args;
}

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  const args = parseArgs(argv);
  if (!cmd || args.help || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }
  const table = { init: cmdInit, put: cmdPut, share: cmdShare, get: cmdGet, ls: cmdLs, rm: cmdRm, gc: cmdGc };
  if (!cmd || !table[cmd]) return console.log(USAGE);
  try {
    await table[cmd](args);
  } catch (e) {
    die(e.message);
  }
})();
