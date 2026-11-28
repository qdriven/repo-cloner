# KeepIt

浏览器插件 + 本地伴侣服务（Chrome / Edge，MV3）：

- **GitHub clone**：在仓库页一键 clone 到 `references/<category>/<name>`，默认 `--depth=1`，最多 5 个并发，失败自动重试，有历史和进度。
- **稍后读（read later，`collection`）**：自动识别当前页地址与标题，记入 `server/collected.json`（`category: "collection"`，`crawlStatus: "pending"`，后续统一爬取处理）。
- **克隆网站（`clone`）**：自动识别当前页网址，记录站点信息与规划路径到 `server/collected.json`（`category: "clone"`，`crawlStatus: "pending"`，后续统一克隆处理）。

零依赖，需要 Node.js ≥ 18、git、curl。

## Why — 这个项目解决什么问题

这个项目最初就是为了解决我自己的问题：

- **clone 一个 GitHub 仓库太无聊了。** 看到一个有意思的仓库，想 clone 到本地，就得切到终端（往往要切 3 个窗口：浏览器 → 终端 → 再回浏览器），敲 `git clone ...` 一长串命令，等它跑完再切回去。用这个插件，在仓库页按 `Alt+R`、选类别、点 Clone，**大约 2 秒搞定**——clone 在后台服务里跑，有进度有历史，失败自动重试。
- **任何"以后想读"的内容都应该被记下来。** 之前的功能叫"收藏（collection）"，但"稍后读（read later）"这个名字其实更贴切——你存下它不是为了拥有它，而是为了之后读它。目前只记录了地址，**还缺少真正的稍后读能力**（抓取正文、离线阅读、已读标记等），这是 TODO 之一（见 `docs/TODO.md`）。
- **好网站也应该能"留个坐标，以后再克隆"。** 看到值得整站保存的网站（文档站、教程站），不一定要立刻动手，先把网址记进个人清单，标好计划路径（`references/websites/<name>`），之后再统一克隆处理。

一句话：**看到 → 留下 → 之后再处理。** KeepIt 把这三步里所有的机械劳动都拿掉了。

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
默认读取项目根目录的 `keepit.config.json`（不存在则跳过，可从 `keepit.config.example.json` 复制；也可用 `--config FILE` 或 `KEEPIT_CONFIG` 指定路径）。

| 配置文件字段 | 环境变量 | 命令行参数 | 说明 | 默认 |
|---|---|---|---|---|
| `workspace` / `workspaces` | `KEEPIT_WORKSPACE` | `--workspace D` | clone 目标仓库（JSON 支持字符串或数组；环境变量用 `:` 分隔多个；CLI 可重复） | `service.sh`：本项目上两级（无 `references/` 时当前目录）；CLI：当前目录 |
| `port` | `KEEPIT_PORT` | `--port N` | HTTP 端口 | `7420` |
| `token` | `KEEPIT_TOKEN` | `--token T` | 访问令牌（请求头 `X-KeepIt-Token`，插件 options 填同值） | 无 |
| `browser` | `KEEPIT_BROWSER` | `--browser B` | `chrome` / `edge`（仅 `install.sh` 使用） | 自动检测 |
| `mirror` | `KEEPIT_MIRROR` | `--mirror URL` | GitHub 镜像前缀（`<mirror>/https://github.com/x/y`） | 无 |
| `proxy` | `KEEPIT_PROXY` | `--proxy URL` | git HTTP(S) 代理 | 无 |
| `maxConcurrent` | `KEEPIT_MAX_CONCURRENT` | `--max-concurrent N` | 最大并发 clone 数 | `5` |
| `retry` | `KEEPIT_RETRY` | `--retry N` | 单任务重试次数（退避 2s、4s…） | `3` |
| `full` | `KEEPIT_FULL` | `--full` | 克隆完整历史，不加 `--depth=1`（环境变量支持 `1`/`true`/`0`/`false`） | `false` |
| `noPull` | `KEEPIT_NO_PULL` | `--no-pull` | 目录已存在时报错，不自动 `pull --ff-only` | `false` |
| `cloneTimeout` | `KEEPIT_CLONE_TIMEOUT` | `--clone-timeout MS` | 超时（毫秒） | `0`（不限） |
| `watchClipboard` | `KEEPIT_WATCH_CLIPBOARD` | `--watch-clipboard` | 监听剪贴板 `KEEPIT://clone?workspace=ws0&category=X&url=...` | `false` |

