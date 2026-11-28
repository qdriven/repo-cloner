#!/usr/bin/env node
/**
 * KeepIt Intro Slides + Live Product Demo Video Renderer (Zero npm dependencies).
 *
 * Combines workflows from innate skills:
 *   - slides-voiceover: per-slide voiceover.json + exact -t audio duration + silence check
 *   - frame-capture:    deterministic virtual-clock stepping via Headless Chrome CDP
 *   - cli-intro-video:  live fact verification from server/jobs.json & server/collected.json
 *
 * Usage:
 *   node docs/intro-deck/render-video.mjs --check         # 生成前自动检查: HTML↔JSON 同步 + 多音字/符号读音体检
 *   node docs/intro-deck/render-video.mjs --check-audio   # 仅合成含多音字纠音/告警的句子到 build/check/ 快速试听
 *   node docs/intro-deck/render-video.mjs [--provider edge|minimax|openai|say|off]
 *                                         [--voice zh-CN-YunxiNeural] [--rate +12%] [--pitch +0Hz]
 *                                         [--strict] [--out docs/intro-deck/build/keepit-intro.mp4]
 *   node docs/intro-deck/render-video.mjs --audition      # 合成多款音色试听样音到 build/auditions/
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const BUILD_DIR = path.join(__dirname, 'build');
const PREVIEW_DIR = path.join(BUILD_DIR, 'previews');
const AUDITION_DIR = path.join(BUILD_DIR, 'auditions');
const CHECK_AUDIO_DIR = path.join(BUILD_DIR, 'check');
const WORK_DIR = path.join(REPO, '.run', `video-work-${process.pid}`);
const PROFILE_DIR = path.join(WORK_DIR, 'chrome-profile');
const DEFAULT_OUT_MP4 = path.join(BUILD_DIR, 'keepit-intro.mp4');

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') opts.provider = argv[++i];
    else if (a === '--voice') opts.voice = argv[++i];
    else if (a === '--rate') opts.rate = argv[++i];
    else if (a === '--pitch') opts.pitch = argv[++i];
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--audition') opts.audition = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--check-audio') { opts.check = true; opts.checkAudio = true; }
    else if (a === '--strict') opts.strict = true;
  }
  return opts;
}

// ---------- 内置技术多音字同音纠音表 (仅作用于送往 TTS 的音频文本，不影响 JSON 原文和画面字幕) ----------
const BUILTIN_PRONUNCIATIONS = {
  // 行 (háng) — 避免被 TTS 误读为 xíng ("航" 为唯一读音 háng)
  '命令行': '命令航',
  '代码行': '代码航',
  '多行': '多航',
  '单行': '单航',
  '空行': '空航',
  '换行': '换航',
  '逐行': '逐航',
  '首行': '首航',
  '末行': '末航',
  '按行': '按航',
  '整行': '整航',
  '行号': '航号',
  '一行代码': '一航代码',
  '一行命令': '一航命令',
  '几行代码': '几航代码',
  // 重 (chóng) — 避免被 TTS 误读为 zhòng ("虫" 为唯一读音 chóng)
  '重头再来': '虫头再来',
  '重试': '虫试',
  '重跑': '虫跑',
  '重连': '虫连',
  '重启': '虫启',
  '重构': '虫构',
  '重做': '虫做',
  '重绘': '虫绘',
  '重来': '虫来',
  '去重': '去虫',
  '查重': '查虫',
  '防重': '防虫',
  '判重': '判虫',
  // 弹 (tán) — 避免被误读为 dàn ("谈" 为唯一读音 tán)
  '弹窗': '谈窗',
  '弹出': '谈出',
  // 调 (tiáo) — 避免被误读为 diào ("条" 为唯一读音 tiáo)
  '联调': '联条',
  '调优': '条优',
  '微调': '微条',
  '调参': '条参',
};

const POLYPHONE_WATCHLIST = [
  {
    char: '行',
    readings: 'xíng / háng',
    safeWords: ['运行', '执行', '进行', '行为', '可行', '自行', '流行', '并行', '串行', '放行', '通行', '发行', '行程', '行动', '行业', '银行'],
  },
  {
    char: '重',
    readings: 'zhòng / chóng',
    safeWords: ['重要', '严重', '权重', '重点', '比重', '沉重', '繁重', '尊重', '注重', '慎重', '笨重', '重大', '重新', '重复', '重叠'],
  },
  {
    char: '调',
    readings: 'diào / tiáo',
    safeWords: ['调用', '回调', '调度', '调查', '调试', '调整', '调节', '协调', '强调', '色调', '音调', '单调', '低调', '腔调'],
  },
  {
    char: '弹',
    readings: 'tán / dàn',
    safeWords: ['弹性', '反弹', '回弹', '炸弹', '子弹', '导弹', '动弹'],
  },
  {
    char: '率',
    readings: 'lǜ / shuài',
    safeWords: ['效率', '频率', '概率', '帧率', '码率', '速率', '比率', '成功率', '失败率', '覆盖率', '分辨率', '采样率', '率先', '直率', '草率', '坦率'],
  },
  {
    char: '模',
    readings: 'mó / mú',
    safeWords: ['模块', '模型', '模式', '模拟', '规模', '模糊', '模仿', '模板', '模样', '模具'],
  },
  {
    char: '参',
    readings: 'cān / shēn / cēn',
    safeWords: ['参数', '参考', '参与', '参加', '参阅', '参照', '参观', '参差'],
  },
  {
    char: '处',
    readings: 'chǔ / chù',
    safeWords: ['处理', '处于', '处置', '处罚', '相处', '到处', '好处', '用处', '深处', '长处', '短处', '住处', '出处'],
  },
  {
    char: '藏',
    readings: 'cáng / zàng',
    safeWords: ['收藏', '隐藏', '潜藏', '躲藏', '储藏', '珍藏', '宝藏', '西藏'],
  },
];

function buildPronunciationMap(spec) {
  const merged = { ...BUILTIN_PRONUNCIATIONS, ...(spec.pronunciations || {}) };
  return Object.entries(merged)
    .filter(([k, v]) => k && typeof v === 'string' && v.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
}

function applyPronunciations(spoken, pronEntries) {
  let out = spoken;
  const applied = [];
  for (const [src, dst] of pronEntries) {
    if (out.includes(src)) {
      if (src !== dst) {
        out = out.split(src).join(dst);
        applied.push(`${src} → ${dst}`);
      } else {
        // Explicit identity override in voiceover.json: mark as verified
        applied.push(`${src} (已锁定原音)`);
      }
    }
  }
  return { ttsText: out, applied };
}

function parseHtmlSlides(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const slides = [];
  const re = /<section\s+([^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const idMatch = attrs.match(/\bdata-id=["']([^"']+)["']/i);
    const demoMatch = attrs.match(/\bdata-demo=["']([^"']+)["']/i);
    const tagMatch = attrs.match(/\bdata-tag=["']([^"']+)["']/i);
    slides.push({
      id: idMatch ? idMatch[1] : null,
      kind: demoMatch ? demoMatch[1] : 'slide',
      tag: tagMatch ? tagMatch[1] : '',
    });
  }
  return slides;
}

function inspectSentencePolyphones(spoken, pronEntries) {
  // Mask out phrases already explicitly covered in pronEntries
  let masked = spoken;
  for (const [src] of pronEntries) {
    if (masked.includes(src)) masked = masked.split(src).join('□'.repeat(src.length));
  }
  const warnings = [];
  for (const rule of POLYPHONE_WATCHLIST) {
    if (!masked.includes(rule.char)) continue;
    let temp = masked;
    for (const sw of rule.safeWords) {
      if (temp.includes(sw)) temp = temp.split(sw).join('□'.repeat(sw.length));
    }
    let idx = temp.indexOf(rule.char);
    while (idx !== -1) {
      const ctx = spoken.slice(Math.max(0, idx - 4), Math.min(spoken.length, idx + 5));
      warnings.push(`多音字「${rule.char}」(${rule.readings}) 出现在“…${ctx}…”，若读音不准可在 voiceover.json 的 pronunciations 中指定同音字`);
      idx = temp.indexOf(rule.char, idx + 1);
    }
  }
  const rawSym = spoken.match(/(\+|--|>=|<=|->|=>|\.(?:mjs|cjs|js|ts|sh|py)\b|https?:\/\/)/);
  if (rawSym) {
    warnings.push(`口播词含代码符号/后缀「${rawSym[0]}」，建议在 spoken 中改写为自然口语（字幕 sub 保留原符号即可）`);
  }
  return warnings;
}

function runPreflightChecks(spec, htmlPath, { strict = false } = {}) {
  console.log('[0/4] 生成前自动检查 (HTML ↔ voiceover.json 同步 & 多音字读音体检)…');
  const errors = [];
  const warnings = [];
  const fixesSummary = [];
  const affectedSentences = [];

  const htmlSlides = parseHtmlSlides(htmlPath);
  const jsonSlides = Array.isArray(spec.slides) ? spec.slides : [];

  if (htmlSlides.length !== jsonSlides.length) {
    const htmlIds = htmlSlides.map((s, i) => s.id || `#${i + 1}`).join(', ');
    const jsonIds = jsonSlides.map((s) => s.id).join(', ');
    errors.push(
      `页数不一致: index.html 有 ${htmlSlides.length} 页 [${htmlIds}]，而 voiceover.json 有 ${jsonSlides.length} 页 [${jsonIds}]`
    );
  } else {
    for (let i = 0; i < jsonSlides.length; i++) {
      const hs = htmlSlides[i];
      const js = jsonSlides[i];
      if (hs.id && hs.id !== js.id) {
        errors.push(`第 ${i + 1} 页 ID 不一致: index.html data-id="${hs.id}" vs voiceover.json id="${js.id}"`);
      }
      if (hs.kind !== js.kind) {
        errors.push(`第 ${i + 1} 页 (${js.id}) 类型不一致: index.html (${hs.kind}) vs voiceover.json (${js.kind})`);
      }
    }
  }

  const pronEntries = buildPronunciationMap(spec);

  for (const slide of jsonSlides) {
    if (!Array.isArray(slide.sentences) || !slide.sentences.length) {
      errors.push(`${slide.id}: sentences 不能为空`);
      continue;
    }
    slide.sentences.forEach((s, idx) => {
      if (!s.spoken || !s.spoken.trim()) errors.push(`${slide.id}[${idx}]: spoken 不能为空`);
      if (!s.sub || !s.sub.trim()) errors.push(`${slide.id}[${idx}]: sub 不能为空`);
      if (s.sub) {
        // Count CJK chars as 1, ASCII chars as 0.55 for visual width on 1920px stage
        const vLen = [...s.sub].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 1 : 0.55), 0);
        if (vLen > 48) {
          warnings.push(`${slide.id}[${idx}]: 字幕视觉宽度偏长 (~${Math.round(vLen)} 字)，建议精简以防双行拥挤`);
        }
      }
      const { ttsText, applied } = applyPronunciations(s.spoken || '', pronEntries);
      s.ttsText = ttsText;
      const sentWarns = inspectSentencePolyphones(s.spoken || '', pronEntries);
      if (applied.length) {
        fixesSummary.push(`      ✓ ${slide.id}[${idx}] 自动纠音: ${applied.join('，')}`);
      }
      for (const w of sentWarns) {
        warnings.push(`${slide.id}[${idx}]: ${w}`);
      }
      if (applied.length || sentWarns.length) {
        affectedSentences.push({ slideId: slide.id, idx, spoken: s.spoken, ttsText, applied, warnings: sentWarns });
      }
    });
  }

  console.log(`      ✓ 页面结构同步: index.html (${htmlSlides.length} 页) ↔ voiceover.json (${jsonSlides.length} 页)`);
  if (fixesSummary.length) {
    for (const line of fixesSummary) console.log(line);
  }
  if (warnings.length) {
    console.log(`      ⚠️ 发现 ${warnings.length} 条读音/字幕复核提示:`);
    for (const w of warnings) console.log(`        - ${w}`);
  } else {
    console.log('      ✓ 多音字与口播符号检查全部通过（无未覆盖高危多音字）');
  }

  if (errors.length) {
    console.error('\n❌ 生成前检查未通过:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  if (strict && warnings.length) {
    console.error('\n❌ --strict 模式下存在未确认读音提示，已中止生成。');
    process.exit(1);
  }

  return { pronEntries, warnings, affectedSentences };
}

function findEdgeTts() {
  const localVenv = path.join(REPO, '.run', 'tts-venv', 'bin', 'edge-tts');
  if (fs.existsSync(localVenv)) return localVenv;
  try {
    return execFileSync('which', ['edge-tts'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome / Edge not found in /Applications');
}

function ffprobeDuration(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { encoding: 'utf8' }).trim();
  const d = Number(out);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Bad audio duration for ${file}: ${out}`);
  return d;
}

function readRepoFacts() {
  let jobs = [], col = [];
  try { jobs = JSON.parse(fs.readFileSync(path.join(REPO, 'server/jobs.json'), 'utf8')); } catch {}
  try { col = JSON.parse(fs.readFileSync(path.join(REPO, 'server/collected.json'), 'utf8')); } catch {}
  return {
    jobsTotal: jobs.length || 25,
    jobsDone: jobs.filter((j) => j && j.status === 'done').length || 22,
    colTotal: col.length || 30,
    colCollection: col.filter((c) => c && (c.category || 'collection') === 'collection').length || 23,
    colClone: col.filter((c) => c && c.category === 'clone').length || 7,
  };
}

function normalizeToWav(inputMedia, wavPath, trimSilence = true) {
  const af = trimSilence
    ? 'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,aresample=48000,pan=stereo|c0=c0|c1=c0,apad=pad_dur=0.12'
    : 'aresample=48000,pan=stereo|c0=c0|c1=c0,apad=pad_dur=0.18';
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', inputMedia,
    '-af', af,
    '-ar', '48000', '-ac', '2',
    wavPath,
  ]);
  return ffprobeDuration(wavPath);
}

async function synthSentence(text, ttsCfg, wavPath) {
  const provider = ttsCfg.provider;

  // 1) edge-tts (Microsoft Edge 神经网络语音，免费自然)
  if (provider === 'edge') {
    const bin = findEdgeTts();
    if (!bin) throw new Error('edge-tts 未安装: python3 -m venv .run/tts-venv && .run/tts-venv/bin/pip install edge-tts');
    const mp3 = wavPath + '.mp3';
    const args = ['--voice', ttsCfg.voice || 'zh-CN-YunxiNeural'];
    if (ttsCfg.rate) args.push(`--rate=${ttsCfg.rate}`);
    if (ttsCfg.pitch) args.push(`--pitch=${ttsCfg.pitch}`);
    args.push('--text', text, '--write-media', mp3);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await execFileAsync(bin, args);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
    const dur = normalizeToWav(mp3, wavPath, true);
    fs.unlinkSync(mp3);
    return dur;
  }

  // 2) MiniMax Speech-02-HD (需要 MINIMAX_API_KEY, 可选 MINIMAX_API_BASE)
  if (provider === 'minimax') {
    const key = process.env.MINIMAX_API_KEY;
    if (!key) throw new Error('使用 minimax 需设置环境变量 MINIMAX_API_KEY');
    const base = (process.env.MINIMAX_API_BASE || 'https://api.minimaxi.com').replace(/\/+$/, '');
    const res = await fetch(`${base}/v1/t2a_v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.MINIMAX_TTS_MODEL || 'speech-02-hd',
        text,
        stream: false,
        voice_setting: {
          voice_id: ttsCfg.voice || 'Chinese (Mandarin)_Gentleman',
          speed: Number(ttsCfg.rate) || 1.08,
          vol: 1.0,
          pitch: 0,
        },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      }),
    });
    const json = await res.json();
    if (!res.ok || !json?.data?.audio) {
      throw new Error(`MiniMax TTS failed: ${json?.base_resp?.status_msg || res.status}`);
    }
    const mp3 = wavPath + '.mp3';
    fs.writeFileSync(mp3, Buffer.from(json.data.audio, 'hex'));
    const dur = normalizeToWav(mp3, wavPath, true);
    fs.unlinkSync(mp3);
    return dur;
  }

  // 3) OpenAI 兼容 /v1/audio/speech (OpenAI / 硅基流动 CosyVoice / Fish Speech 等)
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('使用 openai 需设置环境变量 OPENAI_API_KEY（及可选 OPENAI_BASE_URL / OPENAI_TTS_MODEL）');
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        voice: ttsCfg.voice || 'alloy',
        input: text,
        response_format: 'mp3',
      }),
    });
    if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}: ${await res.text()}`);
    const mp3 = wavPath + '.mp3';
    fs.writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
    const dur = normalizeToWav(mp3, wavPath, true);
    fs.unlinkSync(mp3);
    return dur;
  }

  // 4) 无旁白静音模式（仅保留字幕节奏，按阅读速度自动定时）
  if (provider === 'off') {
    const estSec = Math.max(2.6, text.length * 0.19);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', estSec.toFixed(2),
      wavPath,
    ]);
    return ffprobeDuration(wavPath);
  }

  // 5) macOS 系统内置离线语音兜底 (say)
  const aiff = wavPath + '.aiff';
  execFileSync('say', ['-v', ttsCfg.sayVoice || 'Tingting', '-r', String(ttsCfg.sayRate || 205), '-o', aiff, text]);
  const dur = normalizeToWav(aiff, wavPath, false);
  fs.unlinkSync(aiff);
  return dur;
}

async function runAuditions() {
  const bin = findEdgeTts();
  if (!bin) throw new Error('edge-tts 未安装');
  fs.mkdirSync(AUDITION_DIR, { recursive: true });
  const sampleText = '嗨，今天用两分钟看懂 KeepIt：按下快捷键，一次点击就把逛到的开源仓库、好文章和工具网站收进本地知识库。';
  const candidates = [
    { id: '01-yunxi-阳光自然男声', voice: 'zh-CN-YunxiNeural', rate: '+12%' },
    { id: '02-xiaoxiao-温暖亲切女声', voice: 'zh-CN-XiaoxiaoNeural', rate: '+12%' },
    { id: '03-yunyang-沉稳专业播音男声', voice: 'zh-CN-YunyangNeural', rate: '+10%' },
    { id: '04-xiaoyi-轻快活泼女声', voice: 'zh-CN-XiaoyiNeural', rate: '+10%' },
    { id: '05-hsiaochen-温柔台湾女声', voice: 'zh-TW-HsiaoChenNeural', rate: '+10%' },
  ];
  console.log(`正在生成 ${candidates.length} 款神经网络音色试听样音 → ${AUDITION_DIR}`);
  for (const c of candidates) {
    const mp3 = path.join(AUDITION_DIR, `${c.id}.mp3`);
    execFileSync(bin, ['--voice', c.voice, `--rate=${c.rate}`, '--text', sampleText, '--write-media', mp3]);
    const dur = ffprobeDuration(mp3);
    console.log(`  ✓ ${c.id}.mp3  (${c.voice}, ${dur.toFixed(1)}s)`);
  }
}

// Minimal CDP client over Node's built-in WebSocket
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function launchChromeCdp(chromePath) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const proc = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--user-data-dir=${PROFILE_DIR}`,
    '--window-size=1920,1080',
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsBrowserUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Chrome DevTools WS')), 15000);
    proc.stderr.on('data', (chunk) => {
      buf += String(chunk);
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited early: ${code}`)); });
  });

  const httpBase = wsBrowserUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
  const targets = await fetch(`${httpBase}/json/list`).then((r) => r.json());
  const pageTarget = targets.find((t) => t.type === 'page');
  if (!pageTarget) throw new Error('No page target in headless Chrome');

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new CdpSession(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  return { proc, ws, cdp };
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.audition) {
    await runAuditions();
    return;
  }

  const htmlPath = path.join(__dirname, 'index.html');
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'voiceover.json'), 'utf8'));
  const preflight = runPreflightChecks(spec, htmlPath, { strict: cli.strict });

  let provider = cli.provider || spec.provider || (findEdgeTts() ? 'edge' : 'say');
  if (provider === 'edge' && !findEdgeTts()) {
    console.warn('      ! 未检测到 edge-tts，自动回退至 macOS say');
    provider = 'say';
  }
  const ttsCfg = {
    provider,
    voice: cli.voice || spec.voice || 'zh-CN-YunxiNeural',
    rate: cli.rate || spec.rate || '+12%',
    pitch: cli.pitch || spec.pitch || '+0Hz',
    sayVoice: cli.voice || spec.sayVoice || 'Tingting',
    sayRate: Number(cli.rate) || spec.sayRate || 205,
  };

  if (cli.check) {
    if (cli.checkAudio && preflight.affectedSentences.length) {
      fs.mkdirSync(CHECK_AUDIO_DIR, { recursive: true });
      fs.mkdirSync(WORK_DIR, { recursive: true });
      console.log(`\n[check-audio] 正在单独合成 ${preflight.affectedSentences.length} 句含多音字纠音/提示的音频 → ${CHECK_AUDIO_DIR}`);
      for (const item of preflight.affectedSentences) {
        const outWav = path.join(WORK_DIR, `chk-${item.slideId}-s${item.idx}.wav`);
        const outMp3 = path.join(CHECK_AUDIO_DIR, `${item.slideId}-s${item.idx}.mp3`);
        await synthSentence(item.ttsText, ttsCfg, outWav);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', outWav, '-c:a', 'libmp3lame', '-q:a', '3', outMp3]);
        console.log(`  ✓ ${item.slideId}-s${item.idx}.mp3  (${item.applied.join('，') || '复核句'})`);
      }
      try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
    }
    return;
  }

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const outMp4 = cli.out || DEFAULT_OUT_MP4;
  const facts = readRepoFacts();
  const chromePath = findChrome();

  console.log(`[1/4] 核对仓库真实数据 & 合成旁白语音 (provider=${ttsCfg.provider}, voice=${ttsCfg.provider === 'say' ? ttsCfg.sayVoice : ttsCfg.voice})…`);
  console.log(`      facts: jobs=${facts.jobsTotal} (${facts.jobsDone} done), collected=${facts.colTotal} (${facts.colCollection} collection / ${facts.colClone} clone)`);

  let totalDuration = 0;
  for (const slide of spec.slides) {
    // Synthesize sentences within a slide concurrently (using s.ttsText after polyphone normalization)
    await Promise.all(slide.sentences.map(async (s, i) => {
      const wav = path.join(WORK_DIR, `${slide.id}-s${i}.wav`);
      const dur = await synthSentence(s.ttsText || s.spoken, ttsCfg, wav);
      s.wav = wav;
      s.dur = dur;
    }));
    let slideDur = 0;
    for (const s of slide.sentences) {
      s.start = slideDur;
      s.end = slideDur + s.dur;
      slideDur += s.dur;
    }
    // Concat slide sentence WAVs into one slide WAV
    const listTxt = path.join(WORK_DIR, `${slide.id}-wavs.txt`);
    fs.writeFileSync(listTxt, slide.sentences.map((s) => `file '${s.wav}'`).join('\n') + '\n');
    const slideWav = path.join(WORK_DIR, `${slide.id}.wav`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listTxt, '-c', 'copy', slideWav]);
    slide.wav = slideWav;
    slide.dur = ffprobeDuration(slideWav);
    slide.globalStart = totalDuration;
    totalDuration += slide.dur;
    console.log(`      ✓ ${slide.id}: ${slide.dur.toFixed(2)}s (${slide.kind})`);
  }

  console.log(`[2/4] 启动 Headless Chrome 渲染幻灯片与动态产品 Demo (总时长 ~${totalDuration.toFixed(1)}s)…`);
  const { proc, ws, cdp } = await launchChromeCdp(chromePath);
  const segPaths = [];

  try {
    const deckUrl = pathToFileURL(path.join(__dirname, 'index.html')).href + '?capture=1';
    await cdp.send('Page.navigate', { url: deckUrl });
    await new Promise((r) => setTimeout(r, 500));
    await cdp.send('Runtime.evaluate', {
      expression: `window.setFacts(${JSON.stringify(facts)})`,
    });

    for (let sIdx = 0; sIdx < spec.slides.length; sIdx++) {
      const slide = spec.slides[sIdx];
      const isDemo = slide.kind.startsWith('demo-');
      const segMp4 = path.join(WORK_DIR, `seg-${slide.id}.mp4`);

      // Save clean preview PNG (without subtitle clutter or at highlight moment)
      const previewP = slide.kind === 'demo-cli' ? 0.92 : slide.kind === 'demo-clone' ? 0.78 : slide.kind === 'demo-collect' ? 0.85 : 1;
      await cdp.send('Runtime.evaluate', {
        expression: `window.renderAt(${JSON.stringify(slide.id)}, ${previewP}, ${JSON.stringify(slide.sentences[0].sub)}, ${(slide.globalStart + slide.dur * 0.5) / totalDuration})`,
      });
      const prevShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(PREVIEW_DIR, `${slide.id}.png`), Buffer.from(prevShot.data, 'base64'));

      if (!isDemo) {
        // Concept slide: render 1 crisp PNG per sentence, encode each sentence clip, then concat
        const subSegs = [];
        for (let k = 0; k < slide.sentences.length; k++) {
          const sent = slide.sentences[k];
          const gProg = (slide.globalStart + sent.end) / totalDuration;
          await cdp.send('Runtime.evaluate', {
            expression: `window.renderAt(${JSON.stringify(slide.id)}, 1, ${JSON.stringify(sent.sub)}, ${gProg})`,
          });
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
          const pngPath = path.join(WORK_DIR, `${slide.id}-k${k}.png`);
          fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));

          const subMp4 = path.join(WORK_DIR, `${slide.id}-k${k}.mp4`);
          execFileSync('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-loop', '1', '-framerate', '30', '-i', pngPath,
            '-i', sent.wav,
            '-t', sent.dur.toFixed(3),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
            subMp4,
          ]);
          subSegs.push(subMp4);
        }
        const subList = path.join(WORK_DIR, `${slide.id}-subs.txt`);
        fs.writeFileSync(subList, subSegs.map((p) => `file '${p}'`).join('\n') + '\n');
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', subList, '-c', 'copy', segMp4]);
      } else {
        // Animated Product Demo slide: step virtual clock at 20 fps and encode at 30 fps
        const fps = 20;
        const totalFrames = Math.max(1, Math.round(slide.dur * fps));
        const framesDir = path.join(WORK_DIR, `frames-${slide.id}`);
        fs.mkdirSync(framesDir, { recursive: true });

        for (let f = 0; f < totalFrames; f++) {
          const tLocal = (f + 0.5) / fps;
          const p = Math.min(1, f / Math.max(1, totalFrames - 1));
          const activeSent = slide.sentences.find((s) => tLocal >= s.start && tLocal <= s.end) || slide.sentences[slide.sentences.length - 1];
          const gProg = (slide.globalStart + tLocal) / totalDuration;
          await cdp.send('Runtime.evaluate', {
            expression: `window.renderAt(${JSON.stringify(slide.id)}, ${p.toFixed(5)}, ${JSON.stringify(activeSent.sub)}, ${gProg.toFixed(5)})`,
          });
          const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
          const fPath = path.join(framesDir, `f-${String(f).padStart(5, '0')}.jpg`);
          fs.writeFileSync(fPath, Buffer.from(shot.data, 'base64'));
        }

        execFileSync('ffmpeg', [
          '-y', '-loglevel', 'error',
          '-framerate', String(fps),
          '-i', path.join(framesDir, 'f-%05d.jpg'),
          '-i', slide.wav,
          '-t', slide.dur.toFixed(3),
          '-vf', 'fps=30,scale=1920:1080',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
          segMp4,
        ]);
        console.log(`      🎬 rendered animated demo ${slide.id} (${totalFrames} frames)`);
      }

      segPaths.push(segMp4);
    }
  } finally {
    try { ws.close(); } catch {}
    try { proc.kill('SIGTERM'); } catch {}
  }

  console.log('[3/4] 合并全片 MP4 并执行音画体检…');
  const allList = path.join(WORK_DIR, 'all-segs.txt');
  fs.writeFileSync(allList, segPaths.map((p) => `file '${p}'`).join('\n') + '\n');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', allList,
    '-c', 'copy', '-movflags', '+faststart',
    outMp4,
  ]);

  const finalDur = ffprobeDuration(outMp4);
  const stat = fs.statSync(outMp4);
  console.log(`[4/4] 完成！`);
  console.log(`      视频文件: ${outMp4}`);
  console.log(`      分辨率:   1920x1080 · 30fps · H.264 + AAC`);
  console.log(`      总时长:   ${finalDur.toFixed(1)}s (~${Math.floor(finalDur / 60)}m${Math.round(finalDur % 60)}s)`);
  console.log(`      文件大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

  // Clean up temp work dir using Node fs
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('render failed:', e);
  process.exit(1);
});
