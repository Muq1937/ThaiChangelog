#!/usr/bin/env node
// Runs every two hours. Reads the Thai news feeds and Google Trends for Thailand, drops hard-no topics and
// links it has already judged, and asks the model, in batches, which stories have real public
// attention. Every story scored LIMITS.minAttention or higher is written up; most runs publish
// nothing. Each note is saved as its own file in data/entries/.
//
//   node scripts/update.mjs                 normal run (needs GEMINI_API_KEY, from the env or .env)
//   node scripts/update.mjs --backfill 14   judge the past 14 days, as far back as the feeds go,
//                                           one day at a time; notes are dated to the article
//   node scripts/update.mjs --preview       call the model and print the result; write nothing
//   node scripts/update.mjs --dry-run       fetch and filter only; no model call, write nothing
//   BACKFILL_DAYS=14 in the environment works like --backfill 14 (the manual workflow run uses it).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEEDS, LIMITS, TRENDS_URL } from "./config.mjs";
import { fetchFeed, fetchFeedHistory, fetchTrends } from "./lib/rss.mjs";
import { blockedTerm } from "./lib/blocklist.mjs";
import { chat, QuotaError, OutageError } from "./lib/llm.mjs";
import { systemPrompt, replySchema, userMessage, parseReply, toEntries } from "./lib/prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (fs.existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env")); // local runs only
const ENTRIES_DIR = path.join(ROOT, "data", "entries");
const STATE_FILE = path.join(ROOT, ".state", "state.json"); // kept in the Actions cache, not in git
const DRY_RUN = process.argv.includes("--dry-run");
const PREVIEW = process.argv.includes("--preview");
const backfillArg = process.argv.indexOf("--backfill");
const BACKFILL_DAYS = backfillArg >= 0 ? Number(process.argv[backfillArg + 1]) || 14 : Number(process.env.BACKFILL_DAYS) || 0;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const THAI = /[฀-๿]/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAG_LABEL = { new: "NEW", buff: "BUFF", balance: "BALANCE", event: "EVENT", known: "KNOWN ISSUE" };

