// Just enough of the chrome API for the extension's modules, kept in plain objects so tests can read it back.
export const MCP = { id: 10, title: 'Claude (MCP)', windowId: 1 };
export const OTHER = { id: 20, title: 'Work', windowId: 1 };

export const tab = (id, extra = {}) => ({
  id, windowId: 1, groupId: MCP.id, active: false, pinned: false, audible: false, lastAccessed: 0, ...extra,
});

export function fakeBrowser({
  groups = [MCP, OTHER], tabs = [], windows = [{ id: 1, focused: true }], settings = {}, session = {}, touched,
} = {}) {
  const state = {
    groups: groups.map((g) => ({ ...g })), tabs, windows, local: { ...settings },
    session: structuredClone(touched ? { ...session, touched } : session),
    alarm: null, created: [], createdWindows: [], moves: [],
  };
  let nextId = 1000;
  const api = {
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...state.local }),
        set: async (items) => Object.assign(state.local, items),
        remove: async (key) => { delete state.local[key]; },
      },
      session: {
        get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, structuredClone(state.session[k])])),
        set: async (items) => Object.assign(state.session, structuredClone(items)),
      },
    },
    tabGroups: {
      query: async () => state.groups,
      get: async (id) => {
        const group = state.groups.find((g) => g.id === id);
        if (!group) throw new Error(`No group with id: ${id}.`);
        return group;
      },
      move: async (id, { windowId }) => {
        const group = await api.tabGroups.get(id);
        group.windowId = windowId;
        for (const t of state.tabs) if (t.groupId === id) t.windowId = windowId;
        state.moves.push([id, windowId]);
        return group;
      },
    },
    tabs: {
      get: async (id) => {
        const found = state.tabs.find((t) => t.id === id);
        if (!found) throw new Error(`No tab with id: ${id}.`);
        return found;
      },
      query: async ({ groupId }) => state.tabs.filter((t) => t.groupId === groupId),
      remove: async (ids) => {
        const gone = [].concat(ids);
        state.tabs = state.tabs.filter((t) => !gone.includes(t.id));
      },
      create: async ({ windowId, index, active, url, pinned = false }) => {
        const created = { id: nextId++, windowId, groupId: -1, index, active, url, pinned };
        state.created.push(created);
        state.tabs.push(created);
        return created;
      },
      update: async (id, props) => Object.assign(await api.tabs.get(id), props),
    },
    windows: {
      get: async (id) => {
        const win = state.windows.find((w) => w.id === id);
        if (!win) throw new Error(`No window with id: ${id}.`);
        return { type: 'normal', ...win };
      },
      create: async ({ focused, type, url }) => {
        const win = { id: nextId++, focused: !!focused, type };
        state.windows.push(win);
        state.createdWindows.push(win);
        const first = { id: nextId++, windowId: win.id, groupId: -1, active: true, url };
        state.tabs.push(first);
        return { ...win, tabs: [first] };
      },
      getLastFocused: async () => state.windows.find((w) => w.focused) ?? state.windows[0],
      getAll: async () => state.windows.map((w) => ({ ...w, tabs: state.tabs.filter((t) => t.windowId === w.id) })),
    },
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts: async ({ documentUrls = [] }) => state.tabs
        .filter((t) => documentUrls.includes(t.url))
        .map((t) => ({ contextType: 'TAB', tabId: t.id, windowId: t.windowId, documentUrl: t.url })),
    },
    alarms: {
      get: async (name) => (name === 'sweep' && state.alarm ? state.alarm : undefined),
      create: async (name, { when }) => { state.alarm = { name, scheduledTime: when }; },
      clear: async () => { state.alarm = null; return true; },
    },
  };
  return { api, state };
}

export const ids = (tabs) => tabs.map((t) => t.id).sort((a, b) => a - b);
