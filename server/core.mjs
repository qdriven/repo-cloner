/* CloneIt core — shared logic for the server (HTTP) and CLI entry points.
 *
 * Zero-dependency Node ≥ 18. Holds: config parsing, git execution (with
 * progress parsing), clone/pull logic, async job queue with history
 * persistence, references tree / registry scanning, collected-link storage
 * (收藏: record article addresses locally, no crawling yet) and the
 * clone-website placeholder (处理逻辑留空, planned for later).
 *
 * Both clone-it-server.mjs and clone-it-cli.mjs import this and add
 * their own surface (HTTP routes / command-line).
 */
'use strict';

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const VERSION = '0.3.0';
export const DEFAULT_PORT = 7420;
export const ORIGIN_ALLOW = new Set([
  'chrome-extension://',
  'moz-extension://',
]);

// Request token header used when --token is set.
export const TOKEN_HEADER = 'x-cloneit-token';

// ---------- config ----------
export function parseConfig(argv) {
  const argVal = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !argVal(a)));

  const wsArgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' && argv[i + 1]) wsArgs.push(argv[i + 1]);
  }

  const WORKSPACES = (wsArgs.length ? wsArgs : [process.cwd()]).map((dir, i) => {
    const abs = path.resolve(dir);
    const name = path.basename(abs) || 'ws' + i;
    return { id: 'ws' + i, name, dir: abs };
  });

  return {
    argv,
    port: Number(argVal('--port')) || DEFAULT_PORT,
    token: argVal('--token') || null,
    watchClipboard: flags.has('--watch-clipboard'),
    noPull: flags.has('--no-pull'),
    full: flags.has('--full'),
    cloneTimeout: Number(argVal('--clone-timeout')) || 0,
    mirror: argVal('--mirror') || null,
    proxy: argVal('--proxy') || null,
    retry: Number(argVal('--retry')) || 3,
    // max concurrent clone jobs; default 5 (user requirement: at most 5 in parallel)
    maxConcurrent: Math.max(1, Number(argVal('--max-concurrent')) || 5),
    workspaces: WORKSPACES,
    jobsFile: path.join(__dirname, 'jobs.json'),
  };
}

// ---------- helpers ----------
export function wsById(workspaces, id) {
  return workspaces.find((w) => w.id === id) || workspaces[0];
}

export function referencesRoot(ws) {
  return path.join(ws.dir, 'references');
}

export function netArgs(cfg, url) {
  const finalUrl = cfg.mirror && /^https:\/\/github\.com\//i.test(url)
    ? cfg.mirror.replace(/\/$/, '') + '/' + url
    : url;
  const args = [];
  if (cfg.proxy) args.push('-c', `http.proxy=${cfg.proxy}`, '-c', `https.proxy=${cfg.proxy}`);
  return { url: finalUrl, args };
}

/**
 * Run a command. `onStderr(chunk)` is called for each stderr write (used to
 * parse git --progress lines). Returns { code, stdout, stderr }.
 */
export function run(cmd, args, cwd, opts = {}) {
  const onStderr = opts.onStderr;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = '', stderr = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve({ code: code ?? (child.exitCode ?? 1), stdout, stderr });
    };
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (onStderr) onStderr(d);
    });
    child.on('error', (e) => { stderr += '\n' + e.message; finish(1); });
    child.on('close', (code) => finish(code));
  });
}

// git --progress writes stage/percent lines to stderr, e.g.:
//   Receiving objects:  45% (90/200), 10.2 MiB | 1.2 MiB/s
//   Resolving deltas: 100% (5/5), done.
export function parseGitProgress(chunk) {
  const lines = String(chunk).split(/\r?\n/).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = last.match(/^([A-Za-z][\w ]*?):\s+(\d+)%/);
  if (!m) return null;
  return { stage: m[1].trim(), percent: Number(m[2]) };
}

