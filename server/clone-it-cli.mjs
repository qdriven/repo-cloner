/* CloneIt CLI — zero-dependency Node ≥ 18.
 *
 * Run a clone directly to the current repo's references/, or manage the
 * companion server / job history. Designed to be invoked as a skill:
 *
 *   node clone-it/server/clone-it-cli.mjs clone <url> [options]
 *   node clone-it/server/clone-it-cli.mjs list [options]
 *   node clone-it/server/clone-it-cli.mjs jobs [--limit N]
 *   node clone-it/server/clone-it-cli.mjs retry <id>
 *   node clone-it/server/clone-it-cli.mjs server [options]
 *
 * The `clone` subcommand runs synchronously in the foreground, prints
 * git progress live, and records the attempt into the shared jobs.json
 * history (same file the HTTP server uses).
 */
'use strict';

import path from 'node:path';
import fs from 'node:fs';

import {
  parseConfig, VERSION, wsById, referencesRoot,
  listCategories, listCategoryRepos, parseRegistry,
  CloneItCore, doClone, validateInputs,
  addCollected, listCollected, removeCollected, doCloneWebsite, isHttpUrl,
} from './core.mjs';

const args = process.argv.slice(2);
const sub = args[0];

function out(msg) { process.stdout.write(msg + '\n'); }
function err(msg) { process.stderr.write(msg + '\n'); }

// parse global flags + subcommand positional args from the remaining tokens
function parseArgs(tokens) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--workspace') { (opts.workspaces ||= []).push(tokens[++i]); }
    else if (t === '--config') opts.config = tokens[++i];
    else if (t === '--full') opts.full = true;
    else if (t === '--no-pull') opts.noPull = true;
    else if (t === '--retry') opts.retry = Number(tokens[++i]);
    else if (t === '--mirror') opts.mirror = tokens[++i];
    else if (t === '--proxy') opts.proxy = tokens[++i];
    else if (t === '--port') opts.port = Number(tokens[++i]);
    else if (t === '--token') opts.token = tokens[++i];
    else if (t === '--watch-clipboard') opts.watchClipboard = true;
    else if (t === '--clone-timeout') opts.cloneTimeout = Number(tokens[++i]);
    else if (t === '--category') opts.category = tokens[++i];
    else if (t === '--name') opts.name = tokens[++i];
    else if (t === '--workspace-id') opts.workspaceId = tokens[++i];
    else if (t === '--title') opts.title = tokens[++i];
    else if (t === '--note') opts.note = tokens[++i];
    else if (t === '--source') opts.source = tokens[++i];
    else if (t === '--limit') opts.limit = Number(tokens[++i]);
    else if (t === '--max-concurrent') opts.maxConcurrent = Number(tokens[++i]);
    else pos.push(t);
  }
  return { pos, opts };
}

function buildCfg(opts) {
  // base config from opts; default workspace = cwd
  const argv = [];
  if (opts.config) argv.push('--config', opts.config);
  for (const w of opts.workspaces || []) argv.push('--workspace', w);
  if (opts.full) argv.push('--full');
  if (opts.noPull) argv.push('--no-pull');
  if (opts.retry != null) argv.push('--retry', String(opts.retry));
  if (opts.mirror) argv.push('--mirror', opts.mirror);
  if (opts.proxy) argv.push('--proxy', opts.proxy);
  if (opts.port != null) argv.push('--port', String(opts.port));
  if (opts.token) argv.push('--token', opts.token);
  if (opts.watchClipboard) argv.push('--watch-clipboard');
  if (opts.cloneTimeout != null) argv.push('--clone-timeout', String(opts.cloneTimeout));
  if (opts.maxConcurrent != null) argv.push('--max-concurrent', String(opts.maxConcurrent));
  try {
    return parseConfig(argv);
  } catch (e) {
    err('config error: ' + e.message);
    process.exit(1);
  }
}

function fmtProgress(p) {
  if (!p) return '';
  if (p.stage === 'done') return 'complete (100%)';
  return `${p.stage}: ${p.percent}%`;
}

