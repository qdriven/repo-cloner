/* KeepIt HTTP companion service — zero-dependency Node ≥ 18.
 *
 * Endpoints (all GET unless noted, JSON):
 *   GET /api/ping                       → { ok, version, workspaces, maxConcurrent }
 *   GET /api/workspaces                 → [{ id, name, dir, referencesExists }]
 *   GET /api/tree?workspace=<id>        → { categories: [{ category, leaf }] }
 *   GET /api/registry?workspace=        → { projects: [{ name, repo, path }] }
 *   GET /api/list?workspace=&category=  → { repos: [...] }
 *   POST /api/clone                     → body { workspace, category, url, name? }
 *                                        202 on enqueue; git runs in background
 *   GET /api/jobs                      → { jobs, running, maxConcurrent } recent records
 *   POST /api/retry                    → body { id } re-queues a failed clone record
 *
 * 稍后读 (read later, collect article addresses locally, crawling left empty):
 *   GET  /api/collected                → { collected: [{ id, url, title, ... }] }
 *   POST /api/collect                  → body { url, title?, note?, source? }
 *                                        201 on record; crawling not implemented
 *   POST /api/collect/remove           → body { id } delete a collected entry
 *
 * clone-website (处理逻辑先留空, 计划后续实现):
 *   POST /api/clone-website            → body { workspace, url, name? }
 *                                        501 Not Implemented (placeholder)
 *
 * Flags (see parseConfig in core.mjs):
 *   --workspace <dir>      repeatable; default = cwd
 *   --port <n>             default 7420
 *   --token <secret>       require X-KeepIt-Token header on every request
 *   --watch-clipboard      poll clipboard for "KEEPIT://clone?..." sentinel
 *   --full                 disable --depth=1 shallow clone
 *   --no-pull              never auto-pull; refuse when dir exists
 *   --mirror URL           GitHub mirror prefix
 *   --proxy URL            git HTTP(S) proxy
 *   --retry N              auto-retries per job (default 3)
 *   --max-concurrent N     max parallel clone jobs (default 5)
 */
'use strict';

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

import {
  parseConfig, VERSION, DEFAULT_PORT, ORIGIN_ALLOW, TOKEN_HEADER,
  wsById, referencesRoot,
  listCategories, listCategoryRepos, parseRegistry,
  addCollected, listCollected, removeCollected, doCloneWebsite, isHttpUrl,
  KeepItCore,
} from './core.mjs';

const argv = process.argv.slice(2);
let cfg;
try {
  cfg = parseConfig(argv);
} catch (e) {
  console.error('[keepit] config error:', e.message);
  process.exit(1);
}
const core = new KeepItCore(cfg);

// ---------- helpers ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function ok(res, obj) { send(res, 200, { ok: true, ...obj }); }
function fail(res, code, msg, extra) { send(res, code, { ok: false, error: msg, ...(extra || {}) }); }

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- clipboard sentinel watcher ----------
async function watchClipboardLoop() {
  const { run } = await import('./core.mjs');
  const os = await import('node:os');
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
    const m = text.match(/KEEPIT:\/\/clone\?(\S+)/);
    if (!m || text === last) continue;
    last = text;
    const params = new URLSearchParams(m[1]);
    const req = {
      workspace: params.get('workspace') || cfg.workspaces[0].id,
      category: params.get('category') || '',
      url: params.get('url') || '',
    };
    console.log('[keepit] clipboard sentinel →', req.url, '→', req.category);
    const job = core.enqueueClone(req);
    console.log('[keepit] clipboard enqueued:', job.id);
  }
}

