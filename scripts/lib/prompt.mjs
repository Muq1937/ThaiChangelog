// What the model is asked, and how its answer is checked before anything is saved.
import { TAGS, PILLARS } from "../config.mjs";
import { blockedTerm } from "./blocklist.mjs";

export const systemPrompt = (maxPicks) => `You are the editor of Thailand Changelog, a website that rewrites real news from Thailand as video-game patch notes, in English and Thai.

You get a numbered list of recent headlines from Thai news sites (some in Thai, some in English) and a list of stories already covered. Pick at most ${maxPicks} stories that fit, and write a patch note for each. Picking none is a normal, good outcome when nothing fits.

WHAT FITS
The story must be about Thailand or happen in Thailand, and fit one pillar:
- animals: zoo animals, wildlife sightings, conservation wins
- food: street food, convenience-store culture, everyday Thai life and local quirks
- festivals: festivals and seasonal events (Loy Krathong, Songkran, the Vegetarian Festival, local fairs)
- weather: everyday weather and traffic inconvenience (rain, heat, the cool season arriving, Bangkok traffic)
- wins: small national wins (science, technology, tourism records, awards, sport results without disputes)

HARD NO. Skip the story entirely, however it could be framed:
- Anything involving the monarchy or the royal family, royal ceremonies, royal projects or royal vocabulary, even indirectly. When in doubt, skip.
- Politics, politicians, government ministers, elections, protests, the military, border conflicts, war.
- Crime, scams, police, courts, drugs, violence, accidents, deaths, and disasters with casualties, evacuations or serious damage.
- Religious scandals, celebrity gossip, advertising, sponsored content, hotel or product promotions, listicles.
- A private person's misfortune.

TONE
- Dry, short and affectionate. Laugh with Thailand, never at it, and never at any person, place or group.
- Use game vocabulary for framing only: patch, buff, nerf, spawn, event, roster, cooldown, known issue, server.
- Every fact must come from the headline and summary you were given. Do not invent numbers, names, dates or places. If a detail is not given, leave it out.

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

Reply with one JSON object and nothing else (no markdown fences), in this shape:
{"picks":[{"id":<headline number>,"tag":"${TAGS.join("|")}","pillar":"${PILLARS.join("|")}","title_en":"...","title_th":"...","body_en":"...","body_th":"..."}]}`;

// Gemini response schema: the reply must be exactly this shape.
const str = { type: "STRING" };
export const replySchema = {
  type: "OBJECT",
  properties: {
    picks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "INTEGER" },
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
  required: ["picks"],
};

export function userMessage(candidates, covered) {
  const coveredList = covered.length ? covered.map((t) => `- ${t}`).join("\n") : "- none";
  const headlines = candidates
    .map((c, i) => {
      const summary = c.summary.length > 280 ? `${c.summary.slice(0, 280)}…` : c.summary;
      const lang = c.feed.lang === "th" ? "Thai" : "English";
      return `[${i + 1}] (${c.feed.name.en}, ${lang}) ${c.title}${summary ? `\n    ${summary}` : ""}`;
    })
    .join("\n");
  return `Already covered. Do not cover these stories again:\n${coveredList}\n\nHeadlines:\n${headlines}`;
}

/** Pulls the picks array out of the model's reply. Throws if there is no usable JSON. */
export function parseReply(text) {
  const cleaned = String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  const data = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(data.picks)) throw new Error('the reply has no "picks" array');
  return data.picks;
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

/** Turns validated picks into entries. Anything that fails a check is rejected with a reason. */
export function toEntries(picks, candidates, { date, time, room }) {
  const entries = [];
  const rejected = [];
  const used = new Set();
  for (const p of picks) {
    const c = candidates[Number(p?.id) - 1];
    const problem =
      !c ? "unknown headline number" :
      used.has(c) ? "headline picked twice" :
      !TAGS.includes(p.tag) ? `unknown tag "${p.tag}"` :
      !PILLARS.includes(p.pillar) ? `unknown pillar "${p.pillar}"` :
      fieldProblem(p);
    const hit = problem ? null : blockedTerm([p.title_en, p.title_th, p.body_en, p.body_th].join(" "));
    const reason = problem ?? (hit ? `the text contains the blocked term "${hit}"` : entries.length >= room ? "over the limit for this run" : null);
    if (reason) {
      rejected.push(`[${p?.id}] ${reason}`);
      continue;
    }
    used.add(c);
    entries.push({
      id: "",
      date,
      time,
      tag: p.tag,
      pillar: p.pillar,
      title: { en: p.title_en.trim(), th: p.title_th.trim() },
      body: { en: p.body_en.trim(), th: p.body_th.trim() },
      source: { name: c.feed.name, url: c.url, headline: c.title },
    });
  }
  return { entries, rejected };
}
