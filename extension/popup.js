/* CloneIt popup — Tab 式 UI: Clone / 收藏 / 克隆网站 / 历史·进度. */
'use strict';

const $ = (id) => document.getElementById(id);
const FIXED_CATS = ['skills', 'plugins', 'products', 'others'];
const state = {
  repo: null,        // { owner, name, url }
  workspace: null,
  categories: [],
  picked: null,
  pickedSub: null,
  serverUp: false,
  jobsOpen: false,   // true when history tab is active
  collectOpen: false,
  collected: [],
};

const SETTINGS_DEFAULTS = { serverUrl: 'http://127.0.0.1:7420', token: '' };

async function settings() {
  const got = await chrome.storage.local.get(SETTINGS_DEFAULTS);
  return got;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function apiBase(s) { return s.serverUrl.replace(/\/+$/, ''); }
function headers(s) { return s.token ? { 'X-CloneIt-Token': s.token } : {}; }

async function fetchApi(pathname, opts = {}) {
  const s = await settings();
  const r = await fetch(apiBase(s) + pathname, { ...opts, headers: { ...headers(s), ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + r.status));
  return body;
}

// ---------- tab switching ----------
const TAB_MAP = {
  clone: 'panel-clone',
  collect: 'panel-collect',
  website: 'panel-website',
  history: 'panel-history',
};
document.querySelectorAll('nav.tabs .tab').forEach((btn) => {
  btn.onclick = () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('nav.tabs .tab').forEach((b) => b.classList.toggle('on', b === btn));
    Object.entries(TAB_MAP).forEach(([k, panelId]) => {
      $(panelId).style.display = k === tab ? '' : 'none';
    });
    if (tab === 'history') {
      state.jobsOpen = true;
      renderJobs();
      startJobsPolling();
    } else {
      state.jobsOpen = false;
      stopJobsPolling();
    }
    if (tab === 'collect') {
      state.collectOpen = true;
      renderCollected();
    } else {
      state.collectOpen = false;
    }
  };
});

function switchToTab(name) {
  const btn = document.querySelector(`nav.tabs .tab[data-tab="${name}"]`);
  if (btn) btn.click();
}

// ---------- repo detection ----------
async function detectRepo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/github\.com\//.test(tab.url || '')) return null;
  const m = tab.url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/);
  if (!m) return null;
  const [, owner, name] = m;
  if (owner === 'orgs' || name === 'orgs' || ['settings', 'explore', 'marketplace', 'topics', 'features', 'collections', 'trending'].includes(owner)) return null;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}

// ---------- current page info (for 收藏, any page) ----------
async function detectPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:\/\//.test(tab.url || '')) return null;
  return { url: tab.url, title: tab.title || tab.url };
}

// ---------- render ----------
function renderRepo() {
  const r = state.repo;
  $('repoName').textContent = r ? `${r.owner}/${r.name}` : '未检测到仓库 — 请打开 GitHub 项目页';
  $('repoBranch').style.display = 'none';
  $('repoDesc').style.display = 'none';
  $('go').disabled = !(r && state.picked);
  $('copy').disabled = !r;
}

function subCatsFor(picked) {
  const prefix = picked + '/';
  return state.categories.filter((c) => c.category.startsWith(prefix) && !c.leaf)
    .map((c) => c.category.slice(prefix.length).split('/')[0]);
}

function renderCats() {
  const box = $('cats');
  box.innerHTML = '';
  for (const name of FIXED_CATS) {
    const b = document.createElement('button');
    b.className = 'cat-chip' + (state.picked === name ? ' on' : '');
    b.textContent = name;
    b.title = `clone 到 references/${name}/`;
    b.onclick = () => {
      state.picked = name; state.pickedSub = null;
      renderCats(); renderSubs(); renderRepo();
    };
    box.appendChild(b);
  }
  if (!state.serverUp) box.innerHTML = '<span class="pill gray">服务离线 — 仍可选择类别,clone 将复制命令</span>';
}

