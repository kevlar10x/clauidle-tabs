// clauidle-tabs by kevlar10x, github.com/kevlar10x/clauidle-tabs. Wires browser events to the sweeper and the router; the rules live there.
import { ALARM, forget, sweep, touch } from './sweeper.js';
import { hashOldTitles, isClaudeGroup } from './groups.js';
import {
  adoptKeeper, claimGroup, ensureKeeper, noteNewGroup, releaseOldKeeper, routeAll, routeGroup,
} from './router.js';

// One job at a time, so a sweep and a touch never write the stored times over each other.
let queue = Promise.resolve();
const run = (job) => {
  queue = queue.then(job).catch((err) => console.warn('clauidle-tabs:', err));
};

// Loading, navigating, a title change or sound all count as the tab being used.
chrome.tabs.onUpdated.addListener((_tabId, _change, tab) => {
  if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) run(() => touch(chrome, tab, Date.now()));
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  run(async () => touch(chrome, await chrome.tabs.get(tabId).catch(() => null), Date.now()));
});
chrome.tabs.onRemoved.addListener((tabId, { isWindowClosing }) => {
  run(() => forget(chrome, tabId));
  // Puts back the pinned tab that keeps Claude's window open, unless the whole window is being closed.
  if (!isWindowClosing) run(() => ensureKeeper(chrome));
});
chrome.tabs.onDetached.addListener(() => run(() => ensureKeeper(chrome)));
// keeper.js says hello when the keeper tab loads, including when Brave restores it after a restart.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'keeper' && sender.tab) run(() => adoptKeeper(chrome, sender.tab));
});

chrome.tabGroups.onCreated.addListener((group) => run(async () => {
  await noteNewGroup(chrome, group, Date.now());
  // Brave restores groups with their names, so one with a name Claude used is counted straight away.
  if (group.title && (await isClaudeGroup(chrome, group.id))) await sweep(chrome, Date.now());
}));
// The Claude extension names its groups a moment after making them, so this is where they're recognised.
chrome.tabGroups.onUpdated.addListener((group) => run(async () => {
  const claim = await claimGroup(chrome, group, Date.now());
  if (!claim) return;
  // Only a group seen for the first time is moved, so one you drag back stays where you put it.
  if (claim === 'new') await routeGroup(chrome, group.id);
  await sweep(chrome, Date.now());
}));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) run(() => sweep(chrome, Date.now()));
});
chrome.storage.onChanged.addListener((changes, area) => {
  // A group switched on or off in the settings changes which tabs are watched.
  if (area === 'session' && ('claudeGroups' in changes || 'notClaudeGroups' in changes)) {
    run(() => sweep(chrome, Date.now()));
  }
  if (area !== 'local') return;
  if ('useWindow' in changes || 'windowId' in changes) {
    run(() => routeAll(chrome));
    run(() => ensureKeeper(chrome));
  }
  run(() => sweep(chrome, Date.now()));
});
chrome.runtime.onStartup.addListener(() => run(() => sweep(chrome, Date.now())));
chrome.runtime.onInstalled.addListener(({ reason }) => {
  run(() => hashOldTitles(chrome));
  run(() => sweep(chrome, Date.now()));
  if (reason === 'update') run(() => releaseOldKeeper(chrome));
  run(() => ensureKeeper(chrome));
});
