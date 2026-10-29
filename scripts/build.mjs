#!/usr/bin/env node
// Builds the static site into _site/: the page from site/, entries.json for it to load,
// and one RSS feed per language.
//
//   node scripts/build.mjs [--data data/entries] [--out _site]
//   SITE_URL sets the absolute links in the RSS feeds (the deploy workflow passes it).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const DATA = path.resolve(ROOT, arg("--data", "data/entries"));
const OUT = path.resolve(ROOT, arg("--out", "_site"));
const SITE_URL = (process.env.SITE_URL || "https://muq1937.github.io/ThaiChangelog").replace(/\/+$/, "");
const MAX_ENTRIES = 500;
const FEED_ITEMS = 50;

const TAG_LABEL = {
  en: { buff: "BUFF", nerf: "NERF", rebalance: "REBALANCE", event: "EVENT", concluded: "EVENT CONCLUDED", known: "KNOWN ISSUE", news: "NEWS" },
  th: { buff: "บัฟ", nerf: "เนิร์ฟ", rebalance: "ปรับบาลานซ์", event: "อีเวนต์", concluded: "ปิดอีเวนต์", known: "ปัญหาที่ทราบ", news: "ข่าว" },
};
const CHANNEL = {
  en: { title: "Thailand Changelog", description: "Real news from Thailand, written as video-game patch notes.", file: "feed.xml" },
  th: { title: "แพตช์โน้ตประเทศไทย", description: "ข่าวจริงจากเมืองไทย เล่าใหม่ในสไตล์แพตช์โน้ตเกม", file: "feed-th.xml" },
};

if (OUT === ROOT || ROOT.startsWith(OUT + path.sep)) throw new Error(`Refusing to use ${OUT} as the output folder.`);

const isValid = (e) =>
  e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && /^\d{2}:\d{2}$/.test(e.time) && TAG_LABEL.en[e.tag] &&
  e.title?.en && e.title?.th && e.body?.en && e.body?.th && /^https?:\/\//.test(e.source?.url ?? "");

const files = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((f) => f.endsWith(".json")) : [];
const entries = [];
for (const f of files) {
  let e;
  try { e = JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch (err) {
    console.warn(`Skipping ${f}: ${err.message}`);
    continue;
  }
  if (!isValid(e)) { console.warn(`Skipping ${f}: missing or malformed fields.`); continue; }
  entries.push({ ...e, id: e.id || path.basename(f, ".json") });
}
entries.sort((a, b) => `${b.date}T${b.time}|${b.id}`.localeCompare(`${a.date}T${a.time}|${a.id}`));

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

function rss(lang) {
  const ch = CHANNEL[lang];
  const items = entries.slice(0, FEED_ITEMS).map((e) => `    <item>
      <title>${xml(`${e.channel === "ugc" ? "[UGC] " : ""}[${TAG_LABEL[lang][e.tag]}] ${e.title[lang]}`)}</title>
      <link>${xml(e.source.url)}</link>
      <guid isPermaLink="false">thailand-changelog:${xml(e.id)}</guid>
      <pubDate>${new Date(`${e.date}T${e.time}:00+07:00`).toUTCString()}</pubDate>
      <description>${xml(`${e.body[lang]} (${lang === "th" ? "แหล่งข่าว" : "Source"}: ${e.source.name?.[lang] ?? e.source.name?.en ?? ""})`)}</description>
    </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(ch.title)}</title>
    <link>${xml(SITE_URL)}/</link>
    <atom:link href="${xml(`${SITE_URL}/${ch.file}`)}" rel="self" type="application/rss+xml"/>
    <description>${xml(ch.description)}</description>
    <language>${lang}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, "site"), OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "entries.json"), JSON.stringify({ generated: new Date().toISOString(), entries: entries.slice(0, MAX_ENTRIES) }));
for (const lang of ["en", "th"]) fs.writeFileSync(path.join(OUT, CHANNEL[lang].file), rss(lang));
console.log(`Built ${path.relative(ROOT, OUT) || OUT} with ${entries.length} entries.`);
