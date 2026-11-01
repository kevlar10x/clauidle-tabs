import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptKeeper, claimGroup, ensureKeeper, noteNewGroup, releaseOldKeeper, routeAll, routeGroup,
} from '../extension/router.js';
import { hashTitle } from '../extension/groups.js';
import { MCP, OTHER, fakeBrowser, tab } from './fake-browser.js';

const NOW = 1_000_000_000_000;
const MAIN = { id: 1, focused: true };
const CLAUDE = { id: 2, focused: false };

// How the Claude extension makes a session's group: one new background tab, grouped, then named.
async function claudeMakesGroup(api, state, { id = 30, title = 'Fix the login page', at = NOW, tabExtra = {} } = {}) {
  const group = { id, title: '', windowId: 1 };
  state.groups.push(group);
  state.tabs.push(tab(100 + id, { groupId: id, lastAccessed: at - 20, ...tabExtra }));
  await noteNewGroup(api, { ...group }, at);
  group.title = title;
  return group;
}

test("a new group of one fresh background tab, named straight away, is Claude's", async () => {
  const { api, state } = fakeBrowser({ windows: [MAIN] });
  const group = await claudeMakesGroup(api, state);
  assert.equal(await claimGroup(api, group, NOW + 50), 'new');
  assert.deepEqual(state.session.claudeGroups, [30]);
  assert.equal(await claimGroup(api, group, NOW + 900), 'known');
});

test('the Claude (MCP) group is always Claude\'s', async () => {
  const { api } = fakeBrowser();
  assert.equal(await claimGroup(api, MCP, NOW), 'new');
  assert.equal(await claimGroup(api, MCP, NOW), 'known');
});

test('groups made in other ways are not Claude\'s', async () => {
  const cases = {
    'named more than 3 seconds later': { name: NOW + 3500 },
    'around a tab you are looking at': { tabExtra: { active: true } },
    'around an older tab': { tabExtra: { lastAccessed: NOW - 60_000 } },
  };
  for (const [label, { name = NOW + 50, tabExtra = {} }] of Object.entries(cases)) {
    const { api, state } = fakeBrowser();
    const group = await claudeMakesGroup(api, state, { tabExtra });
    assert.equal(await claimGroup(api, group, name), false, label);
  }

  // Two tabs at once.
  const two = fakeBrowser();
  two.state.groups.push({ id: 31, title: '', windowId: 1 });
  two.state.tabs.push(tab(1, { groupId: 31, lastAccessed: NOW }), tab(2, { groupId: 31, lastAccessed: NOW }));
  await noteNewGroup(two.api, { id: 31, title: '' }, NOW);
  assert.equal(await claimGroup(two.api, { id: 31, title: 'Mine' }, NOW + 50), false, 'two tabs');

  // Restored groups come back already named.
  const restored = fakeBrowser();
  restored.state.groups.push({ id: 32, title: 'Recipes', windowId: 1 });
  restored.state.tabs.push(tab(3, { groupId: 32, lastAccessed: NOW }));
  await noteNewGroup(restored.api, { id: 32, title: 'Recipes' }, NOW);
  assert.equal(await claimGroup(restored.api, { id: 32, title: 'Recipes' }, NOW + 50), false, 'restored');
  assert.equal(await claimGroup(restored.api, OTHER, NOW), false, 'a group you named');
});

test("a group that gets ⌛ in front of its name is Claude's: the Claude extension adds it while a tool runs", async () => {
  const { api } = fakeBrowser();
  assert.equal(await claimGroup(api, { id: 60, title: '⌛🟢 Old session' }, NOW), 'new');
  assert.equal(await claimGroup(api, { id: 60, title: '🟢 Old session' }, NOW), 'known');
});

test("a restored group with a name Claude used is Claude's but isn't moved; a new one Claude makes is", async () => {
  const { api, state } = fakeBrowser({ settings: { titleHashes: [await hashTitle('Fix the login page')] } });
  assert.equal(await claimGroup(api, { id: 61, title: '🟢 Fix the login page' }, NOW), 'known');
  const group = await claudeMakesGroup(api, state, { id: 62, title: '⚪ Fix the login page' });
  assert.equal(await claimGroup(api, group, NOW + 50), 'new');
});

test('a group Claude makes again under a name it used is moved, even when its start went unseen', async () => {
  const { api } = fakeBrowser({ settings: { titleHashes: [await hashTitle('Sidebar Tidy')] } });
  assert.equal(await claimGroup(api, { id: 64, title: 'Claude' }, NOW), false);
  assert.equal(await claimGroup(api, { id: 64, title: '🔵 Sidebar Tidy' }, NOW + 50), 'new');
});

