> 这是首版 Python 实现（FastAPI + requests）。功能与 Node 版对齐，但**不含**大文件分片与后缀伪装——
> 那两块只在 Node 版实现。日常使用建议装 Node 版。

# adrive — agent 网盘（存储后端：蓝奏云）

一套自建版 agent 网盘：接口是 init → 上传 → commit → ticket → 匿名分享，
**唯一的替换点是把对象存储换成蓝奏云**。文件不落第三方对象存储，全在蓝奏云账号里。

## 为什么这么设计

常见做法是「REST 发凭证 + 对象存储直传/预签名直取」。蓝奏云没有预签名机制，
所以 `init` 返回的是**本服务的代理上传地址**，上传/下载都经由本服务转发到蓝奏云：

```
客户端 --init--> 服务 --发 resource_id--> 客户端
客户端 --PUT /drive/{id}/blob (zip)--> 服务 --html5up.php--> 蓝奏云
客户端 --commit--> 服务（落库，资源 active）
接收方 --POST /public/drive/ticket--> 服务 --签 HMAC URL--> 接收方
接收方 --GET /public/drive/{id}/blob--> 服务 --分享页→iframe→ajaxfile--> 蓝奏云
```

## 结构

| 文件 | 作用 |
|---|---|
| `lanzou.py` | 蓝奏云存储层：登录（含 acw_sc__v2 反爬）、列目录、上传、分享、下载、删除 |
| `server.py` | FastAPI 服务：资源元数据（SQLite）、上传代理、签名票据、匿名开关 |
| `cli.py` | 客户端：`put / get / ls / share / rm` |

## 安装

```bash
# 依赖
python3 -m pip install fastapi uvicorn requests

# 配置（写入 ~/.config/adrive/config.json，token 自动生成）
python3 -m cli init --username <蓝奏云账号> --password <密码>

# 起服务
python3 -m uvicorn server:app --host 127.0.0.1 --port 8787

# 客户端挂到 PATH
ln -sf "$PWD/cli.py" ~/.local/bin/adrive
```

## 用法

```bash
adrive put ./build.zip            # 上传，得到 resource_id
adrive share <id> --ttl 7d        # 开放匿名下载（默认 7 天，上限 7 天）
adrive get <id> -o ./downloads    # 接收方取回（不需要账号/token）
adrive ls                         # 我的资源
adrive rm <id>                    # 删除（连蓝奏云对象一起删）
```

`share` 会打印一段给接收方 agent 的交接文案，直接原样转发即可。

## HTTP 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 否 | 存活 |
| POST | `/drive/init` | Bearer | `{size,sha256,name}` → `{resource_id, upload{url,headers}}` |
| PUT | `/drive/{id}/blob` | Bearer | 上传 zip 字节 |
| POST | `/drive/commit` | Bearer | 资源转 active |
| GET | `/drive?limit&status` | Bearer | 列表 |
| POST | `/drive/ticket` | Bearer | 本人下载票据 |
| POST | `/public/drive/ticket` | **否** | 匿名下载票据（需 `anonymous_until` 未过期） |
| GET | `/public/drive/{id}/blob?exp&sig` | 签名 | 实际取回 |
| PUT | `/drive/{id}/anonymous` | Bearer | `{"anonymous_ttl":"7d"}` / `""` 关闭 |
| DELETE | `/drive/{id}` | Bearer | 删资源 + 蓝奏云对象 |

## 蓝奏云存储层的几个坑（都已在 `lanzou.py` 里处理）

1. **登录有 WAF**：`accounts.woozooo.com` 返回阿里云 `acw_sc__v2` JS 挑战。算法公开，
   本地算 cookie 即可，不需要浏览器。
2. **登录是 AJAX**：`POST /accounts.php` 带 `task=uselogin`，返回 `{zt:1, msgs:<中转URL>}`，
   必须再 GET 那个中转 URL 才算登录完成，`phpdisk_info` cookie 才生效。
3. **工作区在 iframe 里**：`mydisk.php` → iframe → 页面脚本里藏着 ajax 入口
   `/doupload.php?uid=<uid>`，所有业务操作都打这个入口。
4. **上传**：`POST /html5up.php`，multipart 字段固定
   `task=1, vie=2, ve=2, lastModifiedDate, type, id=WU_FILE_0, folder_id_bb_n, size, name, upload_file`。
   响应里 `text[0]` 带 `id`（文件 id）、`f_id`（分享 id）、`is_newd`（分享域名）。
5. **下载要三跳**：分享页 → iframe → `apifile.woozooo.com/ajaxfile.php`（要 `ajaxdata`/`wp_sign`）
   → `dom/file/<url>`，这一跳还可能再吃一次 acw 挑战，甚至落到验证页（再 POST `ajax.php` 拿真链）。
   `lanzou.py` 里做了重试 + 挑战重算。
6. **限额**：免费账号单文件 100MB（本服务 `limits.max_bytes` 默认 100MB）。

## 已知限制

- 下载要服务端中转，带宽吃本机（蓝奏云直链短时有效且带反爬，不适合直接发给接收方）。
- 蓝奏云分享链接是永久的，但本服务的签名票据默认 15 分钟；匿名开关是服务侧控制，
  关掉后旧票据过期即失效。
- 单账号并发上传没有做限流，蓝奏云风控敏感，批量传建议串行 + 间隔。
