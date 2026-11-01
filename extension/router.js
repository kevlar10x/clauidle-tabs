// Spots the tab groups Claude makes and moves them into the window you picked for Claude.
import { GROUP_TITLE, claudeGroups, isClaude, markClaude, readIdentity, rememberTitle } from './groups.js';
import { getSettings } from './sweeper.js';

// The Claude extension names a new group within milliseconds; a person takes longer than this.
const FRESH_MS = 3000;
const FIRST_TITLE = 'Claude';

async function readPending(api) {
  return (await api.storage.session.get('pending')).pending ?? {};
}

// The Claude extension makes a session's group from one new background tab, then names it.
// Untitled groups that start that way are noted, so the naming that follows can be recognised.
export async function noteNewGroup(api, group, now) {
  if (group.title) return; // groups Brave restores come back already named
  const tabs = await api.tabs.query({ groupId: group.id });
  if (tabs.length !== 1) return;
  const [tab] = tabs;
  if (tab.active || now - (tab.lastAccessed ?? 0) > FRESH_MS) return;
  const pending = await readPending(api);
  for (const [id, at] of Object.entries(pending)) if (now - at > FRESH_MS) delete pending[id];
  pending[group.id] = now;
  await api.storage.session.set({ pending });
}

// Says whether a group is Claude's: 'new' when Claude has just made it or started on it (it gets moved),
// 'known' when it already was, or was recognised by name (it stays where it is).
export async function claimGroup(api, group, now) {
  const identity = await readIdentity(api);
  if (identity.notIds.has(group.id)) return false;
  if (identity.ids.has(group.id)) {
    await rememberTitle(api, group.title, identity.titles); // follows a session being renamed
    return 'known';
  }
  // Only Claude names things like this: its MCP group, and ⌛ in front while a tool runs.
  if (group.title === GROUP_TITLE || group.title?.startsWith('⌛')) {
    await markClaude(api, group);
    return 'new';
  }
  if (group.title) {
    const pending = await readPending(api);
    const at = pending[group.id];
    if (at !== undefined) {
      delete pending[group.id];
      await api.storage.session.set({ pending });
      if (now - at <= FRESH_MS) {
        await markClaude(api, group);
        return 'new';
      }
    }
    // Every new group is called this for a moment before it gets the session's name. Noting that catches
    // a group whose start went unseen, which a name Claude used before would otherwise pass off as restored.
    if (group.title === FIRST_TITLE) {
      pending[group.id] = now;
      await api.storage.session.set({ pending });
      return false;
    }
  }
  // A name Claude used before, on a group Brave restored.
  if (await isClaude(group, identity)) {
    await markClaude(api, group);
    return 'known';
  }
  return false;
}

// The window picked for Claude. When it's gone (closed, or Brave restarted and gave it a new id),
// a new background window takes its place.
async function claudeWindow(api) {
  const { useWindow, windowId } = await getSettings(api);
  if (!useWindow) return null;
  if (windowId !== null) {
    const win = await api.windows.get(windowId).catch(() => null);
    if (win?.type === 'normal') return win.id;
  }
  // The new window opens on the keeper tab, so it doesn't need another one.
  const created = await api.windows.create({ focused: false, type: 'normal', url: api.runtime.getURL(KEEPER_PAGE) });
  const keeper = created.tabs?.[0]?.id ?? null;
  if (keeper !== null) await settleKeeper(api, keeper);
  await api.storage.local.set({ keeperTab: keeper, windowId: created.id });
  return created.id;
}

// Claude's window keeps one pinned tab of its own (keeper.html), so closing all of Claude's tabs never
// closes the window. It's a small page from the extension: nothing to fetch, quick to spot, no close button.
export const KEEPER_PAGE = 'keeper.html';

// Pinned, and never unloaded by Brave's memory saver, so it's always there and always recognisable.
const settleKeeper = (api, tabId) => api.tabs.update(tabId, { pinned: true, autoDiscardable: false }).catch(() => {});

async function readKeeper(api) {
  const { keeperTab } = await api.storage.local.get({ keeperTab: null });
  return keeperTab === null ? null : api.tabs.get(keeperTab).catch(() => null);
}

async function showsKeeperPage(api, tabId) {
  const pages = await api.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [api.runtime.getURL(KEEPER_PAGE)] });
  return pages.some((page) => page.tabId === tabId);
}

// You can browse in a pinned tab too, and once you have, it's your tab rather than the extension's page.
async function closeKeeper(api, tabId) {
  if (await showsKeeperPage(api, tabId)) await api.tabs.remove(tabId).catch(() => {});
}

// Version 0.4 kept a plain New Tab. On update it stops counting as the keeper and stays open as an
// ordinary tab (you may have browsed in it), and a pinned keeper tab takes over.
export async function releaseOldKeeper(api) {
  const keeper = await readKeeper(api);
  if (keeper && !(await showsKeeperPage(api, keeper.id))) await api.storage.local.set({ keeperTab: null });
}

export async function ensureKeeper(api) {
  const { useWindow, windowId } = await getSettings(api);
  const keeper = await readKeeper(api);
  if (!useWindow) {
    // It's the extension's own page with nothing of yours in it, so it goes when the feature does.
    if (keeper) await closeKeeper(api, keeper.id);
    if (keeper) await api.storage.local.set({ keeperTab: null });
    return;
  }
  const win = windowId === null ? null : await api.windows.get(windowId).catch(() => null);
  if (win?.type !== 'normal') return; // gone: a restart may bring it back, see adoptKeeper
  if (keeper?.windowId === windowId) return;
  if (keeper) await closeKeeper(api, keeper.id); // left in a window that isn't Claude's any more
  const created = await api.tabs.create({ windowId, url: api.runtime.getURL(KEEPER_PAGE), pinned: true, active: false });
  await settleKeeper(api, created.id);
  await api.storage.local.set({ keeperTab: created.id });
}

// A keeper tab has loaded. After a restart, Brave brings it back in the old Claude's window under a new id,
// so its window becomes Claude's window again. Any other spare keeper tab is closed.
export async function adoptKeeper(api, tab) {
  const { useWindow, windowId } = await getSettings(api);
  const keeper = await readKeeper(api);
  if (useWindow && keeper?.id === tab.id) return;
  const win = useWindow && windowId !== null ? await api.windows.get(windowId).catch(() => null) : null;
  if (useWindow && !win) {
    await settleKeeper(api, tab.id);
    await api.storage.local.set({ keeperTab: tab.id, windowId: tab.windowId });
  } else if (useWindow && !keeper && tab.windowId === windowId) {
    await api.storage.local.set({ keeperTab: tab.id });
  } else {
    await api.tabs.remove(tab.id).catch(() => {});
  }
}

export async function routeGroup(api, groupId) {
  const { useWindow } = await getSettings(api);
  if (!useWindow) return;
  const group = await api.tabGroups.get(groupId).catch(() => null);
  if (!group) return;
  const target = await claudeWindow(api);
  // Moving keeps the group's id and its tabs' ids, so Claude keeps working with them.
  if (group.windowId !== target) await api.tabGroups.move(groupId, { windowId: target, index: -1 });
}

export async function routeAll(api) {
  for (const group of await claudeGroups(api)) await routeGroup(api, group.id);
}
