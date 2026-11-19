# adrive

**给 AI agent 之间传文件的网盘。存储用你自己的蓝奏云账号，零第三方对象存储。**

一个 agent 想把手上的文件交给另一个 agent（或另一台机器上的程序），最麻烦的从来不是传输，
而是"怎么把文件交出去、对方怎么可靠地取回、什么时候该收回"。`adrive` 把这套做成一条命令：

```bash
# 发送方
adrive put ./build.zip
adrive share <resource_id> --ttl 7d

# 接收方（另一台机器 / 另一个 agent）
adrive get <resource_id> -o ./downloads
```

整套语义是「两段式上传 + 短期下载票」：`init → 上传 → commit → ticket → 匿名分享`。
区别只有一个——**存储后端换成蓝奏云**，文件不落在任何第三方对象存储里。

- 零运行时依赖（Node ≥ 20，只用内置模块）
- **超过 95MB 自动分片上传，取回时按序合并**（蓝奏云单文件 100MB 上限）
- **任意格式都能传**：扩展名不在白名单时自动伪装后缀，取回时还原
- 单文件直传不打 zip（目录才打包）
- 匿名下载可开关、可限时（最长 7 天），到期自动失效
- 全程 sha256 校验、路径穿越防护

## 架构

```
发送方                           adrive 服务                     蓝奏云
  │  POST /drive/init               │                              │
  │ ─────────────────────────────►  │  发 resource_id + 上传地址     │
  │  PUT /drive/{id}/blob (zip)     │                              │
  │ ─────────────────────────────►  │ ── html5up.php ────────────► │
  │  POST /drive/commit             │                              │
  │ ─────────────────────────────►  │  落库，资源 active             │
  │                                                                 │
接收方                                                               │
  │  POST /public/drive/ticket      │                              │
  │ ─────────────────────────────►  │ 校验 anonymous_until → 签 URL │
  │  GET  /public/drive/{id}/blob   │                              │
  │ ─────────────────────────────►  │ ── 分享页→iframe→ajaxfile ──► │
```

没有预签名直传（蓝奏云不提供），所以上传/下载都经由本服务中转。好处是接收方只需要 `resource_id`，
不需要账号、不需要知道蓝奏云；坏处是带宽走你自己的机器。

## 安装

```bash
# 方式一：直接从 GitHub 全局安装（推荐）
npm install -g github:yaoxiaolinglong/adrive

# 方式二：克隆后本地安装
git clone https://github.com/yaoxiaolinglong/adrive.git
cd adrive && npm install -g .

# 方式三：不安装，临时跑
npx github:yaoxiaolinglong/adrive ls
```

> `@yxll/adrive` 尚未发布到 npm registry，先把 GitHub 作为分发渠道。

## 快速开始

```bash
# 1. 写入配置（会生成 API token，存在 ~/.config/adrive/config.json，权限 600）
adrive init --username <蓝奏云账号> --password <蓝奏云密码>

# 2. 起服务（默认 127.0.0.1:8787，前台运行，Ctrl-C 停）
adrive-server
# 从源码目录启动则是：node server.js

# 3. 传东西
adrive put ./report.pdf
adrive share <resource_id> --ttl 7d
```

**接收方在另一台机器上时，要告诉它你的服务地址**（`--server` 或环境变量 `ADRIVE_SERVER`）：

```bash
adrive get <resource_id> --server http://192.168.1.10:8787 -o ./downloads
```

`adrive share` 会打印一段给接收方 agent 的交接文案，原样转发即可：

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
| `adrive init --username --password [--public-base] [--port]` | 写配置 |
| `adrive put <路径> [--name] [--json]` | 上传文件或目录（目录自动打包） |
| `adrive share <id> [--ttl 7d] [--off]` | 开/关匿名下载（上限 7 天） |
| `adrive get <id> [--server URL] [-o 目录]` | 取回；接收方用 `--server` 指向发布方，不需要账号 |
| `adrive ls [--limit]` | 列出我的资源 |
| `adrive rm <id>` | 删除资源（连蓝奏云对象一起删） |

### 错误码

