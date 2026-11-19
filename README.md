# adrive

**给 AI agent 之间传文件的网盘。存储用你自己的蓝奏云账号，零第三方对象存储。**

一个 agent 想把手上的文件交给另一个 agent（或另一台机器上的程序），麻烦的从来不是传输，
而是「怎么交出去、对方怎么可靠取回、什么时候收回」。`adrive` 把这件事做成两条命令：

```bash
# 发送方
adrive put ./build.zip
adrive share <resource_id> --ttl 7d

# 接收方（另一台机器 / 另一个 agent）
adrive get <resource_id> --server http://<发送方IP>:8787 -o ./downloads
```

- 零运行时依赖（Node ≥ 20，只用内置模块）
- 超过 `chunk_bytes`（默认 95MB）自动分片，取回按序合并并校验整文件 sha256
- 单文件直传原始字节，目录打包成 zip（保留空目录）
- 匿名下载可开关、可限时（上限 7 天），过期立即失效
- 本地已有同名文件默认不覆盖，`--force` 才覆盖

## 架构

```
发送方                           adrive 服务                     蓝奏云
  │  POST /drive/init               │                              │
  │ ─────────────────────────────►  │  发 resource_id + 上传地址     │
  │  PUT /drive/{id}/blob           │                              │
  │   （文件原文 / 目录 zip，分片）  │ ── html5up.php ────────────► │
  │  POST /drive/commit             │                              │
  │ ─────────────────────────────►  │  落库，资源 active             │
  │                                                                 │
接收方                                                               │
  │  POST /public/drive/ticket      │                              │
  │ ─────────────────────────────►  │ 校验 anonymous_until → 签 URL │
  │  GET  /public/drive/{id}/blob   │                              │
  │ ─────────────────────────────►  │ ── 分享页→iframe→ajaxfile ──► │
```

蓝奏云没有预签名直传，所以上传/下载都经由本服务中转。好处是接收方只需要 `resource_id`；
代价是带宽走你自己的机器。

## 安装

```bash
# 方式一：从 GitHub 全局安装（推荐）
npm install -g github:yaoxiaolinglong/adrive

# 方式二：克隆后本地安装
git clone https://github.com/yaoxiaolinglong/adrive.git
cd adrive && npm install -g .

# 方式三：不安装，临时跑 CLI
npx github:yaoxiaolinglong/adrive ls
# 起服务要显式指定 bin：
npx -y -p github:yaoxiaolinglong/adrive adrive-server
```

> `@yxll/adrive` 尚未发布到 npm registry，先把 GitHub 作为分发渠道。
> 全局安装只包含 `bin/` `lib/` `server.js`，`py/` 与 `test/` 只在仓库里。

## 快速开始

```bash
# 1. 写配置（会校验蓝奏云登录、生成 API token）
adrive init --username <蓝奏云账号> --password <蓝奏云密码>

# 2. 起服务（默认 127.0.0.1:8787，前台运行，Ctrl-C 停）
adrive-server
# 从源码目录启动则是：node server.js

# 3. 传东西
adrive put ./report.pdf
adrive share <resource_id> --ttl 7d
```

> 服务端和 CLI **必须用同一个 `HOME`**（同一份 `~/.config/adrive/config.json`），
> 否则各自生成随机 token，表现是永远 401。

### 跨机器 / 交给另一个 agent

默认只监听 `127.0.0.1`，别的机器连不上。要给局域网用：

```bash
adrive init --username <账号> --password <密码> \
  --host 0.0.0.0 --public-base http://192.168.1.10:8787
adrive-server        # 改了 host / port / public_base 必须重启才生效
```

`--public-base` 要写**接收方真能访问到的地址**（局域网 IP 或域名）；写 `127.0.0.1` 只有本机取得到。

接收方不需要账号、不需要配置文件：

```bash
adrive get <resource_id> --server http://192.168.1.10:8787 -o ./downloads
# 也可以用环境变量：ADRIVE_SERVER=http://192.168.1.10:8787 adrive get <id>
```

`adrive share` 会打印一段交接文案，原样转给对方即可：

