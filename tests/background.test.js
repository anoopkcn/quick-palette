const test = require("node:test");
const assert = require("node:assert/strict");

const ranking = require("../ranking.js");
const stored = {};
let messageListener;
let commandListener;
let offscreenOpen = false;
const clipboardMessages = [];
const tabMessages = [];
const createdTabs = [];

const tabs = new Map([
  [1, {
    id: 1,
    windowId: 1,
    title: "Example",
    url: "https://example.com/docs",
    favIconUrl: "",
    active: false,
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
  action: { onClicked: { addListener() {} } },
  bookmarks: {
    async search() { return [{ id: "b1", title: "Searched bookmark", url: "https://bookmark.test/searched" }]; },
    async getRecent() { return [{ id: "b2", title: "Recent bookmark", url: "https://bookmark.test/recent", dateAdded: 7 }]; }
  },
  commands: { onCommand: { addListener(listener) { commandListener = listener; } } },
  history: {
    async search() { return [{ id: "h1", title: "Visited page", url: "https://history.test/visited", lastVisitTime: 5 }]; }
  },
  runtime: {
    async getContexts() { return offscreenOpen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []; },
    getURL: (path) => `chrome-extension://test/${path}`,
    onMessage: { addListener(listener) { messageListener = listener; } },
    async sendMessage(message) {
      clipboardMessages.push(message);
      return { ok: true };
    }
  },
  offscreen: {
    async closeDocument() { offscreenOpen = false; },
    async createDocument() { offscreenOpen = true; }
  },
  scripting: { executeScript: async () => undefined },
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
    async query() { return Array.from(tabs.values()); },
    async remove() {},
    async sendMessage(tabId, message) { tabMessages.push({ tabId, message }); },
    async update() {}
  },
  windows: {
    async create() { return { id: 10 }; },
    async getLastFocused() { return null; },
    onRemoved: { addListener() {} },
    async update() {}
  }
};

require("../background.js");

function send(message) {
  return new Promise((resolve) => {
    messageListener(message, { tab: tabs.get(1) }, resolve);
  });
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

test("reset clears all learned ranking records", async () => {
  assert.equal((await send({ type: "RESET_TAB_RANKING" })).ok, true);
  assert.deepEqual(stored.tabRankingUsage, ranking.emptyUsageStats());
});

test("palette action copies the requested tab URL and sends feedback", async () => {
  const response = await send({ type: "COPY_CURRENT_URL", tabId: 1 });
  assert.equal(response.ok, true);
  assert.equal(response.copiedUrl, "https://example.com/docs");
  assert.deepEqual(clipboardMessages.at(-1), {
    target: "offscreen",
    type: "WRITE_CLIPBOARD",
    text: "https://example.com/docs"
  });
  assert.deepEqual(tabMessages.at(-1), {
    tabId: 1,
    message: { type: "SHOW_COPY_FEEDBACK", success: true, error: undefined }
  });
  assert.equal(offscreenOpen, false);
});

test("copy-current-url extension command uses its supplied active tab", async () => {
  commandListener("copy-current-url", tabs.get(2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(clipboardMessages.at(-1).text, "https://private.example/");
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
