/* RepoCloner HTTP companion service — zero-dependency Node ≥ 18.
 *
 * Endpoints (all GET unless noted, JSON):
 *   GET /api/ping                 → { ok, version, workspaces, maxConcurrent }
 *   GET /api/workspaces           → [{ id, name, dir, referencesExists }]
 *   GET /api/tree?workspace=<id>  → { categories: [{ category, leaf }] }
 *   GET /api/registry?workspace=  → { projects: [{ name, repo, path }] }
 *   GET /api/list?workspace=&category=  → { repos: [...] }
 *   POST /api/clone               → body { workspace, category, url, name? }
 *                                    202 on enqueue; git runs in background
 *   GET /api/jobs                 → { jobs, running, maxConcurrent } recent records
 *   POST /api/retry               → body { id } re-queues a failed clone record
 *
 * Flags (see parseConfig in core.mjs):
 *   --workspace <dir>      repeatable; default = cwd
 *   --port <n>             default 7420
 *   --token <secret>       require X-RepoCloner-Token header on every request
 *   --watch-clipboard      poll clipboard for "REPOCLONER://clone?..." sentinel
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
  parseConfig, VERSION, DEFAULT_PORT, ORIGIN_ALLOW,
  wsById, referencesRoot,
  listCategories, listCategoryRepos, parseRegistry,
  RepoClonerCore,
} from './core.mjs';

const argv = process.argv.slice(2);
const cfg = parseConfig(argv);
const core = new RepoClonerCore(cfg);

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
    const m = text.match(/REPOCLONER:\/\/clone\?(\S+)/);
    if (!m || text === last) continue;
    last = text;
    const params = new URLSearchParams(m[1]);
    const req = {
      workspace: params.get('workspace') || cfg.workspaces[0].id,
      category: params.get('category') || '',
      url: params.get('url') || '',
    };
    console.log('[repocloner] clipboard sentinel →', req.url, '→', req.category);
    const job = core.enqueueClone(req);
    console.log('[repocloner] clipboard enqueued:', job.id);
  }
}

// ---------- http server ----------
const server = http.createServer(async (req, res) => {
  if (cfg.token) {
    if (req.headers['x-repocloner-token'] !== cfg.token) return fail(res, 401, 'bad token');
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
    return fail(res, 404, 'not found: ' + u.pathname);
  } catch (e) {
    return fail(res, 500, 'server error: ' + e.message);
  }
});

server.on('error', (e) => {
  console.error('[repocloner] server error:', e.message);
  process.exit(1);
});

server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[repocloner] v${VERSION} listening on http://127.0.0.1:${cfg.port}`);
  for (const w of cfg.workspaces) console.log(`[repocloner]   workspace ${w.id}: ${w.dir}`);
  if (cfg.token) console.log('[repocloner]   token auth enabled');
  if (cfg.watchClipboard) console.log('[repocloner]   clipboard sentinel watching (REPOCLONER://clone?...)');
  if (cfg.mirror) console.log('[repocloner]   mirror: ' + cfg.mirror);
  if (cfg.proxy) console.log('[repocloner]   proxy: ' + cfg.proxy);
  console.log(`[repocloner]   max concurrent clones: ${cfg.maxConcurrent}, git shallow: ${cfg.full ? 'full' : '--depth=1'}, retries: ${cfg.retry}`);
});

if (cfg.watchClipboard) watchClipboardLoop().catch((e) => console.error('[repocloner] clipboard watcher crashed:', e));
