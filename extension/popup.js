/* KeepIt popup — Tab 式 UI: Clone / 稍后读 / 克隆网站 / 历史·进度. */
'use strict';

const $ = (id) => document.getElementById(id);
const FIXED_CATS = ['skills', 'plugins', 'products', 'others'];
const state = {
  repo: null,        // { owner, name, url }
  currentPage: null, // { url, title }
  siteUrlEdited: false,
  workspace: null,
  categories: [],
  picked: null,
  pickedSub: null,
  serverUp: false,
  jobsOpen: false,   // true when history tab is active
  collectFilter: 'all', // 'all' | 'collection' | 'clone'
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
function headers(s) { return s.token ? { 'X-KeepIt-Token': s.token } : {}; }

async function fetchApi(pathname, opts = {}) {
  const s = await settings();
  const r = await fetch(apiBase(s) + pathname, { ...opts, headers: { ...headers(s), ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) throw new Error(body.error || ('HTTP ' + r.status));
  return body;
}

function defaultSiteName(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, '').replace(/[^\w.-]/g, '-') || 'site';
    const segs = u.pathname.split('/').filter(Boolean).map((s) => s.replace(/[^\w.-]/g, '-')).filter(Boolean);
    const full = segs.length ? `${host}-${segs.join('-')}` : host;
    return full.slice(0, 80).replace(/-+$/g, '') || 'site';
  } catch {
    return '站点名称';
  }
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
    if (tab === 'collect' || tab === 'website') {
      renderPage();
      refreshCollectedStore();
    }
  };
});

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

// ---------- current page info (for 稍后读 & 克隆网站, any http/https page) ----------
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
  const sep = ws && ws.dir.includes('\\') ? '\\' : '/';
  const root = ws ? ws.dir.replace(/[\\/]+$/, '') + sep + 'references' : `<workspace>${sep}references`;
  const cat = (state.pickedSub ? `${state.picked}/${state.pickedSub}` : (state.picked || '<category>')).replace(/\//g, sep);
  return `git clone --depth=1 ${r.url}.git "${root}${sep}${cat}${sep}${r.name}"`;
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
    await refreshCollectedStore();
  } else {
    WORKSPACES_CACHE = [];
    $('ws').innerHTML = '<option>—</option>';
    state.workspace = 'ws0';
    renderCats(); renderSubs(); renderRepo();
    await renderPage();
    await refreshCollectedStore();
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
  } catch {
    state.categories = [];
    renderCats(); renderSubs();
  }
  renderRepo();
}

// ---------- current page auto-fill (稍后读 & 克隆网站) ----------
async function renderPage() {
  const page = await detectPage();
  state.currentPage = page;

  // 稍后读 tab
  if (!page) {
    $('pageTitle').textContent = '无可用页面';
    $('pageUrl').style.display = 'none';
    $('colTitle').placeholder = '为这篇文章起个名字';
  } else {
    $('pageTitle').textContent = page.title || page.url;
    $('pageUrl').textContent = page.url;
    $('pageUrl').style.display = '';
    $('colTitle').placeholder = page.title || '为这篇文章起个名字';
  }

  // 克隆网站 tab: 自动识别当前网址并填入输入框
  if (!page) {
    $('sitePageTitle').textContent = '未识别到当前网页（可手动输入网址）';
    $('sitePageUrl').style.display = 'none';
  } else {
    $('sitePageTitle').textContent = page.title || page.url;
    $('sitePageUrl').textContent = page.url;
    $('sitePageUrl').style.display = '';
    if (!state.siteUrlEdited) {
      $('siteUrl').value = page.url;
      $('siteName').placeholder = '默认: ' + defaultSiteName(page.url);
    }
  }
}

$('siteUrl').oninput = () => {
  state.siteUrlEdited = true;
  const v = $('siteUrl').value.trim();
  $('siteName').placeholder = /^https?:\/\/\S+$/i.test(v)
    ? '默认: ' + defaultSiteName(v)
    : '默认按网址自动生成';
};

// ---------- collected.json shared store (category: collection | clone) ----------
function setColStatus(msg, kind = 'busy') {
  const el = $('colStatus');
  el.className = 'status show ' + kind;
  el.innerHTML = escapeHtml(msg);
}

function setSiteStatus(msg, kind = 'busy') {
  const el = $('siteStatus');
  el.className = 'status show ' + kind;
  el.innerHTML = escapeHtml(msg);
}

function renderEntryCard(c) {
  const cat = c.category === 'clone' ? 'clone' : 'collection';
  const catPill = cat === 'clone'
    ? '<span class="pill gray">clone</span>'
    : '<span class="pill">collection</span>';
  const heading = c.title || c.name || c.url;
  return `
    <div class="job">
      <div class="jhead">
        ${catPill}
        <span class="jname">${escapeHtml(heading)}</span>
        <span class="jstatus">${escapeHtml(c.crawlStatus || 'pending')}</span>
      </div>
      <div class="jcmd" title="${escapeHtml(c.url)}">${escapeHtml(c.url)}</div>
      ${c.plannedPath ? `<div class="jcmd" title="${escapeHtml(c.plannedPath)}">目标: ${escapeHtml(c.plannedPath)}</div>` : ''}
      ${c.note ? `<div class="jerr" style="color:var(--ink-2)">${escapeHtml(c.note)}</div>` : ''}
      ${c.id ? `<button class="retry" data-id="${escapeHtml(c.id)}" style="margin-top:4px">删除</button>` : ''}
    </div>`;
}