| HTTP | error_code | 含义 |
|---|---|---|
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 401 | `UNAUTHORIZED` | 缺 token 或 token 不对 |
| 403 | `RESOURCE_NOT_SHARED` | 还没开匿名下载 |
| 403 | `SHARE_EXPIRED` | 匿名下载已过期 |
| 403 | `BAD_SCOPE` / 签名不符 | 下载链接签名无效 |
| 404 | `RESOURCE_NOT_FOUND` | 资源不存在或已删除 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不对（响应头带 `Allow`） |
| 409 | `RESOURCE_NOT_READY` | 还没 commit |
| 409 | `PARTS_INCOMPLETE` | 分片没传完（message 里列出缺哪几片） |
| 409 | `SIZE_MISMATCH` | 分片总字节与声明的 size 不一致 |
| 409 | `ALREADY_COMMITTED` | 已 commit 还继续传分片 |
| 413 | `CHUNK_TOO_LARGE` / `PACK_TOO_LARGE` | 单片或整体超限 |
| 422 | `INVALID_*` | 参数不合法（size/sha256/name/part/ttl/limit） |
| 502 | `LANZOU_*` | 蓝奏云侧失败（上传/下载/校验） |

## 运行与数据

- 服务是**前台进程**，`Ctrl-C` 停；要常驻自己套 systemd / launchd / pm2
- 资源元数据在 `~/.local/share/adrive/resources.json`（备份或彻底清空就动这个文件）
- 配置在 `~/.config/adrive/config.json`，**里面有蓝奏云密码明文**（文件权限 600），别整目录打包外发

## HTTP 接口

除 `/public/*` 与 `/health` 外都需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活探针 |
| POST | `/drive/init` | `{size, sha256, name, kind}` → `{resource_id, upload{url, parts, chunk_size, headers}}` |
| PUT | `/drive/{id}/blob[?part=N]` | 上传一片（单片 ≤ `chunk_bytes`） |
| POST | `/drive/commit` | `{resource_id}` → 资源转 active |
| GET | `/drive?limit&status` | 列表 |
| POST | `/drive/ticket` | `{resource_id}` → 本人下载票据（15 分钟） |
| POST | `/public/drive/ticket` | 同上，但无需鉴权、要求匿名未过期 |
| GET | `/public/drive/{id}/blob?exp&sig` | 实际取回（HMAC 签名 URL） |
| PUT | `/drive/{id}/anonymous` | `{"anonymous_ttl":"7d"}` 开启 / `""` 关闭 |
| DELETE | `/drive/{id}` | 删除资源与蓝奏云对象 |

## 大文件与任意格式

