# RepoCloner — GitHub 一键 clone 插件 + 本地伴侣服务

在 GitHub 页面上直接把仓库 clone 到本仓 `references/` 对应类别目录的浏览器插件 +
本地伴侣服务。Chrome / Edge (Manifest V3)。由原 `repo-cloner`(核心 + CLI)与
`ref-dock`(扩展 + HTTP 服务)合并而成。

## 组成

```
repo-cloner/
├── server/                    本地伴侣服务 (零依赖 Node ≥ 18)
│   ├── core.mjs               共享核心：配置、git 执行、进度解析、并发队列、历史
│   ├── repo-cloner-server.mjs HTTP 服务 :7420 + 可选剪贴板监听
│   ├── repo-cloner-cli.mjs    CLI 入口 (同步 clone / list / jobs / retry / server)
│   └── jobs.json              历史记录 (运行时文件, 不入库)
├── extension/                 浏览器插件 (MV3, 无构建步骤, 纯静态)
│   ├── manifest.json
│   ├── popup.html/js/css      弹窗 UI (Clone tab + 历史/进度 tab)
│   ├── content.js             GitHub 页面注入 (识别 repo, 页面内快捷按钮)
│   ├── background.js          service worker (快捷键, 消息路由)
│   ├── options.html/js        设置 (服务地址, workspace 列表)
│   └── icons/                 16/32/48/128 PNG
├── tools/
│   └── make-icons.html        图标生成器 (浏览器打开, 点击下载 PNG)
├── skill/SKILL.md             技能描述
└── README.md
```

## 核心能力

- **UI 发送命令到 Server**：插件弹窗从 GitHub 页面解析 repo → 选择 workspace + 类别 → POST `/api/clone`,服务端后台执行。
- **并发队列**：服务端最多 **5 个 clone 同时执行**(`--max-concurrent`,默认 5),超出的排队等待;支持失败自动退避重试。
- **浅层克隆**：默认所有 clone 都是 **`--depth=1`** 浅克隆(省时间、省空间),加 `--full` 才克隆完整历史。
- **历史 / 进度 Tab**：弹窗「历史 / 进度」tab 实时展示每个任务的状态图标、进度条、阶段、命令、错误;进行中任务 2 秒轮询刷新。
- **CLI 同步模式**：终端前台同步 clone,实时打印 git 进度,完成后记入同一份 `jobs.json`。
- **共享核心**：`server/core.mjs` 是唯一执行核心,CLI 与 HTTP 服务复用,行为完全一致。

## 前置条件

- Node.js ≥ 18(零依赖,无需 `npm install`)
- git 已安装并在 PATH 中
- 工作目录即为目标仓库(默认 workspace = 当前目录,克隆落到 `./references/<category>/<name>`)

## 启动伴侣服务

```bash
# 默认以当前目录为 workspace(推荐在本仓根目录执行)
node repo-cloner/server/repo-cloner-server.mjs

# 多 workspace
node repo-cloner/server/repo-cloner-server.mjs --workspace D:/path/to/repo2 --workspace D:/path/to/repo3

# 可选:同时监听剪贴板哨兵
node repo-cloner/server/repo-cloner-server.mjs --watch-clipboard

# 可选:令牌校验(插件 options 里填同一个值)
node repo-cloner/server/repo-cloner-server.mjs --token mysecret

# 调并发上限(默认 5)
node repo-cloner/server/repo-cloner-server.mjs --max-concurrent 3
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

## 安装插件

1. Chrome/Edge 打开 `chrome://extensions` → 开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `repo-cloner/extension/`
3. 打开插件 options,确认服务地址(默认 `http://127.0.0.1:7420`),点「测试连接」

## 日常使用

1. 打开任意 `github.com/owner/repo` 页面
2. 点工具栏 RepoCloner 图标(或 `Alt+R`)
3. 左上角选 workspace → 点选类别 chips(`skills/ui-ux` 等,来自 references 实时目录)
4. **Clone** tab 点 **Clone** → 服务直接 `git clone --depth=1` 到 `references/<category>/<repo>`;已存在同源则 `git pull --ff-only`
5. **历史 / 进度** tab 实时查看所有任务的状态、进度条、命令、错误;失败的记录可一键「重跑」
6. 服务离线时点 Clone/复制命令 → 自动降级为复制 `git clone --depth=1 …` 到剪贴板

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Alt+R` | 打开 RepoCloner 弹窗 |

## API(调试用)

```
GET  /api/ping                     存活 + workspace 列表 + maxConcurrent
GET  /api/workspaces               workspace 详情
GET  /api/tree?workspace=ws0       references 类别目录实时树
GET  /api/registry?workspace=ws0   registry_references.yaml 解析结果
GET  /api/list?workspace=&category=  类别下已有仓
POST /api/clone                    {workspace, category, url, name?} → 202 入队
GET  /api/jobs                     {jobs, running, maxConcurrent} 历史记录
POST /api/retry                    {id} 重跑失败任务
```

## CLI 用法

CLI 入口:`repo-cloner/server/repo-cloner-cli.mjs`

```bash
# 同步 clone(前台执行,实时进度)
node repo-cloner/server/repo-cloner-cli.mjs clone https://github.com/owner/repo --category skills/ui-ux

# 列出类别 / 已有仓
node repo-cloner/server/repo-cloner-cli.mjs list [--category X]

# 查看克隆历史
node repo-cloner/server/repo-cloner-cli.mjs jobs [--limit 30]

# 重跑失败任务
node repo-cloner/server/repo-cloner-cli.mjs retry <job-id>

# 启动 HTTP 服务
node repo-cloner/server/repo-cloner-cli.mjs server [--port 7420] [--max-concurrent 5]
```

## 剪贴板哨兵(可选)

`server --watch-clipboard` 启动后,复制如下格式文本即触发克隆:

```
REPOCLONER://clone?workspace=ws0&category=skills/ui-ux&url=https://github.com/owner/repo
```

## 历史记录与重启

- 历史持久化在 `repo-cloner/server/jobs.json`(运行时文件,不入库)。
- 服务重启后自动恢复历史;重启时在跑的任务标记为失败,可用 `retry` 重跑。
- CLI `clone` 同步执行完成后也写入同一份 `jobs.json`,`jobs` 命令可查。

## 隐私 / 安全

- 服务仅绑定 loopback;clone 目标被约束在 workspace 的 `references/` 内(防路径穿越)。
- 不加 `--token` 时仅校验请求来源;加 `--token` 后需带 `X-RepoCloner-Token` 头。
- 不采集、不外发任何数据;GitHub 页面内容仅用于拼装 clone URL。
