"""蓝奏云存储后端。

只做存储层：登录 / 列目录 / 上传 / 分享 / 下载 / 删除。
所有反爬（acw_sc__v2）都在本地算，不依赖浏览器。
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import requests

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# ---- 阿里云 acw_sc__v2 反爬 ------------------------------------------------
_KEY = "3000176000856006061501533003690027800375"
_PERM = [0xf, 0x23, 0x1d, 0x18, 0x21, 0x10, 0x1, 0x26, 0xa, 0x9, 0x13, 0x1f,
         0x28, 0x1b, 0x16, 0x17, 0x19, 0xd, 0x6, 0xb, 0x27, 0x12, 0x14, 0x8,
         0xe, 0x15, 0x20, 0x1a, 0x2, 0x1e, 0x7, 0x4, 0x11, 0x5, 0x3, 0x1c,
         0x22, 0x25, 0xc, 0x24]


def _unsbox(arg: str) -> str:
    out = [""] * len(_PERM)
    for i, ch in enumerate(arg):
        for j, v in enumerate(_PERM):
            if v == i + 1:
                out[j] = ch
    return "".join(out)


def acw_cookie(arg1: str) -> str:
    u = _unsbox(arg1)
    n = min(len(u), len(_KEY))
    return "".join("%02x" % (int(u[i:i + 2], 16) ^ int(_KEY[i:i + 2], 16))
                   for i in range(0, n, 2))


class LanzouError(RuntimeError):
    pass


class Lanzou:
    BASE = "https://pc.woozooo.com"
    LOGIN_PAGE = "https://accounts.woozooo.com/accounts.php?action=login&ref=lanzou.com"
    LOGIN_POST = "https://accounts.woozooo.com/accounts.php"

    def __init__(self, username: str, password: str, cookie_file: str | None = None):
        self.username = username
        self.password = password
        self.cookie_file = cookie_file
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
        self.uid: str | None = None
        self.ajax_url: str | None = None
        self._logged_in = False

    # ---- 登录 ---------------------------------------------------------
    def _solve(self, url: str, host: str, body: str, sess=None) -> bool:
        m = re.search(r"var arg1='([0-9A-F]+)'", body)
        if not m:
            return False
        (sess or self.s).cookies.set("acw_sc__v2", acw_cookie(m.group(1)), domain=host)
        return True

    def login(self, force: bool = False) -> None:
        if self._logged_in and not force:
            return
        page = self.s.get(self.LOGIN_PAGE, timeout=30)
        self._solve(self.LOGIN_PAGE, "accounts.woozooo.com", page.text)
        self.s.get(self.LOGIN_PAGE, timeout=30)

        r = self.s.post(self.LOGIN_POST, data={
            "task": "uselogin", "username": self.username,
            "password": self.password, "ref": "lanzou.com",
        }, headers={"Referer": self.LOGIN_PAGE, "X-Requested-With": "XMLHttpRequest"},
            timeout=30)
        try:
            j = r.json()
        except Exception:
            raise LanzouError("登录响应不是 JSON（可能被风控）：" + r.text[:200])
        if str(j.get("zt")) != "1":
            raise LanzouError("登录失败：" + str(j.get("msgs") or j)[:200])

        self.s.get(j["msgs"], timeout=30)
        main = self.s.get(self.BASE + "/mydisk.php", timeout=30).text
        iframe = re.search(r'<iframe[^>]*src="([^"]+)"', main)
        if not iframe:
            raise LanzouError("登录后没找到工作区 iframe（cookie 可能无效）")
        src = iframe.group(1)
        self.uid = (re.search(r"u=(\d+)", src) or [None, None])[1]
        page = self.s.get(urljoin(self.BASE + "/", src), timeout=30).text
        m = re.search(r"url\s*:\s*['\"](/doupload\.php\?uid=\d+)['\"]", page)
        if not m:
            raise LanzouError("没解析到 ajax 入口")
        self.ajax_url = urljoin(self.BASE + "/", m.group(1))
        self._logged_in = True
        self._save_cookies()

    def _save_cookies(self) -> None:
        if not self.cookie_file:
            return
        data = {c.name: c.value for c in self.s.cookies}
        os.makedirs(os.path.dirname(self.cookie_file), exist_ok=True)
        with open(self.cookie_file, "w") as f:
            json.dump(data, f)
        os.chmod(self.cookie_file, 0o600)

    # ---- 通用 ---------------------------------------------------------
    def _ajax(self, data: dict) -> dict:
        self.login()
        r = self.s.post(self.ajax_url, data=data, timeout=60, headers={
            "Referer": f"{self.BASE}/mydisk.php?item=files&action=index&u={self.uid}",
            "X-Requested-With": "XMLHttpRequest",
        })
        try:
            j = r.json()
        except Exception:
            raise LanzouError("ajax 返回非 JSON：" + r.text[:200])
        if str(j.get("zt")) not in ("1", "2"):
            raise LanzouError("蓝奏云返回错误：" + str(j.get("info") or j)[:200])
        return j

    def files(self, folder_id: int = -1) -> list[dict]:
        out, pg = [], 1
        while True:
            j = self._ajax({"task": 5, "folder_id": folder_id, "pg": pg})
            text = j.get("text") or []
            if not isinstance(text, list):
                break
            out.extend(text)
            if len(text) < 18:
                break
            pg += 1
        return out

    # ---- 上传 ---------------------------------------------------------
    def upload(self, blob: bytes, name: str, folder_id: int = -1) -> dict:
        self.login()
        form = {
            "task": "1", "vie": "2", "ve": "2",
            "lastModifiedDate": datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT"),
            "type": "application/octet-stream", "id": "WU_FILE_0",
            "folder_id_bb_n": str(folder_id), "size": str(len(blob)), "name": name,
        }
        r = self.s.post(self.BASE + "/html5up.php", data=form,
                        files={"upload_file": (name, blob, "application/octet-stream")},
                        timeout=600, headers={
                            "Referer": f"{self.BASE}/mydisk.php?item=files&action=index&u={self.uid}",
                            "X-Requested-With": "XMLHttpRequest",
                        })
        try:
            j = r.json()
        except Exception:
            raise LanzouError("上传返回非 JSON（可能被风控）：" + r.text[:200])
        if str(j.get("zt")) not in ("1", "2"):
            raise LanzouError("上传失败：" + str(j.get("info") or j)[:200])
        item = (j.get("text") or [{}])[0]
        share_id = item.get("f_id")
        base = item.get("is_newd") or ""
        return {
            "file_id": str(item.get("id")),
            "share_id": share_id,
            "share_url": f"{base}/{share_id}" if base and share_id else None,
            "size": item.get("size"),
        }

    def share(self, file_id: str) -> dict:
        j = self._ajax({"task": 22, "file_id": file_id})
        info = j.get("info") or {}
        share_id = info.get("f_id")
        base = info.get("is_newd")
        return {"share_id": share_id, "share_url": f"{base}/{share_id}" if base and share_id else info.get("new_url")}

    def delete(self, file_id: str) -> bool:
        self._ajax({"task": 6, "file_id": file_id})
        return True

    # ---- 下载 ---------------------------------------------------------
    def download(self, share_url: str, retries: int = 4) -> bytes:
        """走 分享页 → iframe → ajaxfile → dom/file 取回原始字节。"""
        last = ""
        for attempt in range(retries):
            try:
                data = self._download_once(share_url)
                if data:
                    return data
            except Exception as e:  # noqa: BLE001
                last = str(e)
            time.sleep(1.5 * (attempt + 1))
        raise LanzouError(f"下载失败：{last or '空响应'}")

    def _download_once(self, share_url: str) -> bytes | None:
        s = requests.Session()
        s.headers.update({"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
        r = s.get(share_url, timeout=30)
        iframe = re.search(r'<iframe[^>]*src="([^"]+)"', r.text)
        if not iframe:
            raise LanzouError("分享页里没有 iframe")
        iframe_url = urljoin(r.url, iframe.group(1))
        page = s.get(iframe_url, timeout=30).text

        def var(name):
            m = re.search(r"var\s+%s\s*=\s*'([^']*)'" % name, page)
            return m.group(1) if m else None

        ajax, sign = var("ajaxdata"), var("wp_sign")
        fid = re.search(r"file=(\d+)", page)
        if not (ajax and sign and fid):
            raise LanzouError("分享页变量解析失败")
        j = s.post(f"https://apifile.woozooo.com/ajaxfile.php?file={fid.group(1)}",
                   data={"action": "downprocess", "websignkey": ajax, "signs": ajax,
                         "sign": sign, "websign": "", "kd": "1", "ves": "1"},
                   headers={"Referer": iframe_url}, timeout=30).json()
        if str(j.get("zt")) != "1":
            raise LanzouError("ajaxfile 拒绝：" + str(j)[:150])
        final = f"{j['dom']}/file/{j['url']}"
        host = urlparse(final).hostname

        for _ in range(5):
            r3 = s.get(final, timeout=120)
            if self._solve(final, host, r3.text, s):
                continue
            if r3.content[:2] == b"PK" or b"<html" not in r3.content[:400].lower():
                return r3.content
            # 落到验证页：拿 token 走 ajax.php
            m_f = re.search(r"'file'\s*:\s*'([^']+)'", r3.text)
            m_s = re.search(r"'sign'\s*:\s*'([^']+)'", r3.text)
            if not (m_f and m_s):
                return r3.content
            r4 = s.post(urljoin(r3.url, "ajax.php"),
                        data={"file": m_f.group(1), "el": "2", "sign": m_s.group(1)},
                        headers={"Referer": r3.url, "X-Requested-With": "XMLHttpRequest"},
                        timeout=30)
            try:
                j2 = r4.json()
            except Exception:
                return r3.content
            if str(j2.get("zt")) == "1":
                return s.get(j2["url"], timeout=300).content
            raise LanzouError("验证码环节失败：" + str(j2)[:120])
        raise LanzouError("多次挑战仍未拿到文件")