```
我用 agent 网盘给你传了一个资源：Mqrx0O5E0jbYQeinW6h0dj

请执行这条命令取回：
adrive get Mqrx0O5E0jbYQeinW6h0dj --server http://192.168.1.10:8787

如果提示找不到 adrive，先按仓库 README 安装，再重试。
取回后请告诉我文件放在了哪里、里面有什么，等我确认后再使用。
```

## 命令

| 命令 | 说明 |
|---|---|
| `adrive init --username --password [--host] [--port] [--public-base] [--no-verify]` | 写配置；默认当场校验蓝奏云登录 |
| `adrive put <路径> [--name] [--server] [--follow-symlinks] [--json]` | 上传文件或目录（目录打 zip） |
| `adrive share <id> [--ttl 7d\|24h\|30m] [--off] [--server]` | 开/关匿名下载 |
| `adrive get <id> [--server] [-o 目录] [--force]` | 取回；本地同名文件默认不覆盖 |
| `adrive ls [--status active\|pending\|deleted\|all] [--limit] [--server]` | 列出资源 |
| `adrive rm <id>` | 删除资源（连蓝奏云对象一起删） |
| `adrive gc [--dry-run]` | 回收超时的未完成上传与过期墓碑 |

环境变量：`ADRIVE_SERVER`（服务地址）、`ADRIVE_TOKEN`（覆盖配置里的 token）。

## HTTP 接口

除 `/public/*` 与 `/health` 外都需要 `Authorization: Bearer <token>`（token 在 `config.json` 里，`init` 时会打印）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/HEAD | `/health` | 存活探针（含资源库结构检查，坏了返回 500） |
| POST | `/drive/init` | `{size, sha256?, name, kind?}` → `{resource_id, upload{url, parts, chunk_size, headers}}` |
| PUT | `/drive/{id}/blob[?part=N]` | 上传一片（≤ `chunk_bytes`） |
| POST | `/drive/commit` | `{resource_id}` → 转 active（幂等） |
| GET | `/drive?limit&status` | 列表 |
| POST | `/drive/ticket` | `{resource_id}` → 本人票据（15 分钟） |
| POST | `/public/drive/ticket` | 同上，无需鉴权，要求匿名未过期 |
| GET | `/public/drive/{id}/blob?exp&sig&scope=owner\|public` | 实际取回（HMAC 签名，三个参数都必填） |
| PUT | `/drive/{id}/anonymous` | `{"anonymous_ttl":"7d"}` 开 / `{"anonymous_ttl":""}` 关 |
| DELETE | `/drive/{id}` | 删除资源与蓝奏云对象 |
| POST | `/gc` | `{dry_run?, pending_ttl_h?, tombstone_days?}` 手动回收 |

### 错误码

| HTTP | error_code | 含义 |
|---|---|---|
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 401 | `UNAUTHORIZED` | 缺 token 或 token 不对 |
| 403 | `RESOURCE_NOT_SHARED` | 还没开匿名下载 |
| 403 | `SHARE_EXPIRED` | 匿名下载已过期 |
| 403 | `BAD_SCOPE` | 下载链接缺 `scope` 或取值不对 |
| 403 | —（只有 message） | 签名不对 |
| 404 | `RESOURCE_NOT_FOUND` | 资源不存在或已删除 |
| 404 | `NOT_FOUND` | 路径不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不对（响应头带 `Allow`） |
| 409 | `RESOURCE_NOT_READY` | 还没 commit |
| 409 | `PARTS_INCOMPLETE` | 分片没传完（message 列出缺哪几片） |
| 409 | `SIZE_MISMATCH` | 分片总字节与声明 size 不一致 |
| 409 | `ALREADY_COMMITTED` | 已 commit 还继续传分片 |
| 413 | `CHUNK_TOO_LARGE` / `PACK_TOO_LARGE` / `BODY_TOO_LARGE` | 单片/整体/请求体超限 |
| 422 | `INVALID_SIZE` `INVALID_SHA256` `INVALID_NAME` `INVALID_PART` `INVALID_TTL` `INVALID_LIMIT` `INVALID_STATUS` `EMPTY_BODY` | 参数不合法 |
| 500 | —（只有 message） | 蓝奏云登录/上传失败，看服务端 stdout 日志 |
| 500 | `STORE_BROKEN` | 资源库结构异常（`/health` 也会报） |
| 502 | `LANZOU_DOWNLOAD_FAILED` / `SHA_MISMATCH` | 蓝奏云下载失败 / 拼接后校验不过 |

