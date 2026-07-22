(() => {
  if (window.__quickPaletteLoaded) return;
  window.__quickPaletteLoaded = true;
  const isStandalone = location.protocol === "chrome-extension:";

  const COMMANDS = [
    { title: "New tab", subtitle: "Open a blank tab", icon: "+", keywords: "create open", action: { type: "NEW_TAB" } },
    { title: "New window", subtitle: "Open a browser window", icon: "□", keywords: "create open", action: { type: "NEW_WINDOW" } },
    { title: "New incognito window", subtitle: "Open a private browser window", icon: "◐", keywords: "private create", action: { type: "NEW_INCOGNITO_WINDOW" } },
    { title: "History", subtitle: "Open Chrome history", icon: "↶", keywords: "recent visited", action: { type: "OPEN_CHROME_PAGE", page: "history" } },
    { title: "Downloads", subtitle: "Open Chrome downloads", icon: "↓", keywords: "files", action: { type: "OPEN_CHROME_PAGE", page: "downloads" } },
    { title: "Bookmarks", subtitle: "Open bookmark manager", icon: "★", keywords: "saved favorites", action: { type: "OPEN_CHROME_PAGE", page: "bookmarks" } },
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
  let selectedIndex = 0;
  let requestSequence = 0;
  let resetConfirmation = false;
  const suppressedKeys = new Set();

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
        :host { all: initial; color-scheme: light dark; }
        *, *::before, *::after { box-sizing: border-box; }
        .backdrop {
          position: fixed; inset: 0; z-index: 2147483647;
          display: grid; place-items: start center;
          padding: min(18vh, 150px) 20px 24px;
          background: rgba(14, 16, 20, .32);
          font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          animation: fade-in 110ms ease-out;
        }
        .backdrop.standalone { padding: 12px; background: #18191b; }
        .backdrop.standalone .panel { width: 100%; }
        .backdrop.standalone .results { max-height: calc(100vh - 124px); }
        .panel {
          width: min(680px, 100%); overflow: hidden;
          background: rgba(250, 250, 249, .98); color: #191918;
          border: 1px solid rgba(20, 20, 18, .14); border-radius: 8px;
          box-shadow: 0 24px 70px rgba(0, 0, 0, .28), 0 2px 8px rgba(0, 0, 0, .12);
          transform-origin: 50% 0; animation: enter 130ms ease-out;
        }
        .search { display: flex; align-items: center; min-height: 62px; padding: 0 18px; border-bottom: 1px solid #dededb; }
        .search-mark { flex: 0 0 auto; width: 20px; height: 20px; margin-right: 13px; border: 2px solid #777772; border-radius: 50%; position: relative; }
        .search-mark::after { content: ""; position: absolute; width: 7px; height: 2px; right: -5px; bottom: -2px; background: #777772; transform: rotate(45deg); border-radius: 2px; }
        input { all: unset; min-width: 0; flex: 1; color: #191918; font: 500 18px/1.4 inherit; letter-spacing: 0; caret-color: #2968d8; }
        input::placeholder { color: #8b8b86; opacity: 1; }
        .key { flex: 0 0 auto; margin-left: 12px; padding: 3px 6px; border: 1px solid #d2d2ce; border-bottom-color: #bdbdb8; border-radius: 4px; background: #f0f0ed; color: #777772; font: 600 11px/1.2 inherit; }
        .results { max-height: min(52vh, 430px); overflow: auto; padding: 7px; scrollbar-width: thin; }
        .section { padding: 8px 10px 5px; color: #777772; font: 700 10px/1.2 inherit; letter-spacing: .08em; text-transform: uppercase; }
        .item { width: 100%; height: 52px; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 11px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: inherit; text-align: left; cursor: default; font-family: inherit; }
        .item.selected { background: #e5e7e9; }
        .item:hover { background: #ebedee; }
        .icon { width: 28px; height: 28px; display: grid; place-items: center; overflow: hidden; border: 1px solid #d5d5d1; border-radius: 5px; background: #fff; color: #555550; font: 600 16px/1 inherit; }
        .icon img { width: 18px; height: 18px; object-fit: contain; }
        .copy { min-width: 0; }
        .title, .subtitle { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: 0; }
        .title { color: #20201e; font: 600 14px/1.35 inherit; }
        .subtitle { margin-top: 2px; color: #777772; font: 400 12px/1.3 inherit; }
        .tail { min-width: 76px; display: grid; place-items: center end; margin-left: 12px; }
        .meta { grid-area: 1 / 1; color: #82827d; font: 500 11px/1.2 inherit; white-space: nowrap; }
        .close { width: 26px; height: 26px; display: none; border: 0; border-radius: 4px; background: transparent; color: #656560; font: 18px/1 inherit; cursor: pointer; }
        .item:hover .close, .item.selected .close { display: grid; grid-area: 1 / 1; place-items: center; }
        .item:hover .tail .meta, .item.selected .tail .meta { visibility: hidden; }
        .close:hover { background: #d3d5d7; color: #20201e; }
        .empty { padding: 44px 20px; color: #777772; text-align: center; font: 500 13px/1.5 inherit; }
        .footer { height: 36px; display: flex; align-items: center; justify-content: space-between; padding: 0 14px; border-top: 1px solid #dededb; color: #777772; font: 500 10px/1 inherit; }
        .footer span { display: flex; align-items: center; gap: 8px; }
        .footer b { color: #4f4f4b; font-weight: 650; }
        @keyframes fade-in { from { opacity: 0; } }
        @keyframes enter { from { opacity: 0; transform: translateY(-7px) scale(.99); } }
        @media (prefers-color-scheme: dark) {
          .backdrop { background: rgba(0, 0, 0, .5); }
          .panel { background: rgba(35, 36, 37, .98); color: #f0f0ed; border-color: #4d4e50; box-shadow: 0 24px 80px rgba(0, 0, 0, .55); }
          .search, .footer { border-color: #4a4b4d; }
          input { color: #f5f5f1; caret-color: #72a2f5; }
          input::placeholder, .section, .subtitle, .meta, .footer { color: #9d9e9f; }
          .key { background: #303133; color: #a9aaab; border-color: #555658; }
          .item.selected { background: #484a4d; }
          .item:hover { background: #424447; }
          .title { color: #f2f2ef; }
          .icon { background: #2d2e30; color: #d7d7d3; border-color: #555658; }
          .close { color: #bebfbe; }
          .close:hover { background: #5b5d60; color: #fff; }
          .footer b { color: #d0d0cc; }
        }
        @media (max-width: 540px) {
          .backdrop { padding: 10px; }
          .panel { width: 100%; }
          .results { max-height: calc(100vh - 130px); }
          .meta { display: none; }
        }
        @media (prefers-reduced-motion: reduce) { .backdrop, .panel { animation: none; } }
      </style>
      <div class="backdrop${isStandalone ? " standalone" : ""}" role="presentation">
        <section class="panel" role="dialog" aria-modal="true" aria-label="Quick Palette">
          <div class="search">
            <span class="search-mark" aria-hidden="true"></span>
            <input type="text" role="combobox" aria-expanded="true" aria-controls="quick-palette-results" aria-autocomplete="list" placeholder="Search tabs, history, or the web" autocomplete="off" spellcheck="false">
            <span class="key">ESC</span>
          </div>
          <div id="quick-palette-results" class="results" role="listbox"></div>
          <div class="footer"><span class="footer-hint">Type to search</span><span><b>↑↓</b> Navigate <b>↵</b> Open</span></div>
        </section>
      </div>`;
    input = shadow.querySelector("input");
    resultsElement = shadow.querySelector(".results");
    footerHint = shadow.querySelector(".footer-hint");
    shadow.querySelector(".backdrop").addEventListener("mousedown", (event) => {
      if (event.target.classList.contains("backdrop")) close();
    });
    const scheduleRefresh = debounce(refresh, 70);
    input.addEventListener("input", (event) => {
      event.stopPropagation();
      resetConfirmation = false;
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
    refresh();
    requestAnimationFrame(() => input.focus());
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
      contextTabId
    }).catch(() => null);
    if (!isOpen || sequence !== requestSequence || !response?.ok) return;
    results = buildResults(query, response);
    selectedIndex = Math.min(selectedIndex, Math.max(0, results.length - 1));
    render();
  }

  function buildResults(query, data) {
    const items = [];
    const seenUrls = new Set();
    const normalized = normalize(query);

    const matchingCommands = COMMANDS
      .map((command) => ({ ...command, kind: "Command", score: fuzzyScore(normalized, `${command.title} ${command.keywords}`) }))
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
        meta: tab.id === data.currentTabId ? "Current tab" : (tab.windowId === data.currentWindowId ? "This window" : "Other window"),
        closeable: true,
        tabId: tab.id,
        action: { type: "ACTIVATE_TAB", tabId: tab.id, windowId: tab.windowId },
        relevance: tab.relevance,
        score: tab.rankScore
      }));

    const suggestedTab = normalized
      ? matchingTabs.find((tab) => tab.tabId !== data.currentTabId && tab.relevance >= 0.78)
      : undefined;

    if (query) {
      const goResult = {
        title: looksLikeUrl(query) ? `Open ${query}` : `Search for “${query}”`,
        subtitle: looksLikeUrl(query) ? "Open in a new tab" : "Search with your default search engine",
        icon: looksLikeUrl(query) ? "↗" : "⌕",
        kind: suggestedTab ? "Suggested" : "Go",
        action: looksLikeUrl(query)
          ? { type: "OPEN_URL", url: toUrl(query) }
          : { type: "SEARCH_WEB", query },
        score: Number.MAX_SAFE_INTEGER
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
        action: { type: "OPEN_URL", url: bookmark.url },
        score: fuzzyScore(normalized, `${bookmark.title} ${bookmark.url}`)
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
        action: { type: "OPEN_URL", url: historyItem.url },
        score: fuzzyScore(normalized, `${historyItem.title} ${historyItem.url}`)
      });
    }

    items.push(...matchingCommands);

    return items.slice(0, 60);
  }

  function render() {
    resultsElement.replaceChildren();
    footerHint.textContent = `${results.length} ${results.length === 1 ? "result" : "results"}`;
    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No matching tabs, history, or commands";
      resultsElement.appendChild(empty);
      return;
    }

    let previousKind = "";
    results.forEach((result, index) => {
      if (result.kind !== previousKind) {
        const section = document.createElement("div");
        section.className = "section";
        section.textContent = result.kind;
        resultsElement.appendChild(section);
        previousKind = result.kind;
      }

      const button = document.createElement("div");
      button.className = `item${index === selectedIndex ? " selected" : ""}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === selectedIndex));
      button.addEventListener("mouseenter", () => select(index, false));
      button.addEventListener("click", () => execute(index));

      const icon = document.createElement("span");
      icon.className = "icon";
      if (result.favIconUrl) {
        const image = document.createElement("img");
        image.src = result.favIconUrl;
        image.alt = "";
        image.addEventListener("error", () => { icon.textContent = fallbackLetter(result.title); });
        icon.appendChild(image);
      } else {
        icon.textContent = result.icon || fallbackLetter(result.title);
      }

      const copy = document.createElement("span");
      copy.className = "copy";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = result.title;
      const subtitle = document.createElement("span");
      subtitle.className = "subtitle";
      subtitle.textContent = result.subtitle || "";
      copy.append(title, subtitle);
      button.append(icon, copy);

      if (result.closeable || result.meta) {
        const tail = document.createElement("span");
        tail.className = "tail";
        if (result.meta) {
          const meta = document.createElement("span");
          meta.className = "meta";
          meta.textContent = result.meta;
          tail.appendChild(meta);
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
        button.appendChild(tail);
      }

      resultsElement.appendChild(button);
    });
    selectedItem()?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (resetConfirmation) {
        resetConfirmation = false;
        refresh();
      } else {
        close();
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      select((selectedIndex + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      select((selectedIndex - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      execute(selectedIndex);
    }
  }

  function onGlobalKeyDown(event) {
    if (!isOpen || event.isComposing) return;

    if (["Escape", "ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
      suppressedKeys.add(keyIdentifier(event));
      event.stopImmediatePropagation();
      onKeyDown(event);
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
      deleteFromInput(event.key === "Backspace" ? -1 : 1);
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
      subtitle: "Press Enter again to clear saved tab preferences",
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
          padding: 9px 12px; border: 1px solid rgba(20, 20, 18, .18); border-radius: 6px;
          background: #202124; color: #f5f5f2;
          box-shadow: 0 8px 30px rgba(0, 0, 0, .28);
          font: 600 12px/1.2 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0; animation: toast-in 120ms ease-out;
        }
        div.error { background: #9f2f2f; }
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
