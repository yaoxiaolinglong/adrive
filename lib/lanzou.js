'use strict';
// 蓝奏云存储层：登录（含 acw_sc__v2 反爬）、列目录、上传、分享、下载、删除。
// 只依赖 Node 内置的 fetch / FormData / Blob（Node >= 20）。

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const KEY = '3000176000856006061501533003690027800375';
const PERM = [0xf, 0x23, 0x1d, 0x18, 0x21, 0x10, 0x1, 0x26, 0xa, 0x9, 0x13, 0x1f, 0x28, 0x1b,
  0x16, 0x17, 0x19, 0xd, 0x6, 0xb, 0x27, 0x12, 0x14, 0x8, 0xe, 0x15, 0x20, 0x1a, 0x2,
  0x1e, 0x7, 0x4, 0x11, 0x5, 0x3, 0x1c, 0x22, 0x25, 0xc, 0x24];

function acwCookie(arg1) {
  const out = new Array(PERM.length).fill('');
  for (let i = 0; i < arg1.length; i++) {
    for (let j = 0; j < PERM.length; j++) if (PERM[j] === i + 1) out[j] = arg1[i];
  }
  const u = out.join('');
  let s = '';
  for (let i = 0; i < Math.min(u.length, KEY.length); i += 2) {
    s += (parseInt(u.slice(i, i + 2), 16) ^ parseInt(KEY.slice(i, i + 2), 16)).toString(16).padStart(2, '0');
  }
  return s;
}

// 蓝奏云允许的扩展名（来自开源项目 lanzouyun-disk 的实测白名单）
const SUPPORTED = ('doc,docx,zip,rar,apk,ipa,txt,exe,7z,e,z,ct,ke,cetrainer,db,tar,pdf,w3x,epub,mobi,'
  + 'azw,azw3,osk,osz,xpa,cpk,lua,jar,dmg,ppt,pptx,xls,xlsx,mp3,iso,img,gho,ttf,ttc,txf,dwg,bat,'
  + 'imazingapp,dll,crx,xapk,conf,deb,rp,rpm,rplib,mobileconfig,appimage,lolgezi,flac,cad,hwt,accdb,'
  + 'ce,xmind,enc,bds,bdi,ssf,it,pkg,cfg').split(',');
// 伪装用的"安全后缀"，本身必须是白名单里的
const SAFE = ['ct', 'ke', 'w3x', 'mobi', 'azw3', 'osk', 'osz', 'xpa', 'cpk', 'lua', 'gho', 'ttc',
  'conf', 'rp', 'rplib', 'mobileconfig', 'appimage', 'lolgezi', 'cad', 'hwt', 'ce', 'xmind',
  'bds', 'bdi', 'ssf', 'it', 'pkg', 'cfg'];

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

/** 扩展名不在白名单时，追加 .<safe>.<safe> 骗过上传校验 */
function disguiseName(name) {
  const ext = (name.match(/\.([^./]+)$/) || [])[1];
  if (ext && SUPPORTED.includes(ext.toLowerCase())) return name;
  return `${name}.${pick(SAFE)}.${pick(SAFE)}`;
}

/** 从伪装名还原：末尾两个扩展名都在白名单、且剥掉后仍带扩展名，才算伪装过 */
function restoreName(name) {
  const m = name.match(/^(.*)\.([a-z0-9]+)\.([a-z0-9]+)$/i);
  if (!m) return name;
  const [, base, e1, e2] = m;
  const ok = (e) => SUPPORTED.includes(e.toLowerCase());
  if (!ok(e1) || !ok(e2)) return name;
  if (!/\.[a-z0-9]+$/i.test(base)) return name;
  return base;
}

class LanzouError extends Error {}

class CookieJar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    for (const line of list) {
      const pair = line.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

class Lanzou {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.jar = new CookieJar();
    this.uid = null;
    this.ajaxUrl = null;
    this.loggedIn = false;
  }

  static BASE = 'https://pc.woozooo.com';
  static LOGIN_PAGE = 'https://accounts.woozooo.com/accounts.php?action=login&ref=lanzou.com';
  static LOGIN_POST = 'https://accounts.woozooo.com/accounts.php';

  async req(url, opts = {}) {
    const headers = {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(opts.headers || {}),
      Cookie: this.jar.header(),
    };
    const res = await fetch(url, { ...opts, headers, redirect: 'follow' });
    this.jar.absorb(res);
    return res;
  }

