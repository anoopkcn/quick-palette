const test = require("node:test");
const assert = require("node:assert/strict");

const ranking = require("../ranking.js");
const stored = {};
let messageListener;

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
  bookmarks: { search: async () => [] },
  commands: { onCommand: { addListener() {} } },
  history: { search: async () => [] },
  runtime: {
    getURL: (path) => `chrome-extension://test/${path}`,
    onMessage: { addListener(listener) { messageListener = listener; } }
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
    async create() {},
    async get(id) { return tabs.get(id); },
    async query() { return Array.from(tabs.values()); },
    async remove() {},
    async sendMessage() {},
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