function renderSubs() {
  const row = $('subRow'), sel = $('sub');
  const subs = state.picked ? subCatsFor(state.picked) : [];
  if (!subs.length) { row.style.display = 'none'; state.pickedSub = null; return; }
  row.style.display = '';
  sel.innerHTML = '';
  const o0 = document.createElement('option');
  o0.value = ''; o0.textContent = `(直接放在 ${state.picked}/)`;
  sel.appendChild(o0);
  for (const s of subs) {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    sel.appendChild(o);
  }
  sel.value = state.pickedSub || '';
  sel.onchange = () => { state.pickedSub = sel.value || null; };
}

function renderServer(up, text) {
  $('dot').className = 'dot' + (up ? ' on' : '');
  $('srv').textContent = text;
}

// ---------- server ping ----------
async function pingServer() {
  try {
    const s = await settings();
    const r = await fetch(apiBase(s) + '/api/ping', { headers: headers(s) });
    const body = await r.json();
    if (!body.ok) throw new Error('bad pong');
    state.serverUp = true;
    const names = (body.workspaces || []).map((w) => w.name).join(', ');
    renderServer(true, names ? `服务在线 (${names})` : '服务在线');
    return body;
  } catch {
    state.serverUp = false;
    renderServer(false, '服务离线 — clone 将复制命令');
    return null;
  }
}

function cloneCommand() {
  const r = state.repo;
  const ws = WORKSPACES_CACHE.find((w) => w.id === state.workspace);
  const root = ws ? ws.dir.replace(/[\\/]+$/, '') + '\\references' : '<workspace>\\references';
  const cat = state.pickedSub ? `${state.picked}/${state.pickedSub}` : (state.picked || '<category>');
  return `git clone --depth=1 ${r.url}.git "${root}\\${cat}\\${r.name}"`;
}

let WORKSPACES_CACHE = [];

async function loadAll() {
  const ping = await pingServer();
  if (ping) {
    WORKSPACES_CACHE = ping.workspaces || [];
    const sel = $('ws');
    if (WORKSPACES_CACHE.length) {
      sel.innerHTML = '';
      for (const w of WORKSPACES_CACHE) {
        const o = document.createElement('option');
        o.value = w.id; o.textContent = w.name; o.title = w.dir;
        sel.appendChild(o);
      }
      const remembered = (await chrome.storage.local.get('ws')).ws;
      state.workspace = remembered && WORKSPACES_CACHE.some((w) => w.id === remembered) ? remembered : WORKSPACES_CACHE[0].id;
      sel.value = state.workspace;
    } else {
      sel.innerHTML = '<option>—</option>';
      state.workspace = 'ws0';
    }
    sel.onchange = async () => {
      state.workspace = sel.value;
      await chrome.storage.local.set({ ws: sel.value });
      state.picked = null;
      await loadCatsAndTree();
    };
    await loadCatsAndTree();
    await renderPage();
    await renderCollected();
  } else {
    WORKSPACES_CACHE = [];
    $('ws').innerHTML = '<option>—</option>';
    state.workspace = 'ws0';
    renderCats(); renderSubs(); renderRepo();
    await renderPage();
    await renderCollected();
  }
}

async function loadCatsAndTree() {
  $('cats').innerHTML = '<span class="pill gray">加载中…</span>';
  if (!state.serverUp) {
    state.categories = [];
    renderCats(); renderSubs(); renderRepo();
    return;
  }
  try {
    const tree = await fetchApi(`/api/tree?workspace=${state.workspace}`);
    state.categories = tree.categories || [];
    renderCats(); renderSubs();
  } catch (e) {
    state.categories = [];
    renderCats(); renderSubs();
  }
  renderRepo();
}

// ---------- 收藏: record article address locally (crawl left empty) ----------
async function renderPage() {
  const page = await detectPage();
  if (!page) {
    $('pageTitle').textContent = '无可用页面';
    $('pageUrl').style.display = 'none';
    return;
  }
  $('pageTitle').textContent = page.title || page.url;
  $('pageUrl').textContent = page.url;
  $('pageUrl').style.display = '';
}

function setColStatus(msg, kind = 'busy') {
  const el = $('colStatus');
  el.className = 'status show ' + kind;
  el.innerHTML = escapeHtml(msg);
}

