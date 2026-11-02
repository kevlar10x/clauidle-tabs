// Checks "stay where you are" on real windows, because focus means nothing in a headless browser.
// It takes the focus for a few seconds. Usage: node tests/focus-check.js <path to Chrome for Testing>
// Set QUIET_RUN to the path of quiet-run to start the browser through it.
// Tabs here are clicked over the DevTools protocol, the way the Claude extension clicks them.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorker } from './headless.js';

const BROWSER = process.argv[2];
const LAUNCHER = process.env.QUIET_RUN;
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// What Windows itself has in front, which isn't always what the browser reports.
const foregroundApp = () => spawnSync('powershell', ['-NoProfile', '-Command', `
  Add-Type -Name W -Namespace N -MemberDefinition '
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);';
  [uint32]$id = 0; [void][N.W]::GetWindowThreadProcessId([N.W]::GetForegroundWindow(), [ref]$id);
  (Get-Process -Id $id).ProcessName`], { encoding: 'utf8', windowsHide: true }).stdout.trim();

function connect(ws) {
  let next = 0;
  const waiting = new Map();
  const listeners = new Set();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const done = waiting.get(msg.id);
    if (!done) { for (const listen of listeners) listen(msg); return; }
    waiting.delete(msg.id);
    if (msg.error) done.reject(new Error(msg.error.message));
    else done.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => { if (waiting.delete(id)) reject(new Error(`${method} timed out`)); }, 15_000);
  });
  return { send, listeners };
}

