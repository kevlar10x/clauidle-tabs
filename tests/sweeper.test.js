import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALARM, forget, sweep, touch } from '../extension/sweeper.js';
import { MCP, OTHER, fakeBrowser, ids, tab } from './fake-browser.js';

const MIN = 60_000;
const NOW = 1_000_000_000_000;
const SESSION = { id: 30, title: 'Fix the login page', windowId: 1 };

test('closes Claude (MCP) tabs nobody touched for 30 minutes, and nothing else', async () => {
  const { api, state } = fakeBrowser({
    tabs: [
      tab(1),
      tab(2),
      tab(3, { groupId: OTHER.id }),
      tab(4, { groupId: -1, active: true }),
    ],
    touched: { 1: NOW - 31 * MIN, 2: NOW - 5 * MIN, 3: NOW - 60 * MIN },
  });
  const result = await sweep(api, NOW);
  assert.deepEqual(result.closed, [1]);
  assert.deepEqual(ids(state.tabs), [2, 3, 4]);
  assert.equal(state.alarm.scheduledTime, NOW - 5 * MIN + 30 * MIN);
  assert.deepEqual(Object.keys(state.session.touched), ['2']);
});

test('uses the minutes from the settings', async () => {
  const { api, state } = fakeBrowser({
    tabs: [tab(1), tab(2), tab(3)],
    settings: { minutes: 5 },
    touched: { 1: NOW - 6 * MIN, 2: NOW - 4 * MIN, 3: NOW - 5 * MIN },
  });
  await sweep(api, NOW);
  assert.deepEqual(ids(state.tabs), [2]);
  assert.equal(state.alarm.scheduledTime, NOW + 1 * MIN);
});

test('a tab it sees for the first time counts as touched now', async () => {
  const { api, state } = fakeBrowser({ tabs: [tab(1, { lastAccessed: NOW - 90 * MIN })] });
  const result = await sweep(api, NOW);
  assert.deepEqual(result.closed, []);
  assert.equal(state.session.touched[1], NOW);
  assert.equal(state.alarm.scheduledTime, NOW + 30 * MIN);
});

test('switching to a tab in Brave counts as touching it', async () => {
  const { api, state } = fakeBrowser({
    tabs: [tab(1, { lastAccessed: NOW - 2 * MIN })],
    touched: { 1: NOW - 40 * MIN },
  });
  await sweep(api, NOW);
  assert.deepEqual(ids(state.tabs), [1]);
  assert.equal(state.alarm.scheduledTime, NOW - 2 * MIN + 30 * MIN);
});

test('leaves pinned tabs, tabs playing sound, and the tab you are looking at', async () => {
  const old = NOW - 45 * MIN;
  const { api, state } = fakeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
    tabs: [
      tab(1, { pinned: true }),
      tab(2, { audible: true }),
      tab(3, { active: true }),
      tab(4, { active: true, windowId: 2 }),
      tab(5, { groupId: -1, windowId: 2 }),
    ],
    touched: { 1: old, 2: old, 3: old, 4: old },
  });
  const result = await sweep(api, NOW);
  // Tab 4 is the shown tab of a window in the background, so it still closes.
  assert.deepEqual(result.closed, [4]);
  assert.deepEqual(ids(state.tabs), [1, 2, 3, 5]);
  // Pinned tabs never set the alarm, or it would go off again straight away.
  assert.deepEqual(Object.keys(state.session.touched).sort(), ['2', '3']);
  assert.equal(state.alarm.scheduledTime, NOW + 30 * MIN);
});

test('when Brave is not the focused app, the shown tab can close', async () => {
  const { api, state } = fakeBrowser({
    windows: [{ id: 1, focused: false }, { id: 2, focused: false }],
    tabs: [tab(1, { active: true }), tab(2, { groupId: -1, windowId: 2 })],
    touched: { 1: NOW - 31 * MIN },
  });
  await sweep(api, NOW);
  assert.deepEqual(ids(state.tabs), [2]);
});

test('opens a new tab rather than closing the last window', async () => {
  const { api, state } = fakeBrowser({
    tabs: [tab(1), tab(2)],
    touched: { 1: NOW - 31 * MIN, 2: NOW - 31 * MIN },
  });
  await sweep(api, NOW);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].windowId, 1);
  assert.deepEqual(ids(state.tabs), [1000]);
  assert.equal(state.alarm, null);
});

test('closing every tab of one window is fine while another window stays open', async () => {
  const { api, state } = fakeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
    tabs: [tab(1, { windowId: 2 }), tab(2, { groupId: -1, active: true })],
    touched: { 1: NOW - 31 * MIN },
  });
  await sweep(api, NOW);
  assert.equal(state.created.length, 0);
  assert.deepEqual(ids(state.tabs), [2]);
});

