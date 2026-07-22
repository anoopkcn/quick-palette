const test = require("node:test");
const assert = require("node:assert/strict");

const ranking = require("../ranking.js");
const stored = {};
let messageListener;
let commandListener;
let offscreenOpen = false;
let popupOpen = false;
let openPopupCalls = 0;
const runtimeMessages = [];
const createdTabs = [];
const badgeTexts = [];

// Intercept the badge-clear timer (1.5s) so the test process doesn't wait on
// it; short tick timers used by the tests themselves pass through.
const scheduledCallbacks = [];
const realSetTimeout = global.setTimeout;
global.setTimeout = (callback, delay, ...args) => {
  if (delay >= 1000) {
    scheduledCallbacks.push(callback);
    return 0;
  }
  return realSetTimeout(callback, delay, ...args);
};

const tabs = new Map([
  [1, {
    id: 1,
    windowId: 1,
    title: "Example",
    url: "https://example.com/docs",
    favIconUrl: "",
    active: true,
    incognito: false,
    pinned: true,
    lastAccessed: Date.now()
  }],
  [2, {
    id: 2,
    windowId: 1,
    title: "Private",
    url: "https://private.example/",
    favIconUrl: "",
    active: false,
    incognito: true,
    pinned: false,
    lastAccessed: Date.now()
  }]
]);

global.importScripts = () => { global.QuickPaletteRanking = ranking; };
global.chrome = {
  action: {
    async openPopup() { openPopupCalls += 1; },
    setBadgeText({ text }) { badgeTexts.push(text); },
    setBadgeBackgroundColor() {}
  },
  bookmarks: {
    async search() { return [{ id: "b1", title: "Searched bookmark", url: "https://bookmark.test/searched" }]; },
    async getRecent() { return [{ id: "b2", title: "Recent bookmark", url: "https://bookmark.test/recent", dateAdded: 7 }]; }
  },
  commands: { onCommand: { addListener(listener) { commandListener = listener; } } },
  history: {
    async search() { return [{ id: "h1", title: "Visited page", url: "https://history.test/visited", lastVisitTime: 5 }]; }
  },
  runtime: {
    async getContexts(filter) {
      if (filter?.contextTypes?.includes("POPUP")) {
        return popupOpen ? [{ contextType: "POPUP" }] : [];
      }
      return offscreenOpen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
    },
    getURL: (path) => `chrome-extension://test/${path}`,
    onMessage: { addListener(listener) { messageListener = listener; } },
    async sendMessage(message) {
      runtimeMessages.push(message);
      return { ok: true };
    }
  },
  offscreen: {
    async closeDocument() { offscreenOpen = false; },
    async createDocument() { offscreenOpen = true; }
  },
  search: { query: async () => undefined },
  storage: {
    local: {
      async get(key) { return { [key]: stored[key] }; },
      async set(value) { Object.assign(stored, value); }
    }
  },
  tabs: {
    async create(properties = {}) { createdTabs.push(properties); },
    async get(id) { return tabs.get(id); },
    async query(queryInfo = {}) {
      const all = Array.from(tabs.values());
      return queryInfo.active ? all.filter((tab) => tab.active) : all;
    },
    async remove() {},
    async update() {}
  },
  windows: {
    async create() { return { id: 10 }; },
    async update() {}
  }
};

require("../background.js");

function send(message, sender = { tab: tabs.get(1) }) {
  return new Promise((resolve) => {
    messageListener(message, sender, resolve);
  });
}