function bindRemoveButtons(box, onStatus) {
  box.querySelectorAll('.retry[data-id]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fetchApi('/api/collect/remove', {
          method: 'POST',
          body: JSON.stringify({ id: b.dataset.id }),
          headers: { 'Content-Type': 'application/json' },
        });
        onStatus('已删除', 'ok');
        await refreshCollectedStore();
      } catch (e) {
        onStatus('删除失败: ' + e.message, 'err');
        b.disabled = false;
      }
    };
  });
}

function renderCollectedLists() {
  // 1) 稍后读 tab 列表 (支持 全部 / collection / clone 过滤)
  const colBox = $('colList');
  const filtered = state.collectFilter === 'all'
    ? state.collected
    : state.collected.filter((c) => (c.category || 'collection') === state.collectFilter);
  if (!filtered.length) {
    colBox.innerHTML = '<span class="pill gray">暂无记录</span>';
  } else {
    colBox.innerHTML = filtered.map(renderEntryCard).join('');
    bindRemoveButtons(colBox, setColStatus);
  }

  // 2) 克隆网站 tab 列表 (固定展示 category === 'clone')
  const siteBox = $('siteList');
  const clones = state.collected.filter((c) => c.category === 'clone');
  if (!clones.length) {
    siteBox.innerHTML = '<span class="pill gray">暂无待克隆网站记录</span>';
  } else {
    siteBox.innerHTML = clones.map(renderEntryCard).join('');
    bindRemoveButtons(siteBox, setSiteStatus);
  }
}

async function refreshCollectedStore() {
  const colBox = $('colList');
  const siteBox = $('siteList');
  if (!state.serverUp) {
    colBox.innerHTML = '<span class="pill gray">服务离线 — 无法读取记录</span>';
    siteBox.innerHTML = '<span class="pill gray">服务离线 — 无法读取记录</span>';
    return;
  }
  try {
    const data = await fetchApi('/api/collected');
    state.collected = data.collected || [];
    renderCollectedLists();
  } catch (e) {
    const msg = `<span class="pill gray">${escapeHtml(e.message)}</span>`;
    colBox.innerHTML = msg;
    siteBox.innerHTML = msg;
  }
}

document.querySelectorAll('#colFilter button[data-cat]').forEach((btn) => {
  btn.onclick = () => {
    state.collectFilter = btn.dataset.cat;
    document.querySelectorAll('#colFilter button[data-cat]').forEach((b) => b.classList.toggle('on', b === btn));
    renderCollectedLists();
  };
});

$('colGo').onclick = async () => {
  const page = await detectPage();
  if (!page) { setColStatus('没有可保存的页面', 'err'); return; }
  if (!state.serverUp) { setColStatus('服务离线 — 请先启动后台服务', 'err'); return; }
  const btn = $('colGo');
  btn.disabled = true;
  try {
    const body = JSON.stringify({
      category: 'collection',
      url: page.url,
      title: $('colTitle').value.trim() || page.title || null,
      note: $('colNote').value.trim() || null,
      source: 'browser',
    });
    const res = await fetchApi('/api/collect', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    setColStatus(`已记录 [collection] → ${res.collected.url} (待后续处理)`, 'ok');
    $('colTitle').value = ''; $('colNote').value = '';
    await refreshCollectedStore();
  } catch (e) {
    setColStatus('稍后读失败: ' + e.message, 'err');
  }
  btn.disabled = false;
};
$('colReload').onclick = () => refreshCollectedStore();

// ---------- 克隆网站: 记录到 collected.json [category=clone] ----------
$('siteGo').onclick = async () => {
  const url = $('siteUrl').value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) { setSiteStatus('请输入合法的 http(s) 站点地址', 'err'); return; }
  if (!state.serverUp) { setSiteStatus('服务离线 — 请先启动后台服务', 'err'); return; }
  const btn = $('siteGo');
  btn.disabled = true;
  try {
    const page = state.currentPage;
    const body = JSON.stringify({
      workspace: state.workspace,
      url,
      name: $('siteName').value.trim() || null,
      title: page && page.url === url ? (page.title || null) : null,
      note: $('siteNote').value.trim() || null,
      source: 'browser',
    });
    const res = await fetchApi('/api/clone-website', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });
    setSiteStatus(`已记录 [clone] → ${res.plannedPath || res.url} (待后续处理)`, 'ok');
    $('siteName').value = ''; $('siteNote').value = '';
    await refreshCollectedStore();
  } catch (e) {
    setSiteStatus('记录失败: ' + e.message, 'err');
  }
  btn.disabled = false;
};
$('siteReload').onclick = () => refreshCollectedStore();

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
  await renderPage();
  await loadAll();
})();
