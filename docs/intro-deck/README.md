# KeepIt 自动化视频生成总结与「镜头感产品宣传片」SKILL 调研

本目录与姊妹目录 `docs/promo-film/` 分别承载 KeepIt 的两套纯代码驱动（Video-as-Code）视频流水线：

- **`docs/intro-deck/`（结构化产品讲解片 + 实操演示）**：8 页 1920×1080 交互式 HTML 幻灯片 + 3 段内嵌式产品操作动画，适合完整讲清背景、架构与功能细节（约 3 分钟）。
- **`docs/promo-film/`（电影镜头感产品宣传片 + 真实实操特写）**：采用 Screen Studio / Apple 发布片式的 **3D 空间透视运镜 + 光标跟随变焦（Zoom-to-Action）+ 真实服务数据与真实插件 UI 操作 + 声效卡点**，适合快速抓住眼球的产品发布与社交传播（约 84 秒，6 幕连续运镜）。

---

## 一、`docs/intro-deck` 自动化生成过程总结

整套管线采用**零第三方 npm 依赖**（仅使用 Node.js ≥ 18 内置 `WebSocket`/`fs`/`child_process`、本机 Chrome/Edge Headless CDP、TTS 与 `ffmpeg`），一次命令即可从 `index.html` + `voiceover.json` 生成完整 1080p MP4 与静态预览图。

### 1. 五阶段自动化流水线

```text
index.html (画面与虚拟时钟动画)  +  voiceover.json (口播词 / 字幕 / 纠音词表)
        │
        ▼
[0/4] 生成前自动检查 (Pre-flight Check)
  ├─ 校验 index.html 的 <section class="slide" data-id="..."> 与 voiceover.json 页数、ID 顺序、demo 类型一致
  ├─ 自动应用技术多音字单音同音替换（仅作用于送往 TTS 的音频文本，不改动 JSON 原文和画面字幕）
  └─ 扫描未覆盖的高危多音字（行/重/调/弹/率/模/参/处/藏）与代码符号，校验字幕视觉字宽
        │
        ▼
[1/4] 仓库真实数据注入 & 多引擎并发语音合成
  ├─ 实时读取 server/jobs.json 与 server/collected.json 统计真实克隆数与稍后读/待克隆站记录数
  ├─ 按句并发调用 TTS（edge-tts / MiniMax / OpenAI 兼容 / macOS say / off 静音模式）
  └─ ffmpeg 去除句首静音、统一采样率为 48kHz 立体声 WAV、补齐自然呼吸尾音，并用 ffprobe 精确测量每句秒数
        │
        ▼
[2/4] Headless Chrome CDP 确定性逐帧捕获
  ├─ 通过 --remote-debugging-port=0 启动无头浏览器并注入 window.setFacts(...)
  ├─ 静态概念页 (kind: "slide")：每句字幕捕获 1 张无损 PNG，按该句精确音频时长编码分段视频
  └─ 动态实操页 (kind: "demo-*")：按 20fps 步进虚拟时钟 window.renderAt(slideId, p, subtitle, globalProg)，完全消除掉帧与卡顿
        │
        ▼
[3/4] FFmpeg 分段合成与无损拼接
  └─ H.264 (CRF 18, yuv420p) + AAC (192kbps, 48kHz) 合成 + concat demuxer + +faststart
        │
        ▼
[4/4] 产物输出与音画校验
  ├─ 输出 build/keepit-intro.mp4 与 build/previews/<slide-id>.png
  └─ 校验总时长、音频轨参数与响度峰值（避免空轨或静音帧）
```

### 2. 关键工程问题与解决机制

1. **`index.html` 与 `voiceover.json` 同步修改与防错**
   - 每个 `<section class="slide">` 通过 `data-id`（如 `04-demo-cli`）和 `data-demo` 与 `voiceover.json` 中的 `id`、`kind` 一一绑定。
   - 页眉页码 `01 / NN` 由脚本按实际页数动态计算；任意增删或调整页面顺序时，若两边未对齐，`[0/4]` 会在 0.3 秒内直接报错定位，避免白跑完整渲染。