运行时文件：`.run/keepit.log`、`.run/keepit.pid`；launchd 配置：`~/Library/LaunchAgents/com.innate.keepit.plist`。

## 使用插件

快捷键 `Alt+R` 打开弹窗，共四个 Tab：

- **Clone**：在 GitHub 仓库页选择 workspace 和类别（读取自 `references/` 实时目录），点 Clone。目录已存在且 origin 相同时改为 `pull`。服务离线时降级为复制 `git clone` 命令。
- **稍后读**：自动带入当前页地址和标题，可补备注，以 `category: "collection"` 写入 `server/collected.json`；列表支持按 `全部 / collection / clone` 筛选与删除。
- **克隆网站**：自动识别并填入当前页网址（可手动修改），点击后以 `category: "clone"` 记录到 `server/collected.json`（含规划路径 `references/websites/<name>`，待后续克隆处理）。
- **历史 / 进度**：显示状态、进度条、命令和错误，2 秒刷新一次；失败的任务可以重跑。

## CLI

```bash
node server/keepit-cli.mjs clone <github-url> [--category skills/agent] [--name N] [--full] [--mirror URL]
node server/keepit-cli.mjs list [--category X]
node server/keepit-cli.mjs jobs [--limit 30]
node server/keepit-cli.mjs retry <job-id>
node server/keepit-cli.mjs collect <url> [--title T] [--note N]
node server/keepit-cli.mjs collected [--category collection|clone]
node server/keepit-cli.mjs clone-website <url> [--name N] [--title T] [--note N]
node server/keepit-cli.mjs server [--config FILE] [server 参数]
```

CLI 同样读取 `keepit.config.json` 与 `KEEPIT_*` 环境变量；未指定 `workspace` 时用当前目录。`clone` 在前台同步执行并打印进度，类别默认 `others`。CLI 和 HTTP 服务共用 `server/core.mjs`，克隆历史写在 `server/jobs.json`，稍后读与待克隆网站统一写在 `server/collected.json`。

## API

```
GET  /api/ping | /api/workspaces
GET  /api/tree?workspace=ws0               references 类别树
GET  /api/registry?workspace=ws0           解析 registry_references.yaml
GET  /api/list?workspace=&category=        类别下已有的仓库
POST /api/clone          {workspace, category, url, name?}  → 202 入队
GET  /api/jobs           POST /api/retry {id}
GET  /api/collected[?category=collection|clone]
POST /api/collect        {url, title?, note?, source?}      → 201 (category=collection)
POST /api/clone-website  {workspace, url, name?, title?, note?} → 201 (category=clone)
POST /api/collect/remove {id}
```

## 目录

```
server/                     core.mjs（共享核心） · keepit-server.mjs（HTTP :7420） · keepit-cli.mjs
extension/                  MV3 插件，无构建步骤
scripts/                    install.sh · service.sh
skill/                      SKILL.md
tools/                      make-icons.html（图标生成） · test-parser.mjs
docs/                       视频生成流水线（intro-deck / promo-film，构建产物不入库） · STATUS.md · TODO.md
keepit.config.example.json  配置文件模板（复制为 keepit.config.json 使用）
```

## 文档

- **[docs/STATUS.md](docs/STATUS.md)** — 项目当前状态：哪些功能已可用、哪些是占位（整站克隆、稍后读抓取等）。
- **[docs/TODO.md](docs/TODO.md)** — 待办清单，重点是：怎么处理已保存的稍后读地址，以及怎么处理想克隆的网站 URL。

## 安全

- 服务只监听 `127.0.0.1`，带 Origin 的请求只放行浏览器扩展；clone 目标限制在 workspace 的 `references/` 内。
- 重启时仍在运行的任务会标记为失败，可以用 `retry` 重跑。
- 不采集、不外发任何页面内容。