  solveChallenge(body) {
    const m = body.match(/var arg1='([0-9A-F]+)'/);
    if (!m) return false;
    this.jar.map.set('acw_sc__v2', acwCookie(m[1]));
    return true;
  }

  async login(force = false) {
    if (this.loggedIn && !force) return this;

    let res = await this.req(Lanzou.LOGIN_PAGE);
    this.solveChallenge(await res.text());
    await this.req(Lanzou.LOGIN_PAGE);

    const form = new URLSearchParams({
      task: 'uselogin', username: this.username, password: this.password, ref: 'lanzou.com',
    });
    res = await this.req(Lanzou.LOGIN_POST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: Lanzou.LOGIN_PAGE, 'X-Requested-With': 'XMLHttpRequest' },
      body: form.toString(),
    });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new LanzouError('登录响应不是 JSON（可能被风控）：' + text.slice(0, 200)); }
    if (String(j.zt) !== '1') throw new LanzouError('登录失败：' + (j.msgs || text).slice(0, 200));

    await this.req(j.msgs);

    const main = await (await this.req(Lanzou.BASE + '/mydisk.php')).text();
    const iframe = main.match(/<iframe[^>]*src="([^"]+)"/);
    if (!iframe) throw new LanzouError('登录后没找到工作区 iframe（cookie 可能无效）');
    this.uid = (iframe[1].match(/u=(\d+)/) || [])[1] || null;
    const page = await (await this.req(new URL(iframe[1], Lanzou.BASE + '/').toString())).text();
    const ajax = page.match(/url\s*:\s*['"](\/doupload\.php\?uid=\d+)['"]/);
    if (!ajax) throw new LanzouError('没解析到 ajax 入口');
    this.ajaxUrl = new URL(ajax[1], Lanzou.BASE + '/').toString();
    this.loggedIn = true;
    return this;
  }

  async ajax(data, _retried = false) {
    await this.login();
    const res = await this.req(this.ajaxUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${Lanzou.BASE}/mydisk.php?item=files&action=index&u=${this.uid}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams(data).toString(),
    });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch {
      if (!_retried) return this.reloginAndRetry(() => this.ajax(data, true));
      throw new LanzouError('ajax 返回非 JSON：' + text.slice(0, 200));
    }
    if (!['1', '2'].includes(String(j.zt))) {
      // 登录态失效（zt=9）或未知错误：重登一次再试
      if (!_retried) return this.reloginAndRetry(() => this.ajax(data, true));
      throw new LanzouError('蓝奏云返回错误：' + String(j.info || text).slice(0, 200));
    }
    return j;
  }

  /** 会话可能过期：强制重登后重试一次 */
  async reloginAndRetry(fn) {
    this.loggedIn = false;
    try {
      await this.login(true);
    } catch (e) {
      throw new LanzouError('蓝奏云会话失效且重新登录失败：' + e.message);
    }
    return fn();
  }

  async files(folderId = -1) {
    const out = [];
    let pg = 1;
    for (;;) {
      const j = await this.ajax({ task: 5, folder_id: folderId, pg });
      const text = Array.isArray(j.text) ? j.text : [];
      out.push(...text);
      if (text.length === 0) break;
      pg++;
    }
    return out;
  }

  async upload(blob, name, folderId = -1, _retried = false) {
    await this.login();
    name = disguiseName(name);
    const fd = new FormData();
    fd.append('task', '1');
    fd.append('vie', '2');
    fd.append('ve', '2');
    fd.append('lastModifiedDate', new Date().toUTCString());
    fd.append('type', 'application/octet-stream');
    fd.append('id', 'WU_FILE_0');
    fd.append('folder_id_bb_n', String(folderId));
    fd.append('size', String(blob.length));
    fd.append('name', name);
    fd.append('upload_file', new Blob([blob], { type: 'application/octet-stream' }), name);

    const res = await this.req(Lanzou.BASE + '/html5up.php', {
      method: 'POST',
      headers: {
        Referer: `${Lanzou.BASE}/mydisk.php?item=files&action=index&u=${this.uid}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: fd,
    });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch {
      if (!_retried) return this.reloginAndRetry(() => this.upload(blob, name, folderId, true));
      throw new LanzouError('上传返回非 JSON（可能被风控）：' + text.slice(0, 200));
    }
    if (!['1', '2'].includes(String(j.zt))) {
      if (!_retried) return this.reloginAndRetry(() => this.upload(blob, name, folderId, true));
      throw new LanzouError('上传失败：' + String(j.info || text).slice(0, 200));
    }
    const item = (j.text || [])[0] || {};
    return {
      fileId: String(item.id),
      shareId: item.f_id || null,
      shareUrl: item.is_newd && item.f_id ? `${item.is_newd}/${item.f_id}` : null,
      size: item.size,
    };
  }

  async share(fileId) {
    const j = await this.ajax({ task: 22, file_id: fileId });
    const info = j.info || {};
    return {
      shareId: info.f_id || null,
      shareUrl: info.is_newd && info.f_id ? `${info.is_newd}/${info.f_id}` : (info.new_url || null),
    };
  }

  async delete(fileId) {
    await this.ajax({ task: 6, file_id: fileId });
    return true;
  }

  async download(shareUrl, retries = 4) {
    let last = '';
    for (let i = 0; i < retries; i++) {
      try {
        const data = await this.downloadOnce(shareUrl);
        if (data) return data;
      } catch (e) {
        last = e.message;
      }
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
    throw new LanzouError('下载失败：' + (last || '空响应'));
  }

  async downloadOnce(shareUrl) {
    // 下载用独立会话：分享页不需要登录态
    const jar = new CookieJar();
    const req = async (url, opts = {}) => {
      const res = await fetch(url, {
        ...opts,
        redirect: 'follow',
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...(opts.headers || {}), Cookie: jar.header() },
      });
      jar.absorb(res);
      return res;
    };

    const page = await (await req(shareUrl)).text();
    const iframe = page.match(/<iframe[^>]*src="([^"]+)"/);
    if (!iframe) throw new LanzouError('分享页里没有 iframe');
    const iframeUrl = new URL(iframe[1], shareUrl).toString();
    const inner = await (await req(iframeUrl)).text();

    const varOf = (n) => {
      const m = inner.match(new RegExp(`var\\s+${n}\\s*=\\s*'([^']*)'`));
      return m ? m[1] : null;
    };
    const ajaxdata = varOf('ajaxdata');
    const wpSign = varOf('wp_sign');
    const fid = inner.match(/file=(\d+)/);
    if (!ajaxdata || !wpSign || !fid) throw new LanzouError('分享页变量解析失败');

    const j = await (await fetch(`https://apifile.woozooo.com/ajaxfile.php?file=${fid[1]}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, Referer: iframeUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'downprocess', websignkey: ajaxdata, signs: ajaxdata, sign: wpSign, websign: '', kd: '1', ves: '1',
      }).toString(),
    })).json();
    if (String(j.zt) !== '1') throw new LanzouError('ajaxfile 拒绝：' + JSON.stringify(j).slice(0, 150));

    const finalUrl = `${j.dom}/file/${j.url}`;
    // 关键：二进制内容必须走 arrayBuffer，用 text() 会被 UTF-8 解码毁掉字节
    let res = await req(finalUrl);
    let buf = Buffer.from(await res.arrayBuffer());
    for (let i = 0; i < 5 && this.solveChallengeFor(jar, buf.toString('latin1')); i++) {
      res = await req(finalUrl);
      buf = Buffer.from(await res.arrayBuffer());
    }

    const looksHtml = buf.subarray(0, 64).toString('latin1').trimStart().startsWith('<');
    if (!looksHtml) return buf;

    const body = buf.toString('utf8');
    const token = body.match(/'file'\s*:\s*'([^']+)'/);
    const sign = body.match(/'sign'\s*:\s*'([^']+)'/);
    if (!token || !sign) return buf;
    const r2 = await req(new URL('ajax.php', res.url).toString(), {
      method: 'POST',
      headers: { Referer: res.url, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ file: token[1], el: '2', sign: sign[1] }).toString(),
    });
    const j2 = await r2.json().catch(() => null);
    if (j2 && String(j2.zt) === '1') {
      const fileRes = await req(j2.url);
      return Buffer.from(await fileRes.arrayBuffer());
    }
    throw new LanzouError('验证码环节失败：' + JSON.stringify(j2).slice(0, 120));
  }

  solveChallengeFor(jar, body) {
    const m = body.match(/var arg1='([0-9A-F]+)'/);
    if (!m) return false;
    jar.map.set('acw_sc__v2', acwCookie(m[1]));
    return true;
  }
}

module.exports = { Lanzou, LanzouError, acwCookie, disguiseName, restoreName, SUPPORTED, SAFE };