// ---------- registry yaml (minimal parser, supports v1 flat & v2 nested) ----------
export function parseYamlMini(text) {
  const lines = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim() || l.trim().startsWith('#')) continue;
    lines.push(l);
  }
  let pos = 0;
  const indentOf = (s) => s.match(/^ */)[0].length;
  const scalar = (s) => {
    s = s.trim();
    if (s === '[]') return [];
    if (s === '{}') return {};
    if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return s.slice(1, -1);
    return s;
  };
  function parseValue(minIndent) {
    if (pos >= lines.length) return null;
    const ind = indentOf(lines[pos]);
    if (ind < minIndent) return null;
    const t = lines[pos].trim();
    return t.startsWith('- ') ? parseList(ind) : parseMap(ind);
  }
  function parseList(indent) {
    const out = [];
    while (pos < lines.length) {
      const ind = indentOf(lines[pos]);
      if (ind !== indent) break;
      const t = lines[pos].trim();
      if (!t.startsWith('- ')) break;
      const rest = t.slice(2);
      const kv = rest.match(/^([\w.-]+):\s*(.*)$/);
      if (kv) {
        const item = { [kv[1]]: kv[2] === '' ? null : scalar(kv[2]) };
        pos++;
        parseMapRest(item, indent + 2);
        out.push(item);
      } else {
        out.push(scalar(rest));
        pos++;
      }
    }
    return out;
  }
  function parseMap(indent) {
    const obj = {};
    parseMapRest(obj, indent);
    return obj;
  }
  function parseMapRest(obj, indent) {
    while (pos < lines.length) {
      const ind = indentOf(lines[pos]);
      if (ind < indent) break;
      if (ind > indent) { pos++; continue; }
      const t = lines[pos].trim();
      const kv = t.match(/^([\w.-]+):\s*(.*)$/);
      if (!kv) break;
      if (kv[2] === '') { pos++; obj[kv[1]] = parseValue(indent + 1); }
      else { obj[kv[1]] = scalar(kv[2]); pos++; }
    }
    return obj;
  }
  return parseValue(0);
}

export function flattenRegistry(doc) {
  if (!doc || typeof doc !== 'object') return [];
  if (Array.isArray(doc.categories)) {
    const out = [];
    for (const cat of doc.categories) {
      for (const sub of cat && cat.subcategories || []) {
        for (const p of sub && sub.projects || []) {
          if (p && p.name && p.repo) {
            const catPath = cat.name + '/' + (sub.name || '');
            out.push({
              name: p.name,
              repo: p.repo,
              path: p.path || (catPath + '/' + p.name),
              category: catPath,
            });
          }
        }
      }
    }
    return out;
  }
  if (Array.isArray(doc.projects)) {
    return doc.projects.filter((p) => p && p.name && p.repo && p.path);
  }
  return [];
}

export function parseRegistry(text) {
  return flattenRegistry(parseYamlMini(text));
}

// ---------- categories / tree ----------
export function listCategories(ws) {
  const root = referencesRoot(ws);
  const out = [];
  const walk = (dir, prefix, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const rel = prefix ? prefix + '/' + e.name : e.name;
      const p = path.join(dir, e.name);
      let hasGit = false;
      try { hasGit = fs.existsSync(path.join(p, '.git')); } catch {}
      const kids = fs.readdirSync(p, { withFileTypes: true }).filter((k) => k.isDirectory() && !k.name.startsWith('.'));
      const kidHasGit = kids.some((k) => { try { return fs.existsSync(path.join(p, k.name, '.git')); } catch { return false; } });
      if (hasGit || kidHasGit) out.push({ category: rel, leaf: hasGit });
      if (!hasGit && depth < 3) walk(p, rel, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

export function listCategoryRepos(ws, category) {
  if (typeof category !== 'string' || /[\\]|\.\./.test(category)) return null;
  const dir = path.join(referencesRoot(ws), category);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(dir, e.name, '.git')))
    .map((e) => e.name);
}

// ---------- collected links (收藏: record article addresses locally) ----------
//
// 收藏功能: 看到文章后把文章地址记录到本地文件。后端只负责记录地址,
// 爬取/内容抓取任务先留空(crawlStatus 固定为 "pending"), 后续再实现。
export function collectedFile(cfg) {
  return path.join(__dirname, 'collected.json');
}

export function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url);
}

export function normalizeUrl(url) {
  return String(url).trim().replace(/\/+$/, '');
}