async function renderCollected() {
  const box = $('colList');
  if (!state.serverUp) {
    box.innerHTML = '<span class="pill gray">服务离线 — 无法读取收藏</span>';
    return;
  }
  try {
    const data = await fetchApi('/api/collected');
    state.collected = data.collected || [];
    if (!state.collected.length) {
      box.innerHTML = '<span class="pill gray">暂无收藏</span>';
      return;
    }
    box.innerHTML = state.collected.map((c) => `
      <div class="job">
        <div class="jhead">
          <span class="jname">${escapeHtml(c.title || c.url)}</span>
          <span class="jstatus">${escapeHtml(c.crawlStatus || 'pending')}</span>
        </div>
        <div class="jcmd">${escapeHtml(c.url)}</div>
        ${c.note ? `<div class="jerr" style="color:var(--ink-2)">${escapeHtml(c.note)}</div>` : ''}
        ${c.source ? `<div class="jcmd">来源: ${escapeHtml(c.source)}</div>` : ''}
        ${c.id ? `<button class="retry" data-id="${escapeHtml(c.id)}">删除</button>` : ''}
      </div>`).join('');
    box.querySelectorAll('.retry').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await fetchApi('/api/collect/remove', { method: 'POST', body: JSON.stringify({ id: b.dataset.id }), headers: { 'Content-Type': 'application/json' } });
          setColStatus('已删除', 'ok');
          await renderCollected();
        } catch (e) { setColStatus('删除失败: ' + e.message, 'err'); }
      };
    });
  } catch (e) {
    box.innerHTML = `<span class="pill gray">${escapeHtml(e.message)}</span>`;
  }
}

$('colGo').onclick = async () => {
  const page = await detectPage();
  if (!page) { setColStatus('没有可收藏的页面', 'err'); return; }
  const btn = $('colGo');
  btn.disabled = true;
  try {
    const body = JSON.stringify({
      url: page.url,
      title: $('colTitle').value.trim() || null,
      note: $('colNote').value.trim() || null,
      source: 'browser',
    });
    const res = await fetchApi('/api/collect', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    setColStatus(`已收藏 → ${res.collected.url} (爬取暂未实现)`, 'ok');
    $('colTitle').value = ''; $('colNote').value = '';
    await renderCollected();
  } catch (e) {
    setColStatus('收藏失败: ' + e.message, 'err');
  }
  btn.disabled = false;
};
$('colReload').onclick = () => renderCollected();

// ---------- clone-website (placeholder, planned later) ----------
function setSiteStatus(msg, kind = 'busy') {
  const el = $('siteStatus');
  el.className = 'status show ' + kind;
  el.innerHTML = escapeHtml(msg);
}

$('siteGo').onclick = async () => {
  const url = $('siteUrl').value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) { setSiteStatus('请输入合法的 http(s) 站点地址', 'err'); return; }
  const btn = $('siteGo');
  btn.disabled = true;
  try {
    const r = await fetch(apiBase(await settings()) + '/api/clone-website', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers(await settings()) },
      body: JSON.stringify({ workspace: state.workspace, url, name: $('siteName').value.trim() || null }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 501) {
      setSiteStatus('clone-website 处理逻辑暂未实现,计划后续实现。规划路径: ' + (body.plannedPath || '—'), 'busy');
    } else if (!r.ok) {
      setSiteStatus('失败: ' + (body.error || ('HTTP ' + r.status)), 'err');
    } else {
      setSiteStatus('已提交: ' + (body.plannedPath || url), 'ok');
    }
  } catch (e) {
    setSiteStatus('请求失败: ' + e.message, 'err');
  }
  btn.disabled = false;
};

// ---------- clone action ----------
function setStatus(msg, kind = 'busy') {
  const el = $('status');
  el.className = 'status show ' + kind;
  el.innerHTML = escapeHtml(msg);
}

