(function initQuickPaletteRanking(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QuickPaletteRanking = api;
})(globalThis, () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const USAGE_VERSION = 1;

  function normalize(value) {
    return String(value || "").toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  }

  function canonicalUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.href;
    } catch {
      return String(url || "").split("#")[0];
    }
  }

  function hostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "").toLocaleLowerCase();
    } catch {
      return "";
    }
  }

  function textRelevance(query, tab) {
    const normalizedQuery = normalize(query.trim());
    if (!normalizedQuery) return 1;

    const title = normalize(tab.title);
    const host = normalize(hostname(tab.url));
    const url = normalize(canonicalUrl(tab.url).replace(/^[a-z]+:\/\//, ""));
    const titleTokens = title.split(/[^a-z0-9]+/).filter(Boolean);

    if (title === normalizedQuery || host === normalizedQuery) return 1;
    if (title.startsWith(normalizedQuery)) return 0.95;
    if (host.startsWith(normalizedQuery) || titleTokens.some((token) => token.startsWith(normalizedQuery))) return 0.9;
    if (title.includes(normalizedQuery)) return 0.84;
    if (host.includes(normalizedQuery)) return 0.8;
    if (url.includes(normalizedQuery)) return 0.72;

    return Math.max(
      fuzzySubsequenceRelevance(normalizedQuery, title),
      fuzzySubsequenceRelevance(normalizedQuery, host)
    );
  }

  function fuzzySubsequenceRelevance(query, candidate) {
    if (!query || !candidate) return 0;
    let queryIndex = 0;
    let firstMatch = -1;
    let lastMatch = -1;
    let longestStreak = 0;
    let streak = 0;

    for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
      if (candidate[index] === query[queryIndex]) {
        if (firstMatch < 0) firstMatch = index;
        lastMatch = index;
        queryIndex += 1;
        streak += 1;
        longestStreak = Math.max(longestStreak, streak);
      } else {
        streak = 0;
      }
    }

    if (queryIndex !== query.length) return 0;
    const span = lastMatch - firstMatch + 1;
    const density = query.length / Math.max(query.length, span);
    const streakRatio = longestStreak / query.length;
    return Math.min(0.7, 0.35 + density * 0.25 + streakRatio * 0.1);
  }

  function halfLifeScore(timestamp, halfLife, now = Date.now()) {
    if (!timestamp) return 0;
    const age = Math.max(0, now - timestamp);
    return Math.pow(2, -age / halfLife);
  }

  function rankTabs(tabs, query, context = {}, now = Date.now()) {
    const hasQuery = Boolean(query.trim());
    return tabs
      .map((tab) => {
        const relevance = textRelevance(query, tab);
        const recency = halfLifeScore(tab.lastAccessed, 6 * HOUR, now);
        const preference = clamp(tab.preferenceScore || 0);
        const sameWindow = tab.windowId === context.currentWindowId ? 1 : 0;
        const pinned = tab.pinned ? 1 : 0;
        const current = tab.id === context.currentTabId ? 1 : 0;
        const score = hasQuery
          ? relevance * 0.75 + recency * 0.1 + preference * 0.08 + sameWindow * 0.05 + pinned * 0.02 - current * 0.2
          : recency * 0.5 + preference * 0.3 + sameWindow * 0.15 + pinned * 0.05 - current * 0.25;
        return { ...tab, relevance, rankScore: score };
      })
      .filter((tab) => !hasQuery || tab.relevance > 0)
      .sort((a, b) => b.rankScore - a.rankScore || b.lastAccessed - a.lastAccessed || a.id - b.id);
  }

  function emptyUsageStats() {
    return { version: USAGE_VERSION, byUrl: {}, byHost: {} };
  }

  function sanitizeUsageStats(value) {
    if (!value || value.version !== USAGE_VERSION) return emptyUsageStats();
    return {
      version: USAGE_VERSION,
      byUrl: sanitizeRecords(value.byUrl),
      byHost: sanitizeRecords(value.byHost)
    };
  }

  function preferenceScore(statsValue, url, now = Date.now()) {
    // Called once per tab per query; recordSignal validates individual records,
    // so a full sanitizeUsageStats pass here would be O(records) of wasted work.
    const stats = statsValue && statsValue.version === USAGE_VERSION ? statsValue : emptyUsageStats();
    const urlSignal = recordSignal(stats.byUrl?.[canonicalUrl(url)], now);
    const hostSignal = recordSignal(stats.byHost?.[hostname(url)], now);
    return clamp(urlSignal * 0.7 + hostSignal * 0.3);
  }

  function recordSelection(statsValue, url, now = Date.now()) {
    const stats = sanitizeUsageStats(statsValue);
    const urlKey = canonicalUrl(url);
    const hostKey = hostname(url);
    if (urlKey) stats.byUrl[urlKey] = incrementRecord(stats.byUrl[urlKey], now);
    if (hostKey) stats.byHost[hostKey] = incrementRecord(stats.byHost[hostKey], now);
    return pruneUsageStats(stats);
  }

  function clearUsageStats() {
    return emptyUsageStats();
  }

  function pruneUsageStats(statsValue, maxUrls = 500, maxHosts = 200) {
    const stats = sanitizeUsageStats(statsValue);
    stats.byUrl = newestRecords(stats.byUrl, maxUrls);
    stats.byHost = newestRecords(stats.byHost, maxHosts);
    return stats;
  }

  function incrementRecord(record, now) {
    const previous = validRecord(record) ? record : { score: 0, lastSelectedAt: now };
    const decayed = previous.score * halfLifeScore(previous.lastSelectedAt, 30 * DAY, now);
    return { score: decayed + 1, lastSelectedAt: now };
  }

  function recordSignal(record, now) {
    if (!validRecord(record)) return 0;
    const decayed = record.score * halfLifeScore(record.lastSelectedAt, 30 * DAY, now);
    const frequency = 1 - Math.exp(-decayed / 4);
    const recentSelection = halfLifeScore(record.lastSelectedAt, 7 * DAY, now);
    return frequency * 0.65 + recentSelection * 0.35;
  }

  function sanitizeRecords(records) {
    if (!records || typeof records !== "object") return {};
    return Object.fromEntries(Object.entries(records).filter(([, record]) => validRecord(record)));
  }

  function validRecord(record) {
    return Boolean(record && Number.isFinite(record.score) && record.score >= 0 && Number.isFinite(record.lastSelectedAt));
  }

  function newestRecords(records, limit) {
    return Object.fromEntries(
      Object.entries(records)
        .sort(([, a], [, b]) => b.lastSelectedAt - a.lastSelectedAt)
        .slice(0, limit)
    );
  }

  function clamp(value) {
    return Math.max(0, Math.min(1, value));
  }

  return {
    DAY,
    HOUR,
    USAGE_VERSION,
    canonicalUrl,
    clearUsageStats,
    emptyUsageStats,
    halfLifeScore,
    hostname,
    normalize,
    preferenceScore,
    pruneUsageStats,
    rankTabs,
    recordSelection,
    sanitizeUsageStats,
    textRelevance
  };
});