2. **多音字生成前自动检查与无痕纠音**
   - 针对中文 TTS 常见技术误读（如 `命令行` 的 `行` 误读为 `xíng`、`重跑/重试` 的 `重` 误读为 `zhòng`、`弹窗` 误读为 `dàn`），内置 `BUILTIN_PRONUNCIATIONS` 并支持在 `voiceover.json` 顶部的 `"pronunciations"` 自定义覆盖。
   - 采用**单音同音字替换法**（如 `命令行 → 命令航`、`重跑 → 虫跑`、`重试 → 虫试`、`弹窗 → 谈窗`）：`航/虫/谈` 在现代汉语中只有唯一读音，从根源杜绝任何 TTS 引擎误判，同时画面底部字幕仍渲染原始的 `sub` 文本。
3. **常用命令**
   ```bash
   # 1. 秒级检查 HTML↔JSON 同步与多音字读音告警
   node docs/intro-deck/render-video.mjs --check

   # 2. 仅单独合成涉及多音字纠音/提示的那几句话到 build/check/ 快速试听
   node docs/intro-deck/render-video.mjs --check-audio

   # 3. 生成 5 款神经网络音色试听样音到 build/auditions/
   node docs/intro-deck/render-video.mjs --audition

   # 4. 完整重渲（支持 --provider edge|minimax|openai|say|off 与 --voice）
   node docs/intro-deck/render-video.mjs --provider edge --voice zh-CN-YunxiNeural --rate +12%
   ```

### 3. `intro-deck` 参考的 `innate` SKILL 清单

| 序号 | SKILL 名称 | `innate` 内参考路径 | 借鉴到本流水线的核心设计 |
|---|---|---|---|
| 1 | `open-artifact / slides` | `references/projects/plugins/open-artifact/artifact-types/slides/SKILL.md` | 固定 `1920×1080` 画布、模块化 `slide id` 索引、高对比度大字号排版规范 |
| 2 | `open-artifact / motion` | `references/projects/plugins/open-artifact/artifact-types/motion/SKILL.md` | 纯时间函数 `renderAt(slideId, p)` 驱动一切 UI 状态，禁止依赖真实时间 `setTimeout` |
| 3 | `frame-capture` | `references/skills/open-3d-skills/skills/frame-capture/SKILL.md` | Headless 浏览器虚拟时钟逐帧步进截图再交由 `ffmpeg` 编码，彻底解决录屏掉帧 |
| 4 | `cli-intro-video` | `innate-tools/spark-cli/video/skills/cli-intro-video/SKILL.md` | 渲染前核对仓库真实事实（`jobs.json` / `collected.json`），画面数字与真实状态严格一致 |
| 5 | `lucid` | `innate-tools/spark-cli/video/skills/lucid/SKILL.md` | 先合成语音并用 `ffprobe` 测准每句真实时长，再反向驱动画面时间轴，最后做响度与硬伤体检 |
| 6 | `boring-video / to-scenes` | `references/skills/boring-video-studio/skills/boring-video/to-scenes/SKILL.md` | `screen-evidence` 因果展示契约：`上下文 → 输入 → 触发 → 过程 → 结果停留` |
| 7 | `boring-video / minimax-tts` | `references/skills/boring-video-studio/skills/boring-video/minimax-tts/SKILL.md` | MiniMax `speech-02-hd` 高表现力语音接口参数与多引擎可切换配音抽象 |
| 8 | `record-terminal-demo` | `base/innate-skills/personal/tools/record-terminal-demo/SKILL.md` | 基于真实命令输入输出编排终端演示节奏，抽关键帧（`previews/*.png`）做视觉复核 |
| 9 | `ljg-present` | `references/skills/ljg-skills/skills/ljg-present/SKILL.md` | 「痛点张力 → 机制破局 → 实证验证 → 极简收束」的叙事节奏控制 |
| 10 | `open-artifact / whiteboard` | `references/projects/plugins/open-artifact/artifact-types/whiteboard/SKILL.md` | 双通道数据流架构图（GitHub 5 并发浅克隆通道 + `collected.json` 分类池）的视觉拆解 |

---

## 二、「有镜头感 + 真实实操演示」产品宣传片 SKILL 调研

当目标从「把原理讲清楚的幻灯演示片」升级为**「像 Apple / Linear / Screen Studio 一样有镜头感、同时包含真实软件操作的产品宣传片（Product Promo Film）」**时，核心差异在于**摄影机运动（Camera Choreography）**：不再是整屏静止展示，而是把真实终端和浏览器窗口放进三维舞台空间，用镜头带着观众的眼睛聚焦每一次输入、每一次点击和每一次状态跳变。

以下是 `/Users/patrick/innate` 中可直接支撑这类宣传片的 **8 个核心 SKILL 与工具方案**：

### 1. 全景对比表