## 大文件与任意格式

蓝奏云免费账号有两条硬限制：**单文件 ≤ 100MB**、**只允许白名单扩展名**。

**分片**：超过 `limits.chunk_bytes`（默认 95MB，留余量）就切开逐片上传，取回时按 index 排序拼接。

```
120MB 的文件 → <id>.p001.bin (95MB) + <id>.p002.bin (25MB)
取回：按序拼接 → 整文件 sha256 校验（init 时传了 sha256 才校验）
```

**格式伪装**：上传名统一是 `<id>.bin`（或 `<id>.p001.bin`），`.bin` 不在白名单，
所以存储层会给它追加两个随机白名单后缀（如 `.xpa.mobi`）。

```
蓝奏云里看到的：e3fPwHE2a6MQkyDkXmFzQ.p001.bin.xpa.mobi
原始文件名：报告.mp4（记在 resources.json 里，取回时按元数据还原）
```

也就是说**平台侧看不到你的真实文件名**，还原不依赖后缀解析。

## 运行与数据

- 服务是**前台进程**，`Ctrl-C` 停；常驻自己套 systemd / launchd / pm2
- 配置：`~/.config/adrive/config.json`（权限 600，**含蓝奏云密码明文**）
- 资源库：`~/.local/share/adrive/resources.json`（权限 664，含文件名与云端 file_id，注意备份）
- **单实例锁**：`~/.local/share/adrive/server.pid`。同一数据目录只能起一个服务（换端口也拦）；
  pid 陈旧或被别的进程复用时启动会被误拦，手工删掉这个文件即可
- **启动会自动回收**：`pending` 超过 24 小时的未完成上传会被**连蓝奏云对象一起删掉**；
  `deleted` 墓碑超过 7 天清掉。传了一半想保住，先 `commit` 或调 `/gc` 的参数

## 限制

- **内存**：上传/下载/分片拼接都是整包在内存里，峰值约为文件大小的 **4~6 倍**
  （120MB 实测：CLI ≈ 560MB，服务端 ≈ 720MB）。`max_bytes` 默认 2GB，小机器请调到内存的 1/5 左右
- **目录上传**：整个目录先读进内存再打 zip，超大目录可能在 `init` 之前就吃满内存
- **软链**：默认跳过并提示；`--follow-symlinks` 只跟随**指向文件**的软链，指向目录的一律跳过
- **并发**：CLI 串行上传分片。别同时跑多个 `adrive put` —— 蓝奏云对同账号并发上传敏感
- **票据**：下载票 15 分钟有效，但匿名分享一过期，链接立刻失效（票救不了）
- **接口稳定性**：依赖蓝奏云的内部接口，对方一改就可能失效，属于要跟着修适配层的活

## Python 版

`py/` 是首版实现（FastAPI + requests，元数据存 SQLite），命令与接口语义对齐，
但**不含**大文件分片与后缀伪装，也**不随 npm 包分发**。日常使用建议装 Node 版。

## 路线图 / 想收的 PR

- [ ] 流式上传/下载，把内存占用从「4~6 倍」降到常数级
- [ ] 断点续传：分片失败只重传该片（服务端已支持按 part 重传，CLI 还没暴露）
- [ ] 存储后端插件化（S3 / WebDAV / 本地目录）
- [ ] 资源访问口令（sensitive 内容不该只靠「不公开」）
- [ ] 一键常驻（systemd / launchd 模板）

## 贡献

欢迎 issue 和 PR。提 PR 前麻烦：

1. `npm test` 通过
2. 一个 PR 只做一件事（方便单独回滚）
3. 涉及蓝奏云接口的改动，在描述里贴一下脱敏后的请求/响应片段

## 免责

只做**你自己账号**的自动化，不绕过任何付费能力。使用前请确认符合蓝奏云的服务条款；
接口随时可能变化，坏了就是修一个适配层的活儿。作者不对账号风控、数据丢失负责。

## License

MIT
