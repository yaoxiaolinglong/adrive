#!/usr/bin/env python3
"""adrive 客户端：put / get / ls / share / rm"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import zipfile
from pathlib import Path

import requests

CFG_PATH = os.path.expanduser("~/.config/adrive/config.json")


def cfg() -> dict:
    if not os.path.exists(CFG_PATH):
        sys.exit("未初始化：先跑 adrive init --username <账号> --password <密码>")
    return json.load(open(CFG_PATH))


def base() -> str:
    return cfg()["server"]["public_base"].rstrip("/")


def token() -> str:
    return cfg()["server"]["token"]


def H() -> dict:
    return {"Authorization": f"Bearer {token()}"}


def pack(path: Path) -> tuple[bytes, str]:
    buf = io.BytesIO()
    if path.is_dir():
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for f in path.rglob("*"):
                if f.is_file():
                    z.write(f, str(Path(path.name) / f.relative_to(path)))
        name = path.name
    else:
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(path, path.name)
        name = path.name
    return buf.getvalue(), name


def cmd_init(a) -> None:
    c = cfg() if os.path.exists(CFG_PATH) else {
        "server": {"host": "127.0.0.1", "port": 8787, "public_base": "http://127.0.0.1:8787"},
        "lanzou": {}, "limits": {"max_bytes": 104857600},
    }
    if a.username:
        c["lanzou"]["username"] = a.username
    if a.password:
        c["lanzou"]["password"] = a.password
    if a.public_base:
        c["server"]["public_base"] = a.public_base
    os.makedirs(os.path.dirname(CFG_PATH), exist_ok=True)
    json.dump(c, open(CFG_PATH, "w"), ensure_ascii=False, indent=2)
    os.chmod(CFG_PATH, 0o600)
    print(f"配置已写入 {CFG_PATH}")


def cmd_put(a) -> None:
    p = Path(a.path).expanduser()
    if not p.exists():
        sys.exit(f"路径不存在：{p}")
    blob, name = pack(p)
    name = a.name or name
    r = requests.post(f"{base()}/drive/init", headers=H(),
                      json={"size": len(blob), "sha256": hashlib.sha256(blob).hexdigest(), "name": name},
                      timeout=60)
    if r.status_code != 200:
        sys.exit(f"init 失败 {r.status_code}: {r.text[:300]}")
    d = r.json()["data"]
    rid, up = d["resource_id"], d["upload"]
    r2 = requests.put(up["url"], headers=up["headers"], data=blob, timeout=900)
    if r2.status_code != 200:
        sys.exit(f"上传失败 {r2.status_code}: {r2.text[:300]}")
    r3 = requests.post(f"{base()}/drive/commit", headers=H(), json={"resource_id": rid}, timeout=60)
    if r3.status_code != 200:
        sys.exit(f"commit 失败 {r3.status_code}: {r3.text[:300]}")
    m = r3.json()["data"]
    if not a.json:
        print(f"资源已创建：{m['name']}")
        print(f"resource_id：{rid}")
        print(f"大小：{m['size']} 字节")
        print("有效期至：永久（仅你的账号可见）")
        print("\n要交给别的 agent，先开放匿名下载：")
        print(f"  adrive share {rid} --ttl 7d")
    else:
        print(json.dumps({"code": 0, "data": {**m, "resource_id": rid}}, ensure_ascii=False))


def cmd_share(a) -> None:
    ttl = "" if a.off else (a.ttl or "7d")
    r = requests.put(f"{base()}/drive/{a.resource_id}/anonymous", headers=H(),
                     json={"anonymous_ttl": ttl}, timeout=60)
    if r.status_code != 200:
        sys.exit(f"分享失败 {r.status_code}: {r.text[:300]}")
    d = r.json()["data"]
    if not d["anonymous_until"]:
        print("已关闭匿名下载")
        return
    print(f"已开放匿名下载，到期：{d['anonymous_until']}")
    print(f"\n把下面这段发给接收方（原样，别改写）：\n")
    print(f"我用 agent 网盘给你传了一个资源：{a.resource_id}\n")
    print("请执行这条命令取回：")
    print(f"adrive get {a.resource_id}\n")
    print("如果提示找不到 adrive，先问对方要安装方式，再重试。")
    print("取回后请告诉我文件放在了哪里、里面有什么，等我确认后再使用。")


def cmd_get(a) -> None:
    r = requests.post(f"{base()}/public/drive/ticket", json={"resource_id": a.resource_id}, timeout=60)
    if r.status_code == 403:
        sys.exit("对方没有开放匿名下载（RESOURCE_NOT_SHARED）")
    if r.status_code != 200:
        sys.exit(f"取票失败 {r.status_code}: {r.text[:300]}")
    url = r.json()["data"]["url"]
    r2 = requests.get(url, timeout=900)
    if r2.status_code != 200:
        sys.exit(f"下载失败 {r2.status_code}")
    out = Path(a.output or ".").expanduser()
    out.mkdir(parents=True, exist_ok=True)
    zf = zipfile.ZipFile(io.BytesIO(r2.content))
    for member in zf.namelist():
        target = (out / member).resolve()
        if not str(target).startswith(str(out.resolve())):
            sys.exit(f"压缩包含不安全路径：{member}")
    zf.extractall(out)
    files = zf.namelist()
    print(f"已取回 {len(files)} 个文件到 {out}")
    for f in files[:10]:
        print(" -", f)
    if len(files) > 10:
        print(f" ... 共 {len(files)} 个")


def cmd_ls(a) -> None:
    r = requests.get(f"{base()}/drive", headers=H(), params={"limit": a.limit}, timeout=60)
    if r.status_code != 200:
        sys.exit(f"列出失败 {r.status_code}: {r.text[:200]}")
    hits = r.json()["data"]["hits"]
    if not hits:
        print("（空）")
        return
    for h in hits:
        print(f"{h['resource_id']}  {h['size']:>10}  {h['status']:<8} {h['name']}"
              + (f"  匿名至 {h['anonymous_until']}" if h["anonymous_until"] else ""))


def cmd_rm(a) -> None:
    r = requests.delete(f"{base()}/drive/{a.resource_id}", headers=H(), timeout=60)
    if r.status_code != 200:
        sys.exit(f"删除失败 {r.status_code}: {r.text[:200]}")
    d = r.json()["data"]
    print(f"已删除 {d['resource_id']}（蓝奏云对象{'已删' if d['object_removed'] else '未删'}）")


def main() -> None:
    ap = argparse.ArgumentParser(prog="adrive")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init", help="写入配置")
    p.add_argument("--username"); p.add_argument("--password"); p.add_argument("--public-base")
    p.set_defaults(fn=cmd_init)

    p = sub.add_parser("put", help="上传文件或目录")
    p.add_argument("path"); p.add_argument("--name"); p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_put)

    p = sub.add_parser("share", help="开/关匿名下载")
    p.add_argument("resource_id"); p.add_argument("--ttl", default="7d"); p.add_argument("--off", action="store_true")
    p.set_defaults(fn=cmd_share)

    p = sub.add_parser("get", help="取回资源")
    p.add_argument("resource_id"); p.add_argument("-o", "--output", default=".")
    p.set_defaults(fn=cmd_get)

    p = sub.add_parser("ls", help="列出我的资源")
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(fn=cmd_ls)

    p = sub.add_parser("rm", help="删除资源")
    p.add_argument("resource_id")
    p.set_defaults(fn=cmd_rm)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