| SKILL / 工具 | `innate` 内路径 | 核心「镜头感」与实操能力 | 最适合承担的宣传片环节 |
|---|---|---|---|
| **`open-artifact / motion`**<br>（含 `recreate-ui.md`、`film-api.md`、`motion.md`、`sound.md`） | `references/projects/plugins/open-artifact/artifact-types/motion/` | **最契合软件产品宣传片**：<br>① **Lift Real UI**：直接把产品真实 HTML/CSS（如 `extension/popup.html` + `popup.css`）搬上 1920×1080 舞台，拒绝假画框；<br>② **Camera 关键帧运镜**：支持 `(cx, cy, z, ease, drift)` 推镜放大到 `1.8×–2.6×` 看清按钮与输入框，停留时带 `1–3%` 呼吸缓推；<br>③ **光标与聚光灯**：弧线轨迹光标（`bow`）、点击波纹下压、`spotlight` 压暗非焦点区域；<br>④ **程序化声效**：`whoosh` 甩镜、`click` 点击、`pop` 弹出、`chime` 完成音与自动闪避人声的配乐。 | **核心主引擎**：真实插件交互特写、光标跟随推拉变焦、声画卡点 |
| **`cinematic-film`** | `references/skills/cinematic-skill/skills/cinematic-film/` | **单世界大画布连续运镜**：<br>① 所有卡片、终端、架构节点铺在一张超大画布上，摄像机通过样条曲线在簇群之间**推（Push in）、拉（Pull back）、甩镜（Whip pan + 运动模糊）**与微倾角（`rot: ±1.2°`）；<br>② 聚光灯跟随镜头，严格执行「一句旁白只照亮一个视觉主角」；<br>③ 标准四幕式产品发布结构（`story.md`：`Problem → Reveal → Three Proofs → Pull-back Close`）与词级时间戳卡点（`doc.W`）。 | 全片叙事骨架、跨场景连续甩镜转场、片尾全景拉远收束（Pull-back Reveal） |
| **`frame-capture`** | `references/skills/open-3d-skills/skills/frame-capture/` | **高帧率零掉帧虚拟时钟摄影机**：<br>接管 `performance.now`、`requestAnimationFrame` 与 CSS 动画，通过 `window.__recordFrame(t)` 逐帧驱动三维 CSS `perspective() rotateX() rotateY()`、阴影和高斯模糊，无论单帧渲染多重，成片始终稳定 30/60fps。 | 宣传片底层逐帧渲染器（保障 3D 倾斜透视与快速变焦绝对丝滑） |
| **`cli-intro-video` + `lucid`** | `innate-tools/spark-cli/video/skills/cli-intro-video/`<br>`innate-tools/spark-cli/video/skills/lucid/` | **真实命令执行采集 + 事实门禁**：<br>在真实本机环境跑一遍 CLI 命令抓取原样输出，再合成适合观看的敲击与输出节奏；渲染前强制核对命令、路径与统计数字真实有效，并支持 `16:9 / 9:16 / 1:1` 多画幅裁剪。 | 宣传片中的真实终端实操片段采集（`install.sh`、`keepit-cli.mjs`、`service.sh`） |
| **`boring-video / to-scenes` & `record-terminal`** | `references/skills/boring-video-studio/skills/boring-video/` | **实操因果镜头契约（`screen-evidence.md`）**：<br>遵循「保留触发与结果、压缩漫长等待（Keep the trigger and the result, shorten the wait）」，确保先看见点击/输入、再发生状态变化、最后在结果画面留足阅读停留时间。 | 实操演示的剪辑节奏设计（例如 60 秒克隆过程压缩为 1.5 秒进度跃迁并定格在 `done`） |
| **`open-3d-skills / exploded-view` & `cursor-rig`** | `references/skills/open-3d-skills/skills/exploded-view/`<br>`references/skills/open-3d-skills/skills/cursor-rig/` | **三维空间分层拆解 & 弹簧阻尼物理**：<br>① 将「浏览器扩展层 → 本地 HTTP `:7420` 服务层 → `references/` & `collected.json` 存储层」在 Z 轴分层拉开并配引线标注；<br>② 欠阻尼弹簧（Under-damped Spring）让镜头追随光标停止时产生极其自然的微回弹呼吸感。 | 产品架构 3D 分层揭示镜头、Screen Studio 风格的弹簧阻尼镜头跟随 |
| **`record-terminal-demo`** | `base/innate-skills/personal/tools/record-terminal-demo/` | **真实终端 TUI / CLI 录制与关键帧抽检**：<br>基于 JSON 步骤清单驱动真实终端录制，并用 `--verify` 自动抽取关键时间点 PNG 校验无乱码、无截断。 | 独立 GIF 动图或嵌入宣传片画中画的终端实录素材 |
| **`Editroom` / `autoclip`（参考实现）** | `references/products/Editroom/`<br>`references/products/autoclip/` | **变速坡度（Speed Ramp）与节拍剪辑理念**：<br>操作瞬间 `1.0×` 慢推聚焦，等待加载阶段 `4×` 加速滑过，落盘成功瞬间配合音效定格，全片响度统一归一到播客/视频平台标准（`-16 ~ -14 LUFS`）。 | 宣传片速度曲线（Speed Ramping）与音轨混音母带处理 |

