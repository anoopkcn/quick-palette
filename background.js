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
let standaloneWindowId;
let usageStatsCache;
let usageWriteQueue = Promise.resolve();
let offscreenCreation;
let clipboardQueue = Promise.resolve();

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-command-palette") {
    togglePaletteInActiveTab().catch((error) => console.warn("Quick Palette:", error.message));
  } else if (command === "copy-current-url") {
    copyCurrentUrl(tab).catch((error) => notifyCopyResult(tab, false, error.message));
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    sendToggle(tab.id).catch((error) => console.warn("Quick Palette:", error.message));
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === standaloneWindowId) standaloneWindowId = undefined;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function togglePaletteInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) {
    await sendToggle(tab.id);
  }
}

async function sendToggle(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_PALETTE" });
    return;
  } catch {
    // The palette script is injected on demand (activeTab), so a tab the
    // palette has not been opened in yet has no listener.
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["ranking.js", "content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_PALETTE" });
  } catch {
    // Chrome pages and the Web Store reject injection, so use an extension window.
    await openStandalonePalette(tabId);
  }
}

async function openStandalonePalette(sourceTabId) {
  const paletteUrl = chrome.runtime.getURL(`palette.html?tabId=${sourceTabId}`);
  if (standaloneWindowId) {
    try {
      // Reload the palette page so it targets the new source tab instead of
      // whichever tab it was opened for previously.
      const [paletteTab] = await chrome.tabs.query({ windowId: standaloneWindowId });
      if (paletteTab?.id) await chrome.tabs.update(paletteTab.id, { url: paletteUrl });
      await chrome.windows.update(standaloneWindowId, { focused: true });
      return;
    } catch {
      standaloneWindowId = undefined;
    }
  }

  const parent = await chrome.windows.getLastFocused().catch(() => null);
  const width = 720;
  const height = 560;
  const left = parent?.left == null || parent?.width == null
    ? undefined
    : Math.round(parent.left + Math.max(0, (parent.width - width) / 2));
  const top = parent?.top == null || parent?.height == null
    ? undefined
    : Math.round(parent.top + Math.max(0, (parent.height - height) / 3));
  let created;
  try {
    created = await chrome.windows.create({
      url: paletteUrl,
      type: "popup",
      focused: true,
      width,
      height,
      left,
      top
    });
  } catch {
    // Wayland compositors don't report real window positions, so the computed
    // bounds can land off-screen and Chrome rejects them. Let it place the window.
    created = await chrome.windows.create({
      url: paletteUrl,
      type: "popup",
      focused: true,
      width,
      height
    });
  }
  standaloneWindowId = created.id;
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_PALETTE_DATA": {
      const contextTab = message.contextTabId
        ? await chrome.tabs.get(message.contextTabId).catch(() => sender.tab)
        : sender.tab;
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
    case "COPY_CURRENT_URL": {
      const targetTab = message.tabId
        ? await chrome.tabs.get(message.tabId)
        : sender.tab;
      try {
        return await copyCurrentUrl(targetTab);
      } catch (error) {
        notifyCopyResult(targetTab, false, error.message);
        throw error;
      }
    }
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
  notifyCopyResult(tab, true);
  return { copiedUrl: tab.url };
}

async function notifyCopyResult(tab, success, error) {
  if (!tab?.id) return;
  const message = { type: "SHOW_COPY_FEEDBACK", success, error };
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["ranking.js", "content.js"] });
      await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      // Chrome pages reject injection, so the toast is skipped there.
    }
  }
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
