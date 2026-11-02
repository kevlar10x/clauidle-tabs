// Keeps you where you are when Claude's tabs act. Claude's clicks count as real clicks, so one that opens a tab or
// popup brings its window to the front, and so does a "Leave site?" prompt. An extension can't block that, only
// send you straight back. Brave reports things in the order they happen: your click focuses the window before
// the tab opens, and Claude's click opens the tab first. Every browser call goes through `api`.
import { isClaudeGroup } from './groups.js';
import { getSettings } from './sweeper.js';

// Brave moves the focus within milliseconds of the tab opening. Focus arriving later than this is you.
const PULL_MS = 1000;
const PROMPT_WAIT_MS = 200;
const PROMPT_TRIES = 10;
const NO_WINDOW = -1; // what Brave reports when you're in another app

const save = (api, focus) => api.storage.session.set({ focus });

export async function seedFocus(api) {
  const windows = await api.windows.getAll({ populate: true });
  const focus = {
    window: windows.find((w) => w.focused)?.id ?? NO_WINDOW,
    showing: Object.fromEntries(windows.map((w) => [w.id, w.tabs.find((t) => t.active)?.id])),
    pulls: {}, // windows about to take the focus, with when that was noticed and where you were
  };
  await save(api, focus);
  return focus;
}

// Empty after the extension is switched off and on, which doesn't count as a start or an install.
async function readFocus(api) {
  return (await api.storage.session.get('focus')).focus ?? seedFocus(api);
}

// Back to the window you were in. From another app there's no window to ask for, so this one drops the focus
// and it goes to whatever was behind.
async function sendBack(api, windowId, from) {
  const back = from !== NO_WINDOW && (await api.windows.update(from, { focused: true }).catch(() => null));
  if (!back) await api.windows.update(windowId, { focused: false }).catch(() => {});
}

// While a "Leave site?" prompt is up, Brave gives it the focus back from every window. Claude answers it by itself,
// so this keeps trying for a moment. It runs outside the queue, so nothing else waits for it.
async function outlastPrompt(api, windowId, from) {
  for (let tries = 0; tries < PROMPT_TRIES; tries++) {
    await new Promise((done) => setTimeout(done, PROMPT_WAIT_MS));
    const win = await api.windows.getLastFocused().catch(() => null);
    if (win?.focused && win.id !== windowId) return;
    if (win?.focused) await sendBack(api, windowId, from);
  }
}

export async function noteFocus(api, windowId, now) {
  const focus = await readFocus(api);
  const pull = focus.pulls[windowId];
  delete focus.pulls[windowId];
  // Dropping the focus makes Brave report the next window down, even when Windows keeps you in the other app.
  const echo = windowId !== NO_WINDOW && now - focus.dropped <= PULL_MS;
  focus.window = echo ? NO_WINDOW : windowId;
  if (echo) delete focus.dropped;
  const pulled = pull && now - pull.at <= PULL_MS;
  if (pulled && pull.from === NO_WINDOW) focus.dropped = now;
  await save(api, focus);
  if (!pulled) return;
  await sendBack(api, windowId, pull.from);
  if (pull.prompt) outlastPrompt(api, windowId, pull.from);
}

async function isClaudes(api, tab) {
  const { useWindow, windowId } = await getSettings(api);
  return (useWindow && tab.windowId === windowId) || isClaudeGroup(api, tab.groupId);
}

// You can only click in a page that's showing in the window you're in, so a tab opened by any other page is Claude's.
export async function noteNewTab(api, tab, now) {
  if (tab.openerTabId === undefined || !tab.active) return;
  if (!(await getSettings(api)).stayPut) return;
  const opener = await api.tabs.get(tab.openerTabId).catch(() => null);
  if (!opener || !(await isClaudes(api, opener))) return;
  const focus = await readFocus(api);
  const showing = focus.showing[opener.windowId];
  if (focus.window === opener.windowId && showing === opener.id) return;
  if (tab.windowId === opener.windowId && showing !== undefined && showing !== opener.id) {
    await api.tabs.update(showing, { active: true }).catch(() => {});
  }
  if (focus.window !== tab.windowId) {
    focus.pulls[tab.windowId] = { at: now, from: focus.window };
    await save(api, focus);
  }
}

// The Claude extension puts ⌛ in front of a group's name while a tool runs.
async function toolRunning(api, tabId) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab || !(await isClaudeGroup(api, tab.groupId))) return false;
  const group = await api.tabGroups.get(tab.groupId).catch(() => null);
  return group?.title?.startsWith('⌛') === true;
}

// A "Leave site?" prompt brings its tab forward, then its window. A hidden tab doing that in a window you're not in
// while Claude works there is the prompt. With no tool running it could be you, picking the tab in tab search.
export async function noteShowing(api, { tabId, windowId }, now) {
  const focus = await readFocus(api);
  focus.showing[windowId] = tabId;
  if (focus.window !== windowId && (await getSettings(api)).stayPut && (await toolRunning(api, tabId))) {
    focus.pulls[windowId] = { at: now, from: focus.window, prompt: true };
  }
  await save(api, focus);
}