test('a tab that closed on its own does not stop the others from closing', async () => {
  const { api, state } = fakeBrowser({
    windows: [{ id: 1, focused: true }],
    tabs: [tab(1), tab(2), tab(3, { groupId: -1 })],
    touched: { 1: NOW - 31 * MIN, 2: NOW - 31 * MIN },
  });
  const { discard, remove } = api.tabs;
  api.tabs.discard = async (id) => {
    if (id === 1) throw new Error('No tab with id: 1.');
    return discard(id);
  };
  api.tabs.remove = async (target) => {
    if (Array.isArray(target)) throw new Error('No tab with id: 1.');
    if (target === 1) throw new Error('No tab with id: 1.');
    return remove(target);
  };
  await sweep(api, NOW);
  assert.deepEqual(ids(state.tabs), [1, 3]);
});

test('with nothing to watch the alarm is cleared', async () => {
  const { api, state } = fakeBrowser({ tabs: [tab(1, { groupId: OTHER.id })] });
  state.alarm = { name: ALARM, scheduledTime: NOW };
  await sweep(api, NOW);
  assert.equal(state.alarm, null);
});

test('turned off, it closes nothing and clears the alarm', async () => {
  const { api, state } = fakeBrowser({
    tabs: [tab(1), tab(2, { groupId: -1 })],
    settings: { enabled: false },
    touched: { 1: NOW - 90 * MIN },
  });
  state.alarm = { name: ALARM, scheduledTime: NOW };
  const result = await sweep(api, NOW);
  assert.deepEqual(result.closed, []);
  assert.deepEqual(ids(state.tabs), [1, 2]);
  assert.equal(state.alarm, null);
});

test('touch records the time and sets the alarm when none is set', async () => {
  const { api, state } = fakeBrowser({ tabs: [tab(1)], touched: { 1: NOW - 20 * MIN } });
  await touch(api, tab(1), NOW);
  assert.equal(state.session.touched[1], NOW);
  assert.equal(state.alarm.scheduledTime, NOW + 30 * MIN);
});

test('touch leaves an alarm that is already set', async () => {
  const { api, state } = fakeBrowser({ tabs: [tab(1), tab(2)], touched: { 1: NOW - 20 * MIN, 2: NOW - 10 * MIN } });
  state.alarm = { name: ALARM, scheduledTime: NOW + 10 * MIN };
  await touch(api, tab(1), NOW);
  assert.equal(state.session.touched[1], NOW);
  assert.equal(state.alarm.scheduledTime, NOW + 10 * MIN);
});

test('touch ignores tabs outside the Claude (MCP) group', async () => {
  const { api, state } = fakeBrowser({ tabs: [tab(1, { groupId: OTHER.id }), tab(2, { groupId: -1 })] });
  await touch(api, tab(1, { groupId: OTHER.id }), NOW);
  await touch(api, tab(2, { groupId: -1 }), NOW);
  await touch(api, tab(3, { groupId: 99 }), NOW);
  assert.equal(state.session.touched, undefined);
  assert.equal(state.alarm, null);
});

test("also closes idle tabs in a session's own group once it is known to be Claude's", async () => {
  const { api, state } = fakeBrowser({
    groups: [MCP, OTHER, SESSION, { id: 40, title: 'Fix the login page', windowId: 1 }],
    tabs: [tab(1, { groupId: SESSION.id }), tab(2, { groupId: 40 }), tab(3, { groupId: -1, active: true })],
    session: { claudeGroups: [SESSION.id] },
    touched: { 1: NOW - 31 * MIN, 2: NOW - 31 * MIN },
  });
  await sweep(api, NOW);
  // Group 40 has the same name but nothing said it is Claude's, so it is left alone.
  assert.deepEqual(ids(state.tabs), [2, 3]);
});

test("touch counts tabs in a known session group", async () => {
  const { api, state } = fakeBrowser({
    groups: [MCP, SESSION], tabs: [tab(1, { groupId: SESSION.id })], session: { claudeGroups: [SESSION.id] },
  });
  await touch(api, tab(1, { groupId: SESSION.id }), NOW);
  assert.equal(state.session.touched[1], NOW);
});

test("keeps Claude's window open with a new tab when its last Claude tab closes", async () => {
  const { api, state } = fakeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
    tabs: [tab(1, { windowId: 2 }), tab(2, { groupId: -1, active: true })],
    settings: { useWindow: true, windowId: 2 },
    touched: { 1: NOW - 31 * MIN },
  });
  await sweep(api, NOW);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].windowId, 2);
  assert.deepEqual(ids(state.tabs), [2, state.created[0].id]);
});

