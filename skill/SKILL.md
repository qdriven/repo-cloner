---
name: clone-it
description: 一键把 GitHub 仓库 clone 到本仓 references/ 对应类别目录的浏览器插件 + 本地伴侣服务，同时支持收藏文章地址到本地文件（仅记录地址，爬取留空）与克隆网站入口（处理逻辑先留空，计划后续实现），带 clone 历史与进度 Tab，服务端支持最多 5 并发浅克隆（--depth=1）。当用户需要把 GitHub 仓库拉到本地 references 目录、收集开源参考仓、批量克隆仓库、查看克隆任务进度/历史、重跑失败的克隆任务，或记录文章地址到本地收藏、尝试克隆网站，或提到 clone-it / 克隆仓库到 references / clone github repo 到本地 / 收藏文章地址 / clone website 时使用。同时覆盖浏览器插件模式（HTTP 伴侣服务 + 弹窗 Clone/收藏/克隆网站/历史进度 四 Tab）与终端 CLI 模式（同步执行、实时进度）。
---

# CloneIt

CloneIt 把「开终端 → 想类别目录 → 手敲 `git clone` → 网慢失败重来」这条链缩成一次点击。
UI 从 GitHub 页面发送命令到本地伴侣服务，服务端在后台执行 clone，**默认全部 `--depth=1` 浅克隆**，
**最多 5 个 clone 并发执行**（超出的排队），失败自动退避重试，每次克隆都记入历史，弹窗「历史 / 进度」Tab 实时展示进度条。

除 GitHub clone 外，CloneIt 还提供两个功能模块：

- **收藏（collect）**：在任意文章页把文章地址（含标题/备注）记录到本地 `collected.json`。**只记录地址，爬取任务先留空**，计划后续实现。
- **克隆网站（clone-website）**：输入站点地址，本地化保存整站。**端点与规划已就位，处理逻辑先留空**，当前返回 501，计划后续直接实现。

## 核心能力

- **UI → Server 命令通道**：浏览器插件从 GitHub 页面解析 repo，选择 workspace + 类别后 POST `/api/clone`，服务端后台异步入队执行。
- **并发队列（≤5）**：服务端最多同时执行 5 个 clone（`--max-concurrent`，默认 5），超出的排队等待；每任务失败自动退避重试（默认 3 次，2s/8s）。
- **浅层克隆**：所有 clone 默认 `--depth=1`（省时间、省空间），仅 `--full` 时克隆完整历史。
- **历史 / 进度 Tab**：弹窗四 Tab —— 「Clone」发起克隆，「收藏」记录文章地址，「克隆网站」发起站点克隆，「历史 / 进度」实时展示每个任务的状态图标、进度条、阶段百分比、完整命令、错误；进行中任务 2 秒轮询刷新。
- **收藏：仅记录地址**：POST `/api/collect` 把文章地址写入本地 `collected.json`，URL 去重；爬取状态固定为 `pending`，内容抓取逻辑尚未实现。
- **克隆网站：处理留空**：POST `/api/clone-website` 校验地址并给出规划路径，实际克隆逻辑未实现，固定返回 501。
- **CLI 同步模式**：终端前台同步 clone，实时打印 git 进度，完成后记入同一份 `jobs.json`。
- **共享核心**：`server/core.mjs` 是唯一执行核心，CLI 与 HTTP 服务复用，行为完全一致。

## 前置条件

- Node.js ≥ 18（零依赖，无需 npm install）
- git 已安装并在 PATH 中
- 工作目录即为目标仓库（默认 workspace = 当前目录，克隆落到 `./references/<category>/<name>`）

## 浏览器插件模式（推荐）

需要 HTTP 伴侣服务 + Chrome/Edge 插件（MV3）。

### 1. 启动伴侣服务

```bash
node clone-it/server/clone-it-server.mjs
# 多 workspace / 令牌 / 调并发
node clone-it/server/clone-it-server.mjs --workspace D:/repo2 --workspace D:/repo3 --token secret --max-concurrent 3
```

### 2. 安装插件

`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `clone-it/extension/`。
打开 options 确认服务地址（默认 `http://127.0.0.1:7420`），点「测试连接」。

### 3. 使用

**GitHub clone**
1. 打开 GitHub 仓库页 → 点图标或 `Alt+R`
2. **Clone Tab**：左上角选 workspace → 点选类别 chips → 点 **Clone**
3. **历史 / 进度 Tab**：实时查看进度条、状态、命令、错误；失败记录点「重跑」
4. 服务离线时点 Clone/复制命令 → 自动降级为复制 `git clone --depth=1 …` 到剪贴板

**收藏文章**
1. 打开任意文章页（无需 GitHub）
2. **收藏 Tab**：自动读取当前页地址与标题，可补填标题/备注 → 点 **收藏**
3. 地址写入本地 `collected.json`；列表可刷新或删除

