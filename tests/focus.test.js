import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteFocus, noteNewTab, noteShowing, seedFocus } from '../extension/focus.js';
import { getSettings } from '../extension/sweeper.js';
import { fakeBrowser, tab } from './fake-browser.js';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const NOW = 1_000_000_000_000;
const NOWHERE = -1; // what Brave reports when you're in another app
const SESSION = { id: 30, title: 'Fix the login page', windowId: 2 };
const YOURS = 1; // the tab you're on in your window
const CLAUDES = 5; // the tab showing in Claude's window
const HIDDEN = 8; // a Claude tab behind it

// You in window 1 on your own tab, Claude working in window 2.
async function browser({ title = SESSION.title, settings = {} } = {}) {
  const { api, state } = fakeBrowser({
    groups: [{ ...SESSION, title }],
    windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
    tabs: [
      tab(YOURS, { groupId: -1, active: true }),
      tab(CLAUDES, { windowId: 2, groupId: SESSION.id, active: true }),
      tab(HIDDEN, { windowId: 2, groupId: SESSION.id }),
    ],
    settings: { useWindow: true, windowId: 2, ...settings },
    session: { claudeGroups: [SESSION.id] },
  });
  await seedFocus(api);
  return { api, state };
}

const newTab = (id, extra = {}) => ({ id, windowId: 2, openerTabId: CLAUDES, active: true, ...extra });

test('a Claude tab that opens a tab while you are in another window: that window gets the focus back', async () => {
  const { api, state } = await browser();
  await noteNewTab(api, newTab(6), NOW);
  await noteFocus(api, NOWHERE, NOW + 10); // Brave reports this on the way between two windows
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, [[1, { focused: true }]]);
});

test('from another app there is no window to ask for, so its window drops the focus instead', async () => {
  const { api, state } = await browser();
  await noteFocus(api, NOWHERE, NOW - 5000);
  await noteNewTab(api, newTab(6), NOW);
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, [[2, { focused: false }]]);
});

test('still in that app, a second Claude click drops the focus again instead of asking for a window', async () => {
  const { api, state } = await browser();
  await noteFocus(api, NOWHERE, NOW - 5000);
  await noteNewTab(api, newTab(6), NOW);
  await noteFocus(api, 2, NOW + 20);
  await noteFocus(api, NOWHERE, NOW + 30);
  await noteFocus(api, 1, NOW + 40); // Brave reports the next window down, though Windows left you in the app
  await noteNewTab(api, newTab(9), NOW + 2000);
  await noteFocus(api, 2, NOW + 2020);
  assert.deepEqual(state.windowUpdates, [[2, { focused: false }], [2, { focused: false }]]);
});

test('coming back to Brave after that counts as normal', async () => {
  const { api, state } = await browser();
  await noteFocus(api, NOWHERE, NOW - 5000);
  await noteNewTab(api, newTab(6), NOW);
  await noteFocus(api, 2, NOW + 20);
  await noteFocus(api, 1, NOW + 40);
  await noteFocus(api, NOWHERE, NOW + 3000);
  await noteFocus(api, 1, NOW + 4000); // you, clicking your window
  await noteNewTab(api, newTab(9), NOW + 5000);
  await noteFocus(api, 2, NOW + 5020);
  assert.deepEqual(state.windowUpdates, [[2, { focused: false }], [1, { focused: true }]]);
});

test('a window you click once the drop is long over is yours, with no report in between', async () => {
  const { api, state } = await browser();
  await noteFocus(api, NOWHERE, NOW - 5000);
  await noteNewTab(api, newTab(6), NOW);
  await noteFocus(api, 2, NOW + 20);
  await noteFocus(api, 1, NOW + 3000); // Windows really did take you away, so no report came after the drop
  await noteNewTab(api, newTab(9), NOW + 5000);
  await noteFocus(api, 2, NOW + 5020);
  assert.deepEqual(state.windowUpdates, [[2, { focused: false }], [1, { focused: true }]]);
});

