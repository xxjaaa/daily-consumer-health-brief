/**
 * generate-feed.js
 *
 * Fetches content from all configured sources and writes raw-feed.json.
 *
 * Sources:
 *   News (28h)    — Fitt Insider, Out of Pocket, Rock Health
 *   Builders (7d) — Owned substacks & podcasts
 *                 — Podcast Index API: guest appearances by builder name
 *                 — Google News RSS: text interviews by builder name
 *                 — YouTube channel RSS: official company channels
 *                 — Mention scan: builder name matches in fetched content
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';
import RSSParser from 'rss-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ─── Config ────────────────────────────────────────────────────────────────

const newsConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'feed-news.json'), 'utf8'));
const buildersConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'feed-builders.json'), 'utf8'));

const NEWS_LOOKBACK_HOURS = parseInt(process.env.NEWS_LOOKBACK_HOURS || '28', 10);
const BUILDER_LOOKBACK_HOURS = parseInt(process.env.BUILDER_LOOKBACK_HOURS || '168', 10);
const newsCutoff = new Date(Date.now() - NEWS_LOOKBACK_HOURS * 60 * 60 * 1000);
const builderCutoff = new Date(Date.now() - BUILDER_LOOKBACK_HOURS * 60 * 60 * 1000);

const parser = new RSSParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
});

// ─── Insight filter config ──────────────────────────────────────────────────

const BUILDER_NAMES = buildersConfig.builders.flatMap(b =>
  b.people.map(p => ({ name: p.name.toLowerCase(), display: p.name, company: b.company }))
);

const BEHAVIOR_KEYWORDS = [
  'learn', 'habit', 'behav', 'chang', 'insight', 'framework', 'strateg',
  'approach', 'protocol', 'routine', 'lesson', 'principle', 'tactic',
  'method', 'how to', 'what works', 'mistake', 'advice', 'scale', 'build',
  'model', 'data', 'research', 'invest', 'found', 'thesis', 'playbook',
  'decision', 'vision', 'why i', 'the truth', 'rethink', 'wrong about',
];

const INSIGHT_SOURCE_TYPES = ['podcast', 'interview', 'substack', 'thread'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRecent(dateStr, cutoff) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? false : d >= cutoff;
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
}

async function fetchRSS(url, sourceName, cutoff) {
  try {
    const feed = await parser.parseURL(url);
    const items = (feed.items || [])
      .filter(item => isRecent(item.pubDate || item.isoDate, cutoff))
      .map(item => ({
        id: item.guid || item.link,
        title: item.title || '',
        url: item.link || '',
        published: item.pubDate || item.isoDate || null,
        summary: stripHtml(item.contentSnippet || item.content || item.summary || ''),
        source: sourceName,
      }));
    console.log(`  ✓ ${sourceName}: ${items.length} recent item(s)`);
    return items;
  } catch (err) {
    console.warn(`  ✗ ${sourceName} (${url}): ${err.message}`);
    return [];
  }
}

// ─── Podcast Index API ──────────────────────────────────────────────────────
// Finds episodes where the person appears as a guest across all indexed podcasts.
// Requires PODCAST_INDEX_API_KEY + PODCAST_INDEX_API_SECRET in .env
// Free registration: https://api.podcastindex.org

async function fetchPodcastIndexByPerson(personName, company) {
  const apiKey = process.env.PODCAST_INDEX_API_KEY;
  const apiSecret = process.env.PODCAST_INDEX_API_SECRET;
  if (!apiKey || !apiSecret) return null; // null = skip, not an error

  try {
    const authDate = Math.floor(Date.now() / 1000).toString();
    const hash = crypto.createHash('sha1')
      .update(apiKey + apiSecret + authDate)
      .digest('hex');

    const since = Math.floor(builderCutoff.getTime() / 1000);
    const url = `https://api.podcastindex.org/api/1.0/search/byperson?q=${encodeURIComponent(personName)}&max=10&since=${since}`;

    const resp = await fetch(url, {
      headers: {
        'X-Auth-Key': apiKey,
        'X-Auth-Date': authDate,
        'Authorization': hash,
        'User-Agent': 'DailyConsumerHealthBrief/1.0',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const episodes = data.items || data.episodes || [];
    const items = episodes
      .filter(ep => {
        const pubDate = ep.datePublished ? new Date(ep.datePublished * 1000) : null;
        return pubDate ? pubDate >= builderCutoff : true;
      })
      .map(ep => ({
        id: `podcastindex-${ep.id || ep.guid}`,
        title: ep.title || ep.episodeTitle || '',
        url: ep.link || ep.enclosureUrl || '',
        published: ep.datePublished ? new Date(ep.datePublished * 1000).toISOString() : null,
        summary: stripHtml(ep.description || ''),
        source: `Podcast — ${ep.feedTitle || 'Unknown Show'}`,
        matched_builder: personName,
        matched_company: company,
        content_type: 'podcast_guest',
      }))
      .filter(i => i.url);

    console.log(`  ✓ Podcast Index — ${personName}: ${items.length} episode(s)`);
    return items;
  } catch (err) {
    console.warn(`  ✗ Podcast Index — ${personName}: ${err.message}`);
    return [];
  }
}

// ─── Google News RSS ────────────────────────────────────────────────────────
// Searches Google News for text interviews mentioning the builder by name.
// No API key required.

async function fetchGoogleNewsInterviews(personName, company) {
  const query = encodeURIComponent(`"${personName}" interview`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  const items = await fetchRSS(url, `Google News — ${personName}`, builderCutoff);
  return items.map(i => ({
    ...i,
    matched_builder: personName,
    matched_company: company,
    content_type: 'interview',
  }));
}

// ─── YouTube Interview Search ───────────────────────────────────────────────
// Searches YouTube for interview videos featuring a specific builder by name.
// Uses YouTube Data API v3 search endpoint.
// Requires YOUTUBE_API_KEY in .env.
// Cost: 100 units per search call. Free quota: 10,000 units/day.
// Get a key: https://console.cloud.google.com → Enable "YouTube Data API v3"

async function searchYouTubeInterviews(personName, company) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null; // null = skip, not an error

  try {
    const publishedAfter = builderCutoff.toISOString();
    const query = encodeURIComponent(`"${personName}" ${company} interview`);
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${query}&type=video&order=date&publishedAfter=${publishedAfter}&maxResults=5&key=${apiKey}`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();

    const items = (data.items || []).map(item => ({
      id: `youtube-${item.id.videoId}`,
      title: item.snippet.title,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      published: item.snippet.publishedAt,
      summary: item.snippet.description?.slice(0, 500) || '',
      source: `YouTube — ${item.snippet.channelTitle}`,
      matched_builder: personName,
      matched_company: company,
      content_type: 'youtube_interview',
    }));

    console.log(`  ✓ YouTube interviews — ${personName}: ${items.length} video(s)`);
    return items;
  } catch (err) {
    console.warn(`  ✗ YouTube interviews — ${personName}: ${err.message}`);
    return [];
  }
}

// ─── Builder mention scan ───────────────────────────────────────────────────
// Scans all fetched items for builder name mentions with insight keywords.
// Catches appearances in news/podcasts outside the dedicated builder fetchers.

function scanForBuilderMentions(allItems) {
  const seen = new Set();
  const mentions = [];

  for (const item of allItems) {
    const text = ((item.title || '') + ' ' + (item.summary || '')).toLowerCase();
    const sourceType = (item.source || item.platform || '').toLowerCase();

    const matchedBuilder = BUILDER_NAMES.find(b => text.includes(b.name));
    if (!matchedBuilder) continue;

    const typeMatch = INSIGHT_SOURCE_TYPES.some(t => sourceType.includes(t));
    const keywordMatch = BEHAVIOR_KEYWORDS.some(kw => text.includes(kw));
    if (!typeMatch || !keywordMatch) continue;

    const isOwnChannel = item.author?.toLowerCase().includes(matchedBuilder.name);
    if (isOwnChannel) continue;

    const key = item.url || item.id;
    if (seen.has(key)) continue;
    seen.add(key);

    mentions.push({
      ...item,
      matched_builder: matchedBuilder.display,
      matched_company: matchedBuilder.company,
      insight_worthy: true,
    });
  }

  return mentions;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nGenerating feed — news: ${NEWS_LOOKBACK_HOURS}h, builder insight: ${BUILDER_LOOKBACK_HOURS}h\n`);

  const output = {
    generated_at: new Date().toISOString(),
    news_cutoff: newsCutoff.toISOString(),
    builder_cutoff: builderCutoff.toISOString(),
    news: [],
    builders: {
      substacks: [],
      podcasts: [],
      podcast_guests: [],  // Podcast Index: guest appearances
      interviews: [],      // Google News: text interviews
      youtube: [],         // YouTube channel: official videos
      mentions: [],        // Mention scan: name matches in fetched content
    },
  };

  // ── 1. News sources (28h) ────────────────────────────────────────────────
  console.log('── News Sources ──');
  for (const source of newsConfig.sources) {
    if (source.feeds) {
      for (const feed of source.feeds) {
        const items = await fetchRSS(feed.url, `${source.name} — ${feed.name}`, newsCutoff);
        output.news.push(...items);
      }
    }
    if (source.podcast) {
      const items = await fetchRSS(source.podcast.rss, `${source.name} — Podcast`, newsCutoff);
      output.news.push(...items);
    }
  }

  // ── 2. Builder substacks (7d) ────────────────────────────────────────────
  console.log('\n── Builder Substacks ──');
  for (const sub of buildersConfig.substacks) {
    const items = await fetchRSS(sub.feed, sub.name, builderCutoff);
    output.builders.substacks.push(
      ...items.map(i => ({ ...i, author: sub.author, platform: 'Substack' }))
    );
  }

  // ── 3. Builder podcasts (7d) ─────────────────────────────────────────────
  console.log('\n── Builder Podcasts ──');
  for (const pod of buildersConfig.podcasts) {
    const items = await fetchRSS(pod.rss, pod.name, builderCutoff);
    output.builders.podcasts.push(
      ...items.map(i => ({ ...i, show: pod.name, platform: 'Podcast' }))
    );
  }

  // ── 4. Podcast Index: guest appearances (7d) ─────────────────────────────
  console.log('\n── Podcast Index (Guest Appearances) ──');
  const podcastIndexEnabled = !!(process.env.PODCAST_INDEX_API_KEY && process.env.PODCAST_INDEX_API_SECRET);
  if (!podcastIndexEnabled) {
    console.log('  ⚠ PODCAST_INDEX_API_KEY / PODCAST_INDEX_API_SECRET not set — skipping');
  } else {
    for (const company of buildersConfig.builders) {
      for (const person of company.people) {
        const episodes = await fetchPodcastIndexByPerson(person.name, company.company);
        if (episodes) output.builders.podcast_guests.push(...episodes);
      }
    }
  }

  // ── 5. Google News: text interviews (7d) ─────────────────────────────────
  console.log('\n── Google News (Interviews) ──');
  for (const company of buildersConfig.builders) {
    for (const person of company.people) {
      const articles = await fetchGoogleNewsInterviews(person.name, company.company);
      output.builders.interviews.push(...articles);
    }
  }

  // ── 6. YouTube interview search (7d) ─────────────────────────────────────
  console.log('\n── YouTube (Interview Search) ──');
  if (!process.env.YOUTUBE_API_KEY) {
    console.log('  ⚠ YOUTUBE_API_KEY not set — skipping');
  } else {
    for (const company of buildersConfig.builders) {
      for (const person of company.people) {
        const videos = await searchYouTubeInterviews(person.name, company.company);
        if (videos) output.builders.youtube.push(...videos);
      }
    }
  }

  // ── 7. Builder mention scan ──────────────────────────────────────────────
  console.log('\n── Builder Mention Scan ──');
  const allFetched = [
    ...output.news,
    ...output.builders.substacks,
    ...output.builders.podcasts,
  ];
  output.builders.mentions = scanForBuilderMentions(allFetched);
  console.log(`  ✓ Insight-worthy builder mentions: ${output.builders.mentions.length}`);

  // ── Write output ─────────────────────────────────────────────────────────
  const outPath = path.join(ROOT, 'raw-feed.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  const total =
    output.news.length +
    output.builders.substacks.length +
    output.builders.podcasts.length +
    output.builders.podcast_guests.length +
    output.builders.interviews.length +
    output.builders.youtube.length +
    output.builders.mentions.length;

  console.log(`\n✅ raw-feed.json written — ${total} total items`);
  console.log(`   News: ${output.news.length}`);
  console.log(`   Builder substacks: ${output.builders.substacks.length}`);
  console.log(`   Builder podcasts: ${output.builders.podcasts.length}`);
  console.log(`   Builder podcast guests (Podcast Index): ${output.builders.podcast_guests.length}`);
  console.log(`   Builder interviews (Google News): ${output.builders.interviews.length}`);
  console.log(`   Builder YouTube: ${output.builders.youtube.length}`);
  console.log(`   Builder mentions (scan): ${output.builders.mentions.length}`);
}

main().catch(err => {
  console.error('Fatal error in generate-feed:', err);
  process.exit(1);
});
