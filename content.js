(() => {
  if (window.__quickPaletteLoaded) return;
  window.__quickPaletteLoaded = true;
  const isStandalone = location.protocol === "chrome-extension:";
  const isMac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  const jumpKeyLabel = isMac ? "⌘" : "^";

  const COMMANDS = [
    { title: "New tab", subtitle: "Open a blank tab", icon: "+", keywords: "create open", action: { type: "NEW_TAB" } },
    { title: "New window", subtitle: "Open a browser window", icon: "□", keywords: "create open", action: { type: "NEW_WINDOW" } },
    { title: "New incognito window", subtitle: "Open a private browser window", icon: "◐", keywords: "private create", action: { type: "NEW_INCOGNITO_WINDOW" } },
    { title: "History", subtitle: "Browse and open history items", icon: "↶", keywords: "recent visited browse", action: { type: "BROWSE", mode: "history" } },
    { title: "Downloads", subtitle: "Open Chrome downloads", icon: "↓", keywords: "files", action: { type: "OPEN_CHROME_PAGE", page: "downloads" } },
    { title: "Bookmarks", subtitle: "Browse and open bookmarks", icon: "★", keywords: "saved favorites browse", action: { type: "BROWSE", mode: "bookmarks" } },
    { title: "Extensions", subtitle: "Manage Chrome extensions", icon: "◇", keywords: "plugins addons", action: { type: "OPEN_CHROME_PAGE", page: "extensions" } },
    { title: "Settings", subtitle: "Open Chrome settings", icon: "⚙", keywords: "preferences", action: { type: "OPEN_CHROME_PAGE", page: "settings" } },
    { title: "Copy current URL", subtitle: "Copy this tab's address to the clipboard", icon: "⧉", keywords: "clipboard link address", action: { type: "COPY_CURRENT_URL" } },
    { title: "Reset learned tab ranking", subtitle: "Clear Quick Palette tab preferences", icon: "↺", keywords: "clear smart sorting preferences", action: { type: "REQUEST_RESET_TAB_RANKING" } }
  ];

  let host;
  let shadow;
  let input;
  let resultsElement;
  let footerHint;
  let isOpen = false;
  let results = [];
  let totalTabCount = 0;
  let selectedIndex = 0;
  let requestSequence = 0;
  let hoverSelectionEnabled = true;
  let resetConfirmation = false;
  let browseMode = null;
  let scopeChip;
  const markedUrls = new Set();
  const suppressedKeys = new Set();
  const DEFAULT_PLACEHOLDER = "Search tabs, history, or the web";

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "TOGGLE_PALETTE") toggle();
    if (message?.type === "SHOW_COPY_FEEDBACK") showCopyFeedback(message.success);
  });
  window.addEventListener("keydown", onGlobalKeyDown, true);
  window.addEventListener("keypress", suppressHandledKeyEvent, true);
  window.addEventListener("keyup", suppressHandledKeyEvent, true);
  document.addEventListener("focusin", keepPaletteFocus, true);

  function mount() {
    host = document.createElement("div");
    host.id = "quick-palette-root";
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial; color-scheme: dark;
          --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
          --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        *, *::before, *::after { box-sizing: border-box; }
        .backdrop {
          position: fixed; inset: 0; z-index: 2147483647;
          display: grid; place-items: start center;
          padding: min(18vh, 150px) 20px 24px;
          background: rgba(8, 10, 13, .45);
          font-family: var(--sans);
          animation: fade-in 110ms ease-out;
        }
        .backdrop.standalone { background: #0c0e12; }
        .backdrop.standalone .results { max-height: min(calc(100vh - 240px), 430px); }
        .panel {
          width: min(660px, 100%); overflow: hidden;
          background: #15171c; color: #d8d6ce;
          border: 1px solid #2b2f37; border-radius: 6px;
          box-shadow: 0 24px 60px rgba(0, 0, 0, .55);
          transform-origin: 50% 0; animation: enter 130ms ease-out;
          font-variant-numeric: tabular-nums;
        }
        .search { display: flex; align-items: center; min-height: 46px; padding: 0 14px; gap: 10px; border-bottom: 1px solid #23262e; }
        .prompt { flex: 0 0 auto; color: #ffb454; font: 700 14px/1 var(--mono); }
        input { all: unset; min-width: 0; flex: 1; color: #e8e6df; font: 400 15px/1.4 var(--mono); caret-color: #ffb454; }
        input::placeholder { color: #58606e; opacity: 1; }
        .esc { flex: 0 0 auto; padding: 3px 5px; border: 1px solid #333a45; border-radius: 3px; background: #1c1f26; color: #8a92a0; font: 500 9.5px/1.2 var(--mono); }
        .scope { flex: 0 0 auto; padding: 2px 6px; border: 1px solid rgba(255, 180, 84, .4); border-radius: 3px; background: rgba(255, 180, 84, .08); color: #ffb454; font: 600 10px/1.4 var(--mono); text-transform: lowercase; }
        .scope[hidden] { display: none; }
        .results { max-height: min(52vh, 430px); overflow: auto; padding: 5px; scrollbar-width: thin; scrollbar-color: #333a45 transparent; }
        .section { padding: 9px 8px 5px; color: #667081; font: 600 10px/1.2 var(--mono); letter-spacing: .12em; text-transform: lowercase; }
        .item { width: 100%; height: 38px; display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 0 9px; border: 0; border-radius: 3px; background: transparent; color: inherit; text-align: left; cursor: default; font-family: var(--sans); }
        .item:hover { background: #1b1e24; }
        .item.selected { background: rgba(255, 180, 84, .09); box-shadow: inset 2px 0 0 #ffb454; }
        .icon { width: 20px; height: 20px; display: grid; place-items: center; overflow: hidden; color: #8a92a0; font: 600 11px/1 var(--mono); }
        .icon img { width: 16px; height: 16px; object-fit: contain; }
        .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e8e6df; font: 500 13px/1.4 var(--sans); }
        .item.selected .title { color: #ffcf8d; }
        .tail { display: flex; align-items: center; gap: 8px; }
        .sub { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #667081; font: 400 10.5px/1.2 var(--mono); }
        .meta { color: #58606e; font: 400 10px/1.2 var(--mono); text-transform: lowercase; white-space: nowrap; }
        .key { padding: 2px 5px; border: 1px solid #333a45; border-bottom-width: 2px; border-radius: 3px; background: #1d2129; color: #9aa3b2; font: 500 10px/1.2 var(--mono); }
        .key-return { display: none; }
        .item.selected .key-num { display: none; }
        .item.selected .key-return { display: inline-block; }
        .close { width: 22px; height: 22px; display: none; border: 0; border-radius: 3px; background: transparent; color: #8a92a0; font: 15px/1 var(--sans); cursor: pointer; }
        .item.closeable:hover .key { display: none; }
        .item.closeable:hover .close { display: grid; place-items: center; }
        .close:hover { background: #262b33; color: #e8e6df; }
        .item.marked .icon { color: #ffb454; font-weight: 700; }
        .empty { padding: 40px 20px; color: #667081; text-align: center; font: 400 11.5px/1.6 var(--mono); }
        .footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-top: 1px solid #23262e; color: #667081; font: 400 10.5px/1.4 var(--mono); }
        .footer b { color: #9aa3b2; font-weight: 500; }
        @keyframes fade-in { from { opacity: 0; } }
        @keyframes enter { from { opacity: 0; transform: translateY(-6px) scale(.995); } }
        @media (max-width: 540px) {
          .backdrop { padding: 10px; }
          .panel { width: 100%; }
          .results { max-height: calc(100vh - 128px); }
          .sub, .meta { display: none; }
        }
        @media (prefers-reduced-motion: reduce) { .backdrop, .panel { animation: none; } }
      </style>
      <div class="backdrop${isStandalone ? " standalone" : ""}" role="presentation">
        <section class="panel" role="dialog" aria-modal="true" aria-label="Quick Palette">
          <div class="search">
            <span class="prompt" aria-hidden="true">❯</span>
            <span class="scope" hidden></span>
            <input type="text" role="combobox" aria-expanded="true" aria-controls="quick-palette-results" aria-autocomplete="list" placeholder="Search tabs, history, or the web" autocomplete="off" spellcheck="false">
            <span class="esc">esc</span>
          </div>
          <div id="quick-palette-results" class="results" role="listbox"></div>
          <div class="footer"><span class="footer-hint">Type to search</span><span><b>↑↓</b> move · <b>⇥</b> mark · <b>${jumpKeyLabel}n</b> jump · <b>↵</b> open</span></div>
        </section>
      </div>`;
    input = shadow.querySelector("input");
    scopeChip = shadow.querySelector(".scope");
    resultsElement = shadow.querySelector(".results");
    footerHint = shadow.querySelector(".footer-hint");
    resultsElement.addEventListener("mousemove", (event) => {
      // Chrome fires a synthetic mouse event (movementX/Y of 0) when the list
      // scrolls under a stationary cursor; only genuine movement may re-enable
      // hover selection, or scrolling by keyboard gets hijacked by the cursor.
      if (hoverSelectionEnabled || (event.movementX === 0 && event.movementY === 0)) return;
      hoverSelectionEnabled = true;
      const item = event.target.closest?.(".item");
      if (item) {
        const index = Array.from(shadow.querySelectorAll(".item")).indexOf(item);
        if (index >= 0) select(index, false);
      }
    });
    shadow.querySelector(".backdrop").addEventListener("mousedown", (event) => {
      if (event.target.classList.contains("backdrop")) close();
    });
    const scheduleRefresh = debounce(refresh, 70);
    input.addEventListener("input", (event) => {
      event.stopPropagation();
      resetConfirmation = false;
      selectedIndex = 0;
      scheduleRefresh();
    });
    document.documentElement.appendChild(host);
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  function open() {
    if (!host) mount();
    isOpen = true;
    host.style.display = "block";
    input.value = "";
    selectedIndex = 0;
    resetConfirmation = false;
    hoverSelectionEnabled = false;
    markedUrls.clear();
    browseMode = null;
    scopeChip.hidden = true;
    input.placeholder = DEFAULT_PLACEHOLDER;
    refresh();
    requestAnimationFrame(() => input.focus());
  }

  function setBrowseMode(mode) {
    browseMode = mode;
    scopeChip.hidden = !mode;
    scopeChip.textContent = mode || "";
    input.placeholder = mode === "history"
      ? "Search history"
      : mode === "bookmarks" ? "Search bookmarks" : DEFAULT_PLACEHOLDER;
    input.value = "";
    selectedIndex = 0;
    refresh();
    input.focus({ preventScroll: true });
  }

  function close() {
    if (!host) return;
    isOpen = false;
    requestSequence += 1;
    host.style.display = "none";
    if (isStandalone) window.close();
  }

  async function refresh() {
    const query = input.value.trim();
    const sequence = ++requestSequence;
    const contextTabId = getContextTabId();
    const response = await chrome.runtime.sendMessage({
      type: "GET_PALETTE_DATA",
      query,
      contextTabId,
      mode: browseMode || undefined
    }).catch(() => null);
    if (!isOpen || sequence !== requestSequence || !response?.ok) return;
    totalTabCount = response.tabs.length;
    results = buildResults(query, response);
    selectedIndex = Math.min(selectedIndex, Math.max(0, results.length - 1));
    render();
  }

  function buildResults(query, data) {
    if (browseMode === "history") {
      const items = data.history.slice(0, 59).map((historyItem) => ({
        title: historyItem.title,
        subtitle: displayUrl(historyItem.url),
        url: historyItem.url,
        icon: "↶",
        kind: "History",
        meta: relativeTime(historyItem.lastVisitTime),
        action: { type: "OPEN_URL", url: historyItem.url }
      }));
      items.push({
        title: "Open Chrome history page",
        subtitle: "chrome://history",
        icon: "↗",
        kind: "More",
        action: { type: "OPEN_CHROME_PAGE", page: "history" }
      });
      return items;
    }

    if (browseMode === "bookmarks") {
      const items = data.bookmarks.slice(0, 59).map((bookmark) => ({
        title: bookmark.title,
        subtitle: displayUrl(bookmark.url),
        url: bookmark.url,
        icon: "★",
        kind: "Bookmarks",
        meta: bookmark.dateAdded ? relativeTime(bookmark.dateAdded) : "",
        action: { type: "OPEN_URL", url: bookmark.url }
      }));
      items.push({
        title: "Open bookmark manager",
        subtitle: "chrome://bookmarks",
        icon: "↗",
        kind: "More",
        action: { type: "OPEN_CHROME_PAGE", page: "bookmarks" }
      });
      return items;
    }

    const items = [];
    const seenUrls = new Set();
    const normalized = normalize(query);

    const matchingCommands = COMMANDS
      .map((command) => ({ ...command, kind: "Commands", score: fuzzyScore(normalized, `${command.title} ${command.keywords}`) }))
      .filter((command) => !normalized || command.score > 0)
      .sort((a, b) => b.score - a.score);

    const matchingTabs = QuickPaletteRanking
      .rankTabs(data.tabs, query, {
        currentTabId: data.currentTabId,
        currentWindowId: data.currentWindowId
      })
      .slice(0, normalized ? 25 : 12)
      .map((tab) => ({
        title: tab.title,
        subtitle: displayUrl(tab.url),
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        kind: "Open tabs",
        meta: tab.id === data.currentTabId ? "current" : (tab.windowId === data.currentWindowId ? "" : "other window"),
        closeable: true,
        tabId: tab.id,
        action: { type: "ACTIVATE_TAB", tabId: tab.id, windowId: tab.windowId },
        relevance: tab.relevance
      }));

    const suggestedTab = normalized
      ? matchingTabs.find((tab) => tab.tabId !== data.currentTabId && tab.relevance >= 0.78)
      : undefined;

    if (query) {
      const goResult = {
        title: looksLikeUrl(query) ? `Open ${query}` : `Search for “${query}”`,
        subtitle: looksLikeUrl(query) ? "open in new tab" : "web search",
        icon: looksLikeUrl(query) ? "↗" : "⌕",
        kind: suggestedTab ? "Suggested" : "Go",
        action: looksLikeUrl(query)
          ? { type: "OPEN_URL", url: toUrl(query) }
          : { type: "SEARCH_WEB", query }
      };

      if (suggestedTab) {
        items.push({ ...suggestedTab, kind: "Suggested" }, goResult);
      } else {
        items.push(goResult);
      }
    }

    for (const tab of matchingTabs) {
      if (tab === suggestedTab) continue;
      items.push(tab);
      seenUrls.add(tab.url);
    }
    if (suggestedTab) seenUrls.add(suggestedTab.url);

    for (const bookmark of data.bookmarks.slice(0, 10)) {
      if (seenUrls.has(bookmark.url)) continue;
      seenUrls.add(bookmark.url);
      items.push({
        title: bookmark.title,
        subtitle: displayUrl(bookmark.url),
        url: bookmark.url,
        icon: "★",
        kind: "Bookmarks",
        action: { type: "OPEN_URL", url: bookmark.url }
      });
    }

    for (const historyItem of data.history.slice(0, 16)) {
      if (seenUrls.has(historyItem.url)) continue;
      seenUrls.add(historyItem.url);
      items.push({
        title: historyItem.title,
        subtitle: displayUrl(historyItem.url),
        url: historyItem.url,
        icon: "↶",
        kind: "History",
        meta: relativeTime(historyItem.lastVisitTime),
        action: { type: "OPEN_URL", url: historyItem.url }
      });
    }

    items.push(...matchingCommands);

    return items.slice(0, 60);
  }

  function render() {
    const resultsLabel = `${results.length} ${results.length === 1 ? "result" : "results"}`;
    const tabsLabel = `${totalTabCount} ${totalTabCount === 1 ? "tab" : "tabs"} indexed`;
    const markedLabel = markedUrls.size ? ` · ${markedUrls.size} marked` : "";
    footerHint.textContent = browseMode
      ? `${resultsLabel}${markedLabel} · ⌫ back`
      : `${resultsLabel} · ${tabsLabel}${markedLabel}`;
    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No matching tabs, history, or commands";
      resultsElement.replaceChildren(empty);
      return;
    }

    const sectionCounts = {};
    for (const result of results) {
      sectionCounts[result.kind] = (sectionCounts[result.kind] || 0) + 1;
    }

    const fragment = document.createDocumentFragment();
    let previousKind = "";
    results.forEach((result, index) => {
      if (result.kind !== previousKind) {
        const section = document.createElement("div");
        section.className = "section";
        const count = sectionCounts[result.kind];
        section.textContent = count > 1 ? `${result.kind} · ${count}` : result.kind;
        fragment.appendChild(section);
        previousKind = result.kind;
      }

      const marked = isMarkable(result) && markedUrls.has(result.url);
      const button = document.createElement("div");
      button.className = `item${index === selectedIndex ? " selected" : ""}${result.closeable ? " closeable" : ""}${marked ? " marked" : ""}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === selectedIndex));
      button.addEventListener("mouseenter", () => {
        if (hoverSelectionEnabled) select(index, false);
      });
      button.addEventListener("click", () => execute(index));

      const icon = document.createElement("span");
      icon.className = "icon";
      if (marked) {
        icon.textContent = "✓";
      } else if (result.favIconUrl) {
        const image = document.createElement("img");
        image.src = result.favIconUrl;
        image.alt = "";
        image.addEventListener("error", () => { icon.textContent = fallbackLetter(result.title); });
        icon.appendChild(image);
      } else {
        icon.textContent = result.icon || fallbackLetter(result.title);
      }

      const title = document.createElement("span");
      title.className = "title";
      title.textContent = result.title;

      const tail = document.createElement("span");
      tail.className = "tail";
      if (result.subtitle) {
        const sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = result.subtitle;
        tail.appendChild(sub);
      }
      if (result.meta) {
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = result.meta;
        tail.appendChild(meta);
      }
      if (index < 9) {
        const jumpKey = document.createElement("span");
        jumpKey.className = "key key-num";
        jumpKey.textContent = `${jumpKeyLabel}${index + 1}`;
        const returnKey = document.createElement("span");
        returnKey.className = "key key-return";
        returnKey.textContent = "↵";
        tail.append(jumpKey, returnKey);
      }
      if (result.closeable) {
        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.className = "close";
        closeButton.title = "Close tab";
        closeButton.setAttribute("aria-label", `Close ${result.title}`);
        closeButton.textContent = "×";
        closeButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          await chrome.runtime.sendMessage({ type: "CLOSE_TAB", tabId: result.tabId });
          refresh();
        });
        tail.appendChild(closeButton);
      }

      button.append(icon, title, tail);
      fragment.appendChild(button);
    });
    resultsElement.replaceChildren(fragment);
    selectedItem()?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (resetConfirmation) {
        resetConfirmation = false;
        refresh();
      } else if (markedUrls.size) {
        markedUrls.clear();
        render();
      } else if (browseMode) {
        setBrowseMode(null);
      } else {
        close();
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      hoverSelectionEnabled = false;
      select((selectedIndex + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      hoverSelectionEnabled = false;
      select((selectedIndex - 1 + results.length) % results.length);
    } else if (event.key === "Tab") {
      event.preventDefault();
      if (!results.length) return;
      const current = results[selectedIndex];
      if (isMarkable(current)) {
        if (markedUrls.has(current.url)) markedUrls.delete(current.url);
        else markedUrls.add(current.url);
      }
      hoverSelectionEnabled = false;
      selectedIndex = event.shiftKey
        ? (selectedIndex - 1 + results.length) % results.length
        : (selectedIndex + 1) % results.length;
      render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (markedUrls.size) openMarked();
      else execute(selectedIndex);
    }
  }

  function isMarkable(result) {
    return Boolean(result && result.action.type === "OPEN_URL" && result.url);
  }

  async function openMarked() {
    const urls = [...markedUrls];
    close();
    await chrome.runtime.sendMessage({ type: "OPEN_URLS", urls }).catch(() => null);
  }

  function onGlobalKeyDown(event) {
    if (!isOpen || event.isComposing) return;

    if (["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
      suppressedKeys.add(keyIdentifier(event));
      event.stopImmediatePropagation();
      onKeyDown(event);
      return;
    }

    const jumpModifier = isMac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (jumpModifier && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
      suppressedKeys.add(keyIdentifier(event));
      event.preventDefault();
      event.stopImmediatePropagation();
      const jumpIndex = Number(event.key) - 1;
      if (jumpIndex < results.length) execute(jumpIndex);
      return;
    }

    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "j" || event.key === "k")) {
      suppressedKeys.add(keyIdentifier(event));
      event.preventDefault();
      event.stopImmediatePropagation();
      hoverSelectionEnabled = false;
      const step = event.key === "j" ? 1 : -1;
      select((selectedIndex + step + results.length) % results.length);
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key.length === 1) {
      suppressedKeys.add(keyIdentifier(event));
      event.preventDefault();
      event.stopImmediatePropagation();
      replaceInputSelection(event.key);
    } else if (event.key === "Backspace" || event.key === "Delete") {
      suppressedKeys.add(keyIdentifier(event));
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Backspace" && browseMode && !input.value) {
        setBrowseMode(null);
      } else {
        deleteFromInput(event.key === "Backspace" ? -1 : 1);
      }
    }
  }

  function suppressHandledKeyEvent(event) {
    const identifier = keyIdentifier(event);
    if (!suppressedKeys.has(identifier)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "keyup") suppressedKeys.delete(identifier);
  }

  function keepPaletteFocus() {
    if (!isOpen || !host || document.activeElement === host) return;
    queueMicrotask(() => {
      if (isOpen) input.focus({ preventScroll: true });
    });
  }

  function keyIdentifier(event) {
    return event.code || event.key;
  }

  function replaceInputSelection(text) {
    input.focus({ preventScroll: true });
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(text, start, end, "end");
    input.dispatchEvent(new Event("input"));
  }

  function deleteFromInput(direction) {
    input.focus({ preventScroll: true });
    let start = input.selectionStart ?? input.value.length;
    let end = input.selectionEnd ?? start;

    if (start === end && direction < 0 && start > 0) {
      const previousCharacter = Array.from(input.value.slice(0, start)).at(-1);
      start -= previousCharacter?.length || 1;
    } else if (start === end && direction > 0 && end < input.value.length) {
      const nextCharacter = Array.from(input.value.slice(end))[0];
      end += nextCharacter?.length || 1;
    }

    if (start !== end) {
      input.setRangeText("", start, end, "end");
      input.dispatchEvent(new Event("input"));
    }
  }

  function select(index, scroll = true) {
    if (!results.length) return;
    selectedIndex = index;
    shadow.querySelectorAll(".item").forEach((item, itemIndex) => {
      item.classList.toggle("selected", itemIndex === selectedIndex);
      item.setAttribute("aria-selected", String(itemIndex === selectedIndex));
    });
    if (scroll) selectedItem()?.scrollIntoView({ block: "nearest" });
  }

  async function execute(index) {
    const result = results[index];
    if (!result) return;
    if (result.action.type === "BROWSE") {
      setBrowseMode(result.action.mode);
      return;
    }
    if (result.action.type === "REQUEST_RESET_TAB_RANKING") {
      showResetConfirmation();
      return;
    }
    if (result.action.type === "RESET_TAB_RANKING") {
      await chrome.runtime.sendMessage(result.action).catch(() => null);
      resetConfirmation = false;
      input.value = "";
      selectedIndex = 0;
      await refresh();
      return;
    }
    if (result.action.type === "COPY_CURRENT_URL") {
      close();
      const response = await chrome.runtime.sendMessage({
        ...result.action,
        tabId: getContextTabId()
      }).catch(() => null);
      if (!response?.ok) showCopyFeedback(false);
      return;
    }
    close();
    await chrome.runtime.sendMessage(result.action).catch(() => null);
  }

  function showResetConfirmation() {
    resetConfirmation = true;
    selectedIndex = 0;
    results = [{
      title: "Reset learned tab ranking?",
      subtitle: "press ↵ again to confirm",
      icon: "↺",
      kind: "Confirm",
      action: { type: "RESET_TAB_RANKING" }
    }];
    render();
  }

  function getContextTabId() {
    return isStandalone
      ? Number(new URLSearchParams(location.search).get("tabId")) || undefined
      : undefined;
  }

  function showCopyFeedback(success = true) {
    document.getElementById("quick-palette-copy-toast")?.remove();
    const toastHost = document.createElement("div");
    toastHost.id = "quick-palette-copy-toast";
    const toastShadow = toastHost.attachShadow({ mode: "closed" });
    toastShadow.innerHTML = `
      <style>
        :host { all: initial; }
        div {
          position: fixed; top: 18px; right: 18px; z-index: 2147483647;
          padding: 8px 12px; border: 1px solid #2b2f37; border-left: 2px solid #ffb454; border-radius: 4px;
          background: #15171c; color: #d8d6ce;
          box-shadow: 0 8px 30px rgba(0, 0, 0, .4);
          font: 500 11px/1.2 ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
          letter-spacing: 0; animation: toast-in 120ms ease-out;
        }
        div.error { border-left-color: #e5534b; color: #f0b8b3; }
        @keyframes toast-in { from { opacity: 0; transform: translateY(-4px); } }
        @media (prefers-reduced-motion: reduce) { div { animation: none; } }
      </style>
      <div class="${success ? "" : "error"}" role="status">${success ? "URL copied" : "Could not copy URL"}</div>`;
    document.documentElement.appendChild(toastHost);
    setTimeout(() => toastHost.remove(), 1600);
  }

  function selectedItem() {
    return shadow.querySelectorAll(".item")[selectedIndex];
  }

  function fuzzyScore(query, text) {
    if (!query) return 1;
    const candidate = normalize(text);
    const directIndex = candidate.indexOf(query);
    if (directIndex >= 0) return 1000 - directIndex * 2 - candidate.length * 0.01;
    let queryIndex = 0;
    let score = 0;
    let streak = 0;
    for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
      if (candidate[index] === query[queryIndex]) {
        streak += 1;
        score += 4 + streak * 3;
        queryIndex += 1;
      } else {
        streak = 0;
      }
    }
    return queryIndex === query.length ? score : 0;
  }

  function normalize(value) {
    return value.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  }

  function displayUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    } catch {
      return url;
    }
  }

  function looksLikeUrl(value) {
    return /^(https?:\/\/|localhost(?::\d+)?(?:\/|$)|[^\s]+\.[a-z]{2,}(?:[/:?#]|$))/i.test(value.trim());
  }

  function toUrl(value) {
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }

  function relativeTime(timestamp) {
    if (!timestamp) return "";
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    if (minutes < 1) return "Now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days < 30 ? `${days}d ago` : "Earlier";
  }

  function fallbackLetter(title) {
    return (title.trim()[0] || "•").toLocaleUpperCase();
  }

  function debounce(callback, wait) {
    let timeout;
    return () => {
      clearTimeout(timeout);
      timeout = setTimeout(callback, wait);
    };
  }

  if (isStandalone) open();
})();
