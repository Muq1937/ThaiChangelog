// Client for the Google Gemini API (generateContent). The key comes from GEMINI_API_KEY:
// a GitHub Actions secret in production, the git-ignored .env file locally.
//
// GEMINI_MODEL is a comma-separated list tried in order. Models get overloaded and retired
// (gemini-2.5-flash is already closed to new keys), so a busy, timed-out or missing model
// falls through to the next one instead of failing the run. Flash-Lite is deliberately left
// out: in testing it scored too generously and broke the hard rules.
// The free tier allows 20 requests a day per model.

export class QuotaError extends Error {}
export class OutageError extends Error {}
class TryNextModel extends Error {
  constructor(message, { quota = false } = {}) { super(message); this.quota = quota; }
}

const DEFAULT_MODELS = "gemini-3.5-flash,gemini-flash-latest";
const API = "https://generativelanguage.googleapis.com/v1beta/models";
const ATTEMPTS_PER_MODEL = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Google's own suggestion, from the Retry-After header or the error's RetryInfo ("17s").
function suggestedDelay(res, data) {
  const after = parseFloat(res?.headers.get("retry-after"));
  if (Number.isFinite(after)) return after;
  const info = data?.error?.details?.find((d) => String(d["@type"]).endsWith("RetryInfo"));
  const suggested = parseFloat(info?.retryDelay);
  return Number.isFinite(suggested) ? suggested : null;
}

// Which quotas a 429 names, e.g. "GenerateRequestsPerMinutePerProjectPerModel-FreeTier".
function quotaIds(data) {
  const failure = data?.error?.details?.find((d) => String(d["@type"]).endsWith("QuotaFailure"));
  return (failure?.violations ?? []).map((v) => v.quotaId).filter(Boolean);
}

async function callModel(model, key, body) {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= ATTEMPTS_PER_MODEL - 1;
    let res;
    try {
      res = await fetch(`${API}/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      if (last) throw new TryNextModel(`${model} did not answer (${err.name}).`);
      console.warn(`${model} did not answer (${err.name}); retrying.`);
      continue;
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON; reported below */ }
    const message = data?.error?.message ?? text.slice(0, 400);

    if (res.status === 404) throw new TryNextModel(`${model} is not available: ${message}`);
    if (res.status === 403 || (res.status === 400 && /api key/i.test(message))) {
      throw new Error(`Gemini rejected the API key (HTTP ${res.status}): ${message}`);
    }
    // A per-minute limit or a busy server clears with a short wait. Google says how long when
    // it can; a 429 with no suggested wait that names only per-day quotas means the day's
    // allowance for this model is spent.
    if (res.status === 429 || res.status >= 500) {
      const ids = res.status === 429 ? quotaIds(data) : [];
      const delay = suggestedDelay(res, data);
      const quotaNote = ids.length ? ` (${ids.join(", ")})` : "";
      if (res.status === 429 && delay === null && ids.length && ids.every((id) => /PerDay/i.test(id))) {
        throw new TryNextModel(`${model} daily quota used up${quotaNote}.`, { quota: true });
      }
      if (last || (delay ?? 0) > 90) {
        throw new TryNextModel(`${model} kept returning ${res.status}${quotaNote}.`, { quota: res.status === 429 });
      }
      const wait = delay ?? 2 ** (attempt + 1); // 2, 4 s
      console.warn(`${model} returned ${res.status}${quotaNote}; retrying in ${wait}s.`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status} for ${model}: ${message}`);

    if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt (${data.promptFeedback.blockReason}).`);
    const candidate = data.candidates?.[0];
    const content = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (!content.trim()) throw new Error(`Empty reply from ${model} (finish reason: ${candidate?.finishReason ?? "unknown"}).`);

    const u = data.usageMetadata ?? {};
    return {
      content,
      finish: candidate.finishReason,
      model: data.modelVersion ?? model,
      usage: { prompt_tokens: u.promptTokenCount, completion_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
    };
  }
}

/**
 * messages: OpenAI-style [{ role: "system" | "user" | "assistant", content }].
 * schema: optional response schema; when given, Gemini must reply with matching JSON.
 */
export async function chat({ messages, schema, maxTokens = 16384, temperature = 0.7 }) {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("GEMINI_API_KEY is not set.");
  const models = (process.env.GEMINI_MODEL || DEFAULT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);

  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const body = {
    contents: messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens, // includes the model's thinking
      ...(schema && { responseMimeType: "application/json", responseSchema: schema }),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const failures = [];
  for (const model of models) {
    try {
      return await callModel(model, key, body);
    } catch (err) {
      if (!(err instanceof TryNextModel)) throw err;
      failures.push(err);
      console.warn(err.message);
    }
  }
  const summary = failures.map((f) => f.message).join(" ");
  throw failures.every((f) => f.quota) ? new QuotaError(`Gemini quota exhausted. ${summary}`) : new OutageError(`No Gemini model answered. ${summary}`);
}