test('forget drops a closed tab', async () => {
  const { api, state } = fakeBrowser({ touched: { 1: NOW, 2: NOW } });
  await forget(api, 1);
  assert.deepEqual(state.session.touched, { 2: NOW });
});

test('a tab held open by a "Leave site?" prompt holds nothing else up and is only asked once', async () => {
  const { api, state } = fakeBrowser({
    tabs: [tab(1), tab(2, { lastAccessed: NOW - 5 * MIN }), tab(3, { groupId: -1, active: true })],
    touched: { 1: NOW - 31 * MIN, 2: NOW - 5 * MIN },
  });
  // Brave only answers tabs.remove once the tab has gone, and this one never goes.
  let asked = 0;
  api.tabs.remove = () => { asked++; return new Promise(() => {}); };
  await sweep(api, NOW);
  assert.equal(asked, 1);
  assert.deepEqual(Object.keys(state.session.touched), ['2']);

  const later = await sweep(api, NOW + 2 * MIN);
  assert.deepEqual(later.closed, []);
  assert.equal(asked, 1);
});

test('unloads a tab before closing it, so its page gets no "Leave site?" prompt', async () => {
  const { api, state } = fakeBrowser({
    tabs: [tab(1), tab(2, { groupId: -1, active: true })],
    touched: { 1: NOW - 31 * MIN },
  });
  const calls = [];
  const { discard, remove } = api.tabs;
  api.tabs.discard = (id) => { calls.push('discard'); return discard(id); };
  api.tabs.remove = (id) => { calls.push('remove'); return remove(id); };
  await sweep(api, NOW);
  assert.deepEqual(calls, ['discard', 'remove']);
  assert.deepEqual(ids(state.tabs), [2]);
});

test('a tab Brave will not unload still closes, and a stuck unload holds nothing up', async () => {
  for (const discard of [() => Promise.reject(new Error('Cannot discard')), () => new Promise(() => {})]) {
    const { api, state } = fakeBrowser({
      tabs: [tab(1), tab(2, { groupId: -1, active: true })],
      touched: { 1: NOW - 31 * MIN },
    });
    api.tabs.discard = discard;
    await sweep(api, NOW);
    assert.deepEqual(ids(state.tabs), [2]);
  }
});

test("a group called just Claude counts in Claude's window: that's a session's group after Claude regroups its tab", async () => {
  for (const title of ['Claude', '✅Claude']) {
    const { api, state } = fakeBrowser({
      windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
      groups: [MCP, OTHER, { id: 30, title, windowId: 2 }],
      tabs: [tab(1, { groupId: 30, windowId: 2 }), tab(2, { groupId: -1, active: true })],
      settings: { useWindow: true, windowId: 2 },
      touched: { 1: NOW - 31 * MIN },
    });
    const result = await sweep(api, NOW);
    assert.equal(result.closed.length, 1, title);
  }
});

test('a group called just Claude stays yours anywhere else: the side panel uses that name on your own tabs', async () => {
  const cases = {
    'another window': { useWindow: true, windowId: 2 },
    'no window picked': { useWindow: false, windowId: 1 },
  };
  for (const [label, settings] of Object.entries(cases)) {
    const { api, state } = fakeBrowser({
      windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
      groups: [MCP, OTHER, { id: 30, title: 'Claude', windowId: 1 }],
      tabs: [tab(1, { groupId: 30 }), tab(2, { groupId: -1, active: true })],
      settings,
      touched: { 1: NOW - 31 * MIN },
    });
    await sweep(api, NOW);
    assert.deepEqual(ids(state.tabs).slice(0, 2), [1, 2], label);
  }
});

test("a group called just Claude that you switched off stays off, even in Claude's window", async () => {
  const { api, state } = fakeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
    groups: [MCP, OTHER, { id: 30, title: 'Claude', windowId: 2 }],
    tabs: [tab(1, { groupId: 30, windowId: 2 }), tab(2, { groupId: -1, active: true })],
    settings: { useWindow: true, windowId: 2 },
    session: { notClaudeGroups: [30] },
    touched: { 1: NOW - 31 * MIN },
  });
  await sweep(api, NOW);
  assert.deepEqual(ids(state.tabs).slice(0, 2), [1, 2]);
});

test('forget drops a tab the sweeper already tried to close', async () => {
  const { api, state } = fakeBrowser({ session: { tried: { 1: true, 2: true } } });
  await forget(api, 1);
  assert.deepEqual(state.session.tried, { 2: true });
});