test('a popup from a Claude tab goes back the same way', async () => {
  const { api, state } = await browser();
  state.windows.push({ id: 7, focused: false });
  await noteNewTab(api, newTab(6, { windowId: 7 }), NOW);
  await noteFocus(api, 7, NOW + 20);
  assert.deepEqual(state.windowUpdates, [[1, { focused: true }]]);
});

test("a link you click in Claude's window stays: your click brings the focus there first", async () => {
  const { api, state } = await browser();
  await noteFocus(api, 2, NOW - 200);
  await noteNewTab(api, newTab(6), NOW);
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, []);
  assert.equal(state.tabs.find((t) => t.id === CLAUDES).active, true);
});

test('you click the window a while after the new tab opened: it stays', async () => {
  const { api, state } = await browser();
  await noteNewTab(api, newTab(6), NOW);
  await noteFocus(api, 2, NOW + 1500);
  assert.deepEqual(state.windowUpdates, []);
});

test('it goes back once, so a click right after works', async () => {
  const { api, state } = await browser();
  await noteNewTab(api, newTab(6), NOW);
  await noteFocus(api, 2, NOW + 20);
  await noteFocus(api, 1, NOW + 60);
  await noteFocus(api, 2, NOW + 300);
  assert.equal(state.windowUpdates.length, 1);
});

test('a tab opened in the background moves nothing', async () => {
  const { api, state } = await browser();
  await noteNewTab(api, newTab(6, { active: false }), NOW);
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, []);
});

test("tabs that aren't Claude's are left alone", async () => {
  const { api, state } = await browser();
  state.tabs.push(tab(40, { windowId: 3, groupId: -1 }));
  await noteNewTab(api, newTab(6, { windowId: 3, openerTabId: 40 }), NOW);
  await noteFocus(api, 3, NOW + 20);
  assert.deepEqual(state.windowUpdates, []);
});

test("any tab in Claude's window counts, grouped or not", async () => {
  const { api, state } = await browser();
  state.tabs.push(tab(41, { windowId: 2, groupId: -1 }));
  await noteNewTab(api, newTab(6, { openerTabId: 41 }), NOW);
  await noteFocus(api, 2, NOW + 20);
  assert.equal(state.windowUpdates.length, 1);
});

test('a hidden Claude tab that opens a tab in the window you are in: the tab you were on comes back', async () => {
  const { api, state } = await browser();
  await noteFocus(api, 2, NOW - 200);
  await noteNewTab(api, newTab(6, { openerTabId: HIDDEN }), NOW);
  assert.equal(state.tabs.find((t) => t.id === CLAUDES).lastUpdate?.active, true);
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, []);
});

test('in a window that is not in focus the tab that was showing comes back too', async () => {
  const { api, state } = await browser();
  await noteNewTab(api, newTab(6, { openerTabId: HIDDEN }), NOW);
  assert.equal(state.tabs.find((t) => t.id === CLAUDES).lastUpdate?.active, true);
  await noteFocus(api, 2, NOW + 20);
  assert.equal(state.windowUpdates.length, 1);
});

test('it follows the tab you switch to', async () => {
  const { api, state } = await browser();
  await noteFocus(api, 2, NOW - 400);
  await noteShowing(api, { tabId: HIDDEN, windowId: 2 }, NOW - 200);
  await noteNewTab(api, newTab(6), NOW); // from the tab that was showing before
  assert.equal(state.tabs.find((t) => t.id === HIDDEN).lastUpdate?.active, true);
});

test('a tab you are looking at that opens a tab is left alone, Claude or not', async () => {
  const { api, state } = await browser();
  await noteFocus(api, 2, NOW - 200);
  await noteNewTab(api, newTab(6), NOW);
  assert.equal(state.tabs.find((t) => t.id === CLAUDES).lastUpdate, undefined);
});

