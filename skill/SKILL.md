---
name: repo-cloner
description: 一键把 GitHub 仓库 clone 到本仓 references/ 对应类别目录的浏览器插件 + 本地伴侣服务，带 clone 历史与进度 Tab，服务端支持最多 5 并发浅克隆（--depth=1）。当用户需要把 GitHub 仓库拉到本地 references 目录、收集开源参考仓、批量克隆仓库、查看克隆任务进度/历史、重跑失败的克隆任务，或提到 repo-cloner / 克隆仓库到 references / clone github repo 到本地时使用。同时覆盖浏览器插件模式（HTTP 伴侣服务 + 弹窗 Clone/历史进度 双 Tab）与终端 CLI 模式（同步执行、实时进度）。
---

# RepoCloner

RepoCloner 把「开终端 → 想类别目录 → 手敲 `git clone` → 网慢失败重来」这条链缩成一次点击。
UI 从 GitHub 页面发送命令到本地伴侣服务，服务端在后台执行 clone，**默认全部 `--depth=1` 浅克隆**，
**最多 5 个 clone 并发执行**（超出的排队），失败自动退避重试，每次克隆都记入历史，弹窗「历史 / 进度」Tab 实时展示进度条。

## 核心能力

- **UI → Server 命令通道**：浏览器插件从 GitHub 页面解析 repo，选择 workspace + 类别后 POST `/api/clone`，服务端后台异步入队执行。
- **并发队列（≤5）**：服务端最多同时执行 5 个 clone（`--max-concurrent`，默认 5），超出的排队等待；每任务失败自动退避重试（默认 3 次，2s/8s）。
- **浅层克隆**：所有 clone 默认 `--depth=1`（省时间、省空间），仅 `--full` 时克隆完整历史。
- **历史 / 进度 Tab**：弹窗顶部双 Tab —— 「Clone」Tab 负责发起克隆，「历史 / 进度」Tab 实时展示每个任务的状态图标、进度条、阶段百分比、完整命令、错误；进行中任务 2 秒轮询刷新。
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
node repo-cloner/server/repo-cloner-server.mjs
# 多 workspace / 令牌 / 调并发
node repo-cloner/server/repo-cloner-server.mjs --workspace D:/repo2 --workspace D:/repo3 --token secret --max-concurrent 3
```

### 2. 安装插件

`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `repo-cloner/extension/`。
打开 options 确认服务地址（默认 `http://127.0.0.1:7420`），点「测试连接」。

### 3. 使用

1. 打开 GitHub 仓库页 → 点图标或 `Alt+R`
2. **Clone Tab**：左上角选 workspace → 点选类别 chips → 点 **Clone**
3. **历史 / 进度 Tab**：实时查看进度条、状态、命令、错误；失败记录点「重跑」
4. 服务离线时点 Clone/复制命令 → 自动降级为复制 `git clone --depth=1 …` 到剪贴板

## CLI 用法（适合 AI 助手直接调用）

CLI 入口：`repo-cloner/server/repo-cloner-cli.mjs`

### 克隆仓库

```bash
# 最简：类别默认 others，仓库名取自 URL，浅克隆
node repo-cloner/server/repo-cloner-cli.mjs clone https://github.com/owner/repo

# 指定类别与名称
node repo-cloner/server/repo-cloner-cli.mjs clone https://github.com/owner/repo \
  --category skills/agent --name my-repo

# 完整历史（不加 --depth=1）
node repo-cloner/server/repo-cloner-cli.mjs clone https://github.com/owner/repo --full

# 慢网络：镜像 + 代理 + 加大重试
node repo-cloner/server/repo-cloner-cli.mjs clone https://github.com/owner/repo \
  --category skills --mirror https://ghfast.top --proxy http://127.0.0.1:7890 --retry 5
```

### 列出类别 / 已有仓

```bash
node repo-cloner/server/repo-cloner-cli.mjs list
node repo-cloner/server/repo-cloner-cli.mjs list --category skills/agent
```

### 查看克隆历史（含进度）

```bash
node repo-cloner/server/repo-cloner-cli.mjs jobs [--limit 30]
```

### 重跑失败任务

```bash
node repo-cloner/server/repo-cloner-cli.mjs retry <job-id>
```

### 启动 HTTP 伴侣服务

```bash
node repo-cloner/server/repo-cloner-cli.mjs server [--port 7420] [--token secret] [--max-concurrent 5] [--watch-clipboard]
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
| `--token T` | 访问令牌（仅 `server` 子命令） | 无 |
| `--watch-clipboard` | 监听剪贴板哨兵（仅 `server` 子命令） | 关 |

## 剪贴板哨兵（可选）

`server --watch-clipboard` 启动后，复制如下格式文本即触发克隆：

```
REPOCLONER://clone?workspace=ws0&category=skills/ui-ux&url=https://github.com/owner/repo
```

## 历史记录与重启

- 历史持久化在 `repo-cloner/server/jobs.json`（运行时文件，不入库）。
- 服务重启后自动恢复历史；重启时在跑的任务标记为失败，可用 `retry` 重跑。
- CLI `clone` 同步执行完成后也写入同一份 `jobs.json`，`jobs` 命令可查。

## 安全

- 服务仅绑定 `127.0.0.1`；克隆目标被约束在 workspace 的 `references/` 内（拒绝路径穿越）。
- 不加 `--token` 时仅校验请求来源；加 `--token` 后需带 `X-RepoCloner-Token` 头。
- 不采集、不外发任何数据。
