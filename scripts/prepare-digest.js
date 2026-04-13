/**
 * prepare-digest.js
 *
 * Reads raw-feed.json, deduplicates against state-feed.json (cross-run)
 * and by URL within this run, structures content into sections,
 * and writes digest-ready.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const MAX_NEWS_ITEMS = 8;
const MAX_SUMMARY_CHARS = 1200;

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function normaliseUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().trim();
  }
}

function main() {
  const rawPath = path.join(ROOT, 'raw-feed.json');
  if (!fs.existsSync(rawPath)) {
    console.error('raw-feed.json not found. Run generate-feed.js first.');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

  const statePath = path.join(ROOT, 'state-feed.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const seenIds = new Set(state.seen_ids || []);
  const seenUrls = new Set(); // within-run URL dedup

  function isNew(item) {
    const id = item.id || item.url;
    if (!id) return false;
    if (seenIds.has(id)) return false;
    const normUrl = normaliseUrl(item.url);
    if (normUrl && seenUrls.has(normUrl)) return false;
    seenUrls.add(normUrl);
    return true;
  }

  function mapBase(item) {
    return {
      id: item.id || item.url,
      title: item.title,
      url: item.url,
      published: item.published,
      summary: truncate(item.summary, MAX_SUMMARY_CHARS),
    };
  }

  // ── 1. News ────────────────────────────────────────────────────────────────
  const newsItems = raw.news
    .filter(isNew)
    .filter(i => i.url)
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .slice(0, MAX_NEWS_ITEMS)
    .map(i => ({ ...mapBase(i), source: i.source }));

  // ── 2. Builder substacks ───────────────────────────────────────────────────
  const substackItems = raw.builders.substacks
    .filter(isNew).filter(i => i.url)
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .map(i => ({ ...mapBase(i), type: 'substack', author: i.author, platform: 'Substack' }));

  // ── 3. Builder podcasts (owned shows) ─────────────────────────────────────
  // Podcasts are NOT cross-run deduplicated — we always want the latest episode
  // even if it was seen in a previous run. Only deduplicate within this run by URL.
  const podcastItems = raw.builders.podcasts
    .filter(i => {
      if (!i.url) return false;
      const normUrl = normaliseUrl(i.url);
      if (seenUrls.has(normUrl)) return false;
      seenUrls.add(normUrl);
      return true;
    })
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .map(i => ({ ...mapBase(i), type: 'podcast', show: i.show, platform: 'Podcast' }));

  // ── 4. Podcast guest appearances (Podcast Index) ───────────────────────────
  const podcastGuestItems = (raw.builders.podcast_guests || [])
    .filter(isNew).filter(i => i.url)
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .map(i => ({
      ...mapBase(i),
      type: 'podcast_guest',
      matched_builder: i.matched_builder,
      matched_company: i.matched_company,
      source: i.source,
    }));

  // ── 5. Text interviews (Google News) ──────────────────────────────────────
  const interviewItems = (raw.builders.interviews || [])
    .filter(isNew).filter(i => i.url)
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .map(i => ({
      ...mapBase(i),
      type: 'interview',
      matched_builder: i.matched_builder,
      matched_company: i.matched_company,
      source: i.source,
    }));

  // ── 6. YouTube channel videos ──────────────────────────────────────────────
  const youtubeItems = (raw.builders.youtube || [])
    .filter(isNew).filter(i => i.url)
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .map(i => ({
      ...mapBase(i),
      type: 'youtube',
      company: i.company,
      source: i.source,
    }));

  // ── 7. Builder mention scan ────────────────────────────────────────────────
  const mentionItems = (raw.builders.mentions || [])
    .filter(isNew).filter(i => i.url)
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .map(i => ({
      ...mapBase(i),
      type: 'mention',
      matched_builder: i.matched_builder,
      matched_company: i.matched_company,
      source: i.source,
      insight_worthy: true,
    }));

  // ── Collect new IDs for state update ──────────────────────────────────────
  const allNewIds = [
    ...newsItems, ...substackItems, ...podcastItems,
    ...podcastGuestItems, ...interviewItems, ...youtubeItems, ...mentionItems,
  ].map(i => i.id).filter(Boolean);

  // ── Write digest-ready.json ────────────────────────────────────────────────
  const digest = {
    generated_at: raw.generated_at,
    prepared_at: new Date().toISOString(),
    sections: {
      daily_news: newsItems,
      builder_insight: {
        substacks: substackItems,
        podcasts: podcastItems,
        podcast_guests: podcastGuestItems,   // guest appearances via Podcast Index
        interviews: interviewItems,           // text interviews via Google News
        youtube: youtubeItems,                // official YouTube channel videos
        mentions: mentionItems,               // mention scan matches
      },
    },
    new_ids: allNewIds,
  };

  const outPath = path.join(ROOT, 'digest-ready.json');
  fs.writeFileSync(outPath, JSON.stringify(digest, null, 2));

  console.log('✅ digest-ready.json written');
  console.log(`   Daily News: ${newsItems.length}`);
  console.log(`   Builder substacks: ${substackItems.length}`);
  console.log(`   Builder podcasts: ${podcastItems.length}`);
  console.log(`   Podcast guests (Podcast Index): ${podcastGuestItems.length}`);
  console.log(`   Interviews (Google News): ${interviewItems.length}`);
  console.log(`   YouTube: ${youtubeItems.length}`);
  console.log(`   Mentions (scan): ${mentionItems.length}`);

  const total = newsItems.length + substackItems.length + podcastItems.length +
    podcastGuestItems.length + interviewItems.length + youtubeItems.length + mentionItems.length;
  if (total === 0) console.log('\nℹ No new content found.');
}

main();
