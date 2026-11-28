# KeepIt TODO

> 当前状态见 [STATUS.md](STATUS.md)。本清单的优先级排序：**先让"记录下来的东西"真正被处理掉**，再谈锦上添花。

## P0 — 处理已保存的「稍后读」URL（collection，真正的 read later）

现状：`server/collected.json` 里 `category: "collection"` 的条目只有 url/标题/备注，`crawlStatus: "pending"`，没有任何后续处理——**还不是一个真正的稍后读功能**。要做：

### 1. 抓取流水线（把 pending 变 done）

- [ ] 新增抓取 worker（复用 clone 任务队列的并发/重试骨架，`server/core.mjs`）：定时或手动触发，逐条处理 `crawlStatus: "pending"` 的 collection 条目。
- [ ] 拉取页面 HTML（跟 `--mirror`/`--proxy` 一样支持代理），失败重试 + 退避；失败条目标 `crawlStatus: "failed"` + 记录错误，可重跑。
- [ ] 正文提取（readability 思路：去导航/广告/侧栏，保留标题、正文、代码块、图片引用），零依赖实现或引入单个无依赖 parser。
- [ ] 落盘格式：存为 `references/read-later/<id>-<slug>/index.md`（正文 markdown + 元数据 frontmatter：url、抓取时间、标题、备注），图片先记远程地址，懒下载。
- [ ] 完成后回写 `crawlStatus: "done"`、`crawledAt`、实际路径；重复 URL 去重（已有 409 逻辑，扩展到抓取阶段）。

### 2. 阅读体验（记下来要能"读"）

- [ ] 本地阅读入口：服务加一个只读路由（或生成一个静态 `index.html`），列出所有已抓取文章，点击离线阅读。
- [ ] 已读/未读与归档：`read: true` / `archived: true` 字段，插件列表加过滤（稍后读的意义就是"读完划掉"）。
- [ ] URL 规范化：入库前剥掉 `utm_*` 等跟踪参数、统一 `http/https` 与尾斜杠，避免同一篇文章存两遍。

### 3. 与 clone 生态打通

- [ ] 稍后读条目里识别出 GitHub 仓库链接时，一键转成 clone 任务（入口已重叠，只差一个按钮/CLI 参数）。

## P0 — 处理「想克隆的网站」URL（clone，整站抓取）

现状：`category: "clone"` 条目记录了 url、站点名、workspace、规划路径 `references/websites/<name>`，`crawlStatus: "pending"`，**整站抓取逻辑完全留空**。要做：

- [ ] 选定抓取工具并封装：优先 `wget --mirror`（macOS 自带）/ `wpull` / `httrack`，统一封装成和 git clone 一样的 job（进度解析、超时、重试、并发上限复用同一队列）。
- [ ] 抓取策略配置（进 `keepit.config.json`）：`depth`、`pageLimit`、`sizeLimit`、`wait`（JS 渲染页面的保守策略）、是否下载图片/视频资源。
- [ ] 资源重写：抓完后把页面内链接重写为相对路径，保证 `open references/websites/<name>/index.html` 能离线浏览。
- [ ] robots/礼貌抓取：默认遵守 robots.txt、限速（如 1 req/s），站点名冲突时自动加 `-2` 后缀。
- [ ] 特殊站点走 git：目标其实是个 GitHub 仓库/文档源（如 docs 站）时，检测后改走 git clone 通道，落盘到 `references/websites/<name>` 并注明。
- [ ] 完成后回写 `crawlStatus: "done"` + 实际路径；插件「克隆网站」tab 的列表显示进度（现在只有 pending 状态）。

## P1 — 工程与体验

- [ ] **collected.json 的位置**：现在数据文件在仓库目录 `server/` 下，跟随 git 走；考虑移到 workspace 或 `.run/`，避免个人浏览记录混进代码仓库（或保持现状但继续确保 gitignore）。
- [ ] 插件「克隆网站」tab 支持从粘贴板批量导入多个 URL。
- [ ] CLI：`keepit-cli.mjs collect` 支持 `--file urls.txt` 批量导入；`read-later` 子命令列出未读。
- [ ] API 文档同步：新增抓取/整站克隆状态查询接口（如 `GET /api/collected?id=`、`POST /api/crawl/:id`）后补进 README。
- [ ] 视频流水线：intro-deck/promo-film 的口播与画面已随改名更新，后续功能落地后补「整站克隆」与「稍后读」实操镜头。

## 已完成

- [x] 改名 KeepIt / keepit / keepit → KeepIt / keep-it / keepit（扩展、服务、CLI、脚本、配置、环境变量、launchd label、剪贴板哨兵、token 头）。
- [x] GitHub 远端仓库改名 `qdriven/repo-cloner` → `qdriven/keepit`。
- [x] 「收藏（collection）」文案改为「稍后读（read later）」，数据字段保持 `category: "collection"` 兼容旧记录。
- [x] 视频产物（`docs/**/build/`）加入 `.gitignore`，只保留本地、不入 GitHub。
- [x] README 增加 Why 章节；新增 `docs/STATUS.md` 与本清单。