// ---------- clone (synchronous, live progress) ----------
async function cmdClone(pos, opts) {
  const url = pos[0];
  if (!url) { err('usage: clone <url> [--category X] [--name N] [--workspace-id ws0] [--full] [--no-pull] [--retry N] [--mirror URL] [--proxy URL]'); process.exit(2); }
  const cfg = buildCfg(opts);
  const category = opts.category || 'others';
  const ws = wsById(cfg.workspaces, opts.workspaceId || cfg.workspaces[0].id);

  out(`CloneIt v${VERSION}`);
  out(`workspace: ${ws.id}  ${ws.dir}`);
  out(`category:   ${category}`);
  out(`url:        ${url}`);
  out(`shallow:    ${cfg.full ? 'full history' : '--depth=1 (shallow)'}`);
  out('');

  // record the job up front so it lands in history even if it fails
  const core = new CloneItCore(cfg);
  // enqueue gives us a job record + runs the queue; but for CLI we want
  // synchronous live output, so run doClone directly and write the record.
  const v = validateInputs(cfg, { workspace: ws.id, category, url, name: opts.name });
  if (v.code !== 0) { err('error: ' + v.error); process.exit(v.code); }
  const { urlNorm, repoName } = v;

  const job = {
    id: 'job-' + Date.now().toString(36) + '-' + (core._jobSeq + 1),
    status: 'running',
    kind: 'clone',
    workspace: ws.id,
    category, url: urlNorm, name: repoName,
    command: '',
    path: path.join(referencesRoot(ws), category, repoName),
    error: null,
    attempt: 1,
    progress: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  core.JOBS.unshift(job);

  out(`cloning → ${job.path}`);
  const t0 = Date.now();
  const r = await doClone(cfg, { workspace: ws.id, category, url, name: opts.name }, (p) => {
    process.stderr.write('\r' + fmtProgress(p).padEnd(40));
    job.progress = p;
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write('\r' + ' '.repeat(40) + '\r');

  if (r.code < 400) {
    job.status = 'done';
    job.kind = r.body.action === 'pull' ? 'pull' : 'clone';
    job.error = null;
    job.progress = { stage: 'done', percent: 100 };
    out(`✅ ${job.kind} OK in ${elapsed}s → ${job.path}`);
    core.persistJobs();
    process.exit(0);
  } else {
    job.status = 'failed';
    job.error = (r.body && r.body.error) || 'unknown error';
    out(`❌ ${job.kind} failed in ${elapsed}s: ${job.error}`);
    core.persistJobs();
    process.exit(1);
  }
}

// ---------- list ----------
function cmdList(pos, opts) {
  const cfg = buildCfg(opts);
  const ws = wsById(cfg.workspaces, opts.workspaceId || cfg.workspaces[0].id);
  const cat = opts.category;
  if (cat) {
    const repos = listCategoryRepos(ws, cat);
    if (repos === null) { err('invalid category'); process.exit(2); }
    out(`repos in ${ws.id}/references/${cat} (${repos.length}):`);
    for (const r of repos) out('  ' + r);
  } else {
    const cats = listCategories(ws);
    out(`categories under ${ws.id}/references/ (${cats.length}):`);
    for (const c of cats) out(`  ${c.category}${c.leaf ? '  [repo]' : ''}`);
  }
}

// ---------- jobs ----------
function cmdJobs(pos, opts) {
  const cfg = buildCfg(opts);
  const core = new CloneItCore(cfg);
  const jobs = core.getJobs(opts.limit || 50);
  const ICON = { queued: '⏳', running: '🔄', retrying: '🔁', done: '✅', failed: '❌' };
  if (!jobs.length) { out('no clone history yet'); return; }
  out(`clone history (${jobs.length}):`);
  for (const j of jobs) {
    const p = j.progress ? ` ${j.progress.stage} ${j.progress.percent}%` : '';
    const e = j.error ? ` — ${j.error}` : '';
    out(`  ${ICON[j.status] || '·'} ${j.id}  ${j.name}  [${j.category}]${p}${e}`);
    out(`      ${j.command}`);
  }
}

// ---------- retry ----------
async function cmdRetry(pos, opts) {
  const id = pos[0];
  if (!id) { err('usage: retry <job-id>'); process.exit(2); }
  const cfg = buildCfg(opts);
  const core = new CloneItCore(cfg);
  const r = core.retryJob(id);
  if (r.error) { err('error: ' + r.error); process.exit(1); }
  if (r.skipped) { out(`job ${id} already ${r.job.status}, not re-queued`); return; }
  out(`re-queued job ${r.job.id} (from ${r.retriedFrom})`);
  out('run `jobs` to watch progress, or start the server to let it drain.');
}

// ---------- server ----------
async function cmdServer(pos, opts) {
  // re-exec the server module so it owns the event loop
  const serverFile = new URL('./clone-it-server.mjs', import.meta.url).pathname;
  const { spawn } = await import('node:child_process');
  const argv = [];
  if (opts.config) argv.push('--config', opts.config);
  for (const w of opts.workspaces || []) argv.push('--workspace', w);
  if (opts.full) argv.push('--full');
  if (opts.noPull) argv.push('--no-pull');
  if (opts.retry != null) argv.push('--retry', String(opts.retry));
  if (opts.mirror) argv.push('--mirror', opts.mirror);
  if (opts.proxy) argv.push('--proxy', opts.proxy);
  if (opts.port != null) argv.push('--port', String(opts.port));
  if (opts.token) argv.push('--token', opts.token);
  if (opts.watchClipboard) argv.push('--watch-clipboard');
  if (opts.cloneTimeout != null) argv.push('--clone-timeout', String(opts.cloneTimeout));
  if (opts.maxConcurrent != null) argv.push('--max-concurrent', String(opts.maxConcurrent));
  const child = spawn(process.execPath, [serverFile, ...argv], { stdio: 'inherit' });
  child.on('close', (code) => process.exit(code ?? 0));
}

// ---------- collect (收藏: record article address, crawl left empty) ----------
function cmdCollect(pos, opts) {
  const url = pos[0];
  if (!url) { err('usage: collect <url> [--title T] [--note N] [--source S]'); process.exit(2); }
  const cfg = buildCfg(opts);
  const r = addCollected(cfg, { url, title: opts.title, note: opts.note, source: opts.source });
  if (r.code === 409) { out('已收藏过: ' + url); return; }
  if (r.code !== 200) { err('error: ' + r.error); process.exit(r.code); }
  out('已收藏: ' + r.entry.url);
  out('  id:        ' + r.entry.id);
  if (r.entry.title) out('  title:    ' + r.entry.title);
  out('  crawl:     ' + r.entry.crawlStatus + ' (爬取任务暂未实现)');
}

function cmdCollected(pos, opts) {
  const cfg = buildCfg(opts);
  const list = listCollected(cfg);
  if (!list.length) { out('暂无收藏记录'); return; }
  out(`收藏记录 (${list.length}):`);
  for (const c of list) {
    const t = c.title ? '  ' + c.title : '';
    out(`  ${c.id}  ${c.url}${t}`);
  }
}

// ---------- clone-website (处理逻辑先留空, 计划后续实现) ----------
function cmdCloneWebsite(pos, opts) {
  const url = pos[0];
  if (!url) { err('usage: clone-website <url> [--name N] [--workspace-id ws0]'); process.exit(2); }
  const cfg = buildCfg(opts);
  const r = doCloneWebsite(cfg, { workspace: opts.workspaceId || cfg.workspaces[0].id, url, name: opts.name });
  if (r.code === 501) {
    out('clone-website 暂未实现 (计划后续实现)');
    out('  url:       ' + r.body.url);
    out('  planned:   ' + r.body.plannedPath);
    process.exit(0);
  }
  if (r.code >= 400) { err('error: ' + r.body.error); process.exit(r.code); }
  out('ok: ' + r.body.plannedPath);
}

// ---------- dispatch ----------
const rest = args.slice(1);
const { pos, opts } = parseArgs(rest);

const HELP = `CloneIt v${VERSION} — clone GitHub repos into references/

usage:
  clone-it-cli.mjs clone <url> [--category X] [--name N] [--workspace-id ws0]
                                 [--full] [--no-pull] [--retry N] [--mirror URL] [--proxy URL]
  clone-it-cli.mjs list   [--category X] [--workspace-id ws0]
  clone-it-cli.mjs jobs   [--limit N]
  clone-it-cli.mjs retry  <job-id>
  clone-it-cli.mjs server [--port N] [--token T] [--watch-clipboard] [--max-concurrent N] [--workspace D] ...
  clone-it-cli.mjs help

default workspace = current working directory (clone lands in ./references/<category>/<name>).
history is recorded in server/jobs.json and shared with the HTTP server.
`;

switch (sub) {
  case 'clone': await cmdClone(pos, opts); break;
  case 'list': cmdList(pos, opts); break;
  case 'jobs': cmdJobs(pos, opts); break;
  case 'retry': await cmdRetry(pos, opts); break;
  case 'collect': cmdCollect(pos, opts); break;
  case 'collected': cmdCollected(pos, opts); break;
  case 'clone-website': cmdCloneWebsite(pos, opts); break;
  case 'server': await cmdServer(pos, opts); break;
  case 'help': case undefined: case '-h': case '--help': out(HELP); break;
  default: err(`unknown subcommand: ${sub}\n`); out(HELP); process.exit(2);
}