function loadCollected(cfg) {
  const file = collectedFile(cfg);
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveCollected(cfg, list) {
  try { fs.writeFileSync(collectedFile(cfg), JSON.stringify(list, null, 2)); } catch {}
}

/**
 * Record an article/page address into the local collected store.
 * Crawling is intentionally left empty for now — only the address is stored.
 */
export function addCollected(cfg, { url, title, note, source }) {
  if (!isHttpUrl(url)) return { code: 400, error: 'url must be an http(s) address' };
  const norm = normalizeUrl(url);
  const list = loadCollected(cfg);
  if (list.some((c) => c && c.url === norm)) {
    return { code: 409, error: 'already collected: ' + norm, entry: list.find((c) => c.url === norm) };
  }
  const entry = {
    id: 'col-' + Date.now().toString(36) + '-' + (list.length + 1),
    url: norm,
    title: typeof title === 'string' && title.trim() ? title.trim() : null,
    note: typeof note === 'string' && note.trim() ? note.trim() : null,
    source: typeof source === 'string' && source.trim() ? source.trim() : null,
    collectedAt: new Date().toISOString(),
    crawlStatus: 'pending', // 爬取任务先留空, 计划后续实现
  };
  list.unshift(entry);
  if (list.length > 500) list.length = 500;
  saveCollected(cfg, list);
  return { code: 200, entry };
}

export function listCollected(cfg) {
  return loadCollected(cfg);
}

export function removeCollected(cfg, id) {
  const list = loadCollected(cfg);
  const idx = list.findIndex((c) => c && c.id === id);
  if (idx < 0) return { code: 404, error: 'unknown collected id: ' + id };
  const [removed] = list.splice(idx, 1);
  saveCollected(cfg, list);
  return { code: 200, entry: removed };
}

// ---------- clone-website (clone website: 处理逻辑先留空, 计划后续实现) ----------
/**
 * Placeholder for the clone-website feature. The endpoint and job record are
 * wired up, but the actual website cloning logic is intentionally left empty
 * for now and will be implemented later. Returns 501 Not Implemented.
 */
export function doCloneWebsite(cfg, { workspace, url, name }) {
  if (!isHttpUrl(url)) return { code: 400, error: 'url must be an http(s) address' };
  const ws = wsById(cfg.workspaces, workspace);
  const norm = normalizeUrl(url);
  const siteName = name && /^[\w.-]+$/.test(name) ? name : safeHostname(norm);
  return {
    code: 501,
    body: {
      ok: false,
      notImplemented: true,
      error: 'clone-website 处理逻辑暂未实现 (计划后续实现)',
      workspace: ws ? ws.id : null,
      url: norm,
      name: siteName,
      plannedPath: ws ? path.join(ws.dir, 'references', 'websites', siteName) : null,
    },
  };
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/[^\w.-]/g, '-') || 'site';
  } catch {
    return 'site';
  }
}

// ---------- clone / pull ----------
export function validateInputs(cfg, { workspace, category, url, name }) {
  if (typeof url !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/i.test(url)) {
    return { code: 400, error: 'url must be an https github repo url' };
  }
  if (typeof category !== 'string' || /[\\]|\.\.|^\/|^$|[\x00-\x1f]/.test(category)) {
    return { code: 400, error: 'invalid category (single relative path, no .. or backslash)' };
  }
  if (!wsById(cfg.workspaces, workspace)) {
    return { code: 400, error: 'unknown workspace: ' + workspace };
  }
  const urlNorm = url.replace(/\.git$/i, '');
  const repoName = name && /^[\w.-]+$/.test(name) ? name : urlNorm.split('/').pop();
  if (!repoName) return { code: 400, error: 'cannot derive repo name' };
  return { code: 0, urlNorm, repoName };
}

export function jobCommand(cfg, ws, kind, category, url, name) {
  const root = path.join(ws.dir, 'references');
  const depth = cfg.full ? '' : ' --depth=1';
  const shownUrl = cfg.mirror && /^https:\/\/github\.com\//i.test(url)
    ? cfg.mirror.replace(/\/$/, '') + '/' + url.replace(/\.git$/i, '') + '.git'
    : url.replace(/\.git$/i, '') + '.git';
  const p = path.join(root, category, name);
  return kind === 'pull'
    ? `git -C "${p}" pull --ff-only${depth}`
    : `git clone${depth} ${shownUrl} "${p}"`;
}

/**
 * Clone or update a repo under referencesRoot/<category>/<name>.
 * `onProgress({ stage, percent })` receives parsed git progress lines.
 */