test('a group you call Claude and rename later is still yours', async () => {
  const { api } = fakeBrowser();
  assert.equal(await claimGroup(api, { id: 65, title: 'Claude' }, NOW), false);
  assert.equal(await claimGroup(api, { id: 65, title: 'Mine' }, NOW + 60_000), false);
});

test('a group you said is not Claude\'s stays that way', async () => {
  const { api } = fakeBrowser({ session: { notClaudeGroups: [MCP.id, 63] } });
  assert.equal(await claimGroup(api, MCP, NOW), false);
  assert.equal(await claimGroup(api, { id: 63, title: '⌛ Something' }, NOW), false);
});

test("moves a Claude group into Claude's window", async () => {
  const { api, state } = fakeBrowser({ windows: [MAIN, CLAUDE], settings: { useWindow: true, windowId: 2 } });
  const group = await claudeMakesGroup(api, state);
  await claimGroup(api, group, NOW + 50);
  await routeGroup(api, group.id);
  assert.deepEqual(state.moves, [[30, 2]]);
  assert.equal(state.tabs.find((t) => t.id === 130).windowId, 2);
});

test('does nothing while no window is picked', async () => {
  const { api, state } = fakeBrowser({ windows: [MAIN, CLAUDE] });
  await routeGroup(api, MCP.id);
  assert.deepEqual(state.moves, []);
  assert.deepEqual(state.createdWindows, []);
});

test('leaves a group that is already in Claude\'s window', async () => {
  const { api, state } = fakeBrowser({ windows: [MAIN, CLAUDE], settings: { useWindow: true, windowId: 1 } });
  await routeGroup(api, MCP.id);
  assert.deepEqual(state.moves, []);
});

test("opens a new background window when Claude's window is gone, and keeps using it", async () => {
  const { api, state } = fakeBrowser({ windows: [MAIN], settings: { useWindow: true, windowId: 99 } });
  await routeGroup(api, MCP.id);
  assert.equal(state.createdWindows.length, 1);
  const [win] = state.createdWindows;
  assert.equal(win.focused, false);
  assert.equal(state.local.windowId, win.id);
  assert.deepEqual(state.moves, [[MCP.id, win.id]]);

  state.groups.push({ id: 50, title: 'Claude', windowId: 1 });
  await routeGroup(api, 50);
  assert.equal(state.createdWindows.length, 1);
  assert.deepEqual(state.moves.at(-1), [50, win.id]);
});

test("picking a window moves Claude's groups there, and only Claude's", async () => {
  const { api, state } = fakeBrowser({
    groups: [MCP, OTHER, { id: 30, title: 'Fix the login page', windowId: 1 }, { id: 40, title: 'Notes', windowId: 1 }],
    windows: [MAIN, CLAUDE],
    settings: { useWindow: true, windowId: 2 },
    session: { claudeGroups: [30] },
  });
  await routeAll(api);
  assert.deepEqual(state.moves.sort(), [[MCP.id, 2], [30, 2]].sort());
});

const KEEPER_URL = 'chrome-extension://test/keeper.html';

test("Claude's window gets its own pinned keeper tab, in the background, that Brave won't unload", async () => {
  const { api, state } = fakeBrowser({
    windows: [MAIN, CLAUDE], tabs: [tab(1, { windowId: 2 })], settings: { useWindow: true, windowId: 2 },
  });
  await ensureKeeper(api);
  assert.equal(state.created.length, 1);
  const [keeper] = state.created;
  assert.deepEqual(
    [keeper.windowId, keeper.url, keeper.pinned, keeper.active, keeper.groupId, keeper.autoDiscardable],
    [2, KEEPER_URL, true, false, -1, false],
  );
  assert.equal(state.local.keeperTab, keeper.id);

  await ensureKeeper(api);
  assert.equal(state.created.length, 1, 'only one');
});

test('a keeper tab that was closed is replaced; one dragged to another window is closed and replaced', async () => {
  const { api, state } = fakeBrowser({ windows: [MAIN, CLAUDE], settings: { useWindow: true, windowId: 2 } });
  await ensureKeeper(api);
  await api.tabs.remove(state.created[0].id);
  await ensureKeeper(api);
  assert.equal(state.created.length, 2);

  state.created[1].windowId = 1;
  await ensureKeeper(api);
  assert.equal(state.created.length, 3);
  assert.equal(state.created[2].windowId, 2);
  assert.equal(state.tabs.some((t) => t.id === state.created[1].id), false, 'the dragged one is closed');
});

