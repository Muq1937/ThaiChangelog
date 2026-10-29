# Thailand Changelog

Real news from Thailand, rewritten as video-game patch notes in Thai and English. Checked every hour.

Site: https://muq1937.github.io/ThaiChangelog/ · RSS: [`feed.xml`](https://muq1937.github.io/ThaiChangelog/feed.xml) (English), [`feed-th.xml`](https://muq1937.github.io/ThaiChangelog/feed-th.xml) (Thai)

## How it works

Every hour GitHub Actions runs [`scripts/update.mjs`](scripts/update.mjs) ([`hourly.yml`](.github/workflows/hourly.yml)):

1. Read the RSS feeds listed in [`scripts/config.mjs`](scripts/config.mjs) (English: Thaiger, Khaosod English; Thai: Khaosod, Matichon, Sanook), plus [Google Trends for Thailand](https://trends.google.com/trending?geo=TH): what people are searching for right now, with linked articles.
2. Drop links already judged, and stories older than 36 hours.
3. Drop every hard-no topic with a keyword list in Thai and English ([`scripts/lib/blocklist.mjs`](scripts/lib/blocklist.mjs)), before the model sees anything.
4. Send the new headlines to Google Gemini in batches of 40, with the trending searches and nearby headlines as context ([`scripts/lib/prompt.mjs`](scripts/lib/prompt.mjs)). Gemini scores the best few for **public attention** (1-10): is it trending, covered by several outlets, called viral, the kind of thing people forward? Every story scoring **8 or more** is written up, in English and Thai; there is no cap. Most hours nothing qualifies, and nothing is published.
5. Check the reply in code: the attention score, tags, lengths, language, and the blocklist again. Save each story as its own file in `data/entries/`.
6. **Review mode** (default): open a pull request. Merging it publishes. **Auto mode**: commit straight to `main`.
7. [`scripts/build.mjs`](scripts/build.mjs) turns the entries into the site ([`site/index.html`](site/index.html)), `entries.json` and the two RSS feeds, and [`deploy.yml`](.github/workflows/deploy.yml) publishes them to GitHub Pages.

The list of links already judged is kept in the Actions cache (`.state/`), not in git.

## Content rules

**Pillars:** animals, food and everyday life, festivals, weather and traffic (as "known issues"), small national wins.

**Hard no's:** the monarchy (Thailand's lèse-majesté law), politics, crime, scams, and tragedy. These are blocked in code, in the prompt, and (in review mode) by a person. Over-blocking is acceptable. Never loosen the monarchy list.

**Tone:** dry, short and affectionate. Laughing with Thailand, never at it.

**The bar:** a story needs real public attention. The benchmark is Moo Deng. Each run's log (Actions → Hourly news check → a run → "Find and write stories") lists what Gemini considered and the score it gave, so near-misses are visible. To publish more or less, change `minAttention` in [`scripts/config.mjs`](scripts/config.mjs).

**Backfill:** Actions → Hourly news check → Run workflow, with *backfill days* set to, say, 14. It reads older pages of the feeds that offer them (Thaiger, Khaosod English, Matichon; Khaosod Lifestyle already spans about two weeks) and judges one day at a time. Stories are dated to when they were reported.

## Setup

1. **Settings → Pages → Source:** GitHub Actions.
2. **Settings → Actions → General → Workflow permissions:** tick *Allow GitHub Actions to create and approve pull requests* (needed for review mode).
3. **Settings → Secrets and variables → Actions → Secrets:** add `GEMINI_API_KEY`.
4. **Actions → Hourly news check → Run workflow** to test it once.

Optional repository **variables** (same page, Variables tab):

| Variable | Default | Meaning |
|---|---|---|
| `PUBLISH_MODE` | `review` | `review` opens a pull request per batch; `auto` publishes directly |
| `GEMINI_MODEL` | `gemini-3.5-flash,gemini-flash-latest` | Models to try, in order. The next one is used when one is overloaded or retired |

## Running it locally

Needs Node 20.12 or newer. Put the key in `.env` (git-ignored):

```
GEMINI_API_KEY=...
```

```
node scripts/update.mjs --dry-run   # read and filter the feeds; no AI call, writes nothing
node scripts/update.mjs --preview   # also call Gemini and print the notes; writes nothing
node scripts/update.mjs --preview --backfill 3   # the same, for the past 3 days
node scripts/build.mjs              # build the site into _site/
```

## When something breaks

A failed scheduled run sends GitHub's usual failure email. The run log says which step failed.

- **"No Gemini model answered"**: Gemini was overloaded (HTTP 503). The next hourly run judges the same headlines again.
- **"Gemini quota exhausted"**: the free-tier limit for the day was reached. It resets daily.
- **"Gemini rejected the API key"**: replace the `GEMINI_API_KEY` secret.
- **A feed failed**: the run continues with the other feeds. If a feed keeps failing, remove or replace it in `scripts/config.mjs`.
