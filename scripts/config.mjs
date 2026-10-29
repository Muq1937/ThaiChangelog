// Sources, limits and vocabulary for the hourly pipeline. Edit this file to add or drop a feed.

export const USER_AGENT = "ThailandChangelog/0.1 (+https://github.com/Muq1937/ThaiChangelog)";

// Checked Oct 2026. Bangkok Post, TAT News and PPTV refused the connection; Nation Thailand,
// Thai PBS World and Daily News returned pages without stories.
export const FEEDS = [
  { url: "https://thethaiger.com/news/feed", lang: "en", name: { en: "Thaiger", th: "Thaiger" } },
  { url: "https://thethaiger.com/travel/feed", lang: "en", name: { en: "Thaiger", th: "Thaiger" } },
  { url: "https://www.khaosodenglish.com/feed/", lang: "en", name: { en: "Khaosod English", th: "Khaosod English" } },
  { url: "https://www.khaosod.co.th/around-thailand/feed", lang: "th", name: { en: "Khaosod", th: "ข่าวสด" } },
  { url: "https://www.khaosod.co.th/lifestyle/feed", lang: "th", name: { en: "Khaosod", th: "ข่าวสด" } },
  { url: "https://www.matichon.co.th/region/feed", lang: "th", name: { en: "Matichon", th: "มติชน" } },
  { url: "https://www.thairath.co.th/rss/news", lang: "th", name: { en: "Thairath", th: "ไทยรัฐ" } },
  { url: "https://rssfeeds.sanook.com/rss/feeds/sanook/news.index.xml", lang: "th", name: { en: "Sanook", th: "สนุก" } },
  { url: "https://rssfeeds.sanook.com/rss/feeds/sanook/travel.index.xml", lang: "th", name: { en: "Sanook", th: "สนุก" } },
];

export const LIMITS = {
  maxAgeHours: 36,    // skip stories older than this
  maxCandidates: 40,  // headlines sent to the model per run
  maxPerRun: 2,       // patch notes written per run
  maxPerDay: 12,      // patch notes per Bangkok calendar day, published or awaiting review
  seenDays: 14,       // how long a link is remembered so it is not judged twice
};

export const TAGS = ["new", "buff", "balance", "event", "known"];
export const PILLARS = ["animals", "food", "festivals", "weather", "wins"];
