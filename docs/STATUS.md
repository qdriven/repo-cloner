# KeepIt 当前状态（Status）

> 更新于 2026-11-28，对应版本 v0.4（改名 KeepIt 之后的第一个版本）。
> 待办清单见 [TODO.md](TODO.md)。

## 已完成、可用的功能

### GitHub 仓库克隆（核心功能，已稳定）

- **插件 Clone tab**：在 GitHub 仓库页按 `Alt+R`，选 workspace 与类别（类别树实时读取自 workspace 的 `references/` 目录），点 Clone 入队。
- **本地 HTTP 服务**（`server/keepit-server.mjs`，默认 `127.0.0.1:7420`）：
  - 异步任务队列，最多 5 个并发 clone（`--max-concurrent`）；
  - 单任务自动重试（默认 3 次，指数退避 2s/4s…）；
  - git `--progress` 实时解析，历史/进度在插件「历史 / 进度」tab 2 秒轮询；
  - 目标目录已存在且 origin 相同时自动改为 `pull --ff-only`，origin 不同时报 409；
  - 服务重启时在途任务标记为 failed，可一键重跑；
  - 支持 `--mirror`（GitHub 镜像前缀）、`--proxy`（git 代理）、`--token`（请求头 `X-KeepIt-Token`）、`--no-pull`、`--full`、`--clone-timeout`。
- **CLI**（`server/keepit-cli.mjs`）：`clone / list / jobs / retry / collect / collected / clone-website / server`，与服务共用 `server/core.mjs`，历史同写 `server/jobs.json`。适合 agent 直接调用。
- **安装与服务管理**：`scripts/install.sh` 一键安装（依赖检查 → 后台启动 → 引导装插件）；`scripts/service.sh start/stop/status/logs/restart/enable/disable`，macOS 支持 launchd 开机自启 + 崩溃拉起（`com.innate.keepit.plist`）。
- **安全**：只监听 `127.0.0.1`；带 Origin 的请求只放行浏览器扩展；clone 目标限制在 workspace 的 `references/` 内（含路径穿越防护）。

### 稍后读 / 克隆网站（记录功能可用，处理逻辑待实现）

两条记录通道都写入 `server/collected.json`，用 `category` 区分，均带 `crawlStatus: "pending"`：

| category | 插件入口 | 目前做到 | 还没做 |
|---|---|---|---|
| `collection`（稍后读） | 任意页面 → 「稍后读」tab | 记录 url、标题、备注、时间；列表筛选/删除 | 抓取正文、离线阅读、已读管理 |
| `clone`（克隆网站） | 任意页面 → 「克隆网站」tab | 记录 url、站点名、workspace、规划路径 `references/websites/<name>` | 真正的整站抓取落盘 |

### 视频文档流水线（本地）

`docs/intro-deck/`（8 页讲解片 + 实操动画）与 `docs/promo-film/`（6 幕宣传片）为纯代码驱动的 Video-as-Code 流水线（Headless Chrome CDP 逐帧捕获 + TTS + ffmpeg）。**构建产物（`build/` 下的 mp4/mp3/png）只保留在本地，已加入 `.gitignore`，不会提交到 GitHub。**

## 本次改名（keepit → KeepIt）已覆盖

- 仓库与品牌名：KeepIt → **KeepIt**；GitHub 远端仓库 `qdriven/repo-cloner` → `qdriven/keepit`。
- 扩展：`manifest.json`（名称、`open-keepit` 快捷键命令）、popup/options/content/background、token 头 `X-KeepIt-Token`。
- 服务与 CLI：`server/keepit-server.mjs`、`server/keepit-cli.mjs`、日志前缀 `[keepit]`、剪贴板哨兵 `KEEPIT://clone?...`。
- 配置：`keepit.config.json`（模板 `keepit.config.example.json`）、环境变量前缀 `KEEPIT_*`。
- 脚本：`scripts/service.sh`（pid/log 文件名、launchd label `com.innate.keepit`）、`scripts/install.sh`。
- 数据文件名不变：`server/jobs.json`、`server/collected.json`（内部 category 值 `collection` / `clone` 不变，仅 UI 文案改为「稍后读」）。

### 改名后的迁移清单（本地一次性操作）

1. 若本地已有旧配置：`mv keepit.config.json keepit.config.json`；
2. 重新执行 `scripts/service.sh enable`（或 `restart`），让 launchd plist 与服务进程换用新名字；
3. 在 `chrome://extensions` 重新加载本地扩展目录（名称会变为 KeepIt）；
4. 插件 options 里无需改动（服务地址没变）；若配置了 token，保持两边一致即可。

## 架构一览

```
浏览器扩展 (MV3, Alt+R)
  ├── Clone tab      → POST /api/clone          ─┐
  ├── 稍后读 tab      → POST /api/collect         ├→ 127.0.0.1:7420  server/keepit-server.mjs
  ├── 克隆网站 tab    → POST /api/clone-website  ─┘        │
  └── 历史/进度 tab   → GET  /api/jobs                     ├→ git clone --depth=1 → <workspace>/references/<category>/<name>
                                                            ├→ server/jobs.json       （克隆历史）
                                                            └→ server/collected.json  （稍后读 + 待克隆网站）

CLI server/keepit-cli.mjs ── 同一套 core.mjs，可直接调用，无需服务在跑
```
