// What the model is asked, and how its answer is checked before anything is saved.
import { TAGS, PILLARS } from "../config.mjs";
import { blockedTerm } from "./blocklist.mjs";

export const systemPrompt = ({ minAttention }) => `You are the editor of Thailand Changelog, a website that rewrites real news from Thailand as video-game patch notes, in English and Thai.

You get a batch of headlines from Thai news sites, plus context: what people in Thailand are searching for on Google (when available), other headlines from around the same days, and what the site already covered. Your job is to find the rare story that genuinely deserves a place on the site. Most batches have none, and an empty "picks" list is the expected answer.

PUBLIC ATTENTION
A story is worth publishing only if a lot of people in Thailand are paying attention to it: talking about it, sharing it or searching for it. The benchmark is Moo Deng, the baby pygmy hippo the whole country, and then the world, could not stop sharing. Signs of attention:
- It matches a trending search in Thailand.
- Several outlets cover the same story (compare with the other recent headlines).
- Thai headlines call it viral or widely shared (ไวรัล, ชาวเน็ต, โซเชียล, แห่แชร์, ฮือฮา).
- It is surprising, delightful, a first or a record: the kind of thing people forward to friends.

Score attention from 1 to 10 and be honest. Most stories score below ${minAttention}; that is expected, so do not inflate scores.
- 9-10: a national talking point: trending, or covered by many outlets.
- 7-8: clearly viral or widely shared, or covered by more than one outlet.
- 4-6: ordinary news: routine announcements, event listings, local updates, brand or product explainers.
- 1-3: filler, promotions, listicles, tips.

WHAT FITS
The story must be about Thailand or happen in Thailand, and fit one pillar:
- animals: zoo animals, wildlife sightings, conservation wins
- food: street food, convenience-store culture, everyday Thai life and local quirks
- festivals: festivals and seasonal events (Loy Krathong, Songkran, the Vegetarian Festival, local fairs)
- weather: everyday weather and traffic inconvenience (rain, heat, the cool season arriving, Bangkok traffic)
- wins: small national wins (science, technology, tourism records, awards, sport results without disputes)

HARD NO. Skip the story entirely, however much attention it has:
- Anything involving the monarchy or the royal family, royal ceremonies, royal projects or royal vocabulary, even indirectly. When in doubt, skip.
- Politics, politicians, government ministers, elections, protests, the military, border conflicts, war.
- Crime, scams, police, courts, drugs, violence, accidents, deaths, and disasters with casualties, evacuations or serious damage.
- Religious scandals, celebrity gossip, advertising, sponsored content, hotel or product promotions, listicles.
- A private person's misfortune.

TONE
- Dry, short and affectionate. Laugh with Thailand, never at it, and never at any person, place or group.
- Use game vocabulary for framing: patch, buff, nerf, spawn, event, roster, cooldown, known issue, server.
- Every fact must come from the headlines and summaries you were given. Do not invent numbers, names, dates or places. If a detail is not given, leave it out.
- The voice, shown with an invented example (not a real story):
  title_en "Rainy season patch extended; umbrellas remain overpowered"
  body_en "Afternoon storms keep spawning across Bangkok. No fix is scheduled. Players are advised to equip a raincoat."
  title_th "ขยายเวลาแพตช์หน้าฝน ร่มยังแรงเกินไปเหมือนเดิม"
  body_th "พายุช่วงบ่ายยังเกิดถี่ทั่วกรุงเทพฯ ยังไม่มีกำหนดแก้ไข แนะนำให้ผู้เล่นสวมเสื้อกันฝนไว้ก่อน"

TAGS
- new: something new appears (an animal birth, a new attraction, a discovery)
- buff: something got better
- balance: a change with trade-offs, or an adjustment
- event: a festival or a time-limited happening
- known: a recurring everyday annoyance (weather, traffic). Only minor inconvenience, never a disaster.

WRITING
Write every note in both languages. The Thai must read naturally, as a Thai gamer would write it, not as a word-for-word translation. Gaming loanwords such as บัฟ, เนิร์ฟ, อีเวนต์ and แพตช์ are welcome. In Thai text, write years in the Buddhist Era (2026 is 2569).
- title_en: at most 70 characters. title_th: at most 60 Thai characters.
- body_en: one to three short sentences, at most 220 characters. body_th: one to three short sentences, at most 200 Thai characters.

REPLY
One JSON object with two lists:
- "considered": the best headlines that fit a pillar and break no hard rule (at most 8), each with "id", "attention" (1-10) and "reason" (one short sentence naming the evidence of attention). Empty if none fit.
- "picks": a full patch note for every considered headline with attention ${minAttention} or higher. When several headlines are the same story, write it once, from the headline with the most detail. Usually empty.`;