// ---------- http server ----------
const server = http.createServer(async (req, res) => {
  if (cfg.token) {
    if (req.headers[TOKEN_HEADER] !== cfg.token) return fail(res, 401, 'bad token');
  }
  const origin = req.headers.origin || '';
  if (origin && ![...ORIGIN_ALLOW].some((p) => origin.startsWith(p))) {
    return fail(res, 403, 'origin not allowed');
  }
  const u = new URL(req.url, 'http://127.0.0.1');
  const q = u.searchParams;

  try {
    if (u.pathname === '/api/ping') {
      return ok(res, {
        version: VERSION,
        workspaces: cfg.workspaces.map((w) => ({ id: w.id, name: w.name, dir: w.dir })),
        maxConcurrent: cfg.maxConcurrent,
      });
    }
    if (u.pathname === '/api/workspaces') {
      return ok(res, {
        workspaces: cfg.workspaces.map((w) => ({
          id: w.id, name: w.name, dir: w.dir,
          referencesExists: fs.existsSync(referencesRoot(w)),
        })),
      });
    }
    if (u.pathname === '/api/tree') {
      const ws = wsById(cfg.workspaces, q.get('workspace'));
      return ok(res, { categories: listCategories(ws) });
    }
    if (u.pathname === '/api/registry') {
      const ws = wsById(cfg.workspaces, q.get('workspace'));
      const file = path.join(ws.dir, 'registry_references.yaml');
      if (!fs.existsSync(file)) return ok(res, { projects: [], missing: true });
      return ok(res, { projects: parseRegistry(fs.readFileSync(file, 'utf8')) });
    }
    if (u.pathname === '/api/list') {
      const ws = wsById(cfg.workspaces, q.get('workspace'));
      const list = listCategoryRepos(ws, q.get('category') || '');
      if (list === null) return fail(res, 400, 'invalid category');
      return ok(res, { repos: list });
    }
    if (u.pathname === '/api/clone' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'bad json'); }
      if (typeof body.url !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/i.test(body.url)) {
        return fail(res, 400, 'url must be an https github repo url');
      }
      if (typeof body.category !== 'string' || /[\\]|\.\.|^\/|^$|[\x00-\x1f]/.test(body.category)) {
        return fail(res, 400, 'invalid category (single relative path, no .. or backslash)');
      }
      const job = core.enqueueClone(body);
      if (job.error) return fail(res, 400, job.error);
      return send(res, 202, { ok: true, queued: true, job: { id: job.id, status: job.status, path: job.path } });
    }
    if (u.pathname === '/api/jobs') {
      const limit = Math.min(Number(q.get('limit')) || 50, 200);
      return ok(res, {
        jobs: core.getJobs(limit),
        running: core.running.size,
        maxConcurrent: cfg.maxConcurrent,
      });
    }
    if (u.pathname === '/api/retry' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'bad json'); }
      const r = core.retryJob(body.id);
      if (r.error) return fail(res, 404, r.error);
      if (r.skipped) return ok(res, { job: { id: r.job.id, status: r.job.status }, skipped: true });
      return send(res, 202, { ok: true, queued: true, job: { id: r.job.id, status: r.job.status, retriedFrom: body.id } });
    }
    // ---------- 稍后读 & 克隆网站记录 (统一存入 collected.json, category: collection | clone) ----------
    if (u.pathname === '/api/collected') {
      const cat = q.get('category') || q.get('type') || null;
      return ok(res, { collected: listCollected(cfg, cat) });
    }
    if (u.pathname === '/api/collect' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'bad json'); }
      const r = addCollected(cfg, { ...body, category: body.category || body.type || 'collection' });
      if (r.code === 409) return send(res, 409, { ok: false, error: r.error, entry: r.entry });
      if (r.code !== 200) return fail(res, r.code, r.error);
      return send(res, 201, { ok: true, collected: r.entry });
    }
    if (u.pathname === '/api/collect/remove' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'bad json'); }
      const r = removeCollected(cfg, body.id);
      if (r.code !== 200) return fail(res, r.code, r.error);
      return ok(res, { removed: r.entry });
    }
    if (u.pathname === '/api/clone-website' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'bad json'); }
      if (!isHttpUrl(body.url)) return fail(res, 400, 'url must be an http(s) address');
      const r = doCloneWebsite(cfg, body);
      return send(res, r.code, r.body);
    }
    return fail(res, 404, 'not found: ' + u.pathname);
  } catch (e) {
    return fail(res, 500, 'server error: ' + e.message);
  }
});

server.on('error', (e) => {
  console.error('[keepit] server error:', e.message);
  process.exit(1);
});

server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[keepit] v${VERSION} listening on http://127.0.0.1:${cfg.port}`);
  if (cfg.loadedConfigFile) console.log(`[keepit]   config: ${cfg.loadedConfigFile}`);
  for (const w of cfg.workspaces) console.log(`[keepit]   workspace ${w.id}: ${w.dir}`);
  if (cfg.token) console.log('[keepit]   token auth enabled');
  if (cfg.watchClipboard) console.log('[keepit]   clipboard sentinel watching (KEEPIT://clone?...)');
  if (cfg.mirror) console.log('[keepit]   mirror: ' + cfg.mirror);
  if (cfg.proxy) console.log('[keepit]   proxy: ' + cfg.proxy);
  console.log(`[keepit]   max concurrent clones: ${cfg.maxConcurrent}, git shallow: ${cfg.full ? 'full' : '--depth=1'}, retries: ${cfg.retry}`);
});

if (cfg.watchClipboard) watchClipboardLoop().catch((e) => console.error('[keepit] clipboard watcher crashed:', e));
