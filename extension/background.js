/* KeepIt background service worker — keyboard shortcut → open popup window. */
'use strict';

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-keepit') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    focused: true,
    width: 420,
    height: 620,
    ...(tab ? { top: Math.max(0, (tab.windowId ? 100 : 100)) } : {}),
  });
  void w;
});
