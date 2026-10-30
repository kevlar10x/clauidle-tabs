// Checks that Claude's window is recognised again after Brave restarts, through its restored keeper tab.
// Usage: node tests/restart-check.js
// Runs headless Brave twice on one throwaway profile, then deletes it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, start } from './headless.js';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const state = (sw) => sw(async () => {
  const { useWindow, windowId, keeperTab } = await chrome.storage.local.get(['useWindow', 'windowId', 'keeperTab']);
  const keepers = (await chrome.runtime.getContexts({ contextTypes: ['TAB'] }))
    .filter((c) => c.documentUrl.endsWith('/keeper.html')).map((c) => ({ tab: c.tabId, window: c.windowId }));
  const windowAlive = windowId != null && await chrome.windows.get(windowId).then(() => true, () => false);
  return { useWindow, windowId, keeperTab, keepers, windowAlive, windows: (await chrome.windows.getAll()).length };
});

const profile = await mkdtemp(join(tmpdir(), 'idle-tabs-check-'));
try {
  let browser = await start(profile, EXT);
  await browser.sw(async () => {
    const win = await chrome.windows.create({ url: 'about:blank', focused: false });
    await chrome.storage.local.set({ useWindow: true, windowId: win.id });
  });
  await sleep(1500);
  const before = await state(browser.sw);
  check('before: Claude\'s window has its keeper tab', before.keepers.length === 1 && before.keepers[0].window === before.windowId,
    JSON.stringify(before));
  await browser.stop();

  browser = await start(profile, EXT, ['--restore-last-session']);
  let after;
  for (let i = 0; i < 40; i++) {
    after = await state(browser.sw);
    if (after.windowAlive && after.keepers.some((k) => k.window === after.windowId)) break;
    await sleep(250);
  }
  check('after a restart, the restored keeper tab makes its window Claude\'s window again',
    after.windowAlive && after.windowId !== before.windowId && after.keepers.some((k) => k.window === after.windowId && k.tab === after.keeperTab),
    JSON.stringify(after));
  check('and only one keeper tab is open', after.keepers.length === 1, `${after.keepers.length}`);
  await browser.stop();
} finally {
  await sleep(500);
  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
