// End-to-end check in a real headless Brave with a throwaway profile.
// Usage: node tests/browser-check.js [screenshot folder]
// Closes Brave and deletes the profile when done.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorker } from './headless.js';

const BRAVE = process.env.BRAVE ?? 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const SHOTS = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.waiting = new Map();
    this.listeners = new Set();
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      const pending = this.waiting.get(msg.id);
      if (pending) {
        this.waiting.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      } else {
        for (const listen of this.listeners) listen(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      // Fail rather than hang when Brave never answers.
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
      this.waiting.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }
  async evaluate(sessionId, fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const { result, exceptionDetails } = await this.send(
      'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }
}

const profile = await mkdtemp(join(tmpdir(), 'idle-tabs-check-'));
const brave = spawn(BRAVE, [
  '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank',
], { stdio: 'ignore', windowsHide: true });

try {
  // Brave writes its DevTools port into the profile once it's listening.
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [port, path] = (await readFile(portFile, 'utf8')).trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new CDP(ws);

  const worker = await findWorker((...args) => cdp.send(...args), EXT);
  check('extension loads and its service worker starts', !!worker);
  if (!worker) throw new Error('No service worker, stopping.');
  const extId = new URL(worker.url).host;
  const { sessionId: sw } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  const errors = [];
  cdp.listeners.add((m) => {
    if (m.sessionId === sw && m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.sessionId === sw && m.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(m.params.type)) {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });
  await cdp.send('Runtime.enable', {}, sw);
  // Right after attaching, the worker can answer before the extension's APIs are in place.
  let name;
  for (let i = 0; i < 50 && !name; i++) {
    name = await cdp.evaluate(sw, () => globalThis.chrome?.runtime?.getManifest?.().name);
    if (!name) await sleep(100);
  }
  check('service worker is this extension', name === 'Clauidle Tabs', String(name));
  if (name !== 'Clauidle Tabs') throw new Error('Wrong service worker, stopping.');

  // Run in the service worker: make Claude-style groups and report what's open.
  const sw$ = (fn, ...args) => cdp.evaluate(sw, fn, ...args);
  const makeGroup = (title, count) => sw$(async (title, count) => {
    const tabs = [];
    for (let i = 0; i < count; i++) {
      tabs.push(await chrome.tabs.create({ url: `data:text/html,<title>${title} ${i}</title>`, active: false }));
    }
    const groupId = await chrome.tabs.group({ tabIds: tabs.map((t) => t.id) });
    await chrome.tabGroups.update(groupId, { title });
    return tabs.map((t) => t.id);
  }, title, count);
  const openIds = () => sw$(async () => (await chrome.tabs.query({})).map((t) => t.id));

  // Brave sometimes loads a background tab late, which rightly counts as a touch,
  // so these wait up to 10 seconds for a close instead of expecting it at an exact time.
  const closedWithin = async (ids, ms, meanwhile = async () => {}) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      const open = await openIds();
      if (ids.every((id) => !open.includes(id))) return true;
      await meanwhile();
      await sleep(250);
    }
    return false;
  };

  // 1. Untouched tabs close, a touched one stays, other groups are left alone.
  await sw$(() => chrome.storage.local.set({ minutes: 0.05 })); // 3 seconds
  const [idleTab, busyTab] = await makeGroup('Claude (MCP)', 2);
  // Two tabs, so it isn't made the way Claude makes a session group.
  const [workTab] = await makeGroup('Work', 2);
  const started = Date.now();
  let lastReload = 0;
  const keepBusy = async () => {
    if (Date.now() - lastReload < 1000) return;
    lastReload = Date.now();
    await sw$((id) => chrome.tabs.reload(id), busyTab);
  };
  check('untouched Claude (MCP) tab closes', await closedWithin([idleTab], 10_000, keepBusy));
  while (Date.now() - started < 8000) { await keepBusy(); await sleep(250); }
  let open = await openIds();
  check('a Claude (MCP) tab that keeps loading stays open well past the limit', open.includes(busyTab));
  check('a tab in another group stays open', open.includes(workTab));
  check('once it stops loading, it closes too', await closedWithin([busyTab], 10_000));

  // 2. Claude's tabs as the only ones open, with focus elsewhere: a new tab keeps the browser open.
  // A popup window takes the focus, standing in for you being in another app.
  await sw$(() => chrome.storage.local.set({ minutes: 60 }));
  const [lastTab] = await makeGroup('Claude (MCP)', 1);
  const popup = await sw$(async (keep) => {
    const others = (await chrome.tabs.query({})).filter((t) => t.id !== keep).map((t) => t.id);
    await chrome.tabs.remove(others);
    return (await chrome.windows.create({ type: 'popup', url: 'about:blank', focused: true })).id;
  }, lastTab);
  // Headless Brave is loose about focus, so wait until it reports the popup as focused.
  for (let i = 0; i < 20; i++) {
    if (await sw$(async (id) => (await chrome.windows.getLastFocused()).id === id, popup)) break;
    await sw$((id) => chrome.windows.update(id, { focused: true }), popup);
    await sleep(100);
  }
  const normalTabs = () => sw$(async () => (await chrome.tabs.query({ windowType: 'normal' })).map((t) => t.id));
  await sw$(() => chrome.storage.local.set({ minutes: 0.05 }));
  const lastClosed = await closedWithin([lastTab], 10_000);
  open = await normalTabs();
  check('the last Claude tab closes, with a new tab left open in its place',
    lastClosed && open.length === 1, `normal-window tabs: ${JSON.stringify(open)}, Claude tab ${lastTab}`);
  await sw$((id) => chrome.windows.remove(id), popup);

  // 3. Turned off: nothing closes.
  await sw$(() => chrome.storage.local.set({ enabled: false }));
  const [offTab] = await makeGroup('Claude (MCP)', 1);
  await sleep(4500);
  check('turned off, nothing closes', (await openIds()).includes(offTab));
  await sw$(() => chrome.storage.local.set({ enabled: true, minutes: 30 }));
  await sleep(300); // the sweep runs from the storage change, just after the write
  const alarm = await sw$(() => chrome.alarms.get('sweep'));
  check('turning it back on sets one alarm', !!alarm);

  // 4. Settings page, light and dark, narrow and wide.
  await makeGroup('Claude (MCP)', 2);
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const { sessionId: page } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, page);
  await sleep(800);
  const statusText = await cdp.evaluate(page, () => document.getElementById('status').textContent);
  check('settings page shows the watched tabs', /^Watching 3 tabs\. The next one closes at .+\.$/.test(statusText), statusText);

  const shoot = async (label, session = page, widths = [400, 680]) => {
    if (!SHOTS) return;
    await mkdir(SHOTS, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      for (const width of widths) {
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, session);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 2, mobile: false }, session);
        await sleep(200);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
        await writeFile(join(SHOTS, `options-${label}-${scheme}-${width}.png`), Buffer.from(data, 'base64'));
      }
    }
  };
  await shoot('normal');

  const invalid = await cdp.evaluate(page, async () => {
    const field = document.getElementById('minutes');
    field.value = '0';
    field.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 50));
    const saved = (await chrome.storage.local.get('minutes')).minutes;
    return { error: !document.getElementById('minutes-error').hidden, saved };
  });
  check('0 minutes shows the error and is not saved', invalid.error && invalid.saved === 30, JSON.stringify(invalid));

  const off = await cdp.evaluate(page, async () => {
    const field = document.getElementById('minutes');
    field.dispatchEvent(new Event('blur'));
    document.getElementById('enabled').click();
    await new Promise((r) => setTimeout(r, 400));
    return { minutes: field.value, disabled: field.disabled, status: document.getElementById('status').textContent };
  });
  check('leaving a bad value puts the saved one back', off.minutes === '30', off.minutes);
  check('the switch turns it off', off.disabled && off.status === "Off. Claude's tabs stay open.", off.status);
  await shoot('off');

  // 5. Claude's window: Claude's groups move there, yours stay where they are.
  await sw$(() => chrome.storage.local.set({ enabled: true, minutes: 30 }));
  const waitFor = async (fn, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await sleep(150); }
    return false;
  };
  const groupWindow = (id) => sw$((id) => chrome.tabGroups.get(id).then((g) => g.windowId, () => null), id);
  // The way the Claude extension makes a session's group: one new background tab, grouped,
  // called Claude for a moment, then given the session's name.
  const claudeLike = (title, windowId) => sw$(async (title, windowId) => {
    const t = await chrome.tabs.create({ windowId, url: 'data:text/html,<title>s</title>', active: false });
    const groupId = await chrome.tabs.group({ tabIds: t.id, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: 'Claude', color: 'orange', collapsed: false });
    await chrome.tabGroups.update(groupId, { title, color: 'cyan' });
    return { groupId, tabId: t.id };
  }, title, windowId);

  const mainWin = await sw$(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id);
  const claudeWin = await sw$(async () => (await chrome.windows.create({ url: 'about:blank', focused: false })).id);
  await sw$((id) => chrome.storage.local.set({ useWindow: true, windowId: id }), claudeWin);
  const session = await claudeLike('Fix the login page', mainWin);
  check("a Claude session group moves to Claude's window, keeping its id",
    await waitFor(async () => (await groupWindow(session.groupId)) === claudeWin));
  const later = await sw$(async (windowId, groupId) => {
    const t = await chrome.tabs.create({ windowId, url: 'data:text/html,later', active: false });
    await chrome.tabs.group({ tabIds: t.id, groupId });
    return (await chrome.tabs.get(t.id)).windowId;
  }, mainWin, session.groupId);
  check("a tab Claude adds to that group later lands in Claude's window", later === claudeWin);

  // Yours: a group made around an older tab, and one named a few seconds after it was made.
  const oldTab = await sw$(async (w) => (await chrome.tabs.create({ windowId: w, url: 'data:text/html,old', active: false })).id, mainWin);
  const slowGroup = await sw$(async (w) => {
    const t = await chrome.tabs.create({ windowId: w, url: 'data:text/html,slow', active: false });
    return chrome.tabs.group({ tabIds: t.id, createProperties: { windowId: w } });
  }, mainWin);
  await sleep(3500);
  const mine = await sw$(async (w, oldTab, slowGroup) => {
    const g = await chrome.tabs.group({ tabIds: oldTab, createProperties: { windowId: w } });
    await chrome.tabGroups.update(g, { title: 'Recipes' });
    await chrome.tabGroups.update(slowGroup, { title: 'Reading' });
    return g;
  }, mainWin, oldTab, slowGroup);
  await sleep(1500);
  check('your own groups stay where they are',
    (await groupWindow(mine)) === mainWin && (await groupWindow(slowGroup)) === mainWin);

  // After a restart Brave gives every window a new id, so the saved one points at nothing.
  // (Closing the window from here would be the other way, but headless Brave won't close a window
  // holding a tab group from the API, even with no extension involved.)
  await sw$(() => chrome.storage.local.set({ windowId: 424242 }));
  const next = await claudeLike('Write the docs', mainWin);
  const moved = await waitFor(async () => ![null, mainWin, claudeWin].includes(await groupWindow(next.groupId)));
  const remembered = await sw$(() => chrome.storage.local.get('windowId').then((s) => s.windowId));
  check("when Claude's window is gone, the next group gets a new window, and it's remembered",
    moved && remembered === await groupWindow(next.groupId), `remembered ${remembered}`);
  check('earlier Claude groups follow to the new window',
    await waitFor(async () => (await groupWindow(session.groupId)) === remembered));

  await sw$(() => chrome.storage.local.set({ minutes: 0.05 }));
  check("idle tabs in a Claude session group close", await closedWithin([next.tabId], 10_000));
  check("Claude's window stays open", await sw$((id) => chrome.windows.get(id).then(() => true, () => false), remembered));
  await sw$(() => chrome.storage.local.set({ minutes: 30 }));

  // When a session's tab leaves its group, Claude puts it in a new group called just Claude, which keeps that
  // name until the next tool call. The side panel uses the name too, so it only counts in Claude's window.
  const openTab = (windowId) => sw$(async (w) => (await chrome.tabs.create({ windowId: w, url: 'data:text/html,<title>r</title>', active: false })).id, windowId);
  const inClaudesWindow = await openTab(remembered);
  const inMainWindow = await openTab(mainWin);
  await sleep(3500); // older tabs, so neither is spotted as a new session
  const regroup = (tabId, windowId) => sw$(async (tabId, windowId) => {
    const groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: 'Claude', color: 'orange', collapsed: false });
    return groupId;
  }, tabId, windowId);
  const regrouped = await regroup(inClaudesWindow, remembered);
  const sidePanel = await regroup(inMainWindow, mainWin);
  await sw$(() => chrome.storage.session.remove('claudeGroups')); // what a reload or a restart does
  await sw$(() => chrome.storage.local.set({ minutes: 0.05 }));
  // Unloading gives a tab a new id, so this goes by the group, which closes with its last tab.
  check("idle tabs in a group called just Claude close in Claude's window",
    await waitFor(async () => (await groupWindow(regrouped)) === null, 10_000));
  check("and in another window they stay, since it could be the side panel on your own tab",
    (await groupWindow(sidePanel)) === mainWin);
  await sw$(() => chrome.storage.local.set({ minutes: 30 }));
  await sw$((id) => chrome.tabs.remove(id), inMainWindow);

  // 6. Groups made before the extension was on: you switch them on, and their names are remembered.
  const groupOf = (tabId) => sw$((id) => chrome.tabs.get(id).then((t) => t.groupId), tabId);
  const switchState = (gid) => cdp.evaluate(page, (id) => document.getElementById(`group-${id}`)?.checked ?? null, gid);
  const titles = () => sw$(() => chrome.storage.local.get('titleHashes').then((s) => s.titleHashes ?? []));
  const hashOf = (name) => createHash('sha256').update(name).digest('base64');
  const [preTab] = await makeGroup('🟢 Old session', 2); // two tabs, so it isn't spotted as it's made
  const oldGroup = await groupOf(preTab);
  await waitFor(async () => (await switchState(oldGroup)) !== null);
  check("a group made the way you'd make one starts switched off", (await switchState(oldGroup)) === false);
  await cdp.evaluate(page, (id) => document.getElementById(`group-${id}`).click(), oldGroup);
  check('switching it on counts it, and its name is remembered without the dot',
    await waitFor(async () => (await titles()).includes(hashOf('Old session')) && (await switchState(oldGroup)) === true));
  check('and only its hash is stored, not the name',
    !JSON.stringify(await sw$(() => chrome.storage.local.get(null))).includes('Old session'));
  check("and it moves to Claude's window", await waitFor(async () => (await groupWindow(oldGroup)) === remembered));

  // A restart loses every group id; a restored group keeps its name, and its dot may have changed.
  await sw$(() => chrome.storage.session.remove('claudeGroups'));
  const [restoredTab] = await makeGroup('⚪ Old session', 2);
  const restoredGroup = await groupOf(restoredTab);
  check('after a restart, a group with a remembered name counts again',
    await waitFor(async () => (await switchState(restoredGroup)) === true));
  check('it is not moved', (await groupWindow(restoredGroup)) !== remembered);
  await sw$(() => chrome.storage.local.set({ minutes: 0.05 }));
  check('and its idle tabs close', await closedWithin([restoredTab], 10_000));
  await sw$(() => chrome.storage.local.set({ minutes: 30 }));

  const [laterTab] = await makeGroup('Later stuff', 2);
  const laterGroup = await groupOf(laterTab);
  await sw$((id) => chrome.tabGroups.update(id, { title: '⌛Later stuff' }), laterGroup);
  check("an older group that gets ⌛ (Claude working in it) counts and moves to Claude's window",
    await waitFor(async () => (await groupWindow(laterGroup)) === remembered && (await switchState(laterGroup)) === true));
  await cdp.evaluate(page, (id) => document.getElementById(`group-${id}`).click(), laterGroup);
  check('switching a group off forgets its name',
    await waitFor(async () => !(await titles()).includes('Later stuff') && (await switchState(laterGroup)) === false));

  // 7. Claude's window keeps a New Tab of its own, so it stays open when all of Claude's tabs close.
  const keeper = () => sw$(async () => {
    const { keeperTab } = await chrome.storage.local.get('keeperTab');
    const pages = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const page = pages.find((c) => c.tabId === keeperTab)?.documentUrl ?? '';
    return chrome.tabs.get(keeperTab).then((t) => ({
      id: t.id, windowId: t.windowId, groupId: t.groupId, pinned: t.pinned, discardable: t.autoDiscardable,
      page: page.split('/').pop(),
    }), () => null);
  });
  await waitFor(async () => (await keeper())?.page === 'keeper.html');
  const firstKeeper = await keeper();
  check("Claude's window has its own keeper tab: pinned, the extension's page, never unloaded",
    firstKeeper?.windowId === remembered && firstKeeper.groupId === -1 && firstKeeper.pinned
      && firstKeeper.discardable === false && firstKeeper.page === 'keeper.html',
    JSON.stringify(firstKeeper));
  await sw$(async (windowId, keep) => {
    const others = (await chrome.tabs.query({ windowId })).map((t) => t.id).filter((id) => id !== keep);
    await chrome.tabs.remove(others);
  }, remembered, firstKeeper?.id);
  await sleep(1000);
  check("with every other tab closed, Claude's window stays open",
    await sw$((id) => chrome.windows.get(id).then(() => true, () => false), remembered));
  // Closing it while it's the last tab closes the window, like closing the window yourself,
  // so close it while another tab is open there.
  await claudeLike('Another session', mainWin);
  await waitFor(async () => (await sw$((id) => chrome.tabs.query({ windowId: id }).then((t) => t.length), remembered)) > 1);
  await sw$((id) => chrome.tabs.remove(id), firstKeeper?.id);
  check('closing the keeper tab opens another, so the window stays',
    await waitFor(async () => { const k = await keeper(); return k && k.id !== firstKeeper?.id && k.windowId === remembered; }));

  // A spare keeper tab (one more than needed) closes itself as soon as it loads.
  const spare = await sw$((w) => chrome.tabs.create({ windowId: w, url: chrome.runtime.getURL('keeper.html'), active: false }).then((t) => t.id), remembered);
  check('a spare keeper tab is closed', await closedWithin([spare], 5000));

  // 8. A page that would ask "Leave site?" closes without asking, even the tab showing in its window.
  let prompts = 0;
  const askingPage = async (windowId, active) => {
    const title = `Unsaved form ${active}`;
    const url = `data:text/html,<title>${title}</title><script>onbeforeunload=(e)=>{e.preventDefault();e.returnValue=""}</script><body style="height:100vh">`;
    const tabId = await sw$(async (w, url, active) => (await chrome.tabs.create({ windowId: w, url, active })).id, windowId, url, active);
    let target;
    await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      target = targetInfos.find((t) => t.type === 'page' && t.title === title);
      return target;
    }, 10_000);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    cdp.listeners.add((m) => { if (m.sessionId === sessionId && m.method === 'Page.javascriptDialogOpening') prompts++; });
    await cdp.send('Page.enable', {}, sessionId);
    // Pages can only ask after someone has clicked in them.
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: 50, y: 50, button: 'left', clickCount: 1 }, sessionId);
    }
    await sw$((id) => chrome.tabs.group({ tabIds: id }).then((g) => chrome.tabGroups.update(g, { title: 'Claude (MCP)' })), tabId);
  };
  await askingPage(mainWin, false);
  await askingPage(remembered, true);
  // A popup takes the focus as in check 2, or the tab showing in Claude's window counts as the one you're on.
  const focusTaker = await sw$(async () => (await chrome.windows.create({ type: 'popup', url: 'about:blank', focused: true })).id);
  for (let i = 0; i < 20; i++) {
    if (await sw$(async (id) => (await chrome.windows.getLastFocused()).id === id, focusTaker)) break;
    await sw$((id) => chrome.windows.update(id, { focused: true }), focusTaker);
    await sleep(100);
  }
  await sw$(() => chrome.storage.local.set({ minutes: 0.05 })); // 3 seconds
  // Unloading gives a tab a new id, so this goes by the groups, which close with their last tab.
  check('idle tabs on pages that would ask "Leave site?" close, the one showing in its window too',
    await waitFor(async () => (await sw$(() => chrome.tabGroups.query({ title: 'Claude (MCP)' }).then((g) => g.length))) === 0, 15_000));
  check('and none of them asked', prompts === 0, `${prompts} prompts`);
  await sw$(() => chrome.storage.local.set({ minutes: 30 }));
  await sw$((id) => chrome.windows.remove(id), focusTaker);

  if (SHOTS) {
    // A keeper page opened from here would be a spare and close itself, so use the real one.
    const { targetInfos } = await cdp.send('Target.getTargets');
    const keeperTarget = targetInfos.find((t) => t.type === 'page' && t.url.endsWith('/keeper.html'));
    const { sessionId: keeperPage } = await cdp.send('Target.attachToTarget', { targetId: keeperTarget.targetId, flatten: true });
    await cdp.send('Page.enable', {}, keeperPage);
    await cdp.send('Page.bringToFront', {}, keeperPage); // a background tab doesn't paint, so it can't be captured
    await sleep(500);
    await shoot('keeper', keeperPage, [400, 1200]);
  }

  const popupTarget = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html?popup` });
  const { sessionId: popupPage } = await cdp.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true });
  await cdp.send('Page.enable', {}, popupPage);
  await sleep(800);
  const windowText = await cdp.evaluate(popupPage, () => document.getElementById('window-status').textContent);
  check('the popup shows which window Claude uses', /^(This window\.|Another window, with \d+ tabs?\.)/.test(windowText), windowText);
  await shoot('popup', popupPage, [400]);

  if (SHOTS) {
    // The keeper tab's icon at the size a pinned tab shows it, between two ordinary favicons.
    await cdp.evaluate(popupPage, () => {
      const strip = (bg) => `<div style="display:flex;gap:10px;align-items:center;padding:8px 10px;background:${bg}">
        <span style="width:16px;height:16px;border-radius:3px;background:#ff0000"></span>
        <img src="keeper.svg" width="16" height="16">
        <span style="width:16px;height:16px;border-radius:50%;background:#1da1f2"></span>
        <img src="keeper.svg" width="32" height="32"></div>`;
      document.body.className = '';
      document.body.innerHTML = strip('#dfe1e5') + strip('#202124');
    });
    for (const scheme of ['light', 'dark']) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, popupPage);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 160, height: 104, deviceScaleFactor: 4, mobile: false }, popupPage);
      await sleep(200);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, popupPage);
      await writeFile(join(SHOTS, `icon-${scheme}.png`), Buffer.from(data, 'base64'));
    }
  }
  if (SHOTS) console.log(`screenshots in ${SHOTS}`);

  check('no errors or warnings in the service worker', errors.length === 0, errors.join(' | '));
  await cdp.send('Browser.close').catch(() => {});
} finally {
  brave.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
