# Chrome Web Store listing — Quick Palette

Working draft of everything the developer console asks for. Not shipped in the
package (see .gitignore note in dist/).

## Basics

- **Name:** Quick Palette
- **Category:** Workflow & Planning (or Productivity → Tools)
- **Language:** English
- **Summary (max 132 chars):**
  Search the web, open pages, and jump between tabs from one keyboard-first
  palette.

## Description

Quick Palette puts a Spotlight-style command palette one keystroke away in
your toolbar — on any page, including Chrome's own. Press Ctrl+Shift+K (⌘⇧K
on Mac) and start typing to:

- Jump to any open tab, in any window
- Reopen pages from your history and bookmarks
- Search the web with your default search engine
- Run browser commands: new tab/window, incognito, downloads, settings, and more
- Copy the current page URL without touching the mouse

Everything is ranked locally and learns which results you actually pick, so
your most-used tabs and sites float to the top. Multi-select with Tab to open
several results at once. Browse modes let you page through your full history
or bookmark tree without leaving the keyboard.

Privacy: all matching, ranking, and learning happens on your device. The
extension makes no network requests and collects nothing. See the privacy
policy for details.

## Single-purpose statement

Quick Palette provides one function: a keyboard-invoked palette to find and
open tabs, history entries, bookmarks, web searches, and browser commands.

## Permission justifications

- **tabs** — Lists open tabs (title/URL) so the user can search and switch to
  them; activates the tab the user selects.
- **history** — Searched locally to suggest previously visited pages matching
  the user's query. Never transmitted.
- **bookmarks** — Searched locally to suggest bookmarked pages matching the
  user's query. Never transmitted.
- **search** — Runs the user's query with their default search engine when
  they choose "Search the web".
- **storage** — Stores learned result-ranking preferences locally so
  frequently chosen items rank higher. Stays on-device.
- **clipboardWrite** — Implements the "Copy current URL" command.
- **offscreen** — Hosts the clipboard write for "Copy current URL" when it is
  triggered from a context without a focused page (service-worker limitation).

## Data-use disclosures (Privacy tab)

- Collects user data: **No** (all processing is local; nothing is transmitted).
- Remote code: **No** — all code is packaged; nothing is fetched or eval'd.
- Certify: does not sell data, does not use/transfer data for purposes
  unrelated to the single purpose, does not use/transfer data to determine
  creditworthiness.
- **Privacy policy URL:**
  https://github.com/anoopkcn/quick-palette/blob/main/PRIVACY.md

## Assets

- Icon 128×128: `icons/icon-128.png`
- Screenshot 1280×800: `dist/screenshot-1280x800.png` (generated from
  `assets/demo.png`)
