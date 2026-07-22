importScripts("ranking.js");

const CHROME_PAGES = {
  bookmarks: "chrome://bookmarks/",
  downloads: "chrome://downloads/",
  extensions: "chrome://extensions/",
  history: "chrome://history/",
  settings: "chrome://settings/"
};
const USAGE_STORAGE_KEY = "tabRankingUsage";
let standaloneWindowId;
let usageWriteQueue = Promise.resolve();

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-command-palette") {
    togglePaletteInActiveTab();
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    sendToggle(tab.id);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === standaloneWindowId) standaloneWindowId = undefined;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    // Tabs open before installation do not have the declared content script yet.
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
  if (standaloneWindowId) {
    try {
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
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(`palette.html?tabId=${sourceTabId}`),
    type: "popup",
    focused: true,
    width,
    height,
    left,
    top
  });
  standaloneWindowId = created.id;
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_PALETTE_DATA": {
      const contextTab = message.contextTabId
        ? await chrome.tabs.get(message.contextTabId).catch(() => sender.tab)
        : sender.tab;
      return getPaletteData(message.query || "", contextTab);
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
    default:
      throw new Error("Unknown palette action");
  }
}

async function getPaletteData(query, senderTab) {
  const normalizedQuery = query.trim();
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
    currentTabId: senderTab?.id,
    currentWindowId: senderTab?.windowId,
    tabs: tabs
      .filter((tab) => tab.id && tab.url && !tab.url.startsWith(chrome.runtime.getURL("")))
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
    history: history
      .filter((item) => item.url)
      .map((item) => ({
        id: item.id,
        title: item.title || item.url,
        url: item.url,
        lastVisitTime: item.lastVisitTime || 0
      })),
    bookmarks: bookmarks
      .filter((item) => item.url)
      .slice(0, 40)
      .map((item) => ({ id: item.id, title: item.title || item.url, url: item.url }))
  };
}

async function readUsageStats() {
  const stored = await chrome.storage.local.get(USAGE_STORAGE_KEY);
  return QuickPaletteRanking.sanitizeUsageStats
    ? QuickPaletteRanking.sanitizeUsageStats(stored[USAGE_STORAGE_KEY])
    : stored[USAGE_STORAGE_KEY] || QuickPaletteRanking.emptyUsageStats();
}

function learnFromSelection(tab) {
  if (!tab?.url || tab.incognito || tab.url.startsWith(chrome.runtime.getURL(""))) {
    return Promise.resolve();
  }
  usageWriteQueue = usageWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const current = await readUsageStats();
      const updated = QuickPaletteRanking.recordSelection(current, tab.url);
      await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: updated });
    });
  return usageWriteQueue;
}

function resetLearnedRanking() {
  usageWriteQueue = usageWriteQueue
    .catch(() => undefined)
    .then(() => chrome.storage.local.set({
      [USAGE_STORAGE_KEY]: QuickPaletteRanking.clearUsageStats()
    }));
  return usageWriteQueue;
}
