// Minimal RSS 2.0 / Atom reader: enough for the news feeds in config.mjs, with no dependencies.
import { USER_AGENT } from "../config.mjs";

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function inner(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") : "";
}

function plain(html) {
  const stripTags = (s) => s.replace(/<[^>]*>/g, " ");
  return decodeEntities(stripTags(decodeEntities(stripTags(html)))) // some feeds escape their HTML twice
    .replace(/The post .* appeared first on .*$/s, "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function linkOf(block) {
  const rss = plain(inner(block, "link"));
  if (/^https?:\/\//i.test(rss)) return rss;
  const atom = block.match(/<link\b[^>]*\bhref="([^"]+)"/i);
  if (atom) return decodeEntities(atom[1]);
  const guid = plain(inner(block, "guid"));
  return /^https?:\/\//i.test(guid) ? guid : "";
}

function dateOf(block) {
  for (const name of ["pubDate", "published", "updated", "dc:date"]) {
    let raw = plain(inner(block, name));
    if (!raw) continue;
    // A few Thai feeds write the Buddhist Era year (2569 = 2026).
    raw = raw.replace(/\b(25\d\d)\b/, (y) => String(Number(y) - 543));
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** Fetches one feed and returns its items as { title, link, summary, published, feed }. */
export async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  return blocks
    .map((b) => ({
      title: plain(inner(b, "title")),
      link: linkOf(b),
      summary: plain(inner(b, "description") || inner(b, "summary") || inner(b, "content")),
      published: dateOf(b),
      feed,
    }))
    .filter((item) => item.title && item.link);
}
