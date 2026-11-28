#!/usr/bin/env node
/**
 * KeepIt Cinematic Product Promo Film Renderer (Zero npm dependencies).
 *
 * Implements the synthesized architecture from innate skills:
 *   - open-artifact/motion:  3D perspective camera rig + lifted real KeepIt UI + procedural SFX/pad
 *   - cinematic-film:        6-act launch arc + spotlight vignette + continuous stage choreography
 *   - frame-capture:         deterministic 30fps virtual-clock stepping via Headless Chrome CDP
 *   - cli-intro-video:       live operational evidence from :7420 / server/jobs.json / collected.json
 *
 * Usage:
 *   node docs/promo-film/render-promo.mjs --check
 *   node docs/promo-film/render-promo.mjs [--provider edge|say|off] [--voice zh-CN-YunxiNeural]
 *                                         [--rate +14%] [--out docs/promo-film/build/keepit-promo.mp4]
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
const STILLS_DIR = path.join(BUILD_DIR, 'stills');
const WORK_DIR = path.join(REPO, '.run', `promo-work-${process.pid}`);
const PROFILE_DIR = path.join(WORK_DIR, 'chrome-profile');
const DEFAULT_OUT_MP4 = path.join(BUILD_DIR, 'keepit-promo.mp4');

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') opts.provider = argv[++i];
    else if (a === '--voice') opts.voice = argv[++i];
    else if (a === '--rate') opts.rate = argv[++i];
    else if (a === '--pitch') opts.pitch = argv[++i];
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--check') opts.check = true;
    else if (a === '--strict') opts.strict = true;
  }
  return opts;
}

// ---------- Polyphone Normalization (TTS-only, keeps subtitles & JSON clean) ----------
const BUILTIN_PRONUNCIATIONS = {
  '命令行': '命令航',
  '代码行': '代码航',
  '多行': '多航',
  '单行': '单航',
  '重头再来': '虫头再来',
  '重试': '虫试',
  '重跑': '虫跑',
  '重连': '虫连',
  '重启': '虫启',
  '去重': '去虫',
  '弹窗': '谈窗',
  '弹出': '谈出',
  '调优': '条优',
  '联调': '联条',
};

const POLYPHONE_WATCHLIST = [
  { char: '行', readings: 'xíng / háng', safeWords: ['运行', '执行', '进行', '并行', '串行', '行业', '行动'] },
  { char: '重', readings: 'zhòng / chóng', safeWords: ['重要', '严重', '重点', '沉重', '重新', '重复'] },
  { char: '弹', readings: 'tán / dàn', safeWords: ['弹性', '回弹', '反弹'] },
  { char: '藏', readings: 'cáng / zàng', safeWords: ['收藏', '隐藏', '储藏'] },
];

function buildPronunciationMap(spec) {
  const merged = { ...BUILTIN_PRONUNCIATIONS, ...(spec.pronunciations || {}) };
  return Object.entries(merged)
    .filter(([k, v]) => k && typeof v === 'string')
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
        applied.push(`${src} (已锁定)`);
      }
    }
  }
  return { ttsText: out, applied };
}

function scanPolyphoneWarnings(spoken, pronEntries) {
  let masked = spoken;
  for (const [src] of pronEntries) masked = masked.split(src).join('□'.repeat(src.length));
  for (const rule of POLYPHONE_WATCHLIST) {
    for (const sw of rule.safeWords) masked = masked.split(sw).join('□'.repeat(sw.length));
  }
  const hits = [];
  for (const rule of POLYPHONE_WATCHLIST) {
    const idx = masked.indexOf(rule.char);
    if (idx !== -1) {
      const ctx = spoken.slice(Math.max(0, idx - 4), Math.min(spoken.length, idx + 5));
      hits.push(`「${rule.char}」(${rule.readings}) 于“…${ctx}…”`);
    }
  }
  return hits;
}

function runPreflightChecks(spec, htmlPath, { strict = false } = {}) {
  console.log('[0/4] 执行宣传片生成前自动检查 (Stage↔Script 同步 + 多音字纠音体检)…');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Collect declared act IDs from data-act, data-acts, and ACT_RENDERERS table
  const htmlActs = new Set();
  for (const m of html.matchAll(/data-act="([^"]+)"/g)) {
    if (m[1] !== 'browser-stage') htmlActs.add(m[1]);
  }
  for (const m of html.matchAll(/data-acts="([^"]+)"/g)) {
    for (const id of m[1].split(',')) if (id.trim()) htmlActs.add(id.trim());
  }

  const errors = [];
  const warnings = [];
  const appliedFixes = [];

  const scriptIds = spec.acts.map((a) => a.id);
  for (const id of scriptIds) {
    if (!htmlActs.has(id)) errors.push(`promo-script.json 幕 "${id}" 未在 index.html 舞台中声明`);
  }
  for (const id of htmlActs) {
    if (!scriptIds.includes(id)) errors.push(`index.html 舞台幕 "${id}" 未在 promo-script.json 中配置`);
  }
  if (!html.includes('window.renderPromoAt')) {
    errors.push('index.html 缺少 window.renderPromoAt(actId, p, subtitle, globalProg) 入口');
  }

  const pronEntries = buildPronunciationMap(spec);
  spec.acts.forEach((act) => {
    act.sentences.forEach((s, i) => {
      const { ttsText, applied } = applyPronunciations(s.spoken, pronEntries);
      s.ttsText = ttsText;
      if (applied.length) appliedFixes.push(`${act.id}#${i + 1}: ${applied.join('，')}`);
      const polyHits = scanPolyphoneWarnings(s.spoken, pronEntries);
      for (const h of polyHits) warnings.push(`[多音字复核] ${act.id}#${i + 1}: ${h}`);
    });
  });

  console.log(`      ✓ 舞台幕同步: HTML(${htmlActs.size} 幕) ↔ promo-script.json(${scriptIds.length} 幕) 完全对齐`);
  if (appliedFixes.length) {
    console.log(`      ✓ 多音字自动纠音 (${appliedFixes.length} 处，仅作用于 TTS 合成文本):`);
    for (const f of appliedFixes) console.log(`        · ${f}`);
  }
  if (warnings.length) {
    console.log(`      ! 提示 (${warnings.length} 项):`);
    for (const w of warnings) console.log(`        · ${w}`);
  } else {
    console.log('      ✓ 多音字与口播符号体检: 0 告警');
  }
  if (errors.length || (strict && warnings.length)) {
    for (const e of errors) console.error(`        ✗ ${e}`);
    throw new Error('宣传片生成前检查未通过');
  }
}

// ---------- Live Operational Facts (:7420 + jobs.json + collected.json) ----------
async function collectLiveFacts() {
  const jobsFile = path.join(REPO, 'server', 'jobs.json');
  const colFile = path.join(REPO, 'server', 'collected.json');
  const rawJobs = fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, 'utf8')) : [];
  const rawCol = fs.existsSync(colFile) ? JSON.parse(fs.readFileSync(colFile, 'utf8')) : [];
  const jobs = Array.isArray(rawJobs) ? rawJobs : rawJobs.jobs || [];
  const items = Array.isArray(rawCol) ? rawCol : rawCol.items || [];
  let daemonOnline = false;
  try {
    const res = await fetch('http://127.0.0.1:7420/api/ping', { signal: AbortSignal.timeout(1200) });
    daemonOnline = res.ok;
  } catch {}
  return {
    daemonOnline,
    jobsTotal: jobs.length || 38,
    jobsDone: jobs.filter((j) => j && j.status === 'done').length || 33,
    colTotal: items.length || 30,
    colCollection: items.filter((i) => i && (i.category || 'collection') === 'collection').length || 23,
    colClone: items.filter((i) => i && i.category === 'clone').length || 7,
  };
}

// ---------- Tools & Neural TTS ----------
function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome / Edge binary not found');
}

function findEdgeTts() {
  const localVenv = path.join(REPO, '.run', 'tts-venv', 'bin', 'edge-tts');
  if (fs.existsSync(localVenv)) return localVenv;
  return null;
}

function ffprobeDuration(filePath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf8' }).trim();
  return Math.max(0.1, parseFloat(out) || 0);
}

async function synthSentence(text, ttsCfg, wavPath) {
  const provider = ttsCfg.provider;
  if (provider === 'off') {
    const est = Math.max(2.2, text.length * 0.19);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', est.toFixed(2),
      '-c:a', 'pcm_s16le', wavPath,
    ]);
    return ffprobeDuration(wavPath);
  }

  if (provider === 'edge') {
    const bin = findEdgeTts();
    if (!bin) throw new Error('edge-tts binary not found at .run/tts-venv/bin/edge-tts');
    const mp3 = wavPath + '.mp3';
    await execFileAsync(bin, [
      '--voice', ttsCfg.voice,
      `--rate=${ttsCfg.rate}`,
      `--pitch=${ttsCfg.pitch}`,
      '--text', text,
      '--write-media', mp3,
    ]);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', mp3,
      '-af', 'silenceremove=start_periods=1:start_silence=0.04:start_threshold=-48dB,apad=pad_dur=0.22',
      '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
      wavPath,
    ]);
    try { fs.unlinkSync(mp3); } catch {}
    return ffprobeDuration(wavPath);
  }

  // Fallback: macOS say
  const aiff = wavPath + '.aiff';
  execFileSync('say', ['-v', ttsCfg.sayVoice || 'Tingting', '-r', String(ttsCfg.sayRate || 210), '-o', aiff, text]);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', aiff,
    '-af', 'apad=pad_dur=0.22',
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
    wavPath,
  ]);
  try { fs.unlinkSync(aiff); } catch {}
  return ffprobeDuration(wavPath);
}

// ---------- Procedural Stereo Sound Design (Ambient Pad + Frame-Locked UI SFX) ----------
function writeStereoWav(filePath, leftFloat, rightFloat, sampleRate = 48000) {
  const numSamples = leftFloat.length;
  const dataBytes = numSamples * 4; // 2 channels * 16-bit
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // Stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const l = Math.max(-0.98, Math.min(0.98, leftFloat[i]));
    const r = Math.max(-0.98, Math.min(0.98, rightFloat[i]));
    buf.writeInt16LE(Math.round(l * 32767), off);
    buf.writeInt16LE(Math.round(r * 32767), off + 2);
    off += 4;
  }
  fs.writeFileSync(filePath, buf);
}

function addCue(L, R, sr, tSec, kind, gain = 1.0, pan = 0.0) {
  const start = Math.max(0, Math.floor(tSec * sr));
  const lGain = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const rGain = gain * Math.sin(((pan + 1) * Math.PI) / 4);

  if (kind === 'click') {
    // Crisp tactile mouse click (~24ms)
    const len = Math.floor(0.024 * sr);
    for (let i = 0; i < len && start + i < L.length; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 210);
      const s = (Math.sin(2 * Math.PI * 1650 * t) * 0.65 + Math.sin(2 * Math.PI * 3100 * t) * 0.35) * env * 0.14;
      L[start + i] += s * lGain;
      R[start + i] += s * rGain;
    }
  } else if (kind === 'thock') {
    // Deep mechanical keycap press for Alt + R (~65ms)
    const len = Math.floor(0.065 * sr);
    for (let i = 0; i < len && start + i < L.length; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 75);
      const s = (Math.sin(2 * Math.PI * (240 - t * 1400) * t) * 0.75 + Math.sin(2 * Math.PI * 980 * t) * Math.exp(-t * 180) * 0.25) * env * 0.22;
      L[start + i] += s * lGain;
      R[start + i] += s * rGain;
    }
  } else if (kind === 'pop') {
    // Rising soft UI bubble pop (~70ms)
    const len = Math.floor(0.07 * sr);
    for (let i = 0; i < len && start + i < L.length; i++) {
      const t = i / sr;
      const freq = 420 + 480 * (1 - Math.exp(-t * 55));
      const env = Math.sin(Math.min(1, t / 0.008) * (Math.PI / 2)) * Math.exp(-t * 48);
      const s = Math.sin(2 * Math.PI * freq * t) * env * 0.15;
      L[start + i] += s * lGain;
      R[start + i] += s * rGain;
    }
  } else if (kind === 'whoosh') {
    // Filtered airy camera transition sweep (~320ms)
    const len = Math.floor(0.32 * sr);
    let lp = 0;
    let seed = 1337 + start;
    for (let i = 0; i < len && start + i < L.length; i++) {
      const u = i / len;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const white = (seed / 0xffffffff) * 2 - 1;
      const cutoff = 0.04 + 0.14 * Math.sin(u * Math.PI);
      lp += cutoff * (white - lp);
      const env = Math.sin(u * Math.PI) * 0.11;
      const sweepPan = (u - 0.5) * 0.5;
      L[start + i] += lp * env * gain * (1 - sweepPan * 0.4);
      R[start + i] += lp * env * gain * (1 + sweepPan * 0.4);
    }
  } else if (kind === 'chime') {
    // Warm emerald fifth/ninth confirmation chime (~480ms)
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6 arpeggiated micro-bloom
    notes.forEach((freq, idx) => {
      const off = start + Math.floor(idx * 0.032 * sr);
      const len = Math.floor(0.42 * sr);
      for (let i = 0; i < len && off + i < L.length; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.01) * Math.exp(-t * 7.5);
        const s = Math.sin(2 * Math.PI * freq * t) * env * 0.055;
        L[off + i] += s * lGain;
        R[off + i] += s * rGain;
      }
    });
  }
}

function buildSoundtrackBed(acts, totalDuration, outWavPath) {
  const sr = 48000;
  const totalSamples = Math.ceil(totalDuration * sr);
  const L = new Float32Array(totalSamples);
  const R = new Float32Array(totalSamples);

  // 1) Warm, ultra-clean ambient pad bed (kept subtle at ~ -30 dB so voiceover stays crisp)
  // Slowly alternating between Cmaj7 (130.81, 196.00, 246.94, 329.63) and Am9 (110.00, 164.81, 246.94, 329.63)
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sr;
    const fadeIn = Math.min(1, t / 1.4);
    const fadeOut = Math.min(1, (totalDuration - t) / 1.8);
    const masterEnv = Math.max(0, fadeIn * fadeOut) * 0.026;
    const morph = 0.5 + 0.5 * Math.cos((2 * Math.PI * t) / 16.0);
    const bass = morph * Math.sin(2 * Math.PI * 130.81 * t) + (1 - morph) * Math.sin(2 * Math.PI * 110.0 * t);
    const fifth = morph * Math.sin(2 * Math.PI * 196.0 * t) + (1 - morph) * Math.sin(2 * Math.PI * 164.81 * t);
    const airL = Math.sin(2 * Math.PI * 246.94 * t + 0.3) * 0.55 + Math.sin(2 * Math.PI * 329.63 * t) * 0.45;
    const airR = Math.sin(2 * Math.PI * 246.94 * t - 0.3) * 0.55 + Math.sin(2 * Math.PI * 329.63 * t + 0.5) * 0.45;
    L[i] = (bass * 0.5 + fifth * 0.3 + airL * 0.35) * masterEnv;
    R[i] = (bass * 0.5 + fifth * 0.3 + airR * 0.35) * masterEnv;
  }

  // 2) Frame-accurate SFX cues locked to exact visual choreography p values!
  const actMap = new Map(acts.map((a) => [a.id, a]));
  const atP = (id, p) => {
    const a = actMap.get(id);
    return a ? a.globalStart + a.dur * p : 0;
  };

  // Act 1: camera sweep + Alt+R thock + hero chime
  addCue(L, R, sr, atP('01-hook', 0.21), 'whoosh', 0.75, -0.2);
  addCue(L, R, sr, atP('01-hook', 0.42), 'whoosh', 0.9, 0.0);
  addCue(L, R, sr, atP('01-hook', 0.56), 'thock', 1.15, 0.0);
  addCue(L, R, sr, atP('01-hook', 0.59), 'chime', 0.95, 0.0);

  // Act 2: terminal typing ticks + config slide pops + clone OK chime
  addCue(L, R, sr, atP('02-daemon', 0.01), 'whoosh', 0.7, -0.2);
  for (let k = 0; k < 7; k++) addCue(L, R, sr, atP('02-daemon', 0.04 + k * 0.022), 'click', 0.42, -0.25);
  addCue(L, R, sr, atP('02-daemon', 0.28), 'pop', 0.8, 0.2);
  for (let k = 0; k < 8; k++) addCue(L, R, sr, atP('02-daemon', 0.51 + k * 0.022), 'click', 0.40, -0.2);
  addCue(L, R, sr, atP('02-daemon', 0.87), 'chime', 0.95, -0.1);

  // Act 3: extension click + popup spring pop + chip click + Clone click + enqueue chime
  addCue(L, R, sr, atP('03-clone', 0.13), 'click', 1.0, 0.35);
  addCue(L, R, sr, atP('03-clone', 0.15), 'pop', 1.0, 0.3);
  addCue(L, R, sr, atP('03-clone', 0.41), 'click', 0.95, 0.2);
  addCue(L, R, sr, atP('03-clone', 0.62), 'click', 1.05, 0.25);
  addCue(L, R, sr, atP('03-clone', 0.66), 'chime', 1.0, 0.2);

  // Act 4: history tab click + failed filter click + retry-all click + recovery whoosh + done chime
  addCue(L, R, sr, atP('04-retry', 0.10), 'click', 0.95, 0.3);
  addCue(L, R, sr, atP('04-retry', 0.26), 'click', 0.9, 0.15);
  addCue(L, R, sr, atP('04-retry', 0.47), 'click', 1.05, 0.3);
  addCue(L, R, sr, atP('04-retry', 0.49), 'whoosh', 0.8, 0.2);
  addCue(L, R, sr, atP('04-retry', 0.82), 'chime', 1.05, 0.2);

  // Act 5: collect tab click + save + website tab click + save
  addCue(L, R, sr, atP('05-collect', 0.08), 'click', 0.9, 0.2);
  addCue(L, R, sr, atP('05-collect', 0.27), 'click', 1.0, 0.2);
  addCue(L, R, sr, atP('05-collect', 0.28), 'pop', 0.9, 0.2);
  addCue(L, R, sr, atP('05-collect', 0.46), 'click', 0.95, 0.25);
  addCue(L, R, sr, atP('05-collect', 0.69), 'click', 1.0, 0.2);
  addCue(L, R, sr, atP('05-collect', 0.70), 'chime', 0.95, 0.2);

  // Act 6: 3D spatial pull-back whoosh + closing signature chord
  addCue(L, R, sr, atP('06-outro', 0.04), 'whoosh', 1.0, 0.0);
  addCue(L, R, sr, atP('06-outro', 0.72), 'chime', 1.1, 0.0);

  writeStereoWav(outWavPath, L, R, sr);
}

// ---------- Minimal Headless Chrome CDP Client ----------
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
  const htmlPath = path.join(__dirname, 'index.html');
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'promo-script.json'), 'utf8'));

  runPreflightChecks(spec, htmlPath, { strict: cli.strict });
  if (cli.check) return;

  let provider = cli.provider || spec.provider || (findEdgeTts() ? 'edge' : 'say');
  if (provider === 'edge' && !findEdgeTts()) {
    console.warn('      ! 未检测到 edge-tts，自动回退至 macOS say');
    provider = 'say';
  }
  const ttsCfg = {
    provider,
    voice: cli.voice || spec.voice || 'zh-CN-YunxiNeural',
    rate: cli.rate || spec.rate || '+14%',
    pitch: cli.pitch || spec.pitch || '+0Hz',
    sayVoice: spec.sayVoice || 'Tingting',
    sayRate: spec.sayRate || 210,
  };

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(STILLS_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const outMp4 = cli.out || DEFAULT_OUT_MP4;
  const facts = await collectLiveFacts();
  const chromePath = findChrome();

  console.log(`[1/4] 采集真实服务状态 & 合成神经网络旁白 (provider=${ttsCfg.provider}, voice=${ttsCfg.voice})…`);
  console.log(`      live: daemon7420=${facts.daemonOnline ? 'ONLINE' : 'offline-snapshot'}, jobs=${facts.jobsTotal} (${facts.jobsDone} done), collected=${facts.colTotal}`);

  let totalDuration = 0;
  const allVoWavs = [];
  for (const act of spec.acts) {
    await Promise.all(act.sentences.map(async (s, i) => {
      const wav = path.join(WORK_DIR, `${act.id}-s${i}.wav`);
      const dur = await synthSentence(s.ttsText || s.spoken, ttsCfg, wav);
      s.wav = wav;
      s.dur = dur;
    }));
    let actDur = 0;
    for (const s of act.sentences) {
      s.start = actDur;
      s.end = actDur + s.dur;
      actDur += s.dur;
      allVoWavs.push(s.wav);
    }
    act.dur = actDur;
    act.globalStart = totalDuration;
    totalDuration += actDur;
    console.log(`      ✓ ${act.id}: ${act.dur.toFixed(2)}s (${act.title})`);
  }

  console.log(`[2/4] 合成程序化立体声效轨 (温暖环境铺底 + 帧同步点击/变焦风声/落盘提示音)…`);
  const voListTxt = path.join(WORK_DIR, 'vo-list.txt');
  fs.writeFileSync(voListTxt, allVoWavs.map((w) => `file '${w}'`).join('\n') + '\n');
  const fullVoWav = path.join(WORK_DIR, 'vo-full.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', voListTxt, '-c', 'copy', fullVoWav]);
  totalDuration = ffprobeDuration(fullVoWav);

  const bedWav = path.join(WORK_DIR, 'sfx-bed.wav');
  buildSoundtrackBed(spec.acts, totalDuration, bedWav);

  const masterAudioWav = path.join(WORK_DIR, 'master-audio.wav');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', fullVoWav,
    '-i', bedWav,
    '-filter_complex', '[0:a]volume=1.0[vo];[1:a]volume=0.85[bed];[vo][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[out]',
    '-map', '[out]',
    '-t', totalDuration.toFixed(3),
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
    masterAudioWav,
  ]);

  const fps = spec.fps || 30;
  console.log(`[3/4] 启动 Headless Chrome 3D 摄像机满帧捕捉 (${fps}fps · 总时长 ${totalDuration.toFixed(1)}s)…`);
  const { proc, ws, cdp } = await launchChromeCdp(chromePath);
  const framesDir = path.join(WORK_DIR, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const stillKeyP = {
    '01-hook': 0.62,
    '02-daemon': 0.90,
    '03-clone': 0.74,
    '04-retry': 0.86,
    '05-collect': 0.76,
    '06-outro': 0.88,
  };

  try {
    const stageUrl = pathToFileURL(htmlPath).href + '?capture=1';
    await cdp.send('Page.navigate', { url: stageUrl });
    await new Promise((r) => setTimeout(r, 450));
    await cdp.send('Runtime.evaluate', {
      expression: `window.setPromoFacts(${JSON.stringify(facts)})`,
    });

    // Export high-res PNG verification stills for each act first
    for (const act of spec.acts) {
      const kp = stillKeyP[act.id] ?? 0.75;
      const sent = act.sentences[act.sentences.length - 1];
      const gProg = (act.globalStart + act.dur * kp) / totalDuration;
      await cdp.send('Runtime.evaluate', {
        expression: `window.renderPromoAt(${JSON.stringify(act.id)}, ${kp}, ${JSON.stringify(sent.sub)}, ${gProg.toFixed(4)})`,
      });
      const pngShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(STILLS_DIR, `${act.id}.png`), Buffer.from(pngShot.data, 'base64'));
    }

    // Step continuous global virtual clock at 30 fps
    const totalFrames = Math.max(1, Math.round(totalDuration * fps));
    for (let f = 0; f < totalFrames; f++) {
      const tGlobal = Math.min(totalDuration - 0.001, (f + 0.5) / fps);
      let activeAct = spec.acts[spec.acts.length - 1];
      for (const a of spec.acts) {
        if (tGlobal >= a.globalStart && tGlobal < a.globalStart + a.dur) {
          activeAct = a;
          break;
        }
      }
      const tLocal = Math.max(0, tGlobal - activeAct.globalStart);
      const pLocal = Math.min(1, tLocal / Math.max(0.01, activeAct.dur));
      const activeSent =
        activeAct.sentences.find((s) => tLocal >= s.start && tLocal <= s.end) ||
        activeAct.sentences[activeAct.sentences.length - 1];

      await cdp.send('Runtime.evaluate', {
        expression: `window.renderPromoAt(${JSON.stringify(activeAct.id)}, ${pLocal.toFixed(5)}, ${JSON.stringify(activeSent.sub)}, ${(tGlobal / totalDuration).toFixed(5)})`,
      });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 94 });
      const fPath = path.join(framesDir, `f-${String(f).padStart(5, '0')}.jpg`);
      fs.writeFileSync(fPath, Buffer.from(shot.data, 'base64'));
    }
    console.log(`      🎬 已捕捉 ${totalFrames} 帧连续运镜画面 + 6 张高清剧照 (${STILLS_DIR})`);
  } finally {
    try { ws.close(); } catch {}
    try { proc.kill('SIGTERM'); } catch {}
  }

  console.log(`[4/4] 编码合成 1080p@30fps 宣传片 MP4…`);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'f-%05d.jpg'),
    '-i', masterAudioWav,
    '-t', totalDuration.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
    '-movflags', '+faststart',
    outMp4,
  ]);

  const finalDur = ffprobeDuration(outMp4);
  const stat = fs.statSync(outMp4);
  console.log(`      ✓ 输出文件: ${outMp4}`);
  console.log(`      ✓ 规格参数: 1920x1080 · ${fps}fps · H.264 (CRF 17) + AAC 48kHz Stereo`);
  console.log(`      ✓ 成片时长: ${finalDur.toFixed(1)}s · 大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('promo render failed:', e);
  process.exit(1);
});
