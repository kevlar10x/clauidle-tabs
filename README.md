# Clauidle Tabs

A small Brave extension (it works in Chrome too) for the tabs Claude Code opens through the Claude browser extension. It does two things, and you can use either one on its own:

- Keeps Claude's tab groups in one window you pick, so they stop landing in the window you're watching videos in.
- Closes Claude's tabs once nobody has touched them for a set number of minutes (30 by default).

It goes only by what happens in the tabs and has no connection to Claude Code. It's an unofficial project by kevlar10x, not made by or affiliated with Anthropic. The original lives at https://github.com/kevlar10x/clauidle-tabs.

## Install

1. Download or clone this repo and put it somewhere it will stay. Brave runs an unpacked extension from its folder, so moving or deleting the folder removes the extension.
2. Open `brave://extensions` and turn on Developer mode (top right).
3. Click Load unpacked and pick the `extension` folder inside this one.
4. Pin it to the toolbar: click the puzzle piece, then the pin next to Clauidle Tabs.

The toolbar button opens the settings. They're also under Options in the extension's menu.

## Claude's window

Go to the window you want Claude to use, click the toolbar button, then Use this window. From then on:

- Each new Claude tab group moves to that window as soon as Claude makes it. Tabs Claude adds to the group later land there too, and the window you're in keeps its current tab.
- Claude keeps working with its tabs after the move. The group and its tabs keep their ids, which is how Claude finds them.
- A group you drag back out stays where you put it.
- The window keeps a pinned tab of its own called "Claude's window", with a small window icon, so it stays open when all of Claude's tabs close, whoever closes them. It's a tiny page inside the extension: it loads in a few milliseconds and fetches nothing. Being pinned, it has no close button, and Brave's memory saver leaves it alone.
- If you close that tab anyway (Ctrl+W), it opens again. The exception is when it was the last tab left: then the window closes, the same as closing the window yourself.
- After Brave restarts and restores your windows, that pinned tab tells the extension which window is Claude's, so everything carries on there. If Brave doesn't restore your last session, the next Claude group opens a new background window, which becomes Claude's window.
- If you close Claude's window, the next Claude group also opens a new background window. Click Use this window again if you'd rather use another one.
- Stop turns it off and closes the pinned tab. Picking another window moves the pinned tab there.

## Closing idle tabs

- A tab counts as touched when it loads, goes to a new page, changes its title or plays sound, and when you switch to it.
- Pinned tabs, tabs playing sound, and the tab you're looking at (the one showing in the Brave window you're using) are never closed.
- A tab it hasn't seen before counts as touched at that moment, so installing it or restarting Brave doesn't close anything straight away.
- If closing would leave Claude's window, or all of Brave, with no tabs, it opens a new tab first so the window stays.
- A closed tab comes back with Ctrl+Shift+T like any other.
- Idle tabs close without a "Leave site?" prompt, so any unsaved text in them is lost. If Brave won't unload a tab first, the prompt can still show, once. If you stay on the page, that tab stays open until you close it or restart Brave.

## Which groups count as Claude's

- The "Claude (MCP)" group, by its name.
- Each Claude Code session's own group. These are named after the session, so the extension recognises them by how Claude makes them: a new group around one brand-new background tab, named within 3 seconds. A group you make yourself, or one you restore with Ctrl+Shift+T, doesn't look like that.
- A group that gets ⌛ in front of its name. The Claude extension adds it while it runs a tool in that group, so older groups count as soon as Claude works in them again.
- A group called just "Claude" in Claude's window. When a session's tab leaves its group, Claude puts it in a new group with that name, and it keeps the name until the next tool call. In any other window that name stays yours, because the side panel uses it on your own tabs.
- Any group you switch on under "Claude's tab groups" in the settings. Use this for groups that were already open before the extension was. A group you switch on also moves to Claude's window, if you picked one.

The names of Claude's groups are remembered as hashes, so when Brave restarts and restores them they're recognised again, and the names themselves are never stored. Names are compared without the ⌛, ✅ and 🔔 the Claude extension adds and without status dots, since those change all the time. Switching a group off forgets its name. The plain name "Claude" is never remembered, because the side panel and sessions without a name all use it.

A group of yours could be taken for Claude's if it has a name Claude used, starts with ⌛, is called just "Claude" in Claude's window, or comes from another extension that makes groups exactly the way Claude does. Switch it off in the settings and it stays off. The exception is a group called just "Claude" in Claude's window, which counts again after a Brave restart or an extension update.

## Things to know

- Screenshots, clicks and typing that don't change the page are invisible to it. A Claude session that spends longer than the limit on one page without it loading or changing could lose that tab. If that happens, raise the minutes.
- Keep Claude's window open rather than minimized. I haven't checked whether Claude can take screenshots of tabs in a minimized window.
- The extension asks Brave to open that new background window without focus. I've only tested in headless Brave, so I haven't seen whether Windows really keeps it behind your other windows.
- The old "Claude (MCP)" group opens in a new window of its own, which takes focus. That's the Claude extension's doing. The group then moves to Claude's window and the empty window closes.
- It depends on how the Claude extension makes its groups (tested with version 1.0.104 and Claude Code 2.1.309). If that changes, groups may stop being recognised until this is updated.

## Permissions

- `tabGroups`, to find Claude's groups and move them.
- `alarms`, for one timer set to when the next tab is due.
- `storage`, for your settings, Claude's window and its pinned tab, hashes of the names of Claude's groups, and when each tab was last touched.

It can't read page contents, addresses or titles, and it makes no network requests. See [PRIVACY.md](PRIVACY.md).

## Development

```bash
npm test
```

```bash
node tests/browser-check.js
```

```bash
node tests/restart-check.js
```

```bash
node tests/update-check.js
```

The first runs the unit tests (Node 22 or newer). The second loads the extension into a headless Brave with a throwaway profile, checks the closing and moving rules and the settings page for real, then deletes the profile. Give it a folder name to also save screenshots of the settings page and the pinned tab. The third restarts Brave on one throwaway profile to check that Claude's window is found again. The fourth checks that names stored as plain text by 0.5 become hashes. All three browser checks use another browser if you set the `BRAVE` environment variable to its path.

`store/` holds what the Chrome Web Store needs: the icon and screenshot scripts, the listing text and the package builder.

## License

MIT, by kevlar10x.

If you'd like to leave a tip: https://ko-fi.com/kevlar10x
