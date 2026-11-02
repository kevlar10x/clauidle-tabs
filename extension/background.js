// clauidle-tabs by kevlar10x, github.com/kevlar10x/clauidle-tabs. Wires browser events to the sweeper and the router; the rules live there.
import { ALARM, forget, sweep, touch } from './sweeper.js';
import { noteFocus, noteNewTab, noteShowing, seedFocus } from './focus.js';
import { hashOldTitles, isClaudeGroup } from './groups.js';
import {
  adoptKeeper, claimGroup, ensureKeeper, noteNewGroup, releaseOldKeeper, routeAll, routeGroup,
} from './router.js';

const inTurn = () => {
  let queue = Promise.resolve();
  return (job) => {
    queue = queue.then(job).catch((err) => console.warn('clauidle-tabs:', err));
  };
};
// One job at a time, so a sweep and a touch never write the stored times over each other.
const run = inTurn();
// Sending you back goes by the order things happened in, and a sweep shouldn't hold it up.
const runFocus = inTurn();

// Loading, navigating, a title change or sound all count as the tab being used.
chrome.tabs.onUpdated.addListener((_tabId, _change, tab) => {
  if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) run(() => touch(chrome, tab, Date.now()));
});
chrome.tabs.onActivated.addListener((active) => {
  const now = Date.now();
  run(async () => touch(chrome, await chrome.tabs.get(active.tabId).catch(() => null), now));
  runFocus(() => noteShowing(chrome, active, now));
});
chrome.tabs.onCreated.addListener((tab) => {
  const now = Date.now();
  runFocus(() => noteNewTab(chrome, tab, now));
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  const now = Date.now();
  runFocus(() => noteFocus(chrome, windowId, now));
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
chrome.runtime.onStartup.addListener(() => {
  runFocus(() => seedFocus(chrome));
  run(() => sweep(chrome, Date.now()));
});
chrome.runtime.onInstalled.addListener(({ reason }) => {
  runFocus(() => seedFocus(chrome));
  run(() => hashOldTitles(chrome));
  run(() => sweep(chrome, Date.now()));
  if (reason === 'update') run(() => releaseOldKeeper(chrome));
  run(() => ensureKeeper(chrome));
});
