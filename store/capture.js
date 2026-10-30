// Takes the store screenshots from the real extension in headless Brave, on a throwaway profile with made-up groups.
// Usage: node store/capture.js
// Writes 1280x800 PNGs to store/screenshots. Run store/clean-shots.py afterwards.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, start } from '../tests/headless.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, '..', 'extension');
const OUT = join(HERE, 'screenshots');

const profile = await mkdtemp(join(tmpdir(), 'idle-tabs-check-'));
await mkdir(OUT, { recursive: true });
const browser = await start(profile, EXT);
try {
  const { send, sw, extId } = browser;
  await sw(async () => {
    const claudeWin = await chrome.windows.create({ url: 'about:blank', focused: false });
    await chrome.storage.local.set({ useWindow: true, windowId: claudeWin.id });
    const main = (await chrome.windows.getAll()).find((w) => w.id !== claudeWin.id);
    const group = async (windowId, title, color, count) => {
      const tabs = [];
      for (let i = 0; i < count; i++) tabs.push((await chrome.tabs.create({ windowId, url: 'about:blank', active: false })).id);
      const id = await chrome.tabs.group({ tabIds: tabs, createProperties: { windowId } });
      await chrome.tabGroups.update(id, { title, color });
      return id;
    };
    const claude = [
      await group(claudeWin.id, 'Claude (MCP)', 'yellow', 2),
      await group(claudeWin.id, 'Fix the login page', 'blue', 3),
      await group(claudeWin.id, 'Write the release notes', 'purple', 1),
    ];
    await group(main.id, 'Trip planning', 'green', 3);
    await chrome.storage.session.set({ claudeGroups: claude });
  });
  await sleep(1500);

  const open = async (url) => {
    const { targetId } = await send('Target.createTarget', { url });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Page.bringToFront', {}, sessionId); // a background tab doesn't paint, so it can't be captured
    return sessionId;
  };
  const shoot = async (session, name, scheme = 'light') => {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, session);
    // 864x540 scaled up is the 1280x800 the store asks for, with the page at a readable size.
    await send('Emulation.setDeviceMetricsOverride', { width: 864, height: 540, deviceScaleFactor: 1280 / 864, mobile: false }, session);
    await send('Emulation.setScrollbarsHidden', { hidden: true }, session);
    // The settings column sits to the left of a page this wide; in Brave's options dialog it fills the width.
    await send('Runtime.evaluate', { expression: "document.querySelector('main').style.marginInline = 'auto'" }, session);
    await sleep(600);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, session);
    await writeFile(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  };

  await shoot(await open(`chrome-extension://${extId}/options.html`), 'settings');
  const { targetInfos } = await send('Target.getTargets');
  const keeper = targetInfos.find((t) => t.type === 'page' && t.url.endsWith('/keeper.html'));
  const { sessionId } = await send('Target.attachToTarget', { targetId: keeper.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Page.bringToFront', {}, sessionId);
  await shoot(sessionId, 'pinned-tab');
  console.log(`screenshots in ${OUT}`);
} finally {
  await browser.stop();
  await sleep(500);
  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
process.exit(0);