### 2. 「镜头感产品宣传片」的 5 条核心镜头准则（提炼自上述 SKILL）

1. **大胆推进局部特写（Zoom 1.8× ~ 2.5×），绝不长时间停在全景小字**（来自 `open-artifact/motion/recreate-ui.md`）：
   - 14px 的插件文字在全景窗口里难以一眼看清；当光标移向「Clone」「重试全部失败」「克隆网站」按钮时，摄像机同步推进到 `2.1×` 并伴随 `-6° ~ +8°` 的轻微 3D 透视倾角（`perspective(1400px) rotateX(...) rotateY(...)`），瞬间产生强烈的 Screen Studio 镜头质感。
2. **直接使用产品真实 UI 源码（Lift UI, Don't Redraw）**（来自 `recreate-ui.md`）：
   - 宣传片里的插件弹窗直接复用 `extension/popup.css` 的真实配色、圆角、徽标与 DOM 结构，并通过真实运行中的 `127.0.0.1:7420` 服务与 CLI 抓取真实输出作为演示数据。
3. **弹簧物理跟随 + 聚光灯视觉引导（Spring Camera + Spotlight）**（来自 `cinematic-film` & `cursor-rig`）：
   - 镜头中心滞后光标约 `0.18s` 平滑跟进，落点微幅回弹；非当前交互区域用柔和暗角压低对比度，观众视线永远锁定在正在发生的动作上。
4. **保留「触发」与「结果」，变速压缩「等待」**（来自 `recreate-ui.md` & `screen-evidence.md`）：
   - 完整展示「按下 `Alt+R` → 点选分类 → 点击按钮」与「队列完成 / 自动纠错重试成功 / JSON 落盘」，将中间漫长的下载过程浓缩为富有动感的快速跳变。
5. **动作点精确配音效（Sound the World）**（来自 `open-artifact/motion/sound.md` & `cinematic-film`）：
   - 镜头快速推进/甩镜配轻柔 `whoosh`，光标点击配清脆 `click`，任务完成落盘配柔和 `chime`，底层铺低频温暖环境铺底音（自动避让人声频段）。

---

## 三、落地实例：`docs/promo-film/` 产品宣传片工程

基于以上调研，仓库已在 `docs/promo-film/` 实现了一套完整的**「有镜头感 + 真实实操演示」KeepIt 产品宣传片工程**，融合了 `open-artifact/motion`（真实 UI + 镜头变焦 + 声效）、`cinematic-film`（四幕发布叙事 + 连续大画布运镜）、`cli-intro-video`（真实命令执行数据采集）与 `frame-capture`（虚拟时钟满帧渲染）：

- `docs/promo-film/index.html`：支持三维透视摄像机（`x, y, zoom, rotX, rotY, rotZ` 弹簧插值）、光标弧线运动、聚光灯暗角与真实 KeepIt 插件/终端实操舞台（浏览器直接打开即可交互预览或按 `Space` 播放全片运镜）
- `docs/promo-film/promo-script.json`：六幕宣传片分镜、口播词、字幕、镜头关键帧与多音字纠音配置
- `docs/promo-film/render-promo.mjs`：自动采集本机真实 CLI / 服务输出 → 预检同步与多音字 → 合成神经网络旁白 + 程序化声效轨（点击音 / 转场风声 / 完成提示音 / 温暖环境铺底）→ 30fps 逐帧渲染出片 `docs/promo-film/build/keepit-promo.mp4`

```bash
# 预检宣传片分镜与多音字
node docs/promo-film/render-promo.mjs --check

# 一键渲染完整镜头感产品宣传片 (1920x1080, 30fps, 旁白 + 音效混音)
node docs/promo-film/render-promo.mjs
```