**克隆网站（待实现）**
1. **克隆网站 Tab**：输入站点地址（可选名称）→ 点 **克隆网站**
2. 当前返回「处理逻辑暂未实现，计划后续实现」并展示规划落盘路径

## CLI 用法（适合 AI 助手直接调用）

CLI 入口：`clone-it/server/clone-it-cli.mjs`

### 克隆仓库

```bash
# 最简：类别默认 others，仓库名取自 URL，浅克隆
node clone-it/server/clone-it-cli.mjs clone https://github.com/owner/repo

# 指定类别与名称
node clone-it/server/clone-it-cli.mjs clone https://github.com/owner/repo \
  --category skills/agent --name my-repo

# 完整历史（不加 --depth=1）
node clone-it/server/clone-it-cli.mjs clone https://github.com/owner/repo --full

# 慢网络：镜像 + 代理 + 加大重试
node clone-it/server/clone-it-cli.mjs clone https://github.com/owner/repo \
  --category skills --mirror https://ghfast.top --proxy http://127.0.0.1:7890 --retry 5
```

### 收藏文章地址（仅记录，爬取留空）

```bash
node clone-it/server/clone-it-cli.mjs collect https://example.com/article --title "标题" --note "备注"
node clone-it/server/clone-it-cli.mjs collected
```

### 克隆网站（当前为占位，返回未实现）

```bash
node clone-it/server/clone-it-cli.mjs clone-website https://example.com
```

### 列出类别 / 已有仓

```bash
node clone-it/server/clone-it-cli.mjs list
node clone-it/server/clone-it-cli.mjs list --category skills/agent
```

### 查看克隆历史（含进度）

```bash
node clone-it/server/clone-it-cli.mjs jobs [--limit 30]
```

### 重跑失败任务

```bash
node clone-it/server/clone-it-cli.mjs retry <job-id>
```

### 启动 HTTP 伴侣服务

```bash
node clone-it/server/clone-it-cli.mjs server [--port 7420] [--token secret] [--max-concurrent 5] [--watch-clipboard]
```

## CLI 选项速查

| 选项 | 说明 | 默认值 |
|---|---|---|
| `--category X` | 类别路径（多级用 `/`，如 `skills/agent`） | `others` |
| `--name N` | 仓库名（落盘目录名） | 取自 URL |
| `--workspace-id ws0` | 目标 workspace | 当前目录 (`ws0`) |
| `--full` | 不加 `--depth=1`，完整历史 | 关（浅克隆） |
| `--no-pull` | 已存在时不自动 pull，直接报错 | 关（自动 pull --ff-only） |
| `--retry N` | 自动重试次数 | `3` |
| `--mirror URL` | GitHub 加速镜像前缀 | 无 |
| `--proxy URL` | git HTTP(S) 代理 | 无 |
| `--max-concurrent N` | 服务端最大并发 clone 数（仅 `server` 子命令） | `5` |
| `--port N` | HTTP 服务端口（仅 `server` 子命令） | `7420` |
| `--token T` | 访问令牌（仅 `server` 子命令，请求头 `X-CloneIt-Token`） | 无 |
| `--watch-clipboard` | 监听剪贴板哨兵（仅 `server` 子命令） | 关 |
| `--title T` | 收藏标题（仅 `collect` 子命令） | 无 |
| `--note N` | 收藏备注（仅 `collect` 子命令） | 无 |
| `--source S` | 收藏来源（仅 `collect` 子命令） | 无 |

## 收藏与克隆网站的数据与状态

- 收藏记录持久化在 `clone-it/server/collected.json`（运行时文件，不入库）；每条含 `url/title/note/source/collectedAt/crawlStatus`，`crawlStatus` 固定为 `pending`。
- 克隆网站无独立记录文件，当前通过 API/CLI 返回 `501` 与规划路径 `references/websites/<name>`；处理逻辑实现后将复用历史与落盘结构。
- 服务重启后自动恢复历史；重启时在跑的任务标记为失败，可用 `retry` 重跑。
- CLI `clone` 同步执行完成后也写入同一份 `jobs.json`，`jobs` 命令可查。

## 剪贴板哨兵（可选）

`server --watch-clipboard` 启动后，复制如下格式文本即触发克隆：

```
CLONEIT://clone?workspace=ws0&category=skills/ui-ux&url=https://github.com/owner/repo
```

## 安全

- 服务仅绑定 `127.0.0.1`；克隆目标被约束在 workspace 的 `references/` 内（拒绝路径穿越）。
- 不加 `--token` 时仅校验请求来源；加 `--token` 后需带 `X-CloneIt-Token` 头。
- 收藏功能仅记录文章地址与可选标题/备注，不采集、不外发页面内容。
- 不采集、不外发任何数据。
