// Sources, limits and vocabulary for the news pipeline. Edit this file to add or drop a feed.

export const USER_AGENT = "ThailandChangelog/0.1 (+https://github.com/Muq1937/ThaiChangelog)";

// Checked Oct 2026. Bangkok Post, TAT News and PPTV refused the connection; Nation Thailand,
// Thai PBS World and Daily News returned pages without stories; Thairath answers 403 to
// GitHub's servers.
// `paged`: the feed serves older pages at ?paged=2, 3, …, which a backfill follows.
export const FEEDS = [
  { url: "https://thethaiger.com/news/feed", lang: "en", paged: true, name: { en: "Thaiger", th: "Thaiger" } },
  { url: "https://thethaiger.com/travel/feed", lang: "en", paged: true, name: { en: "Thaiger", th: "Thaiger" } },
  { url: "https://www.khaosodenglish.com/feed/", lang: "en", paged: true, name: { en: "Khaosod English", th: "Khaosod English" } },
  { url: "https://www.khaosod.co.th/around-thailand/feed", lang: "th", name: { en: "Khaosod", th: "ข่าวสด" } },
  { url: "https://www.khaosod.co.th/lifestyle/feed", lang: "th", name: { en: "Khaosod", th: "ข่าวสด" } },
  { url: "https://www.matichon.co.th/region/feed", lang: "th", paged: true, name: { en: "Matichon", th: "มติชน" } },
  { url: "https://rssfeeds.sanook.com/rss/feeds/sanook/news.index.xml", lang: "th", name: { en: "Sanook", th: "สนุก" } },
  { url: "https://rssfeeds.sanook.com/rss/feeds/sanook/travel.index.xml", lang: "th", name: { en: "Sanook", th: "สนุก" } },
];

// What people in Thailand are searching for right now, with related news articles.
// Used as an attention signal and as an extra source of candidates.
export const TRENDS_URL = "https://trends.google.com/trending/rss?geo=TH";

export const LIMITS = {
  minAttention: 8,     // public-attention score (1-10) a story needs; every story at or above it is published
  maxAgeHours: 36,     // skip stories older than this (a backfill uses its own number of days)
  batchSize: 60,       // headlines judged per model call; sized so a two-hour run usually needs one call
  contextHours: 48,    // nearby headlines shown as context, to judge how widely a story is covered
  contextLines: 250,
  maxPages: 40,        // how many older pages a backfill may read per paged feed
  seenDays: 21,        // how long a link is remembered so it is not judged twice
};

export const TAGS = ["new", "buff", "nerf", "balance", "event", "concluded", "known"];
export const PILLARS = ["animals", "food", "festivals", "weather", "wins"];
// Site tabs: "changelog" is Thailand as a whole; "ugc" (user-generated content) is stories
// whose main characters are people: athletes, performers, photographers, villagers.
export const CHANNELS = ["changelog", "ugc"];
