# Quick Palette

A keyboard-first command palette for Chrome, inspired by Arc's command bar. It can:

- Switch to any open tab, including tabs in other windows
- Rank tabs using match quality, recency, window context, pinned state, and locally learned palette choices
- Search browsing history and bookmarks
- Search with Chrome's default search engine
- Open URLs directly
- Create tabs, windows, and incognito windows
- Open common Chrome pages such as History, Downloads, Bookmarks, Extensions, and Settings
- Close open tabs from the result list

## Author

Anoop K. Chandran

## Install

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open a normal webpage and press `Command+Shift+K` on macOS or `Ctrl+Shift+K` on Windows/Linux.

Chrome may leave the shortcut unassigned if another extension or browser feature already uses it. Open `chrome://extensions/shortcuts` to assign or change the shortcut.

## Use

- Start typing to filter open tabs and search history/bookmarks.
- Use the up/down arrow keys to move through results.
- Press Enter to open the selected result.
- Press Escape or click outside the palette to close it.
- Hover a tab result and click the close button to close that tab.
- Search for **Reset learned tab ranking** to clear locally stored ranking preferences.

On protected Chrome pages and the Chrome Web Store, Chrome does not allow an injected overlay. Quick Palette automatically opens in a small extension window instead.

## Development

There is no build step. After changing `manifest.json` or `background.js`, click the extension's reload button on `chrome://extensions`. Reload an open page after changing `content.js`.

Run the automated tests with `node --test tests/*.test.js`.
