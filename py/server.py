"""adrive — agent 网盘服务（存储后端：蓝奏云）

两段式上传 + 短期下载票：init → 上传 → commit → ticket → 匿名分享。
区别只有一处：没有对象存储的预签名直传，上传/下载都经由本服务代理到蓝奏云。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import string
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from lanzou import Lanzou, LanzouError

CFG_PATH = os.path.expanduser("~/.config/adrive/config.json")
DEFAULT_CFG = {
    "server": {"host": "127.0.0.1", "port": 8787, "public_base": "http://127.0.0.1:8787"},
    "lanzou": {"username": "", "password": ""},
    "limits": {"max_bytes": 100 * 1024 * 1024},
}

ALPHABET = string.ascii_letters + string.digits


def load_cfg() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CFG))
    if os.path.exists(CFG_PATH):
        cfg.update(json.load(open(CFG_PATH)))
    cfg["server"]["token"] = cfg["server"].get("token") or os.environ.get("ADRIVE_TOKEN", "")
    if not cfg["server"]["token"]:
        cfg["server"]["token"] = secrets.token_urlsafe(24)
        save_cfg(cfg)
    return cfg


def save_cfg(cfg: dict) -> None:
    os.makedirs(os.path.dirname(CFG_PATH), exist_ok=True)
    with open(CFG_PATH, "w") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.chmod(CFG_PATH, 0o600)


CFG = load_cfg()
DATA_DIR = os.path.expanduser("~/.local/share/adrive")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "adrive.db")

lz = Lanzou(CFG["lanzou"]["username"], CFG["lanzou"]["password"],
            cookie_file=os.path.join(DATA_DIR, "lanzou-cookies.json"))

app = FastAPI(title="adrive", version="0.1.0")


# ---------------- 存储 ----------------
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS resources(
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            sha256 TEXT,
            file_id TEXT,
            share_id TEXT,
            share_url TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            anonymous_until TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""")


init_db()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def new_id() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(22))


# ---------------- 鉴权 / 签名 ----------------
def require_auth(authorization: Optional[str] = Header(None)) -> None:
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not token or not hmac.compare_digest(token, CFG["server"]["token"]):
        raise HTTPException(401, "unauthorized")


def sign(rid: str, exp: int) -> str:
    msg = f"{rid}.{exp}".encode()
    return hmac.new(CFG["server"]["token"].encode(), msg, hashlib.sha256).hexdigest()[:32]


def verify(rid: str, exp: int, sig: str) -> bool:
    return exp > int(time.time()) and hmac.compare_digest(sign(rid, exp), sig)


def parse_ttl(ttl: str) -> int:
    ttl = (ttl or "").strip()
    if not ttl:
        return 0
    unit, num = ttl[-1], ttl[:-1]
    mult = {"s": 1, "m": 60, "h": 3600, "d": 86400}.get(unit)
    if not mult or not num.isdigit():
        raise HTTPException(400, f"bad ttl: {ttl}")
    return min(int(num) * mult, 7 * 86400)


# ---------------- 模型 ----------------
class InitReq(BaseModel):
    size: int
    sha256: str | None = None
    name: str


class CommitReq(BaseModel):
    resource_id: str


class TicketReq(BaseModel):
    resource_id: str


class AnonReq(BaseModel):
    anonymous_ttl: str = ""


# ---------------- 路由 ----------------
@app.get("/health")
def health():
    return {"ok": True, "backend": "lanzou", "version": "0.1.0"}


@app.post("/drive/init", dependencies=[Depends(require_auth)])
def drive_init(req: InitReq):
    limit = CFG["limits"]["max_bytes"]
    if req.size > limit:
        raise HTTPException(413, f"PACK_TOO_LARGE: 单资源上限 {limit} 字节（蓝奏云免费账号）")
    rid = new_id()
    ts = now_iso()
    with db() as c:
        c.execute("INSERT INTO resources(id,name,size,sha256,status,created_at,updated_at)"
                  " VALUES(?,?,?,?,?,?,?)",
                  (rid, req.name, req.size, req.sha256, "pending", ts, ts))
    base = CFG["server"]["public_base"].rstrip("/")
    return {"code": 0, "message": "ok", "data": {
        "resource_id": rid,
        "upload": {
            "mode": "proxy",
            "url": f"{base}/drive/{rid}/blob",
            "method": "PUT",
            "content_type": "application/zip",
            "headers": {"Authorization": f"Bearer {CFG['server']['token']}"},
            "expires_in": 3600,
        },
    }}


