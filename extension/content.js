/* CloneIt content script — GitHub repo page badge. */
'use strict';

(() => {
  if (window.__cloneitInjected) return;
  window.__cloneitInjected = true;

  const m = location.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/);
  if (!m) return;
  const [, owner, name] = m;
  if (!name || ['orgs', 'topics', 'explore', 'marketplace', 'trending', 'collections', 'settings', 'features'].includes(owner)) return;

  const badge = document.createElement('div');
  badge.className = 'cloneit-badge';
  badge.textContent = 'R';
  badge.title = `CloneIt 就绪: ${owner}/${name} — 点击工具栏图标或按 Alt+R 一键 clone`;
  badge.addEventListener('click', () => {
    badge.classList.add('pulse');
    setTimeout(() => badge.classList.remove('pulse'), 900);
  });
  document.documentElement.appendChild(badge);
})();