const profile = await mkdtemp(join(tmpdir(), 'clauidle-focus-'));
const args = [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`, '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=640,480', 'about:blank',
];
const browser = LAUNCHER
  ? spawn(LAUNCHER, ['--show', '--allow-focus', '--cwd', tmpdir(), '--', BROWSER, ...args], { stdio: 'ignore', windowsHide: true })
  : spawn(BROWSER, args, { stdio: 'ignore' });

let cdp;
try {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
  const [port, path] = (await readFile(portFile, 'utf8')).trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  cdp = connect(ws);

  const worker = await findWorker(cdp.send, EXT);
  const { sessionId: sw } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sw);
  const sw$ = async (fn, ...args) => {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sw);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  for (let i = 0; i < 50 && !(await sw$(() => !!globalThis.chrome?.windows)); i++) await sleep(100);

  // Every focus change, with its time, so the checks can read what happened and how long it took.
  await sw$(() => {
    globalThis.moves = [];
    chrome.windows.onFocusChanged.addListener((id) => globalThis.moves.push({ id, at: Date.now() }));
  });
  const moves = () => sw$(() => globalThis.moves);
  const clearMoves = () => sw$(() => { globalThis.moves = []; });
  const focusedWindow = () => sw$(async () => {
    const win = await chrome.windows.getLastFocused();
    return win.focused ? win.id : -1;
  });
  const focus = async (id) => {
    for (let i = 0; i < 30 && (await focusedWindow()) !== id; i++) {
      await sw$((id) => chrome.windows.update(id, { focused: true }), id);
      await sleep(100);
    }
    return (await focusedWindow()) === id;
  };

  const yours = await sw$(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id);
  const claudes = await sw$(async () => (await chrome.windows.create({ url: 'about:blank', focused: false, width: 640, height: 480 })).id);
  await sw$((id) => chrome.storage.local.set({ useWindow: true, windowId: id, stayPut: true }), claudes);
  await sleep(500);

  // A page with a link that opens a tab, a button that opens a popup, and a form that asks "Leave site?".
  const page = (title, ask = '') => 'data:text/html,' + encodeURIComponent(`<title>${title}</title>
    <body style="margin:0"><a href="about:blank#new" target="_blank" style="position:fixed;left:0;top:0;width:200px;height:100px;background:#ccc">new tab</a>
    <button style="position:fixed;left:220px;top:0;width:200px;height:100px" onclick="window.open('about:blank#popup','_blank','popup,width=320,height=240')">popup</button>
    <script>${ask}</script>`);

  const claudeTab = async (title, active, ask) => {
    const tabId = await sw$(async (windowId, url, active) => (await chrome.tabs.create({ windowId, url, active })).id, claudes, page(title, ask), active);
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      target = targetInfos.find((t) => t.type === 'page' && t.title === title);
      if (!target) await sleep(100);
    }
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await sw$(async (id, title) => {
      const groupId = await chrome.tabs.group({ tabIds: id, createProperties: { windowId: (await chrome.tabs.get(id)).windowId } });
      await chrome.tabGroups.update(groupId, { title });
    }, tabId, 'Claude (MCP)');
    return { tabId, sessionId };
  };
  const click = async (sessionId, x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
    }
  };
  const report = (list, from) => {
    const landed = list.findIndex((m) => m.id === from);
    const back = list.findIndex((m, i) => i > landed && m.id !== from && m.id !== -1);
    return landed >= 0 && back >= 0 ? `away for ${list[back].at - list[landed].at} ms` : JSON.stringify(list);
  };

  if (!(await focus(yours))) throw new Error("Couldn't give the test window the focus, so nothing here would mean anything.");

  // 1. A Claude click that opens a tab.
  const first = await claudeTab('Claude working', true);
  await focus(yours);
  await clearMoves();
  await click(first.sessionId, 50, 50);
  await sleep(1500);
  let list = await moves();
  check('a Claude click that opens a tab: you end up back in your window', (await focusedWindow()) === yours, report(list, claudes));
  check("and the new tab really did pull Claude's window forward first, so the check means something", list.some((m) => m.id === claudes), JSON.stringify(list.map((m) => m.id)));

  // 2. A Claude click that opens a popup.
  await focus(yours);
  await clearMoves();
  await click(first.sessionId, 300, 50);
  await sleep(1500);
  list = await moves();
  const popup = await sw$(async () => (await chrome.windows.getAll({ windowTypes: ['popup'] }))[0]?.id ?? null);
  check('a Claude click that opens a popup: you end up back in your window', popup !== null && (await focusedWindow()) === yours, report(list, popup));
  if (popup !== null) await sw$((id) => chrome.windows.remove(id), popup);
  await sleep(300);

  // 3. A click of yours. The focus reaches the window first, as it does when you click it with the mouse.
  await focus(claudes);
  await sw$((tab) => chrome.tabs.update(tab, { active: true }), first.tabId);
  await sleep(300);
  await clearMoves();
  await click(first.sessionId, 50, 50);
  await sleep(1500);
  check("a click in Claude's window with the focus already there stays there", (await focusedWindow()) === claudes, JSON.stringify((await moves()).map((m) => m.id)));

  // 4. A "Leave site?" prompt on a hidden tab, while a tool runs in its group.
  const asking = await claudeTab('Unsaved form', true, 'onbeforeunload=(e)=>{e.preventDefault();e.returnValue=""}');
  await click(asking.sessionId, 500, 300); // pages can only ask after a click
  await sw$(async (tab, hide) => {
    const { groupId } = await chrome.tabs.get(tab);
    await chrome.tabGroups.update(groupId, { title: '⌛Fix the form' });
    await chrome.tabs.update(hide, { active: true });
  }, asking.tabId, first.tabId);
  await sleep(200);
  await focus(yours);
  await clearMoves();
  cdp.send('Page.navigate', { url: 'about:blank' }, asking.sessionId).catch(() => {}); // answers once the prompt has gone
  await sleep(400);
  await cdp.send('Page.handleJavaScriptDialog', { accept: false }, asking.sessionId).catch(() => {}); // what Claude does
  await sleep(2200);
  list = await moves();
  check('a "Leave site?" prompt on a hidden tab while a tool runs: once Claude answers it, you end up back in your window',
    (await focusedWindow()) === yours, report(list, claudes));

  // 5. The same in another app, where there's no window to go back to. Character Map is on every Windows.
  // Windows may refuse the raise by itself, so this can pass with the setting off too (see the end). It does show
  // that going back doesn't pull you out of the app. The browser's own report isn't to be trusted here.
  const clickTwiceFromAnotherApp = async () => {
    await sw$((tab) => chrome.tabs.update(tab, { active: true }), first.tabId);
    await focus(yours);
    spawn(LAUNCHER, ['--show', '--allow-focus', '--cwd', tmpdir(), '--', 'C:\\Windows\\System32\\charmap.exe'], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 80 && (await focusedWindow()) !== -1; i++) await sleep(100);
    if ((await focusedWindow()) !== -1) throw new Error("Character Map didn't take the focus.");
    const inFront = [];
    for (let i = 0; i < 2; i++) {
      await sw$((tab) => chrome.tabs.update(tab, { active: true }), first.tabId);
      await click(first.sessionId, 50, 50);
      await sleep(1500);
      inFront.push(foregroundApp());
    }
    spawnSync('taskkill', ['/IM', 'charmap.exe'], { windowsHide: true });
    await sleep(500);
    return inFront;
  };
  if (LAUNCHER) {
    const inFront = await clickTwiceFromAnotherApp();
    check('two Claude clicks while you are in another app: that app stays in front', inFront.every((app) => app === 'charmap'), inFront.join());
  }

  // 6. Switched off: the pull stays, which shows the guard is what brought you back.
  await sw$(() => chrome.storage.local.set({ stayPut: false }));
  await sleep(200);
  await sw$((tab) => chrome.tabs.update(tab, { active: true }), first.tabId);
  await focus(yours);
  await clearMoves();
  await click(first.sessionId, 50, 50);
  await sleep(1500);
  check("with the setting off, the click leaves you in Claude's window", (await focusedWindow()) === claudes);
  if (LAUNCHER) console.log(`note: with the setting off, in front after two clicks from another app: ${await clickTwiceFromAnotherApp()}`);
} finally {
  await cdp?.send('Browser.close').catch(() => {}); // the browser first: quiet-run unmutes it as it closes
  await sleep(1500);
  if (!cdp || !LAUNCHER) browser.kill();
  await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