function bangkok(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
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
    .map((f) => ({ id: path.basename(f, ".json"), ...readJson(path.join(ENTRIES_DIR, f), null) }))
    .filter((e) => e.title);
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Trending articles first, then newest first from each feed in turn, so one busy feed
// does not crowd a batch.
function ordered(items) {
  const sorted = [...items].sort((a, b) => (b.published ?? 0) - (a.published ?? 0));
  const out = sorted.filter((i) => i.trend);
  const queues = new Map();
  for (const item of sorted.filter((i) => !i.trend)) {
    if (!queues.has(item.feed.url)) queues.set(item.feed.url, []);
    queues.get(item.feed.url).push(item);
  }
  while ([...queues.values()].some((q) => q.length)) {
    for (const q of queues.values()) if (q.length) out.push(q.shift());
  }
  return out;
}

// One model call, with one retry if the reply is not valid JSON.
async function ask(messages) {
  let reply = await chat({ messages, schema: replySchema });
  try {
    return { reply, parsed: parseReply(reply.content) };
  } catch (err) {
    console.warn(`The reply was not usable JSON (${err.message}). Asking once more.`);
    reply = await chat({
      messages: [
        ...messages,
        { role: "assistant", content: reply.content },
        { role: "user", content: "That was not valid JSON. Reply again with only the JSON object and nothing else." },
      ],
      schema: replySchema,
    });
    return { reply, parsed: parseReply(reply.content) };
  }
}

function summaryMarkdown(entries, statsLine, when) {
  const notes = entries.map((e) => [
    `### [${TAG_LABEL[e.tag]}] ${e.title.en}`,
    `**${e.title.th}**`,
    e.body.en,
    e.body.th,
    `Attention ${e.attention.score}/10: ${e.attention.reason}`,
    `Source: [${e.source.headline}](${e.source.url}) (${e.source.name.en}) · ${e.date} ${e.time} · tab: ${e.channel} · pillar: ${e.pillar} · file: \`data/entries/${e.id}.json\``,
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
  const runAt = bangkok(now);
  const maxAge = BACKFILL_DAYS ? BACKFILL_DAYS * DAY : LIMITS.maxAgeHours * HOUR;
  if (BACKFILL_DAYS) console.log(`Backfill: judging up to ${BACKFILL_DAYS} days back.`);

  const state = readJson(STATE_FILE, {});
  state.seen ??= {};
  state.proposed = (state.proposed ?? []).filter((p) => now - Date.parse(p.at) < 7 * DAY);
  state.recent = (state.recent ?? [])
    .map((r) => ({ t: r.t, f: r.f, ms: r.ms ?? Date.parse(r.at) }))
    .filter((r) => now - r.ms < Math.max(maxAge, LIMITS.contextHours * HOUR));
  for (const [url, at] of Object.entries(state.seen)) {
    if (now - Date.parse(at) > LIMITS.seenDays * DAY) delete state.seen[url];
  }

  const entries = loadEntries();
  const publishedUrls = new Set(entries.map((e) => canonical(e.source?.url ?? "")));
  const usedIds = new Set(entries.map((e) => e.id));
  const newId = ({ date, time }) => {
    const base = `${date}-${time.replace(":", "")}`;
    let n = 1;
    while (usedIds.has(`${base}-${n}`)) n++;
    usedIds.add(`${base}-${n}`);
    return `${base}-${n}`;
  };

  // 1. Read every feed (older pages too, in a backfill) plus Google Trends.
  //    One broken source is fine; all feeds failing is not.
  const trendsPromise = fetchTrends(TRENDS_URL).catch((err) => {
    console.warn(`  Google Trends failed: ${err.message}`);
    return [];
  });
  const results = await Promise.allSettled(FEEDS.map((feed) =>
    BACKFILL_DAYS && feed.paged ? fetchFeedHistory(feed, now - maxAge, LIMITS.maxPages) : fetchFeed(feed)));
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
    if (item.published && now - item.published > maxAge) { stats.old++; judged.push(url); continue; }
    const term = blockedTerm(`${item.title} ${item.summary}`);
    if (term) {
      stats.blocked++; judged.push(url);
      if (DRY_RUN && !BACKFILL_DAYS) console.log(`  blocked by "${term}": ${item.title}`);
      continue;
    }
    fresh.push({ ...item, url, ms: item.published ?? now });
  }

  // 3. Plan the batches. Normally one or two; a backfill goes one Bangkok day at a time,
  //    oldest first, so stories already published are listed as covered for later days.
  const plan = [];
  if (BACKFILL_DAYS) {
    const days = new Map();
    for (const item of fresh) {
      const d = bangkok(item.ms).date;
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(item);
    }
    for (const d of [...days.keys()].sort()) {
      chunk(ordered(days.get(d)), LIMITS.batchSize).forEach((batch, i, all) => plan.push({ label: all.length > 1 ? `${d} (${i + 1}/${all.length})` : d, batch }));
    }
  } else {
    chunk(ordered(fresh), LIMITS.batchSize).forEach((batch, i) => plan.push({ label: `batch ${i + 1}`, batch }));
  }

  // Headlines from earlier runs plus this one, to judge how widely a story is covered.
  const pool = new Map(state.recent.map((r) => [r.t, r]));
  for (const i of fresh) if (!pool.has(i.title)) pool.set(i.title, { t: i.title, f: i.feed.name.en, ms: i.ms });
  const contextFor = (batch) => {
    const inBatch = new Set(batch.map((c) => c.title));
    const center = Math.max(...batch.map((c) => c.ms));
    return [...pool.values()]
      .filter((r) => !inBatch.has(r.t) && Math.abs(r.ms - center) <= LIMITS.contextHours * HOUR)
      .sort((a, b) => Math.abs(a.ms - center) - Math.abs(b.ms - center))
      .slice(0, LIMITS.contextLines);
  };

  const statsLine = `${items.length} feed items and ${trendItems.length} trending articles · ${stats.seen} already seen · ` +
    `${stats.old} too old · ${stats.blocked} blocked by the hard-no list · ${fresh.length} judged in ${plan.length} batch(es)`;
  console.log(statsLine);

  if (DRY_RUN) {
    console.log(`Trending: ${trending.join(" · ") || "none"}`);
    for (const { label, batch } of plan) {
      console.log(`${label}: ${batch.length} headlines, ${contextFor(batch).length} as context`);
      if (!BACKFILL_DAYS) batch.forEach((c, i) => console.log(`  [${i + 1}] (${c.feed.name.en}${c.trend ? `, trending ${c.trend}` : ""}) ${c.title}`));
    }
    setOutput("new_entries", 0);
    return;
  }

  // 4. Judge each batch. A failed batch is skipped (its headlines stay unjudged for next
  //    time); two failures in a row stop the run, keeping what is already done.
  const notes = [];
  let succeeded = 0;
  let failedInARow = 0;
  let lastFailure = null;
  for (const [n, { label, batch }] of plan.entries()) {
    if (n > 0) await sleep(BACKFILL_DAYS ? 15000 : 6000); // stay under the free tier's requests-per-minute limit
    const withHeadline = (e) => `${e.title.en} (original: ${e.source?.headline ?? "unknown"})`;
    const covered = [
      ...entries.filter((e) => now - Date.parse(`${e.date}T${e.time}:00+07:00`) < maxAge + 7 * DAY).map(withHeadline),
      ...state.proposed.filter((p) => !entries.some((e) => e.id === p.id)).map((p) => p.title),
      ...notes.map(withHeadline),
    ].slice(-80);
    const recentBatch = now - Math.max(...batch.map((c) => c.ms)) < LIMITS.maxAgeHours * HOUR;
    const messages = [
      { role: "system", content: systemPrompt({ minAttention: LIMITS.minAttention }) },
      { role: "user", content: userMessage({ candidates: batch, covered, context: contextFor(batch), trending: recentBatch ? trending : [] }) },
    ];
    let reply, parsed;
    try {
      ({ reply, parsed } = await ask(messages));
    } catch (err) {
      // Quota, overload and an unreadable reply are expected now and then: skip the batch and
      // leave its headlines for the next run. Anything else (a rejected key, a bug) stops the run.
      const expected = err instanceof QuotaError || err instanceof OutageError || err instanceof SyntaxError || /JSON|"picks"/.test(err.message);
      if (!expected) throw err;
      console.warn(`${label}: skipped. ${err.message}`);
      lastFailure = err;
      failedInARow++;
      if (err instanceof QuotaError || failedInARow >= 2) {
        console.warn("Stopping here; what is done so far is kept, and the rest is judged next time.");
        break;
      }
      continue;
    }
    succeeded++;
    failedInARow = 0;

    // Log every story the model weighed, so the attention bar can be tuned from the run logs.
    console.log(`${label}: ${batch.length} headlines · ${reply.model}, ${reply.usage.prompt_tokens} tokens in, ${reply.usage.completion_tokens} out`);
    for (const c of parsed.considered) {
      console.log(`  ${c.attention}/10 ${batch[Number(c.id) - 1]?.title ?? `[${c.id}]`}\n         ${c.reason}`);
    }
    const when = (c) => (BACKFILL_DAYS ? bangkok(c.ms) : runAt);
    const { entries: made, rejected } = toEntries(parsed, batch, { when, minAttention: LIMITS.minAttention });
    for (const r of rejected) console.warn(`  Rejected pick ${r}`);
    for (const e of made) {
      e.id = newId(e);
      console.log(`  → publishing to ${e.channel}: [${TAG_LABEL[e.tag]}] ${e.title.en}`);
      if (!PREVIEW) {
        fs.mkdirSync(ENTRIES_DIR, { recursive: true });
        fs.writeFileSync(path.join(ENTRIES_DIR, `${e.id}.json`), JSON.stringify(e, null, 2) + "\n");
      }
    }
    notes.push(...made);
    for (const c of batch) state.seen[c.url] = nowIso;
  }

  // 5. Remember what was judged, and report.
  if (PREVIEW) {
    if (notes.length) console.log(JSON.stringify(notes, null, 2));
    console.log(`${notes.length} would be published.`);
    setOutput("new_entries", 0);
    return;
  }
  for (const url of judged) state.seen[url] = nowIso;
  state.proposed.push(...notes.map((e) => ({ id: e.id, date: e.date, title: e.title.en, at: nowIso })));
  state.recent = [...pool.values()].sort((a, b) => a.ms - b.ms).slice(-1500);
  saveState(state);

  console.log(notes.length ? `Published ${notes.length}.` : "Nothing worth publishing this time.");
  if (notes.length) {
    const md = summaryMarkdown(notes, statsLine, `${runAt.date} ${runAt.time}`);
    if (process.env.SUMMARY_FILE) fs.writeFileSync(process.env.SUMMARY_FILE, md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
  setOutput("new_entries", notes.length);
  // Not a failure: the headlines wait (up to LIMITS.maxAgeHours) for a run that can judge them.
  // The ::warning:: line shows up on the run's page in GitHub Actions.
  if (plan.length && !succeeded) console.log(`::warning::No batch could be judged this time. ${lastFailure?.message ?? ""}`);
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