@app.put("/drive/{rid}/blob", dependencies=[Depends(require_auth)])
async def drive_blob(rid: str, request: Request):
    body = await request.body()
    with db() as c:
        row = c.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
    if not row:
        raise HTTPException(404, "resource not found")
    if row["status"] != "pending":
        raise HTTPException(409, "already uploaded")
    if len(body) > CFG["limits"]["max_bytes"]:
        raise HTTPException(413, "PACK_TOO_LARGE")
    if row["sha256"] and hashlib.sha256(body).hexdigest() != row["sha256"]:
        raise HTTPException(422, "sha256 mismatch")
    try:
        info = lz.upload(body, f"{rid}.zip")
    except LanzouError as e:
        raise HTTPException(502, f"lanzou upload failed: {e}")
    with db() as c:
        c.execute("UPDATE resources SET file_id=?,share_id=?,share_url=?,size=?,updated_at=?"
                  " WHERE id=?",
                  (info["file_id"], info["share_id"], info["share_url"], len(body), now_iso(), rid))
    return {"code": 0, "data": {"resource_id": rid, "size": len(body)}}


@app.post("/drive/commit", dependencies=[Depends(require_auth)])
def drive_commit(req: CommitReq):
    with db() as c:
        row = c.execute("SELECT * FROM resources WHERE id=?", (req.resource_id,)).fetchone()
        if not row:
            raise HTTPException(404, "resource not found")
        if not row["share_url"]:
            raise HTTPException(409, "blob not uploaded")
        c.execute("UPDATE resources SET status='active',updated_at=? WHERE id=?",
                  (now_iso(), req.resource_id))
    return {"code": 0, "data": meta(row, "active")}


def meta(row, status: str | None = None) -> dict:
    return {
        "resource_id": row["id"], "name": row["name"], "size": row["size"],
        "sha256": row["sha256"], "status": status or row["status"],
        "anonymous_until": row["anonymous_until"], "created_at": row["created_at"],
    }


@app.get("/drive", dependencies=[Depends(require_auth)])
def drive_list(limit: int = 50, status: str = "active"):
    q, args = "SELECT * FROM resources", []
    if status and status != "all":
        q += " WHERE status=?"
        args.append(status)
    q += " ORDER BY created_at DESC LIMIT ?"
    args.append(max(1, min(limit, 500)))
    with db() as c:
        rows = c.execute(q, args).fetchall()
    return {"code": 0, "data": {"hits": [meta(r) for r in rows], "total": len(rows)}}


def _ticket(row) -> dict:
    base = CFG["server"]["public_base"].rstrip("/")
    exp = int(time.time()) + 900
    return {"url": f"{base}/public/drive/{row['id']}/blob?exp={exp}&sig={sign(row['id'], exp)}",
            "expires_at": datetime.fromtimestamp(exp).astimezone().isoformat(timespec="seconds")}


@app.post("/drive/ticket", dependencies=[Depends(require_auth)])
def drive_ticket(req: TicketReq):
    with db() as c:
        row = c.execute("SELECT * FROM resources WHERE id=?", (req.resource_id,)).fetchone()
    if not row or not row["share_url"]:
        raise HTTPException(404, "resource not found")
    return {"code": 0, "data": _ticket(row)}


@app.post("/public/drive/ticket")
def public_ticket(req: TicketReq):
    with db() as c:
        row = c.execute("SELECT * FROM resources WHERE id=?", (req.resource_id,)).fetchone()
    if not row or not row["share_url"]:
        raise HTTPException(404, "resource not found")
    until = row["anonymous_until"]
    if not until or until <= now_iso():
        raise HTTPException(403, "RESOURCE_NOT_SHARED: 未开放匿名下载")
    return {"code": 0, "data": _ticket(row)}


@app.get("/public/drive/{rid}/blob")
def public_blob(rid: str, exp: int, sig: str):
    if not verify(rid, exp, sig):
        raise HTTPException(403, "bad signature")
    with db() as c:
        row = c.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
    if not row or not row["share_url"]:
        raise HTTPException(404, "resource not found")
    try:
        data = lz.download(row["share_url"])
    except LanzouError as e:
        raise HTTPException(502, f"lanzou download failed: {e}")
    return Response(content=data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{rid}.zip"'})


@app.put("/drive/{rid}/anonymous", dependencies=[Depends(require_auth)])
def drive_anonymous(rid: str, req: AnonReq):
    ttl = parse_ttl(req.anonymous_ttl)
    with db() as c:
        row = c.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "resource not found")
        until = (datetime.now().astimezone() + timedelta(seconds=ttl)).isoformat(timespec="seconds") if ttl else None
        c.execute("UPDATE resources SET anonymous_until=?,updated_at=? WHERE id=?", (until, now_iso(), rid))
    return {"code": 0, "data": {"resource_id": rid, "anonymous_until": until, "ttl": req.anonymous_ttl}}


@app.delete("/drive/{rid}", dependencies=[Depends(require_auth)])
def drive_rm(rid: str):
    with db() as c:
        row = c.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "resource not found")
    removed = False
    if row["file_id"]:
        try:
            removed = lz.delete(row["file_id"])
        except LanzouError:
            removed = False
    with db() as c:
        c.execute("UPDATE resources SET status='deleted',updated_at=? WHERE id=?", (now_iso(), rid))
    return {"code": 0, "data": {"resource_id": rid, "name": row["name"], "deleted": True,
                                "object_removed": removed}}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=CFG["server"]["host"], port=CFG["server"]["port"])