$('go').onclick = async () => {
  const r = state.repo;
  if (!r || !state.picked) return;
  const btn = $('go');
  btn.disabled = true;

  if (!state.serverUp) { await doCopy(); btn.disabled = false; return; }

  const category = state.pickedSub ? `${state.picked}/${state.pickedSub}` : state.picked;
  setStatus('已提交 clone 请求 — 后台执行中', 'busy');
  try {
    const body = JSON.stringify({ workspace: state.workspace, category, url: r.url, name: r.name });
    const res = await fetchApi('/api/clone', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    setStatus(`已入队 (${res.job.id}) — ${res.job.path}`, 'ok');
    if (state.jobsOpen) { renderJobs(); startJobsPolling(); }
  } catch (e) {
    setStatus('失败: ' + e.message, 'err');
  }
  btn.disabled = false;
};

async function doCopy() {
  const cmd = cloneCommand();
  await navigator.clipboard.writeText(cmd);
  setStatus('已复制命令 → 粘贴到终端执行', 'ok');
}
$('copy').onclick = () => doCopy();

// ---------- history / progress tab ----------
let jobsTimer = null;

function startJobsPolling() {
  if (jobsTimer) return;
  renderJobs();
  jobsTimer = setInterval(() => { if (state.jobsOpen) renderJobs(); }, 2000);
}

function stopJobsPolling() {
  if (jobsTimer) { clearInterval(jobsTimer); jobsTimer = null; }
}

$('refreshJobs').onclick = (e) => { e.preventDefault(); renderJobs(); };

async function renderJobs() {
  if (!state.jobsOpen) return;
  const list = $('jobsList');
  try {
    const data = await fetchApi('/api/jobs?limit=50');
    const jobs = data.jobs || [];
    $('concInfo').textContent = `并发 ${data.running}/${data.maxConcurrent}`;
    if (!jobs.length) { list.innerHTML = '<span class="pill gray">暂无记录</span>'; return; }
    const ICON = { queued: '⏳', running: '🔄', retrying: '🔁', done: '✅', failed: '❌' };
    const now = Date.now();
    list.innerHTML = jobs.map((j) => {
      const p = j.progress || {};
      const pct = p.percent || (j.status === 'done' ? 100 : 0);
      const stage = p.stage || j.status;
      const active = j.status === 'running' || j.status === 'queued' || j.status === 'retrying';
      const mins = j.createdAt ? Math.max(1, Math.round((now - Date.parse(j.createdAt)) / 60000)) : null;
      const activeTag = active && mins ? `<span class="pill gray">${mins}min${j.attempt > 1 ? ' · 第' + j.attempt + '次' : ''}</span>` : '';
      return `
      <div class="job ${j.status}" title="${escapeHtml(j.command)}">
        <div class="jhead">
          <span class="ji">${ICON[j.status] || '·'}</span>
          <span class="jname">${escapeHtml(j.name || '')}</span>
          <span class="jstatus">${escapeHtml(j.status)}</span>
        </div>
        <div class="jmeta">
          <span class="pill gray">${escapeHtml(j.category)}</span>
          ${activeTag}
          ${j.status === 'done' ? `<span class="pill">${escapeHtml(j.kind)} OK</span>` : ''}
        </div>
        <div class="jprogress">
          <div class="bar" style="width:${pct}%"></div>
        </div>
        <div><span class="jpct">${pct}% · ${escapeHtml(stage)}</span></div>
        <div class="jcmd">${escapeHtml(j.command)}</div>
        ${j.error ? `<div class="jerr">${escapeHtml(j.error)}</div>` : ''}
        ${j.status === 'failed' ? `<button class="retry" data-id="${escapeHtml(j.id)}">重跑</button>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('.retry').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await fetchApi('/api/retry', { method: 'POST', body: JSON.stringify({ id: b.dataset.id }), headers: { 'Content-Type': 'application/json' } });
          setStatus('已重新入队 — 后台执行中', 'ok');
          setTimeout(renderJobs, 300);
        } catch (e) { setStatus('重跑失败: ' + e.message, 'err'); }
      };
    });
  } catch (e) {
    list.innerHTML = `<span class="pill gray">${escapeHtml(e.message)}</span>`;
  }
}

// ---------- boot ----------
(async function boot() {
  renderServer(false, '检查服务…');
  state.repo = await detectRepo();
  renderRepo();
  await loadAll();
})();
