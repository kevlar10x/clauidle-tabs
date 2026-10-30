// Which tab groups are Claude's. Every browser call goes through `api`: chrome in the extension, a fake in the tests.

export const GROUP_TITLE = 'Claude (MCP)';
const NO_GROUP = -1;
const MAX_TITLES = 100;

// The Claude extension puts ⌛, ✅ or 🔔 in front of a group's name while it works, and session names
// can start with a status dot, so names are compared without those.
const MARKS = /^[\s⌛✅\u{1F514}\u{1F534}\u{1F7E1}\u{1F535}\u{1F7E2}⚪️]+/u;
export const baseTitle = (title) => (title ?? '').replace(MARKS, '').trim();

// "Claude" is the name the side panel and unnamed sessions use, so on its own it says nothing.
const GENERIC = new Set(['', 'Claude', GROUP_TITLE]);

// Session names can say what someone is working on, so only a hash of each is stored. That's enough to
// recognise a name again, and the name itself never sits in storage.
export async function hashTitle(base) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

// Ids last until Brave restarts, like the groups. Name hashes are kept, so restored groups are recognised again.
export async function readIdentity(api) {
  const [session, local] = await Promise.all([
    api.storage.session.get(['claudeGroups', 'notClaudeGroups']),
    api.storage.local.get({ titleHashes: [] }),
  ]);
  return {
    ids: new Set(session.claudeGroups ?? []),
    notIds: new Set(session.notClaudeGroups ?? []),
    titles: new Set(local.titleHashes),
  };
}

export async function isClaude(group, { ids, notIds, titles }) {
  if (notIds.has(group.id)) return false;
  if (group.title === GROUP_TITLE || ids.has(group.id)) return true;
  const base = baseTitle(group.title);
  return !GENERIC.has(base) && titles.has(await hashTitle(base));
}

export async function claudeGroups(api) {
  const [groups, identity] = await Promise.all([api.tabGroups.query({}), readIdentity(api)]);
  const claude = await Promise.all(groups.map((g) => isClaude(g, identity)));
  return groups.filter((_, i) => claude[i]);
}

export async function isClaudeGroup(api, groupId) {
  if (groupId === undefined || groupId === NO_GROUP) return false;
  const group = await api.tabGroups.get(groupId).catch(() => null); // null: the group closed in the meantime
  return group !== null && isClaude(group, await readIdentity(api));
}

export async function rememberTitle(api, title, titles) {
  const base = baseTitle(title);
  if (GENERIC.has(base)) return;
  const hash = await hashTitle(base);
  if (titles.has(hash)) return;
  await api.storage.local.set({ titleHashes: [hash, ...titles].slice(0, MAX_TITLES) });
}

// Up to 0.5 the names were stored as plain text. This hashes them and removes the old list.
export async function hashOldTitles(api) {
  const { claudeTitles, titleHashes } = await api.storage.local.get({ claudeTitles: null, titleHashes: [] });
  if (!claudeTitles) return;
  const hashes = await Promise.all(claudeTitles.map(hashTitle));
  await api.storage.local.set({ titleHashes: [...new Set([...titleHashes, ...hashes])].slice(0, MAX_TITLES) });
  await api.storage.local.remove('claudeTitles');
}

export async function markClaude(api, group) {
  const { ids, notIds, titles } = await readIdentity(api);
  ids.add(group.id);
  notIds.delete(group.id);
  await api.storage.session.set({ claudeGroups: [...ids], notClaudeGroups: [...notIds] });
  await rememberTitle(api, group.title, titles);
}

export async function unmarkClaude(api, group) {
  const { ids, notIds, titles } = await readIdentity(api);
  ids.delete(group.id);
  notIds.add(group.id);
  titles.delete(await hashTitle(baseTitle(group.title)));
  await api.storage.session.set({ claudeGroups: [...ids], notClaudeGroups: [...notIds] });
  await api.storage.local.set({ titleHashes: [...titles] });
}