// Gemini response schema: the reply must be exactly this shape.
const str = { type: "STRING" };
const int = { type: "INTEGER" };
export const replySchema = {
  type: "OBJECT",
  properties: {
    considered: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: int, attention: int, reason: str },
        required: ["id", "attention", "reason"],
        propertyOrdering: ["id", "attention", "reason"],
      },
    },
    picks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: int,
          tag: { type: "STRING", enum: TAGS },
          pillar: { type: "STRING", enum: PILLARS },
          title_en: str,
          title_th: str,
          body_en: str,
          body_th: str,
        },
        required: ["id", "tag", "pillar", "title_en", "title_th", "body_en", "body_th"],
        propertyOrdering: ["id", "tag", "pillar", "title_en", "title_th", "body_en", "body_th"],
      },
    },
  },
  required: ["considered", "picks"],
  propertyOrdering: ["considered", "picks"],
};

const list = (lines, empty) => (lines.length ? lines.map((l) => `- ${l}`).join("\n") : `- ${empty}`);

export function userMessage({ candidates, covered, context, trending }) {
  const headlines = candidates
    .map((c, i) => {
      const summary = c.summary.length > 280 ? `${c.summary.slice(0, 280)}…` : c.summary;
      const lang = c.feed.lang === "th" ? "Thai" : "English";
      const via = c.trend ? `, trending search: ${c.trend}` : "";
      return `[${i + 1}] (${c.feed.name.en}, ${lang}${via}) ${c.title}${summary ? `\n    ${summary}` : ""}`;
    })
    .join("\n");
  return [
    `Trending Google searches in Thailand right now:\n${list(trending, "not available for this batch")}`,
    `Already on the site. Do not cover these stories again:\n${list(covered, "none")}`,
    `Other headlines from around the same days. Context only, for judging how widely a story is covered; do not pick from this list:\n${list(context.map((r) => `(${r.f}) ${r.t}`), "none")}`,
    `Headlines to judge:\n${headlines}`,
  ].join("\n\n");
}

/** Pulls { considered, picks } out of the model's reply. Throws if there is no usable JSON. */
export function parseReply(text) {
  const cleaned = String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  const data = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(data.picks)) throw new Error('the reply has no "picks" array');
  return { considered: Array.isArray(data.considered) ? data.considered : [], picks: data.picks };
}

const THAI = /[฀-๿]/;
// Looser than the limits in the prompt; Thai vowel and tone marks count as characters here.
const MAX_LENGTH = { title_en: 90, title_th: 120, body_en: 300, body_th: 360 };

function fieldProblem(p) {
  for (const [field, max] of Object.entries(MAX_LENGTH)) {
    const v = p[field];
    if (typeof v !== "string" || !v.trim()) return `missing ${field}`;
    if (v.length > max) return `${field} is ${v.length} characters (limit ${max})`;
    if (field.endsWith("_th") !== THAI.test(v)) return `${field} is in the wrong language`;
  }
  return null;
}

/**
 * Turns picks into entries. A pick is kept only if the model scored its attention at or above
 * minAttention and it passes every check; anything else is rejected with a reason.
 * `when(candidate)` gives the entry's { date, time }.
 */
export function toEntries({ considered, picks }, candidates, { when, minAttention }) {
  const scores = new Map(considered.map((c) => [Number(c.id), c]));
  const entries = [];
  const rejected = [];
  const used = new Set();
  for (const p of picks) {
    const c = candidates[Number(p?.id) - 1];
    const score = scores.get(Number(p?.id));
    const problem =
      !c ? "unknown headline number" :
      used.has(c) ? "headline picked twice" :
      !score ? "picked without an attention score" :
      !(score.attention >= minAttention) ? `attention ${score.attention} is below ${minAttention}` :
      !TAGS.includes(p.tag) ? `unknown tag "${p.tag}"` :
      !PILLARS.includes(p.pillar) ? `unknown pillar "${p.pillar}"` :
      fieldProblem(p);
    const hit = problem ? null : blockedTerm([p.title_en, p.title_th, p.body_en, p.body_th].join(" "));
    const reason = problem ?? (hit ? `the text contains the blocked term "${hit}"` : null);
    if (reason) {
      rejected.push(`[${p?.id}] ${reason}`);
      continue;
    }
    used.add(c);
    entries.push({
      id: "",
      ...when(c),
      tag: p.tag,
      pillar: p.pillar,
      title: { en: p.title_en.trim(), th: p.title_th.trim() },
      body: { en: p.body_en.trim(), th: p.body_th.trim() },
      source: { name: c.feed.name, url: c.url, headline: c.title },
      attention: { score: score.attention, reason: String(score.reason ?? "").trim() },
    });
  }
  return { entries, rejected };
}
