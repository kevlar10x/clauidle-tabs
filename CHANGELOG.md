# Changelog

Tested on Brave 1.98.60 (Windows) with the Claude extension 1.0.102 and Claude Code 2.1.309. The automated browser checks also pass on Chrome for Testing 156.

## 0.6.0 - 2026-10-30

- Renamed to Clauidle Tabs. Your settings stay as they are.
- The toolbar button now has its own icon.
- The names of Claude's groups are now stored only as hashes. Names saved by older versions are converted when this version starts.
- Fixed: if you browsed to a site in the pinned tab, Stop or picking another window closed it. That tab now stays open as yours.
- Added a privacy policy.
- The extension's details page now links to the project on GitHub.

## 0.5.0 - 2026-10-28

- The tab that keeps Claude's window open is now a pinned "Claude's window" tab with its own icon instead of a New Tab. It has no close button, and it loads in about 17 ms with nothing from the network. Brave's New Tab page fetched about 2 MB in the same test.
- After a Brave restart, Claude's window is found again from that tab, instead of a new window opening for Claude.
- Stop closes that tab, and picking another window moves it.
- Updating from 0.4: the New Tab it kept before stays open as an ordinary tab, so you can close it yourself.

## 0.4.0 - 2026-10-28

- Claude's window now always keeps a New Tab open at the far left, so it no longer closes when all of Claude's tabs close, whether you, Claude or the extension closed them.

## 0.3.0 - 2026-10-28

- Fixed: Claude groups that were already open before the extension started weren't counted, so their tabs never closed. The settings now list every tab group with a switch, so you can turn on the ones that are Claude's.
- Claude's group names are remembered, so they're recognised again after Brave restarts.
- A group counts as Claude's as soon as the Claude extension puts ⌛ in front of its name, which it does while working in it.
- A group you switch on moves to Claude's window, if you picked one.

## 0.2.0 - 2026-10-28

- New: pick a window for Claude's tabs. Click the toolbar button in that window, then Use this window. Claude's new tab groups move there, and tabs Claude adds to them later follow.
- Fixed: tabs in each Claude Code session's own group now close when idle too. 0.1.0 only watched the "Claude (MCP)" group, and current Claude Code mostly uses per-session groups.
- The settings now also open from the toolbar button.

## 0.1.0 - 2026-10-28

- First version. Closes tabs in the Claude (MCP) tab group after 30 minutes without being touched. You can change the minutes or turn it off in the extension's options.
