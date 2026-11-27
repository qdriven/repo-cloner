# CloneIt

浏览器插件 + 本地伴侣服务（Chrome / Edge，MV3）：

- **GitHub clone**：在仓库页一键 clone 到 `references/<category>/<name>`，默认 `--depth=1`，最多 5 个并发，失败自动重试，有历史和进度。
- **收藏**：把当前文章地址记到本地 `server/collected.json`（只记地址，抓取内容还没做）。
- **克隆网站**：接口已经有了，实际下载逻辑还没写，目前返回 `501`。

零依赖，需要 Node.js ≥ 18、git、curl。

## 一键安装

```bash
scripts/install.sh                                  # 检查依赖 → 后台启动服务 → 打开扩展页引导装插件
scripts/install.sh --autostart                      # 改用 launchd 开机自启（macOS）
scripts/install.sh --config my.json --browser edge  # 指定配置文件与浏览器
scripts/install.sh -- --mirror https://ghfast.top   # "--" 之后的参数原样传给 server
```

浏览器不允许脚本静默安装解压版插件。脚本会打开 `chrome://extensions`，在 Finder 里选中 `extension/` 目录，并把路径复制到剪贴板。之后在扩展页打开「开发者模式」，把文件夹拖进去（或点「加载已解压的扩展程序」）即可。

## 后台服务与配置

```bash
scripts/service.sh start [--config FILE] [server 参数]   # nohup 后台启动
scripts/service.sh status | logs | restart | stop
scripts/service.sh enable [--config FILE] [server 参数]  # launchd 开机自启 + 崩溃自动拉起（macOS）
scripts/service.sh disable
```

所有配置同时支持 **配置文件**、**环境变量**、**命令行参数**，优先级：`命令行参数 > 环境变量 > 配置文件 > 默认值`。
默认读取项目根目录的 `cloneit.config.json`（不存在则跳过，可从 `cloneit.config.example.json` 复制；也可用 `--config FILE` 或 `CLONEIT_CONFIG` 指定路径）。

| 配置文件字段 | 环境变量 | 命令行参数 | 说明 | 默认 |
|---|---|---|---|---|
| `workspace` / `workspaces` | `CLONEIT_WORKSPACE` | `--workspace D` | clone 目标仓库（JSON 支持字符串或数组；环境变量用 `:` 分隔多个；CLI 可重复） | `service.sh`：本项目上两级（无 `references/` 时当前目录）；CLI：当前目录 |
| `port` | `CLONEIT_PORT` | `--port N` | HTTP 端口 | `7420` |
| `token` | `CLONEIT_TOKEN` | `--token T` | 访问令牌（请求头 `X-CloneIt-Token`，插件 options 填同值） | 无 |
| `browser` | `CLONEIT_BROWSER` | `--browser B` | `chrome` / `edge`（仅 `install.sh` 使用） | 自动检测 |
| `mirror` | `CLONEIT_MIRROR` | `--mirror URL` | GitHub 镜像前缀（`<mirror>/https://github.com/x/y`） | 无 |
| `proxy` | `CLONEIT_PROXY` | `--proxy URL` | git HTTP(S) 代理 | 无 |
| `maxConcurrent` | `CLONEIT_MAX_CONCURRENT` | `--max-concurrent N` | 最大并发 clone 数 | `5` |
| `retry` | `CLONEIT_RETRY` | `--retry N` | 单任务重试次数（退避 2s、4s…） | `3` |
| `full` | `CLONEIT_FULL` | `--full` | 克隆完整历史，不加 `--depth=1`（环境变量支持 `1`/`true`/`0`/`false`） | `false` |
| `noPull` | `CLONEIT_NO_PULL` | `--no-pull` | 目录已存在时报错，不自动 `pull --ff-only` | `false` |
| `cloneTimeout` | `CLONEIT_CLONE_TIMEOUT` | `--clone-timeout MS` | 超时（毫秒） | `0`（不限） |
| `watchClipboard` | `CLONEIT_WATCH_CLIPBOARD` | `--watch-clipboard` | 监听剪贴板 `CLONEIT://clone?workspace=ws0&category=X&url=...` | `false` |

运行时文件：`.run/cloneit.log`、`.run/cloneit.pid`；launchd 配置：`~/Library/LaunchAgents/com.innate.cloneit.plist`。

## 使用插件

快捷键 `Alt+R` 打开弹窗，共四个 Tab：

- **Clone**：在 GitHub 仓库页选择 workspace 和类别（读取自 `references/` 实时目录），点 Clone。目录已存在且 origin 相同时改为 `pull`。服务离线时降级为复制 `git clone` 命令。
- **收藏**：自动带入当前页地址和标题，可以补备注；URL 去重。
- **克隆网站**：输入地址后返回规划路径 `references/websites/<name>`，处理逻辑还没实现。
- **历史 / 进度**：显示状态、进度条、命令和错误，2 秒刷新一次；失败的任务可以重跑。

## CLI

```bash
node server/clone-it-cli.mjs clone <github-url> [--category skills/agent] [--name N] [--full] [--mirror URL]
node server/clone-it-cli.mjs list [--category X]
node server/clone-it-cli.mjs jobs [--limit 30]
node server/clone-it-cli.mjs retry <job-id>
node server/clone-it-cli.mjs collect <url> [--title T] [--note N]
node server/clone-it-cli.mjs collected
node server/clone-it-cli.mjs clone-website <url>
node server/clone-it-cli.mjs server [--config FILE] [server 参数]
```

CLI 同样读取 `cloneit.config.json` 与 `CLONEIT_*` 环境变量；未指定 `workspace` 时用当前目录。`clone` 在前台同步执行并打印进度，类别默认 `others`。CLI 和 HTTP 服务共用 `server/core.mjs`，历史记录都写在 `server/jobs.json`。

## API

```
GET  /api/ping | /api/workspaces
GET  /api/tree?workspace=ws0               references 类别树
GET  /api/registry?workspace=ws0           解析 registry_references.yaml
GET  /api/list?workspace=&category=        类别下已有的仓库
POST /api/clone          {workspace, category, url, name?}  → 202 入队
GET  /api/jobs           POST /api/retry {id}
GET  /api/collected      POST /api/collect {url, title?, note?, source?}  POST /api/collect/remove {id}
POST /api/clone-website  {workspace, url, name?}  → 501
```

## 目录

```
server/                     core.mjs（共享核心） · clone-it-server.mjs（HTTP :7420） · clone-it-cli.mjs
extension/                  MV3 插件，无构建步骤
scripts/                    install.sh · service.sh
skill/                      SKILL.md
tools/                      make-icons.html（图标生成） · test-parser.mjs
cloneit.config.example.json 配置文件模板（复制为 cloneit.config.json 使用）
```

## 安全

- 服务只监听 `127.0.0.1`，带 Origin 的请求只放行浏览器扩展；clone 目标限制在 workspace 的 `references/` 内。
- 重启时仍在运行的任务会标记为失败，可以用 `retry` 重跑。
- 不采集、不外发任何页面内容。
