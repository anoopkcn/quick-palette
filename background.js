importScripts("ranking.js");

const CHROME_PAGES = {
  bookmarks: "chrome://bookmarks/",
  downloads: "chrome://downloads/",
  extensions: "chrome://extensions/",
  history: "chrome://history/",
  settings: "chrome://settings/"
};
const USAGE_STORAGE_KEY = "tabRankingUsage";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const EXTENSION_ORIGIN = chrome.runtime.getURL("");
let usageStatsCache;
let usageWriteQueue = Promise.resolve();
let offscreenCreation;
let clipboardQueue = Promise.resolve();

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-command-palette") {
    togglePalette().catch((error) => console.warn("Quick Palette:", error.message));
  } else if (command === "copy-current-url") {
    copyCurrentUrl(tab)
      .then(() => showCopyBadge(true))
      .catch(() => showCopyBadge(false));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function togglePalette() {
  const popups = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
  if (popups.length) {
    await chrome.runtime.sendMessage({ type: "CLOSE_PALETTE" }).catch(() => undefined);
    return;
  }
  // Rejects when no browser window is focused or the popup is disallowed
  // (e.g. incognito without access); there is nowhere to show the palette then.
  await chrome.action.openPopup();
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_PALETTE_DATA": {
      // The popup has no sender.tab; while it is open its host window is the
      // last-focused window, so this resolves to the tab underneath it.
      const contextTab = sender.tab
        ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      return getPaletteData(message.query || "", contextTab, message.mode);
    }
    case "ACTIVATE_TAB": {
      const selectedTab = await chrome.tabs.get(message.tabId);
      await chrome.tabs.update(message.tabId, { active: true });
      if (message.windowId) {
        await chrome.windows.update(message.windowId, { focused: true });
      }
      await learnFromSelection(selectedTab);
      return {};
    }
    case "CLOSE_TAB":
      await chrome.tabs.remove(message.tabId);
      return {};
    case "OPEN_URL":
      await chrome.tabs.create({ url: message.url });
      return {};
    case "OPEN_URLS": {
      const urls = Array.isArray(message.urls)
        ? message.urls.filter((url) => typeof url === "string" && url)
        : [];
      if (!urls.length) throw new Error("No URLs to open");
      for (const url of urls) {
        await chrome.tabs.create({ url, active: false });
      }
      return {};
    }
    case "OPEN_CHROME_PAGE":
      if (!CHROME_PAGES[message.page]) throw new Error("Unknown Chrome page");
      await chrome.tabs.create({ url: CHROME_PAGES[message.page] });
      return {};
    case "SEARCH_WEB":
      if (!message.query?.trim()) throw new Error("Search query is empty");
      await chrome.search.query({ text: message.query.trim(), disposition: "NEW_TAB" });
      return {};
    case "NEW_TAB":
      await chrome.tabs.create({});
      return {};
    case "NEW_WINDOW":
      await chrome.windows.create({});
      return {};
    case "NEW_INCOGNITO_WINDOW":
      await chrome.windows.create({ incognito: true });
      return {};
    case "RESET_TAB_RANKING":
      await resetLearnedRanking();
      return {};
    case "COPY_CURRENT_URL":
      return copyCurrentUrl(sender.tab);
    default:
      throw new Error("Unknown palette action");
  }
}

