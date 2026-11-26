# CloneIt — GitHub clone / 收藏文章 / 克隆网站 插件 + 本地伴侣服务

在 GitHub 页面上直接把仓库 clone 到本仓 `references/` 对应类别目录，
在任意文章页一键收藏地址到本地文件，并提供克隆网站（clone-website）入口。
Chrome / Edge (Manifest V3)。由原 `repo-cloner` 升级为 **clone-it**，新增收藏与克隆网站两个功能模块。

## 功能总览

| 功能 | 说明 | 状态 |
|------|------|------|
| **GitHub clone** | 从 GitHub 页面解析 repo，一键 clone 到 `references/<category>/<name>`，支持并发、浅克隆、重试、历史进度 | ✅ 已实现 |
| **收藏 (collect)** | 在任意页面看到文章后，记录文章地址（含标题/备注）到本地 `collected.json`；爬取任务留空，计划后续实现 | ✅ 记录已实现，爬取待做 |
| **克隆网站 (clone-website)** | 输入站点地址，本地化保存整站；处理逻辑先留空，计划后续实现 | ⏳ 端点与规划就位，处理待做 |

## 组成

```
clone-it/
├── server/                    本地伴侣服务 (零依赖 Node ≥ 18)
│   ├── core.mjs               共享核心：配置、git 执行、进度解析、并发队列、历史、
│   │                           收藏存储、clone-website 占位、URL 校验
│   ├── clone-it-server.mjs    HTTP 服务 :7420 + 可选剪贴板监听 + 全部 API 路由
│   ├── clone-it-cli.mjs       CLI 入口 (clone / list / jobs / retry / server /
│   │                            collect / collected / clone-website)
│   ├── jobs.json              克隆历史 (运行时文件, 不入库)
│   └── collected.json         收藏记录 (运行时文件, 不入库)
├── extension/                 浏览器插件 (MV3, 无构建步骤, 纯静态)
│   ├── manifest.json
│   ├── popup.html/js/css      弹窗 UI (Clone / 收藏 / 克隆网站 / 历史·进度 四 Tab)
│   ├── content.js             GitHub 页面注入 (识别 repo, 页面内快捷按钮)
│   ├── background.js          service worker (快捷键, 消息路由)
│   ├── options.html/js        设置 (服务地址, workspace 列表)
│   └── icons/                 16/32/48/128 PNG
├── tools/
│   ├── make-icons.html        图标生成器 (浏览器打开, 点击下载 PNG)
│   ├── _rebrand*.py           改造辅助脚本 (品牌统一, 可按需保留)
├── skill/SKILL.md             技能描述
└── README.md
```

## 核心能力

### 1. GitHub clone（已实现，保持原行为）

- **UI 发送命令到 Server**：插件弹窗从 GitHub 页面解析 repo → 选择 workspace + 类别 → POST `/api/clone`,服务端后台执行。
- **并发队列**：服务端最多 **5 个 clone 同时执行**(`--max-concurrent`,默认 5),超出的排队等待;支持失败自动退避重试。
- **浅层克隆**：默认所有 clone 都是 **`--depth=1`** 浅克隆(省时间、省空间),加 `--full` 才克隆完整历史。
- **历史 / 进度 Tab**：弹窗「历史 / 进度」tab 实时展示每个任务的状态图标、进度条、阶段、命令、错误;进行中任务 2 秒轮询刷新。
- **CLI 同步模式**：终端前台同步 clone,实时打印 git 进度,完成后记入同一份 `jobs.json`。
- **共享核心**：`server/core.mjs` 是唯一执行核心,CLI 与 HTTP 服务复用,行为完全一致。

### 2. 收藏（记录文章地址，爬取留空）

- **后端记录**：看到文章后，把文章地址（含可选标题、备注）记录到本地 `server/collected.json`，不采集内容。
- **爬取任务先留空**：每条收藏记录带 `crawlStatus: "pending"`，实际的内容抓取/解析逻辑尚未实现，计划后续补全。
- **当前接口**：
  - `POST /api/collect` — 记录一条收藏（URL 去重，重复返回 409）
  - `GET /api/collected` — 列出全部收藏
  - `POST /api/collect/remove` — 删除一条收藏