export async function doClone(cfg, { workspace, category, url, name }, onProgress) {
  const ws = wsById(cfg.workspaces, workspace);
  const v = validateInputs(cfg, { workspace, category, url, name });
  if (v.code !== 0) return { code: v.code, body: { ok: false, error: v.error } };
  const { urlNorm, repoName } = v;

  const catDir = path.join(referencesRoot(ws), category);
  const dest = path.join(catDir, repoName);
  fs.mkdirSync(catDir, { recursive: true });

  // path-traversal guard
  const rootReal = fs.realpathSync.native(referencesRoot(ws));
  const destReal = fs.realpathSync.native(catDir);
  if (!destReal.startsWith(rootReal + path.sep) && destReal !== rootReal) {
    return { code: 400, body: { ok: false, error: 'destination escapes references root' } };
  }

  const depthArgs = cfg.full ? [] : ['--depth=1'];
  const gitDir = path.join(dest, '.git');
  let exists = fs.existsSync(gitDir);

  // heal broken clones
  if (exists) {
    const probe = await run('git', ['-C', dest, 'rev-parse', '--verify', 'HEAD']);
    if (probe.code !== 0) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
      exists = false;
    }
  }

  if (exists && cfg.noPull) {
    return { code: 409, body: { ok: false, error: 'already cloned (and --no-pull set)', path: dest } };
  }

  if (!exists) {
    for (const lock of ['shallow.lock', 'index.lock', 'config.lock']) {
      try { fs.rmSync(path.join(gitDir, lock), { force: true }); } catch {}
    }
    const net = netArgs(cfg, urlNorm + '.git');
    const progressCb = onProgress ? (chunk) => {
      const p = parseGitProgress(chunk);
      if (p && onProgress) onProgress(p);
    } : undefined;
    const r = await run('git', [...net.args, 'clone', '--progress', ...depthArgs, net.url, dest], ws.dir, { onStderr: progressCb });
    if (r.code !== 0) {
      try { if (fs.existsSync(gitDir) && !fs.existsSync(path.join(gitDir, 'HEAD'))) fs.rmSync(dest, { recursive: true, force: true }); } catch {}
      return { code: 500, body: { ok: false, error: 'git clone failed: ' + (r.stderr || r.stdout || 'unknown').trim().split('\n').slice(-3).join(' | ') } };
    }
    return { code: 200, body: { ok: true, action: 'clone', path: dest, name: repoName } };
  }

  const remote = await run('git', ['remote', 'get-url', 'origin'], dest);
  const sameRemote = remote.code === 0 && String(remote.stdout).trim().replace(/\.git$/i, '') === urlNorm;
  if (!sameRemote) {
    return { code: 409, body: { ok: false, error: 'directory exists with a different origin: ' + dest, path: dest } };
  }
  const net = netArgs(cfg, urlNorm + '.git');
  const progressCb = onProgress ? (chunk) => {
    const p = parseGitProgress(chunk);
    if (p && onProgress) onProgress(p);
  } : undefined;
  const pr = await run('git', [...net.args, '-C', dest, 'pull', '--ff-only', '--progress', ...(cfg.full ? [] : ['--depth=1'])], undefined, { onStderr: progressCb });
  if (pr.code !== 0) {
    return { code: 500, body: { ok: false, error: 'git pull failed: ' + (pr.stderr || pr.stdout).trim().split('\n').slice(-3).join(' | '), path: dest } };
  }
  return { code: 200, body: { ok: true, action: 'pull', path: dest, name: repoName } };
}

// ---------- job queue + history ----------
export class CloneItCore {
  constructor(cfg) {
    this.cfg = cfg;
    this.JOBS = [];
    let jobSeq = 0;
    this._jobSeq = 0;
    this.pending = [];
    this.running = new Set(); // in-flight job promises; bounded by cfg.maxConcurrent
    this._restore(cfg.jobsFile);
    this._jobSeq = jobSeq;
  }