async function getPaletteData(query, senderTab, mode) {
  const normalizedQuery = query.trim();
  const base = {
    currentTabId: senderTab?.id,
    currentWindowId: senderTab?.windowId,
    tabs: [],
    history: [],
    bookmarks: []
  };

  if (mode === "history") {
    const history = await chrome.history.search({ text: normalizedQuery, maxResults: 100, startTime: 0 });
    return { ...base, history: mapHistoryItems(history) };
  }

  if (mode === "bookmarks") {
    const bookmarks = normalizedQuery
      ? await chrome.bookmarks.search(normalizedQuery)
      : await chrome.bookmarks.getRecent(100);
    return { ...base, bookmarks: mapBookmarkItems(bookmarks, 100) };
  }

  const tabsPromise = chrome.tabs.query({});
  const historyPromise = normalizedQuery.length >= 2
    ? chrome.history.search({ text: normalizedQuery, maxResults: 40, startTime: 0 })
    : Promise.resolve([]);
  const bookmarksPromise = normalizedQuery.length >= 2
    ? chrome.bookmarks.search(normalizedQuery)
    : Promise.resolve([]);
  const usagePromise = readUsageStats();

  const [tabs, history, bookmarks, usageStats] = await Promise.all([
    tabsPromise,
    historyPromise,
    bookmarksPromise,
    usagePromise
  ]);

  return {
    ...base,
    tabs: tabs
      .filter((tab) => tab.id && tab.url && !tab.url.startsWith(EXTENSION_ORIGIN))
      .map((tab) => ({
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title || "Untitled tab",
        url: tab.url,
        favIconUrl: tab.favIconUrl || "",
        active: Boolean(tab.active),
        incognito: Boolean(tab.incognito),
        pinned: Boolean(tab.pinned),
        lastAccessed: tab.lastAccessed || 0,
        preferenceScore: tab.incognito
          ? 0
          : QuickPaletteRanking.preferenceScore(usageStats, tab.url)
      })),
    history: mapHistoryItems(history),
    bookmarks: mapBookmarkItems(bookmarks, 40)
  };
}

function mapHistoryItems(items) {
  return items
    .filter((item) => item.url)
    .map((item) => ({
      id: item.id,
      title: item.title || item.url,
      url: item.url,
      lastVisitTime: item.lastVisitTime || 0
    }));
}

function mapBookmarkItems(items, limit) {
  return items
    .filter((item) => item.url)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      title: item.title || item.url,
      url: item.url,
      dateAdded: item.dateAdded || 0
    }));
}

async function readUsageStats() {
  // This worker is the only writer, so a sanitized in-memory copy stays valid
  // until learnFromSelection/resetLearnedRanking replace it.
  if (!usageStatsCache) {
    const stored = await chrome.storage.local.get(USAGE_STORAGE_KEY);
    usageStatsCache = QuickPaletteRanking.sanitizeUsageStats(stored[USAGE_STORAGE_KEY]);
  }
  return usageStatsCache;
}

function learnFromSelection(tab) {
  if (!tab?.url || tab.incognito || tab.url.startsWith(EXTENSION_ORIGIN)) {
    return Promise.resolve();
  }
  usageWriteQueue = usageWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const current = await readUsageStats();
      const updated = QuickPaletteRanking.recordSelection(current, tab.url);
      await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: updated });
      usageStatsCache = updated;
    });
  return usageWriteQueue;
}

function resetLearnedRanking() {
  usageWriteQueue = usageWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const cleared = QuickPaletteRanking.clearUsageStats();
      await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: cleared });
      usageStatsCache = cleared;
    });
  return usageWriteQueue;
}

async function copyCurrentUrl(sourceTab) {
  let tab = sourceTab;
  if (!tab?.url || tab.url.startsWith(EXTENSION_ORIGIN)) {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  if (!tab?.url || tab.url.startsWith(EXTENSION_ORIGIN)) {
    throw new Error("No browser tab URL is available to copy");
  }

  await writeClipboard(tab.url);
  return { copiedUrl: tab.url };
}

function showCopyBadge(success) {
  chrome.action.setBadgeBackgroundColor({ color: success ? "#3fb950" : "#e5534b" });
  chrome.action.setBadgeText({ text: success ? "✓" : "!" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
}

function writeClipboard(text) {
  clipboardQueue = clipboardQueue
    .catch(() => undefined)
    .then(async () => {
      await ensureOffscreenDocument();
      try {
        const response = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "WRITE_CLIPBOARD",
          text
        });
        if (!response?.ok) throw new Error(response?.error || "Clipboard write failed");
      } finally {
        await chrome.offscreen.closeDocument().catch(() => undefined);
      }
    });
  return clipboardQueue;
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (existing.length) return;

  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["CLIPBOARD"],
      justification: "Copy the active tab URL at the user's request"
    }).finally(() => { offscreenCreation = undefined; });
  }
  await offscreenCreation;
}