蓝奏云免费账号有两条硬限制：**单文件 ≤ 100MB**、**只允许白名单扩展名**。`adrive` 用两招绕开（思路来自开源项目
[lanzouyun-disk](https://github.com/zaxtyson/LanZouCloud-API) 同类实现的实测经验）：

**① 分片**

```
120MB 的文件
  ├─ <id>.p001.bin  (95MB)   ← 每片单独上传
  └─ <id>.p002.bin  (25MB)
取回时按 index 排序 → 顺序拼接 → 校验整文件 sha256
```

分片大小可配（`limits.chunk_bytes`，默认 95MB，留出余量），总上限 `limits.max_bytes`（默认 2GB）。
单片和整文件都有 sha256 校验，拼错一个字节就会报 `SHA_MISMATCH`。

**② 格式伪装**

上传前检查扩展名，不在白名单就在末尾追加两个白名单后缀（随机取自 `ct / ke / cfg / lgezi …`）：

```
报告.mp4   →  报告.mp4.cfg.lua     （蓝奏云看到的只是 .lua，允许）
下载还原：报告.mp4
```

判定规则：末尾两个扩展名**都**在白名单、且剥掉后仍带扩展名，才算伪装过——避免误伤正常的
`a.tar.gz` 这类文件名。

## 蓝奏云适配：踩过的坑

这些都已在 `lib/lanzou.js` 里处理，写出来给后来人：

1. **登录有 WAF**：`accounts.woozooo.com` 会返回阿里云 `acw_sc__v2` JS 挑战。算法公开，
   本地算 cookie 即可，不需要浏览器（`acwCookie()`）。
2. **登录是两段式**：`POST /accounts.php`（`task=uselogin`）返回 `{zt:1, msgs:<中转 URL>}`，
   必须再 GET 那个中转 URL，`phpdisk_info` 才生效。
3. **工作区在 iframe 里**：`mydisk.php` → iframe → 页面脚本里找 `/doupload.php?uid=<uid>`，
   之后所有操作打这个入口（`task: 5` 列文件、`task: 47` 列目录、`task: 22` 取分享、`task: 6` 删除）。
4. **上传**：`POST /html5up.php`，multipart 字段固定为
   `task=1, vie=2, ve=2, lastModifiedDate, type, id=WU_FILE_0, folder_id_bb_n, size, name, upload_file`。
   响应 `text[0]` 里的 `is_newd` + `f_id` 拼起来就是分享链接。
5. **下载三跳**：分享页 → iframe → `apifile.woozooo.com/ajaxfile.php`（需 `ajaxdata` / `wp_sign`）
   → `dom/file/<url>`，这一跳可能再吃一次 acw 挑战，甚至落到验证页（再 POST `ajax.php` 拿真链）。
6. **限额**：免费账号单文件 100MB → 由分片解决（见上一节）；白名单外扩展名 → 由伪装解决。
7. **二进制千万别用 `res.text()`**：会被 UTF-8 解码毁掉字节，必须走 `arrayBuffer()`。
   这个 bug 在自测里表现为「拼接后 sha256 不一致」，排查过一次。


## Python 版

`py/` 下是功能等价的首版实现（FastAPI + requests），逻辑与新版本一一对应。
保持可用，但新功能优先在 Node 版开发。

## 路线图 / 想收的 PR

- [ ] 并发上传限流 + 断点续传（蓝奏云风控敏感，需要节流策略）
- [ ] 断点续传：分片失败只重传该片（目前整轮重来）
- [ ] 直链模式：短时预签名直连蓝奏云 CDN，减轻服务端带宽
- [ ] 存储后端插件化（S3 / WebDAV / 本地目录）
- [ ] 资源访问口令（sensitive 内容不该只靠"不公开"）
- [ ] Windows / macOS 的一键常驻（systemd / launchd / 计划任务）
- [ ] 更完善的 e2e 测试（当前只有 zip 单测）

## 贡献

欢迎 issue 和 PR。提 PR 前麻烦：

1. `npm test` 通过
2. 一个 PR 只做一件事（方便单独回滚）
3. 涉及蓝奏云接口的改动，请在描述里贴一下抓到的请求/响应片段（脱敏）

## 免责

本项目只做**你自己账号**的自动化，不绕过任何付费能力。使用前请确认符合蓝奏云的服务条款；
接口随时可能变化，坏了就是修一个适配层的活儿。作者不对账号风控、数据丢失负责。

## 限制（重要）

- **内存**：上传/下载/分片拼接都是整包在内存里（服务端 `Buffer.concat`，CLI `arrayBuffer`）。
  实测 120MB 没问题；接近 `max_bytes`（默认 2GB）时请按机器内存调低，或等流式实现。
- **单进程**：状态在 `resources.json`，没有多实例锁。别对同一个 `~/.local/share/adrive` 起两个服务。
- **软链**：默认跳过（会打印提示），`--follow-symlinks` 才跟随；跟随等于把链接目标内容发出去，自己确认。
- **空目录**：会保留（zip 里有目录条目）。
- **并发**：CLI 串行上传分片，别同时跑多个 `adrive put` —— 蓝奏云对同账号并发上传很敏感。
- **接口稳定性**：依赖蓝奏云的内部接口，对方一改就可能失效，属于要跟着修适配层的活。

## 致谢

- 分片与后缀伪装的思路来自本机开源项目 `lanzouyun-disk` 的实测经验
- 接口语义参考了 agent 间文件交接的常见做法：两段式上传 + 短期签名下载票

## License

MIT
