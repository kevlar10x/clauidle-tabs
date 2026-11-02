# Chrome Web Store listing

Paste these into the developer dashboard. Keep "Claude" to five uses or fewer in the description: Google treats a keyword repeated more than five times as keyword stuffing.

## Store listing tab

Name: comes from the manifest, Clauidle Tabs

Summary: comes from the manifest

Category: Productivity, then the closest match in the dashboard's list (Workflow & Planning)

Language: English

Description:

```text
Clauidle Tabs tidies up after the Claude browser extension. It's for anyone who lets an AI agent browse for them and ends up with stray tab groups in the window they're using.

What it does:

- Moves new Claude tab groups into one window you pick, so they stop landing next to your videos or work.
- Sends you straight back when a click in one of those tabs opens a tab or popup and pulls you over there. A link you click yourself opens normally.
- Closes tabs in those groups once nobody has touched them for a set number of minutes, 30 by default. Pinned tabs, tabs playing sound and the tab you're looking at are left alone. Idle tabs close without a "Leave site?" prompt, so unsaved text in them is lost.
- Keeps a small pinned tab in that window, so the window stays open when every group closes.

You can use each feature on its own. The settings list every tab group with a switch, so you decide what counts. It needs the Claude browser extension to be useful.

Privacy: it can't read page contents, web addresses or tab titles, and it makes no network requests. Your settings and hashes of group names stay in your browser.

Unofficial, by kevlar10x. Not made by, affiliated with or endorsed by Anthropic. Claude is a trademark of Anthropic.
```

Icon: `extension/icons/icon-128.png`

Screenshots: `store/screenshots/settings.png`, then `store/screenshots/pinned-tab.png`

Homepage URL: `https://github.com/kevlar10x/clauidle-tabs`

Support URL: `https://github.com/kevlar10x/clauidle-tabs/issues`

## Privacy tab

Single purpose:

```text
Manages the tab groups the Claude browser extension opens: keeps them in one window the user picks, sends the user back when those tabs pull them away, and closes the ones left idle.
```

Permission justifications:

- tabGroups: `Finds the Claude browser extension's tab groups by name and moves them to the window the user picked.`
- alarms: `Sets one timer for when the next idle tab is due to close, so the extension doesn't need to poll.`
- storage: `Saves the user's settings, the chosen window, hashes of group names, when each tab was last touched, which window has focus, and which tab shows in each window.`

Host permissions: none

Remote code: No, I am not using remote code

Data usage: tick User activity (when a tab was last touched and which window has focus, kept until the browser closes). Nothing else applies: it never sees web addresses, page contents or tab titles.

Tick all three certifications: not sold, not used for unrelated purposes, not used for credit decisions.

Privacy policy URL: `https://github.com/kevlar10x/clauidle-tabs/blob/main/PRIVACY.md`

## Distribution tab

Free. All regions. Public, or Unlisted to install from a link only.

## Test instructions tab

```text
No account or login is needed, and the Claude extension isn't required for testing. The extension treats a group named exactly "Claude (MCP)" as Claude's.

Closing idle tabs:
1. Open a window with one ordinary tab you stay on, and add two tabs to a new tab group.
2. Name the group exactly Claude (MCP).
3. Click the toolbar button and set Close after to 1 minute.
4. Don't switch to the grouped tabs. They close about a minute later.

Keeping Claude's tabs in one window:
1. Open a second window, click the toolbar button there, then click Use this window.
2. A pinned tab called Claude's window appears in that window.
3. In the first window, make another group named exactly Claude (MCP). It moves to the second window.
4. Click Stop in the toolbar popup. The pinned tab closes.

Stay where you are:
This setting only acts when the Claude browser extension clicks a link in one of its tabs, so it does nothing visible in a test without that extension. Opening tabs and windows yourself works as usual, with the switch on or off.
```