- **前端**：弹窗「收藏」Tab 自动读取当前标签页地址与标题，一键收藏，列表可刷新与删除。

### 3. 克隆网站（端点就位，处理留空）

- **端点与记录已就位**：`POST /api/clone-website` 已接入，负责地址校验与规划落盘路径。
- **处理逻辑先留空**：实际的网站克隆（下载、镜像、静态化）尚未实现，当前固定返回 `501 Not Implemented`，计划后续直接实现。
- **当前行为**：返回 `notImplemented: true` 与 `plannedPath`（规划路径 `references/websites/<name>`），供前端展示与后续接入。

## 前置条件

- Node.js ≥ 18(零依赖,无需 `npm install`)
- git 已安装并在 PATH 中
- 工作目录即为目标仓库(默认 workspace = 当前目录,克隆落到 `./references/<category>/<name>`)

## 启动伴侣服务

```bash
# 默认以当前目录为 workspace(推荐在本仓根目录执行)
node clone-it/server/clone-it-server.mjs

# 多 workspace
node clone-it/server/clone-it-server.mjs --workspace D:/path/to/repo2 --workspace D:/path/to/repo3

# 可选:同时监听剪贴板哨兵
node clone-it/server/clone-it-server.mjs --watch-clipboard

# 可选:令牌校验(插件 options 里填同一个值)
node clone-it/server/clone-it-server.mjs --token mysecret

# 调并发上限(默认 5)
node clone-it/server/clone-it-server.mjs --max-concurrent 3
```

服务绑定 `127.0.0.1:7420`,看到 `listening` 即就绪。

### 稳定性参数(慢网络建议)

```bash
--mirror https://ghfast.top        # GitHub 加速镜像前缀 (clone/pull 都走镜像)
--proxy http://127.0.0.1:7890      # 走本地代理 (注入 git -c http.proxy=…)
--retry 5                          # 每个任务自动重试次数 (默认 3, 2s/8s 退避)
--full                             # 不加 --depth=1, 完整历史 (默认浅克隆)
--clone-timeout 1800000            # 显式超时 ms (默认 0 = 无超时, 跑到结束为止)
```

### 下载地址（镜像源）配置

CloneIt **没有独立配置文件**，所有配置均通过启动 server 时的命令行参数指定。其中"下载地址"即 git clone 的源 URL 前缀，由 `--mirror` 参数控制。

**代码位置**：`clone-it/server/core.mjs:54`（`cfg.mirror`），在 `core.mjs:72-77` 的 `netArgs()` 函数中生效。

**工作原理**：当 `--mirror` 配置后，clone/pull 时所有 `https://github.com/...` 地址会被替换为 `<mirror>/https://github.com/...`：

```
--mirror https://ghfast.top
输入:  https://github.com/owner/repo
实际:  https://ghfast.top/https://github.com/owner/repo
```

**启动时配置示例**：

```bash
# 直连 GitHub（不配置 mirror，默认行为）
node clone-it/server/clone-it-server.mjs

# 配置镜像加速
node clone-it/server/clone-it-server.mjs --mirror https://ghfast.top

# 镜像 + 代理 + 自定义端口
node clone-it/server/clone-it-server.mjs \
  --mirror https://ghfast.top \
  --proxy http://127.0.0.1:7890 \
  --port 7420 \
  --workspace D:/your/repo
```

**CLI 同步模式同样支持**：

```bash
node clone-it/server/clone-it-cli.mjs clone https://github.com/owner/repo \
  --category skills --mirror https://ghfast.top
```

> 注意：`--mirror` 仅对 `https://github.com/` 开头的 URL 生效，其他域名仓库不会被替换。

## 安装插件

1. Chrome/Edge 打开 `chrome://extensions` → 开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `clone-it/extension/`
3. 打开插件 options,确认服务地址(默认 `http://127.0.0.1:7420`),点「测试连接」

## 日常使用

### GitHub clone