test("on update, 0.4's plain New Tab stops being the keeper and stays open; the pinned one takes over", async () => {
  const { api, state } = fakeBrowser({
    windows: [MAIN, CLAUDE], settings: { useWindow: true, windowId: 2, keeperTab: 40 },
    tabs: [tab(40, { windowId: 2, groupId: -1 })],
  });
  await releaseOldKeeper(api);
  await ensureKeeper(api);
  assert.equal(state.tabs.some((t) => t.id === 40), true, 'the old New Tab stays');
  assert.equal((await api.tabs.get(state.local.keeperTab)).url, KEEPER_URL);

  await releaseOldKeeper(api);
  await ensureKeeper(api);
  assert.equal(state.created.length, 1, 'a keeper page is kept as it is');
});

test('Stop closes the keeper tab', async () => {
  const { api, state } = fakeBrowser({ windows: [MAIN, CLAUDE], settings: { useWindow: true, windowId: 2 } });
  await ensureKeeper(api);
  state.local.useWindow = false;
  await ensureKeeper(api);
  assert.equal(state.tabs.some((t) => t.url === KEEPER_URL), false);
  assert.equal(state.local.keeperTab, null);
});

test('a keeper tab you browsed away in is yours: Stop and moving windows leave it open', async () => {
  const stopped = fakeBrowser({ windows: [MAIN, CLAUDE], settings: { useWindow: true, windowId: 2 } });
  await ensureKeeper(stopped.api);
  const [mine] = stopped.state.created;
  mine.url = 'https://example.com/';
  stopped.state.local.useWindow = false;
  await ensureKeeper(stopped.api);
  assert.equal(stopped.state.tabs.includes(mine), true);
  assert.equal(stopped.state.local.keeperTab, null);

  const moved = fakeBrowser({ windows: [MAIN, CLAUDE], settings: { useWindow: true, windowId: 2 } });
  await ensureKeeper(moved.api);
  const [other] = moved.state.created;
  other.url = 'https://example.com/';
  moved.state.local.windowId = 1;
  await ensureKeeper(moved.api);
  assert.equal(moved.state.tabs.includes(other), true);
  assert.equal(moved.state.created.at(-1).windowId, 1, 'the new window gets its own keeper tab');
});

test('after a restart, the window a keeper tab comes back in is Claude\'s window again', async () => {
  const { api, state } = fakeBrowser({
    windows: [MAIN, { id: 5, focused: false }], settings: { useWindow: true, windowId: 99, keeperTab: 98 },
    tabs: [tab(40, { windowId: 5, groupId: -1, url: KEEPER_URL, pinned: true })],
  });
  await adoptKeeper(api, { id: 40, windowId: 5 });
  assert.deepEqual([state.local.windowId, state.local.keeperTab], [5, 40]);
});

test('a spare keeper tab is closed, the current one is left alone', async () => {
  const { api, state } = fakeBrowser({
    windows: [MAIN, CLAUDE], settings: { useWindow: true, windowId: 2, keeperTab: 40 },
    tabs: [
      tab(40, { windowId: 2, groupId: -1, url: KEEPER_URL }),
      tab(41, { windowId: 2, groupId: -1, url: KEEPER_URL }),
      tab(42, { windowId: 1, groupId: -1, url: KEEPER_URL }),
    ],
  });
  for (const t of [40, 41, 42]) await adoptKeeper(api, await api.tabs.get(t));
  assert.deepEqual(state.tabs.map((t) => t.id), [40]);

  state.local.useWindow = false;
  await adoptKeeper(api, await api.tabs.get(40));
  assert.deepEqual(state.tabs, [], 'left over after Stop');
});

test('no keeper tab while no window is picked, or while the picked one is gone', async () => {
  const off = fakeBrowser({ windows: [MAIN, CLAUDE], settings: { windowId: 2 } });
  await ensureKeeper(off.api);
  const gone = fakeBrowser({ windows: [MAIN], settings: { useWindow: true, windowId: 99 } });
  await ensureKeeper(gone.api);
  assert.deepEqual([off.state.created, gone.state.created, gone.state.createdWindows], [[], [], []]);
});

test('a window opened for Claude starts with the keeper tab as its first tab, without adding another', async () => {
  const { api, state } = fakeBrowser({ windows: [MAIN], settings: { useWindow: true, windowId: 99 } });
  await routeGroup(api, MCP.id);
  const [win] = state.createdWindows;
  await ensureKeeper(api);
  assert.equal(state.created.length, 0);
  const keeper = await api.tabs.get(state.local.keeperTab);
  assert.deepEqual([keeper.windowId, keeper.url, keeper.pinned, keeper.autoDiscardable], [win.id, KEEPER_URL, true, false]);
});

test('with no Claude groups, picking a window opens nothing', async () => {
  const { api, state } = fakeBrowser({ groups: [OTHER], windows: [MAIN], settings: { useWindow: true, windowId: 99 } });
  await routeAll(api);
  assert.deepEqual(state.createdWindows, []);
});
