import { DEFAULTS, getSettings, review } from './sweeper.js';
import { isClaude, markClaude, readIdentity, unmarkClaude } from './groups.js';
import { routeGroup } from './router.js';

// The same page is the toolbar popup (options.html?popup) and the options dialog.
if (new URLSearchParams(location.search).has('popup')) document.body.classList.add('popup');

const windowStatus = document.getElementById('window-status');
const useWindow = document.getElementById('use-window');
const stopWindow = document.getElementById('stop-window');
const enabled = document.getElementById('enabled');
const minutes = document.getElementById('minutes');
const minutesRow = document.getElementById('minutes-row');
const error = document.getElementById('minutes-error');
const status = document.getElementById('status');
const groupList = document.getElementById('groups');

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayAndTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const when = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? time : dayAndTime).format(ms);

function showOff(off) {
  minutes.disabled = off;
  minutesRow.classList.toggle('off', off);
}

function readMinutes() {
  const value = minutes.valueAsNumber;
  const ok = Number.isInteger(value) && value >= 1 && value <= 1440;
  minutes.setAttribute('aria-invalid', String(!ok));
  error.hidden = ok;
  return ok ? value : null;
}

async function refreshStatus() {
  const settings = await getSettings(chrome);
  if (!settings.enabled) {
    status.textContent = "Off. Claude's tabs stay open.";
    return;
  }
  const { touched, next } = await review(chrome, Date.now(), settings.minutes);
  const count = Object.keys(touched).length;
  if (!count) {
    status.textContent = 'No Claude tabs open right now.';
    return;
  }
  const tabs = count === 1 ? '1 tab' : `${count} tabs`;
  status.replaceChildren(
    'Watching ', strong(tabs), count === 1 ? '. It closes at ' : '. The next one closes at ', strong(when(next)), '.',
  );
}

async function refreshWindow() {
  const { useWindow: on, windowId } = await getSettings(chrome);
  const here = (await chrome.windows.getCurrent()).id;
  const win = on && windowId !== null ? await chrome.windows.get(windowId, { populate: true }).catch(() => null) : null;
  const isHere = win?.id === here;
  if (!on) {
    windowStatus.textContent = 'Off. Claude opens its tabs in whichever window you used last.';
  } else if (!win) {
    windowStatus.textContent = "That window is closed. Claude's next tab group opens a new window.";
  } else if (isHere) {
    windowStatus.replaceChildren(strong('This window.'), " Claude's new tab groups move here.");
  } else {
    const tabs = win.tabs.length === 1 ? '1 tab' : `${win.tabs.length} tabs`;
    windowStatus.replaceChildren('Another window, with ', strong(tabs), ". Claude's new tab groups move there.");
  }
  useWindow.hidden = isHere;
  stopWindow.hidden = !on;
}

// Every tab group in Brave, in tab strip order, each with a switch for whether it's Claude's.
async function refreshGroups() {
  const [groups, identity] = await Promise.all([chrome.tabGroups.query({}), readIdentity(chrome)]);
  const rows = await Promise.all(groups.map(async (group) => {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    return {
      group, tabs: tabs.length, claude: await isClaude(group, identity), at: [group.windowId, Math.min(...tabs.map((t) => t.index))],
    };
  }));
  rows.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);

  const focused = document.activeElement?.id;
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No tab groups open.';
    groupList.replaceChildren(empty);
    return;
  }
  groupList.replaceChildren(...rows.map(({ group, tabs, claude }) => {
    const item = document.createElement('li');
    item.className = 'group';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.dataset.color = group.color;
    const name = document.createElement('label');
    name.className = group.title ? 'group-name' : 'group-name unnamed';
    name.htmlFor = `group-${group.id}`;
    name.textContent = name.title = group.title || 'Unnamed group';
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = tabs === 1 ? '1 tab' : `${tabs} tabs`;
    const toggle = document.createElement('input');
    Object.assign(toggle, { type: 'checkbox', className: 'switch', id: `group-${group.id}`, checked: claude });
    toggle.setAttribute('role', 'switch');
    toggle.addEventListener('change', async () => {
      if (toggle.checked) {
        await markClaude(chrome, group);
        await routeGroup(chrome, group.id); // joins the others in Claude's window, if one is picked
      } else {
        await unmarkClaude(chrome, group);
      }
      refreshSoon();
    });
    item.append(swatch, name, count, toggle);
    return item;
  }));
  // Redrawing replaces the switches, so put the focus back where it was.
  if (focused) document.getElementById(focused)?.focus();
}

function strong(text) {
  const el = document.createElement('strong');
  el.textContent = text;
  return el;
}

// Tab events come in bursts while pages load; redraw once per burst.
let pending = 0;
function refreshSoon() {
  clearTimeout(pending);
  pending = setTimeout(() => Promise.all([refreshStatus(), refreshWindow(), refreshGroups()]).catch(() => {}), 250);
}

useWindow.addEventListener('click', async () => {
  const { id } = await chrome.windows.getCurrent();
  await chrome.storage.local.set({ useWindow: true, windowId: id });
});
stopWindow.addEventListener('click', () => chrome.storage.local.set({ useWindow: false }));

enabled.addEventListener('change', async () => {
  showOff(!enabled.checked);
  await chrome.storage.local.set({ enabled: enabled.checked });
});
minutes.addEventListener('input', async () => {
  const value = readMinutes();
  if (value !== null) await chrome.storage.local.set({ minutes: value });
});
minutes.addEventListener('blur', () => {
  // Leaving the field empty or out of range puts back the last saved value.
  if (readMinutes() === null) getSettings(chrome).then((s) => { minutes.value = s.minutes; readMinutes(); });
});

chrome.storage.onChanged.addListener(refreshSoon);
chrome.tabs.onUpdated.addListener(refreshSoon);
chrome.tabs.onRemoved.addListener(refreshSoon);
chrome.tabGroups.onCreated.addListener(refreshSoon);
chrome.tabGroups.onUpdated.addListener(refreshSoon);
chrome.tabGroups.onRemoved.addListener(refreshSoon);
chrome.windows.onRemoved.addListener(refreshSoon);

const saved = await getSettings(chrome);
enabled.checked = saved.enabled;
minutes.value = saved.minutes ?? DEFAULTS.minutes;
showOff(!saved.enabled);
await Promise.all([refreshStatus(), refreshWindow(), refreshGroups()]);
