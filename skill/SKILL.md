---
name: clone-it
description: CloneIt 浏览器插件 + 本地伴侣服务：把 GitHub 仓库 clone 到 references/<category>/<name>（默认浅克隆、最多 5 并发、自动重试、历史进度），自动识别当前页网址进行收藏（category=collection）或记录待克隆网站（category=clone）到 server/collected.json。提供一键安装脚本和后台服务管理脚本，统一支持配置文件、环境变量与命令行参数。当用户要安装 CloneIt 插件、启动/停止/重启/查看 CloneIt 后台服务、修改配置或设置开机自启，把 GitHub 仓库拉到 references、查看或重跑克隆任务、收藏文章地址或记录待克隆网站，或提到 clone-it / repo-cloner / 克隆仓库到 references 时使用。
---

# CloneIt

项目目录：`innate-tools/repo-cloner/`（下文命令都在这个目录执行）。依赖 Node.js ≥ 18、git、curl，零 npm 依赖。

## 安装

```bash
scripts/install.sh                                  # 检查依赖 → 后台启动服务 → 打开扩展页引导装插件
scripts/install.sh --autostart                      # 服务改为 launchd 开机自启（macOS）
scripts/install.sh --config my.json --browser edge  # 指定配置文件与浏览器
scripts/install.sh -- --mirror https://ghfast.top --proxy http://127.0.0.1:7890
```

插件装载必须由用户手动完成（浏览器不允许脚本静默安装）。脚本会打开 `chrome://extensions`、在 Finder 中选中 `extension/`、把路径复制到剪贴板。需要告诉用户：打开「开发者模式」，把文件夹拖进扩展页或点「加载已解压的扩展程序」，再到插件 options 点「测试连接」。

## 后台服务与配置

```bash
scripts/service.sh status                          # 先看状态；未运行时退出码为 1
scripts/service.sh start [--config FILE] [参数]    # nohup 后台启动，已运行则跳过
scripts/service.sh restart [参数] | stop | logs
scripts/service.sh enable [--config FILE] [参数]   # launchd 开机自启 + 崩溃拉起
scripts/service.sh disable                         # 取消自启；launchd 托管时 stop 会提示改用 disable
```

配置同时支持三层，优先级 **`命令行参数 > 环境变量 > 配置文件 > 默认值`**（`service.sh`、`install.sh`、HTTP 服务、CLI 共用 `server/core.mjs` 的同一套解析）：

- **配置文件**：默认读取 `cloneit.config.json`（不入库，可从 `cloneit.config.example.json` 复制；也可用 `--config FILE` 或 `CLONEIT_CONFIG` 指定）。字段：`workspace`（或数组 `workspaces`，相对路径相对配置文件目录解析）、`port`、`token`、`browser`、`mirror`、`proxy`、`maxConcurrent`、`retry`、`full`、`noPull`、`cloneTimeout`、`watchClipboard`。
- **环境变量**：`CLONEIT_CONFIG`、`CLONEIT_WORKSPACE`（`:` 分隔多个）、`CLONEIT_PORT`、`CLONEIT_TOKEN`、`CLONEIT_BROWSER`、`CLONEIT_MIRROR`、`CLONEIT_PROXY`、`CLONEIT_MAX_CONCURRENT`、`CLONEIT_RETRY`、`CLONEIT_FULL`、`CLONEIT_NO_PULL`、`CLONEIT_CLONE_TIMEOUT`、`CLONEIT_WATCH_CLIPBOARD`。
- **命令行参数**：`--config FILE`、`--workspace D`、`--port N`、`--token T`、`--browser B`（仅 `install.sh`）、`--mirror URL`、`--proxy URL`、`--max-concurrent N`、`--retry N`、`--full`、`--no-pull`、`--clone-timeout MS`、`--watch-clipboard`。
- 日志在 `.run/cloneit.log`；`enable` 写入 `~/Library/LaunchAgents/com.innate.cloneit.plist`（并固化当时的 `CLONEIT_*` 环境变量），这是唯一写到 `innate` 外部的文件，执行前要先征得用户同意。
- 修改 `cloneit.config.json` 后执行 `scripts/service.sh restart` 即生效；若修改命令行参数或 launchd 固化的环境变量则需重新 `enable`。

## CLI（不依赖服务，适合 agent 直接调用）

未配置 `workspace` 时默认用当前目录，所以在 `innate` 根执行（或在 `cloneit.config.json` / `CLONEIT_WORKSPACE` 指定 `innate` 根），clone 才会落到 `innate/references/`：

```bash
node innate-tools/repo-cloner/server/clone-it-cli.mjs clone https://github.com/owner/repo --category skills/agent [--name N] [--full] [--mirror URL]
node innate-tools/repo-cloner/server/clone-it-cli.mjs list [--category X]
node innate-tools/repo-cloner/server/clone-it-cli.mjs jobs [--limit 30]
node innate-tools/repo-cloner/server/clone-it-cli.mjs retry <job-id>
node innate-tools/repo-cloner/server/clone-it-cli.mjs collect <url> [--title T] [--note N]
node innate-tools/repo-cloner/server/clone-it-cli.mjs clone-website <url> [--name N] [--title T] [--note N]
node innate-tools/repo-cloner/server/clone-it-cli.mjs collected [--category collection|clone]
```

- 类别默认 `others`；目录已存在且 origin 相同时自动 `pull --ff-only`，origin 不同时返回 409。
- 仓库克隆历史在 `server/jobs.json`；收藏与待克隆网站统一保存在 `server/collected.json`，通过 `category` 区分（`collection` 收藏文章、`clone` 待克隆网站，带 `plannedPath` 与 `crawlStatus: "pending"`），CLI 和服务共用。

## 排查

- 插件显示离线：先跑 `scripts/service.sh status`，再看 `logs`，确认插件 options 里的地址和端口一致；设置了 token 时两边要相同。
- clone 慢或失败：配置 `mirror`（如 `https://ghfast.top`）或 `proxy`，并调大 `retry`。
- 端口被占用且 stop 提示「不是由本脚本启动」：找出占用进程手动结束，或改 `port` / `CLONEIT_PORT`。
