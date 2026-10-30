// Tells the extension this tab has loaded. After Brave restarts and brings it back,
// that's how the window it's in is recognised as Claude's window again.
chrome.runtime.sendMessage({ type: 'keeper' }).catch(() => {});
