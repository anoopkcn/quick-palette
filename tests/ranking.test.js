const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DAY,
  HOUR,
  canonicalUrl,
  emptyUsageStats,
  halfLifeScore,
  preferenceScore,
  pruneUsageStats,
  rankTabs,
  recordSelection,
  textRelevance
} = require("../ranking.js");

const NOW = 1_800_000_000_000;

function tab(overrides = {}) {
  return {
    id: 1,
    windowId: 1,
    title: "Example documentation",
    url: "https://docs.example.com/guide",
    lastAccessed: NOW,
    pinned: false,
    preferenceScore: 0,
    ...overrides
  };
}

test("assigns decreasing relevance to exact, prefix, substring, and fuzzy matches", () => {
  const exact = textRelevance("example documentation", tab());
  const prefix = textRelevance("example doc", tab());
  const substring = textRelevance("documentation", tab());
  const fuzzy = textRelevance("exdoc", tab());
  assert.ok(exact > prefix && prefix > substring && substring > fuzzy && fuzzy > 0);
});

test("a substantially better text match beats all contextual boosts", () => {
  const ranked = rankTabs([
    tab({ id: 1, title: "Project dashboard", lastAccessed: NOW - 10 * DAY }),
    tab({ id: 2, windowId: 2, title: "Dashboard", url: "https://other.test", lastAccessed: NOW, pinned: true, preferenceScore: 1 })
  ], "project", { currentTabId: 99, currentWindowId: 2 }, NOW);
  assert.equal(ranked[0].id, 1);
});

test("empty queries combine recency, learned preference, window, and pinned state", () => {
  const ranked = rankTabs([
    tab({ id: 1, lastAccessed: NOW - 24 * HOUR }),
    tab({ id: 2, windowId: 2, lastAccessed: NOW, pinned: true, preferenceScore: 0.8 })
  ], "", { currentTabId: 99, currentWindowId: 1 }, NOW);
  assert.equal(ranked[0].id, 2);
});

test("browser recency uses a six-hour half-life", () => {
  assert.equal(halfLifeScore(NOW - 6 * HOUR, 6 * HOUR, NOW), 0.5);
});

test("current-window context breaks otherwise equal ranking", () => {
  const ranked = rankTabs([
    tab({ id: 1, windowId: 2 }),
    tab({ id: 2, windowId: 1 })
  ], "example", { currentTabId: 99, currentWindowId: 1 }, NOW);
  assert.equal(ranked[0].id, 2);
});

test("pinned state breaks otherwise equal ranking", () => {
  const ranked = rankTabs([
    tab({ id: 1 }),
    tab({ id: 2, pinned: true })
  ], "example", { currentTabId: 99, currentWindowId: 2 }, NOW);
  assert.equal(ranked[0].id, 2);
});

test("the current tab is demoted below an otherwise equivalent tab", () => {
  const ranked = rankTabs([
    tab({ id: 1 }),
    tab({ id: 2 })
  ], "example", { currentTabId: 1, currentWindowId: 1 }, NOW);
  assert.equal(ranked[0].id, 2);
});

test("ties resolve by recency and then tab id", () => {
  const ranked = rankTabs([
    tab({ id: 3, lastAccessed: NOW - HOUR }),
    tab({ id: 2, lastAccessed: NOW }),
    tab({ id: 1, lastAccessed: NOW })
  ], "", { currentTabId: 99, currentWindowId: 2 }, NOW);
  assert.deepEqual(ranked.map(({ id }) => id), [1, 2, 3]);
});

test("canonical URLs discard fragments while retaining meaningful queries", () => {
  assert.equal(canonicalUrl("https://example.com/page?q=one#section"), "https://example.com/page?q=one");
});

test("selection preference grows and decays over time", () => {
  let stats = emptyUsageStats();
  stats = recordSelection(stats, "https://example.com/a", NOW);
  stats = recordSelection(stats, "https://example.com/a#details", NOW);
  const immediate = preferenceScore(stats, "https://example.com/a", NOW);
  const later = preferenceScore(stats, "https://example.com/a", NOW + 30 * DAY);
  assert.ok(immediate > later && later > 0);
});

test("preference scoring tolerates missing or malformed usage data", () => {
  assert.equal(preferenceScore(undefined, "https://example.com/a", NOW), 0);
  assert.equal(preferenceScore({ version: 99, byUrl: {}, byHost: {} }, "https://example.com/a", NOW), 0);
  assert.equal(preferenceScore(
    { version: 1, byUrl: { "https://example.com/a": { score: "bad" } }, byHost: null },
    "https://example.com/a",
    NOW
  ), 0);
});

test("hostname learning partially transfers between pages", () => {
  const stats = recordSelection(emptyUsageStats(), "https://example.com/first", NOW);
  assert.ok(preferenceScore(stats, "https://example.com/second", NOW) > 0);
  assert.equal(preferenceScore(stats, "https://other.test/second", NOW), 0);
});

test("usage pruning retains the most recently selected records", () => {
  const stats = emptyUsageStats();
  for (let index = 0; index < 4; index += 1) {
    stats.byUrl[`https://example.com/${index}`] = { score: 1, lastSelectedAt: NOW + index };
  }
  const pruned = pruneUsageStats(stats, 2, 200);
  assert.deepEqual(Object.keys(pruned.byUrl), ["https://example.com/3", "https://example.com/2"]);
});