  _restore(file) {
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      let maxSeq = 0;
      for (const j of arr) {
        if (j && j.id && j.status) {
          if (j.status === 'running' || j.status === 'queued' || j.status === 'retrying') {
            j.status = 'failed';
            j.error = 'server restarted while this job was in flight — use retry to re-run';
          }
          this.JOBS.push(j);
          const n = Number((j.id || '').split('-').pop());
          if (n > maxSeq) maxSeq = n;
        }
      }
      if (this.JOBS.length) console.log(`[cloneit] restored ${this.JOBS.length} job records from ${path.basename(file)}`);
      return maxSeq;
    } catch {
      return 0;
    }
  }

  persistJobs() {
    try { fs.writeFileSync(this.cfg.jobsFile, JSON.stringify(this.JOBS.slice(0, 100), null, 2)); } catch {}
  }

  // Bounded-concurrency pump: start queued jobs while fewer than maxConcurrent
  // are in flight. Each runner removes itself from `running` on completion and
  // re-pumps, so the next queued job starts immediately (up to the cap).
  pump() {
    while (this.running.size < this.cfg.maxConcurrent && this.pending.length) {
      const next = this.pending.shift();
      const p = next().catch(() => {}).finally(() => {
        this.running.delete(p);
        this.persistJobs();
        this.pump();
      });
      this.running.add(p);
    }
  }

  enqueueClone({ workspace, category, url, name }) {
    const ws = wsById(this.cfg.workspaces, workspace);
    const v = validateInputs(this.cfg, { workspace, category, url, name });
    if (v.code !== 0) return { error: v.error };
    const { urlNorm, repoName } = v;
    const job = {
      id: 'job-' + Date.now().toString(36) + '-' + (++this._jobSeq),
      status: 'queued',
      kind: 'clone',
      workspace: ws.id,
      category, url: urlNorm, name: repoName,
      command: jobCommand(this.cfg, ws, 'clone', category, urlNorm, repoName),
      path: path.join(ws.dir, 'references', category, repoName),
      error: null,
      attempt: 0,
      progress: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.JOBS.unshift(job);
    if (this.JOBS.length > 200) this.JOBS.pop();

    this.pending.push(async () => {
      job.status = 'running';
      this.persistJobs();
      while (job.attempt < this.cfg.retry) {
        job.attempt++;
        try {
          const r = await doClone(this.cfg, { workspace: ws.id, category, url, name }, (p) => {
            job.progress = p;
          });
          if (r.code < 400) {
            job.status = 'done';
            job.kind = r.body.action === 'pull' ? 'pull' : 'clone';
            job.command = jobCommand(this.cfg, ws, job.kind, category, urlNorm, repoName);
            job.error = null;
            job.progress = { stage: 'done', percent: 100 };
            break;
          }
          if (r.code < 500) { job.error = (r.body && r.body.error) || 'unknown error'; break; }
          job.error = (r.body && r.body.error) || 'unknown error';
        } catch (e) {
          job.error = e.message;
        }
        if (job.attempt < this.cfg.retry) {
          job.status = 'retrying';
          job.retryAt = new Date().toISOString();
          await new Promise((r2) => setTimeout(r2, 2000 * Math.pow(2, job.attempt - 1)));
          job.status = 'running';
          job.progress = null;
        }
      }
      if (job.status !== 'done') job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      console.log(`[cloneit] job ${job.id} ${job.status}${job.error ? ' — ' + job.error : ''}`);
    });
    this.pump();
    return job;
  }

  getJobs(limit = 50) {
    return this.JOBS.slice(0, Math.min(limit, 200));
  }

  findJob(id) {
    return this.JOBS.find((j) => j.id === id);
  }

  retryJob(id) {
    const job = this.findJob(id);
    if (!job) return { error: 'unknown job: ' + id };
    if (job.status === 'queued' || job.status === 'running') {
      return { job, skipped: true };
    }
    const fresh = this.enqueueClone({ workspace: job.workspace, category: job.category, url: job.url, name: job.name });
    return { job: fresh, retriedFrom: id };
  }
}

// ---------- clipboard sentinel watcher ----------
export async function watchClipboardLoop(cfg, doCloneFn) {
  let last = '';
  while (true) {
    await new Promise((r) => setTimeout(r, 500));
    let text = '';
    try {
      if (os.platform() === 'win32') {
        const r = await run('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], process.cwd());
        text = r.stdout;
      } else {
        const r = await run('pbpaste', [], process.cwd());
        text = r.stdout;
      }
    } catch { continue; }
    const m = text.match(/CLONEIT:\/\/clone\?(\S+)/);
    if (!m || text === last) continue;
    last = text;
    const params = new URLSearchParams(m[1]);
    const req = {
      workspace: params.get('workspace') || cfg.workspaces[0].id,
      category: params.get('category') || '',
      url: params.get('url') || '',
    };
    console.log('[cloneit] clipboard sentinel →', req.url, '→', req.category);
    const res = await doCloneFn(req);
    console.log('[cloneit] clipboard result:', JSON.stringify(res.body));
  }
}
