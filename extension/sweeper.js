// Closes tabs in Claude's tab groups that nobody has touched for a set time.
// Every browser call goes through `api`: chrome in the extension, a fake in the tests.
import { claudeGroups, isClaudeGroup } from './groups.js';

export const DEFAULTS = { enabled: true, minutes: 30, useWindow: false, windowId: null };
export const ALARM = 'sweep';

export async function getSettings(api) {
  const saved = await api.storage.local.get(DEFAULTS);
  const minutes = Number(saved.minutes);
  return {
    enabled: saved.enabled !== false,
    minutes: minutes > 0 ? minutes : DEFAULTS.minutes,
    useWindow: saved.useWindow === true,
    windowId: Number.isInteger(saved.windowId) ? saved.windowId : null,
  };
}

async function readTouched(api) {
  return (await api.storage.session.get('touched')).touched ?? {};
}

// Notes that a tab in the group was just used. Runs on tab events, so it does as little as it can.
export async function touch(api, tab, now) {
  if (!tab || !(await isClaudeGroup(api, tab.groupId))) return;
  if (!(await getSettings(api)).enabled) return;
  const touched = await readTouched(api);
  touched[tab.id] = now;
  await api.storage.session.set({ touched });
  // A touch only moves a deadline later, so an alarm that is already set still goes off early enough.
  if (!(await api.alarms.get(ALARM))) await sweep(api, now);
}

export async function forget(api, tabId) {
  const touched = await readTouched(api);
  if (!(tabId in touched)) return;
  delete touched[tabId];
  await api.storage.session.set({ touched });
}

// Works out which watched tabs are due to close, without changing anything.
// The settings page uses it too, to show what the sweeper will do.
export async function review(api, now, minutes) {
  const limit = minutes * 60_000;
  const groups = await claudeGroups(api);
  const tabs = (await Promise.all(groups.map((g) => api.tabs.query({ groupId: g.id })))).flat();
  const stored = await readTouched(api);
  const focused = tabs.length ? await api.windows.getLastFocused().catch(() => null) : null;

  const touched = {};
  const idle = [];
  for (const tab of tabs) {
    if (tab.pinned) continue;
    // A tab seen for the first time counts as touched now, so installing or restarting closes nothing.
    let last = Math.max(stored[tab.id] ?? now, tab.lastAccessed ?? 0);
    // The tab you're looking at, or one playing sound, is in use.
    if (tab.audible || (tab.active && focused?.focused && tab.windowId === focused.id)) last = now;
    if (now - last >= limit) idle.push(tab.id);
    else touched[tab.id] = last;
  }
  const deadlines = Object.values(touched).map((t) => t + limit);
  return { idle, touched, next: deadlines.length ? Math.min(...deadlines) : null };
}

// Closes the tabs whose time is up, then sets one alarm for the next tab that comes due.
export async function sweep(api, now) {
  const { enabled, minutes } = await getSettings(api);
  if (!enabled) {
    await api.alarms.clear(ALARM);
    return { closed: [], next: null };
  }
  const { idle, touched, next } = await review(api, now, minutes);

  if (idle.length) await close(api, idle);
  await api.storage.session.set({ touched });

  if (next === null) await api.alarms.clear(ALARM);
  else await api.alarms.create(ALARM, { when: next });
  return { closed: idle, next };
}

// Closing every tab in every window would quit Brave, and closing all of Claude's window would lose it,
// so a new tab keeps the window open in both cases.
async function close(api, ids) {
  const closing = new Set(ids);
  const windows = await api.windows.getAll({ windowTypes: ['normal'], populate: true });
  const emptied = windows.filter((w) => w.tabs.every((t) => closing.has(t.id)));
  const { useWindow, windowId } = await getSettings(api);
  const keep = emptied.find((w) => useWindow && w.id === windowId)
    ?? (emptied.length === windows.length ? windows[0] : undefined);
  if (keep) await api.tabs.create({ windowId: keep.id });
  try {
    await api.tabs.remove(ids);
  } catch {
    // One of them closed on its own first, which fails the whole call. Close the rest one by one.
    await Promise.all(ids.map((id) => api.tabs.remove(id).catch(() => {})));
  }
}