function tick() {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

test("successful palette activation learns normal tabs but not incognito tabs", async () => {
  assert.equal((await send({ type: "ACTIVATE_TAB", tabId: 1, windowId: 1 })).ok, true);
  assert.ok(stored.tabRankingUsage.byUrl["https://example.com/docs"]);

  assert.equal((await send({ type: "ACTIVATE_TAB", tabId: 2, windowId: 1 })).ok, true);
  assert.equal(stored.tabRankingUsage.byUrl["https://private.example/"], undefined);
});

test("palette data exposes pinned and learned preference signals", async () => {
  const response = await send({ type: "GET_PALETTE_DATA", query: "example" });
  const example = response.tabs.find((tab) => tab.id === 1);
  assert.equal(response.ok, true);
  assert.equal(example.pinned, true);
  assert.ok(example.preferenceScore > 0);
  assert.equal(response.tabs.find((tab) => tab.id === 2).preferenceScore, 0);
});

test("palette data from the popup falls back to the active tab as context", async () => {
  const response = await send({ type: "GET_PALETTE_DATA", query: "" }, {});
  assert.equal(response.ok, true);
  assert.equal(response.currentTabId, 1);
  assert.equal(response.currentWindowId, 1);
});

test("reset clears all learned ranking records", async () => {
  assert.equal((await send({ type: "RESET_TAB_RANKING" })).ok, true);
  assert.deepEqual(stored.tabRankingUsage, ranking.emptyUsageStats());
});

test("open-command-palette opens the popup, or closes an already-open one", async () => {
  commandListener("open-command-palette");
  await tick();
  assert.equal(openPopupCalls, 1);

  popupOpen = true;
  commandListener("open-command-palette");
  await tick();
  assert.equal(openPopupCalls, 1);
  assert.deepEqual(runtimeMessages.at(-1), { type: "CLOSE_PALETTE" });
  popupOpen = false;
});

test("popup-initiated copy resolves the active tab and shows no badge", async () => {
  badgeTexts.length = 0;
  const response = await send({ type: "COPY_CURRENT_URL" }, {});
  assert.equal(response.ok, true);
  assert.equal(response.copiedUrl, "https://example.com/docs");
  assert.deepEqual(runtimeMessages.at(-1), {
    target: "offscreen",
    type: "WRITE_CLIPBOARD",
    text: "https://example.com/docs"
  });
  assert.equal(offscreenOpen, false);
  assert.equal(badgeTexts.length, 0);
});

test("copy-current-url extension command uses its supplied active tab and flashes the badge", async () => {
  badgeTexts.length = 0;
  scheduledCallbacks.length = 0;
  commandListener("copy-current-url", tabs.get(2));
  await tick();
  assert.equal(runtimeMessages.at(-1).text, "https://private.example/");
  assert.deepEqual(badgeTexts, ["✓"]);
  scheduledCallbacks.forEach((callback) => callback());
  assert.deepEqual(badgeTexts, ["✓", ""]);
});

test("history browse mode returns history items and no tabs, even without a query", async () => {
  const response = await send({ type: "GET_PALETTE_DATA", query: "", mode: "history" });
  assert.equal(response.ok, true);
  assert.equal(response.tabs.length, 0);
  assert.equal(response.history[0].url, "https://history.test/visited");
});

test("bookmarks browse mode uses recent bookmarks when the query is empty", async () => {
  const empty = await send({ type: "GET_PALETTE_DATA", query: "", mode: "bookmarks" });
  assert.equal(empty.bookmarks[0].url, "https://bookmark.test/recent");
  assert.equal(empty.bookmarks[0].dateAdded, 7);
  const queried = await send({ type: "GET_PALETTE_DATA", query: "book", mode: "bookmarks" });
  assert.equal(queried.bookmarks[0].url, "https://bookmark.test/searched");
});

test("OPEN_URLS opens every URL as a background tab in order", async () => {
  createdTabs.length = 0;
  const response = await send({ type: "OPEN_URLS", urls: ["https://a.test/", "https://b.test/"] });
  assert.equal(response.ok, true);
  assert.deepEqual(createdTabs, [
    { url: "https://a.test/", active: false },
    { url: "https://b.test/", active: false }
  ]);
});

test("OPEN_URLS rejects empty or invalid URL lists", async () => {
  createdTabs.length = 0;
  assert.equal((await send({ type: "OPEN_URLS", urls: [] })).ok, false);
  assert.equal((await send({ type: "OPEN_URLS", urls: [42, ""] })).ok, false);
  assert.equal((await send({ type: "OPEN_URLS" })).ok, false);
  assert.equal(createdTabs.length, 0);
});
