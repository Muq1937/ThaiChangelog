#!/usr/bin/env node
// Hourly job. Reads the Thai news feeds and Google Trends for Thailand, drops hard-no topics and
// links it has already judged, and asks the model which new stories (if any) have real public
// attention. Only stories scored LIMITS.minAttention or higher are written up, so most runs
// publish nothing. Each note is saved as its own file in data/entries/.
//
//   node scripts/update.mjs             normal run (needs GEMINI_API_KEY, from the env or .env)
//   node scripts/update.mjs --preview   calls the model and prints the result; writes nothing
//   node scripts/update.mjs --dry-run   fetches and filters only; no model call, writes nothing

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEEDS, LIMITS, TRENDS_URL } from "./config.mjs";
import { fetchFeed, fetchTrends } from "./lib/rss.mjs";
import { blockedTerm } from "./lib/blocklist.mjs";
import { chat, QuotaError } from "./lib/llm.mjs";
import { systemPrompt, replySchema, userMessage, parseReply, toEntries } from "./lib/prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (fs.existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env")); // local runs only
const ENTRIES_DIR = path.join(ROOT, "data", "entries");
const STATE_FILE = path.join(ROOT, ".state", "state.json"); // kept in the Actions cache, not in git
const DRY_RUN = process.argv.includes("--dry-run");
const PREVIEW = process.argv.includes("--preview");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const THAI = /[฀-๿]/;

const TAG_LABEL = { new: "NEW", buff: "BUFF", balance: "BALANCE", event: "EVENT", known: "KNOWN ISSUE" };

function bangkokNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function canonical(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

function loadEntries() {
  if (!fs.existsSync(ENTRIES_DIR)) return [];
  return fs.readdirSync(ENTRIES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(ENTRIES_DIR, f), null))
    .filter(Boolean);
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function summaryMarkdown(entries, statsLine, when) {
  const notes = entries.map((e) => [
    `### [${TAG_LABEL[e.tag]}] ${e.title.en}`,
    `**${e.title.th}**`,
    e.body.en,
    e.body.th,
    `Attention ${e.attention.score}/10: ${e.attention.reason}`,
    `Source: [${e.source.headline}](${e.source.url}) (${e.source.name.en}) · pillar: ${e.pillar} · file: \`data/entries/${e.id}.json\``,
  ].join("\n\n"));
  return [
    `New stories from the ${when} (UTC+7) check. Merge to publish, close to discard, or edit the JSON files in this pull request to fix the wording first.`,
    ...notes,
    `---\n${statsLine}`,
  ].join("\n\n") + "\n";
}

async function main() {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const { date: today, time } = bangkokNow();

  const state = readJson(STATE_FILE, {});
  state.seen ??= {};
  state.proposed = (state.proposed ?? []).filter((p) => now - Date.parse(p.at) < 7 * DAY);
  state.recent = (state.recent ?? []).filter((r) => now - Date.parse(r.at) < LIMITS.contextHours * HOUR);
  for (const [url, at] of Object.entries(state.seen)) {
    if (now - Date.parse(at) > LIMITS.seenDays * DAY) delete state.seen[url];
  }

  const entries = loadEntries();
  const publishedUrls = new Set(entries.map((e) => canonical(e.source?.url ?? "")));

  // 1. Read every feed, plus Google Trends. One broken source is fine; all feeds failing is not.
  const trendsPromise = fetchTrends(TRENDS_URL).catch((err) => {
    console.warn(`  Google Trends failed: ${err.message}`);
    return [];
  });
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const trends = await trendsPromise;
  const items = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else failed.push(`${FEEDS[i].url}: ${r.reason?.message ?? r.reason}`);
  });
  for (const f of failed) console.warn(`  Feed failed, ${f}`);
  if (!items.length) throw new Error("Every feed failed, so there is nothing to judge.");

  // Articles linked from trending searches become candidates too, labelled with the search.
  const trendItems = trends.flatMap((t) => t.news.map((n) => ({
    title: n.title,
    link: n.url,
    summary: "",
    published: t.published,
    trend: `"${t.term}", ${t.traffic || "unknown"} searches`,
    feed: { url: TRENDS_URL, lang: THAI.test(n.title) ? "th" : "en", name: { en: n.source || "Google Trends", th: n.source || "Google Trends" } },
  })));
  const trending = trends
    .filter((t) => !blockedTerm([t.term, ...t.news.map((n) => n.title)].join(" ")))
    .map((t) => `${t.term} (${t.traffic || "unknown"} searches)`);
  console.log(`Read ${FEEDS.length - failed.length} of ${FEEDS.length} feeds (${items.length} items) and ${trends.length} trending searches (${trendItems.length} linked articles).`);

  // 2. Drop what was already judged, what is too old, and every hard-no topic.
  const stats = { seen: 0, old: 0, blocked: 0 };
  const fresh = [];
  const judged = [];
  const titles = new Set();
  for (const item of [...trendItems, ...items]) {
    const url = canonical(item.link);
    const titleKey = item.title.toLowerCase().replace(/\s+/g, " ");
    if (state.seen[url] || publishedUrls.has(url) || titles.has(titleKey)) { stats.seen++; continue; }
    titles.add(titleKey);
    if (item.published && now - item.published > LIMITS.maxAgeHours * HOUR) {
      stats.old++; judged.push(url); continue;
    }
    const term = blockedTerm(`${item.title} ${item.summary}`);
    if (term) {
      stats.blocked++; judged.push(url);
      if (DRY_RUN) console.log(`  blocked by "${term}": ${item.title}`);
      continue;
    }
    fresh.push({ ...item, url });
  }

  // 3. Trending articles first, then newest first from each feed in turn, so one busy feed
  //    cannot fill the list.
  fresh.sort((a, b) => (b.published ?? 0) - (a.published ?? 0));
  const candidates = fresh.filter((i) => i.trend).slice(0, LIMITS.maxTrending);
  const queues = new Map();
  for (const item of fresh.filter((i) => !i.trend)) {
    if (!queues.has(item.feed.url)) queues.set(item.feed.url, []);
    queues.get(item.feed.url).push(item);
  }
  while (candidates.length < LIMITS.maxCandidates && [...queues.values()].some((q) => q.length)) {
    for (const q of queues.values()) {
      if (q.length && candidates.length < LIMITS.maxCandidates) candidates.push(q.shift());
    }
  }

  // Headlines from earlier runs (and this run's overflow) show how widely a story is covered.
  const inBatch = new Set(candidates.map((c) => c.title));
  const recent = new Map(state.recent.map((r) => [r.t, r]));
  for (const i of fresh) if (!recent.has(i.title)) recent.set(i.title, { t: i.title, f: i.feed.name.en, at: nowIso });
  const context = [...recent.values()].filter((r) => !inBatch.has(r.t)).slice(-LIMITS.contextLines);
  state.recent = [...recent.values()].slice(-400);

  const todayIds = new Set([
    ...entries.filter((e) => e.date === today).map((e) => e.id),
    ...state.proposed.filter((p) => p.date === today).map((p) => p.id),
  ]);
  const room = Math.min(LIMITS.maxPerRun, LIMITS.maxPerDay - todayIds.size);
  const statsLine = `${items.length} feed items and ${trendItems.length} trending articles · ${stats.seen} already seen · ` +
    `${stats.old} too old · ${stats.blocked} blocked by the hard-no list · ${candidates.length} sent to the model ` +
    `with ${context.length} earlier headlines as context`;
  console.log(statsLine);

  if (DRY_RUN) {
    console.log(`Trending: ${trending.join(" · ") || "none"}`);
    candidates.forEach((c, i) => console.log(`  [${i + 1}] (${c.feed.name.en}${c.trend ? `, trending ${c.trend}` : ""}) ${c.title}`));
    setOutput("new_entries", 0);
    return;
  }
  if (room <= 0 || !candidates.length) {
    console.log(room <= 0 ? "Daily limit reached; nothing more today." : "Nothing new to judge.");
    if (!PREVIEW) {
      for (const url of judged) state.seen[url] = nowIso;
      saveState(state);
    }
    setOutput("new_entries", 0);
    return;
  }

  // 4. Ask the model. One retry if the reply is not valid JSON; a second failure fails the run,
  //    and because the memory is not saved, the same headlines are judged again next hour.
  const covered = [
    ...entries
      .filter((e) => now - Date.parse(`${e.date}T${e.time}:00+07:00`) < 7 * DAY)
      .map((e) => e.title.en),
    ...state.proposed.map((p) => p.title),
  ].slice(-40);
  const messages = [
    { role: "system", content: systemPrompt({ maxPicks: room, minAttention: LIMITS.minAttention }) },
    { role: "user", content: userMessage({ candidates, covered, context, trending }) },
  ];
  let reply = await chat({ messages, schema: replySchema });
  let parsed;
  try {
    parsed = parseReply(reply.content);
  } catch (err) {
    console.warn(`The reply was not usable JSON (${err.message}). Asking once more.`);
    messages.push(
      { role: "assistant", content: reply.content },
      { role: "user", content: "That was not valid JSON. Reply again with only the JSON object and nothing else." },
    );
    reply = await chat({ messages, schema: replySchema });
    parsed = parseReply(reply.content);
  }
  console.log(`Model ${reply.model}: ${reply.usage.prompt_tokens} tokens in, ${reply.usage.completion_tokens} out (including thinking).`);

  // Log every story the model weighed, so the attention bar can be tuned from the run logs.
  console.log(parsed.considered.length ? `Considered (publishing needs ${LIMITS.minAttention}/10):` : "Nothing fit a pillar.");
  for (const c of parsed.considered) {
    const cand = candidates[Number(c.id) - 1];
    console.log(`  ${c.attention}/10 [${c.id}] ${cand?.title ?? "?"}\n         ${c.reason}`);
  }

  const { entries: notes, rejected } = toEntries(parsed, candidates, { date: today, time, room, minAttention: LIMITS.minAttention });
  for (const r of rejected) console.warn(`  Rejected pick ${r}`);
  notes.forEach((e, i) => { e.id = `${today}-${time.replace(":", "")}-${i + 1}`; });
  console.log(notes.length ? `Publishing ${notes.length}.` : "Nothing worth publishing this hour.");

  if (PREVIEW) {
    if (notes.length) console.log(JSON.stringify(notes, null, 2));
    setOutput("new_entries", 0);
    return;
  }

  // 5. Save the notes and remember everything that was judged.
  fs.mkdirSync(ENTRIES_DIR, { recursive: true });
  for (const e of notes) fs.writeFileSync(path.join(ENTRIES_DIR, `${e.id}.json`), JSON.stringify(e, null, 2) + "\n");
  for (const url of [...judged, ...candidates.map((c) => c.url)]) state.seen[url] = nowIso;
  state.proposed.push(...notes.map((e) => ({ id: e.id, date: e.date, title: e.title.en, at: nowIso })));
  saveState(state);

  if (notes.length) {
    const md = summaryMarkdown(notes, statsLine, `${today} ${time}`);
    if (process.env.SUMMARY_FILE) fs.writeFileSync(process.env.SUMMARY_FILE, md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
  setOutput("new_entries", notes.length);
}

main().catch((err) => {
  console.error(err instanceof QuotaError ? err.message : err.stack ?? err.message);
  process.exit(1);
});