test('a "Leave site?" prompt on a hidden tab while Claude runs a tool: its window goes back', async () => {
  const { api, state } = await browser({ title: `⌛${SESSION.title}` });
  await noteShowing(api, { tabId: HIDDEN, windowId: 2 }, NOW);
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, [[1, { focused: true }]]);
});

test('a prompt holds the focus until Claude answers it, so going back is tried again', async () => {
  const { api, state } = await browser({ title: `⌛${SESSION.title}` });
  const [yours, claudes] = state.windows;
  await noteShowing(api, { tabId: HIDDEN, windowId: 2 }, NOW);
  yours.focused = false;
  claudes.focused = true;
  await noteFocus(api, 2, NOW + 20);
  assert.equal(state.windowUpdates.length, 1);
  await sleep(260);
  assert.equal(state.windowUpdates.length, 2);
  yours.focused = true;
  claudes.focused = false;
  await sleep(260);
  assert.equal(state.windowUpdates.length, 2);
});

test('a new tab goes back once and leaves it there', async () => {
  const { api, state } = await browser();
  const [yours, claudes] = state.windows;
  await noteNewTab(api, newTab(6), NOW);
  yours.focused = false;
  claudes.focused = true;
  await noteFocus(api, 2, NOW + 20);
  await sleep(260);
  assert.equal(state.windowUpdates.length, 1);
});

test('a Claude tab you pick from another window with no tool running stays', async () => {
  const { api, state } = await browser();
  await noteShowing(api, { tabId: HIDDEN, windowId: 2 }, NOW);
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, []);
});

test('an ungrouped tab coming forward in another window moves nothing', async () => {
  const { api, state } = await browser();
  state.tabs.push(tab(42, { windowId: 2, groupId: -1 }));
  await noteShowing(api, { tabId: 42, windowId: 2 }, NOW);
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, []);
});

test('switching tabs in the window you are in moves nothing, even while a tool runs', async () => {
  const { api, state } = await browser({ title: `⌛${SESSION.title}` });
  await noteFocus(api, 2, NOW - 200);
  await noteShowing(api, { tabId: HIDDEN, windowId: 2 }, NOW);
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, []);
});

test('switched off, nothing is moved', async () => {
  const { api, state } = await browser({ title: `⌛${SESSION.title}`, settings: { stayPut: false } });
  await noteNewTab(api, newTab(6, { openerTabId: HIDDEN }), NOW);
  await noteShowing(api, { tabId: HIDDEN, windowId: 2 }, NOW);
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, []);
  assert.equal(state.tabs.find((t) => t.id === CLAUDES).lastUpdate, undefined);
});

test('it is on by default', async () => {
  const { api } = fakeBrowser();
  assert.equal((await getSettings(api)).stayPut, true);
});

test('with nothing noted yet, as after switching the extension back on, it starts from what is open', async () => {
  const { api, state } = fakeBrowser({
    groups: [SESSION],
    windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
    tabs: [tab(CLAUDES, { windowId: 2, groupId: SESSION.id, active: true })],
    session: { claudeGroups: [SESSION.id] },
  });
  await noteNewTab(api, newTab(6), NOW);
  await noteFocus(api, 2, NOW + 20);
  assert.equal(state.windowUpdates.length, 1);
});

test("if the window you were in has closed, Claude's window just drops the focus", async () => {
  const { api, state } = await browser();
  await noteNewTab(api, newTab(6), NOW);
  state.windows.shift();
  await noteFocus(api, 2, NOW + 20);
  assert.deepEqual(state.windowUpdates, [[2, { focused: false }]]);
});

test('a popup that closed itself in the meantime is no problem', async () => {
  const { api, state } = await browser();
  await noteFocus(api, NOWHERE, NOW - 5000);
  await noteNewTab(api, newTab(6, { windowId: 7 }), NOW);
  await noteFocus(api, 7, NOW + 20); // the fake has no window 7
  assert.deepEqual(state.windowUpdates, []);
});