1. 打开任意 `github.com/owner/repo` 页面
2. 点工具栏 CloneIt 图标(或 `Alt+R`)
3. **Clone** tab：左上角选 workspace → 点选类别 chips(`skills/ui-ux` 等,来自 references 实时目录)
4. 点 **Clone** → 服务直接 `git clone --depth=1` 到 `references/<category>/<repo>`;已存在同源则 `git pull --ff-only`
5. **历史 / 进度** tab 实时查看所有任务的状态、进度条、命令、错误;失败的记录可一键「重跑」
6. 服务离线时点 Clone/复制命令 → 自动降级为复制 `git clone --depth=1 …` 到剪贴板

### 收藏文章

1. 打开任意文章页（无需 GitHub）
2. 点工具栏 CloneIt 图标，切到 **收藏** Tab
3. 弹窗自动读取当前页地址与标题，可补填标题/备注
4. 点 **收藏** → 地址写入本地 `collected.json`（爬取任务暂未实现，仅记录）
5. 列表可 **刷新** 或 **删除** 某条收藏

### 克隆网站（待实现）

1. 切到 **克隆网站** Tab
2. 输入站点地址（可选名称）
3. 点 **克隆网站** → 当前返回「处理逻辑暂未实现，计划后续实现」，并展示规划落盘路径

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Alt+R` | 打开 CloneIt 弹窗 |

## API（调试用）

```
GET  /api/ping                     存活 + workspace 列表 + maxConcurrent
GET  /api/workspaces               workspace 详情
GET  /api/tree?workspace=ws0       references 类别目录实时树
GET  /api/registry?workspace=ws0   registry_references.yaml 解析结果
GET  /api/list?workspace=&category=  类别下已有仓
POST /api/clone                    {workspace, category, url, name?} → 202 入队
GET  /api/jobs                     {jobs, running, maxConcurrent} 克隆历史
POST /api/retry                    {id} 重跑失败任务

# 收藏（记录地址，爬取留空）
GET  /api/collected                { collected: [...] }
POST /api/collect                  {url, title?, note?, source?} → 201（重复 409）
POST /api/collect/remove           {id} 删除一条收藏

# 克隆网站（处理逻辑留空，计划后续实现）
POST /api/clone-website            {workspace, url, name?} → 501 Not Implemented
```

## CLI 用法

CLI 入口:`clone-it/server/clone-it-cli.mjs`

```bash
# 同步 clone（前台执行，实时进度）
node clone-it/server/clone-it-cli.mjs clone https://github.com/owner/repo --category skills/ui-ux

# 列出类别 / 已有仓
node clone-it/server/clone-it-cli.mjs list [--category X]

# 查看克隆历史
node clone-it/server/clone-it-cli.mjs jobs [--limit 30]

# 重跑失败任务
node clone-it/server/clone-it-cli.mjs retry <job-id>

# 收藏一条文章地址（爬取留空）
node clone-it/server/clone-it-cli.mjs collect https://example.com/article --title "标题" --note "备注"

# 列出收藏
node clone-it/server/clone-it-cli.mjs collected

# 克隆网站（当前为占位，返回未实现）
node clone-it/server/clone-it-cli.mjs clone-website https://example.com

# 启动 HTTP 服务
node clone-it/server/clone-it-cli.mjs server [--port 7420] [--max-concurrent 5]
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

## 剪贴板哨兵（可选）

`server --watch-clipboard` 启动后，复制如下格式文本即触发克隆：

```
CLONEIT://clone?workspace=ws0&category=skills/ui-ux&url=https://github.com/owner/repo
```

## 历史记录与重启

- 克隆历史持久化在 `clone-it/server/jobs.json`（运行时文件，不入库）。
- 收藏记录持久化在 `clone-it/server/collected.json`（运行时文件，不入库）。
- 服务重启后自动恢复历史；重启时在跑的任务标记为失败，可用 `retry` 重跑。
- CLI `clone` 同步执行完成后也写入同一份 `jobs.json`，`jobs` 命令可查。

## 隐私 / 安全

- 服务仅绑定 loopback；clone 目标被约束在 workspace 的 `references/` 内（防路径穿越）。
- 不加 `--token` 时仅校验请求来源；加 `--token` 后需带 `X-CloneIt-Token` 头。
- 收藏功能仅记录文章地址与可选标题/备注，不采集、不外发任何页面内容。
- 不采集、不外发任何数据；GitHub 页面内容仅用于拼装 clone URL。
