/**
 * deliver.js
 *
 * Reads digest-ready.json, calls Claude to write the brief,
 * sends it as an HTML email, then updates state-feed.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ─── Load files ──────────────────────────────────────────────────────────────

const digestPath = path.join(ROOT, 'digest-ready.json');
if (!fs.existsSync(digestPath)) {
  console.error('digest-ready.json not found. Run prepare-digest.js first.');
  process.exit(1);
}
const digest = JSON.parse(fs.readFileSync(digestPath, 'utf8'));

// ─── Staleness guard ─────────────────────────────────────────────────────────
// Refuse to deliver if digest-ready.json was prepared more than 4 hours ago.
// This prevents accidentally sending stale content from a previous run.
const MAX_DIGEST_AGE_HOURS = 4;
const preparedAt = new Date(digest.prepared_at || digest.generated_at);
const ageHours = (Date.now() - preparedAt.getTime()) / (1000 * 60 * 60);
if (ageHours > MAX_DIGEST_AGE_HOURS) {
  console.error(
    `❌ digest-ready.json is ${ageHours.toFixed(1)}h old (prepared: ${preparedAt.toISOString()}).`,
  );
  console.error('   Re-run generate-feed.js and prepare-digest.js before delivering.');
  process.exit(1);
}

const statePath = path.join(ROOT, 'state-feed.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

// Load prompts
const promptsDir = path.join(ROOT, 'prompts');
const digestIntro = fs.readFileSync(path.join(promptsDir, 'digest-intro.md'), 'utf8');
const summarizeNews = fs.readFileSync(path.join(promptsDir, 'summarize-news.md'), 'utf8');
const summarizeBuilder = fs.readFileSync(path.join(promptsDir, 'summarize-builder.md'), 'utf8');
const summarizePodcast = fs.readFileSync(path.join(promptsDir, 'summarize-podcast.md'), 'utf8');

// ─── Validate env ────────────────────────────────────────────────────────────

const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

const required = DRY_RUN
  ? ['ANTHROPIC_API_KEY']
  : ['ANTHROPIC_API_KEY', 'EMAIL_TO', 'EMAIL_FROM', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ─── Build prompt ─────────────────────────────────────────────────────────────

function buildPrompt(digest) {
  const { daily_news, builder_insight } = digest.sections;
  const date = new Date(digest.generated_at).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  let prompt = `${digestIntro}\n\n`;
  prompt += `Today's date: ${date}\n\n`;
  prompt += `---\n\n`;

  // News section
  prompt += `## RAW DATA — SECTION 1: DAILY NEWS\n\n`;
  prompt += `Summarization instructions:\n${summarizeNews}\n\n`;
  if (daily_news.length === 0) {
    prompt += `*No new news items fetched today.*\n\n`;
  } else {
    prompt += `Items (${daily_news.length} total — select the 4–6 most relevant):\n\n`;
    prompt += JSON.stringify(daily_news, null, 2) + '\n\n';
  }

  // Builder insight section
  prompt += `---\n\n## RAW DATA — SECTION 2: BUILDER INSIGHT\n\n`;

  if (builder_insight.substacks?.length > 0) {
    prompt += `### Substack / Newsletter Articles\n`;
    prompt += `Summarization instructions:\n${summarizeBuilder}\n\n`;
    prompt += JSON.stringify(builder_insight.substacks, null, 2) + '\n\n';
  }

  if (builder_insight.podcasts?.length > 0) {
    prompt += `### Podcast Episodes (owned shows)\n`;
    prompt += `Summarization instructions:\n${summarizePodcast}\n\n`;
    prompt += JSON.stringify(builder_insight.podcasts, null, 2) + '\n\n';
  }

  if (builder_insight.podcast_guests?.length > 0) {
    prompt += `### Builder Guest Appearances (Podcast Index)\n`;
    prompt += `Summarization instructions:\n${summarizePodcast}\n\n`;
    prompt += JSON.stringify(builder_insight.podcast_guests, null, 2) + '\n\n';
  }

  if (builder_insight.interviews?.length > 0) {
    prompt += `### Text Interviews (Google News)\n`;
    prompt += `Summarization instructions:\n${summarizeBuilder}\n\n`;
    prompt += JSON.stringify(builder_insight.interviews, null, 2) + '\n\n';
  }

  if (builder_insight.youtube?.length > 0) {
    prompt += `### YouTube Interview Videos\n`;
    prompt += `Summarization instructions:\n${summarizeBuilder}\n\n`;
    prompt += JSON.stringify(builder_insight.youtube, null, 2) + '\n\n';
  }

  if (builder_insight.mentions?.length > 0) {
    prompt += `### Builder Mentions in Tracked Content\n`;
    prompt += `Summarization instructions:\n${summarizeBuilder}\n\n`;
    prompt += JSON.stringify(builder_insight.mentions, null, 2) + '\n\n';
  }

  const hasBuilderContent = ['substacks','podcasts','podcast_guests','interviews','youtube','mentions']
    .some(k => builder_insight[k]?.length > 0);
  if (!hasBuilderContent) {
    prompt += `*No new builder content fetched today.*\n\n`;
  }

  prompt += `---\n\nNow write the complete Daily Consumer Health Brief following the assembly instructions above.`;
  return prompt;
}

// ─── Generate brief via Claude ───────────────────────────────────────────────

async function generateBrief(prompt) {
  const client = new Anthropic();
  console.log('Calling Claude API...');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

// ─── Format as HTML email ─────────────────────────────────────────────────────

function markdownToHtml(text) {
  return text
    // Headers
    .replace(/^## (.+)$/gm, '<h2 style="color:#1a1a2e;margin:24px 0 8px;">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 style="color:#16213e;margin:20px 0 6px;">$1</h3>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#0066cc;">$1</a>')
    // Bullets
    .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>(\n|$))+/g, '<ul style="margin:8px 0 8px 20px;">$&</ul>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0;">')
    // Paragraphs (double newlines)
    .replace(/\n\n/g, '</p><p style="margin:8px 0;line-height:1.6;">')
    .replace(/\n/g, '<br>');
}

function buildEmail(briefText, date) {
  const html = markdownToHtml(briefText);
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1a1a1a;background:#ffffff;">
  <div style="border-bottom:2px solid #1a1a2e;padding-bottom:12px;margin-bottom:24px;">
    <h1 style="margin:0;font-size:20px;color:#1a1a2e;">Daily Consumer Health Brief</h1>
    <p style="margin:4px 0 0;font-size:13px;color:#666;">${date}</p>
  </div>
  <div style="font-size:15px;line-height:1.6;">
    <p style="margin:8px 0;line-height:1.6;">${html}</p>
  </div>
</body>
</html>`;
}

// ─── Send email ───────────────────────────────────────────────────────────────

async function sendEmail(briefText, date) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const subject = `Daily Consumer Health Brief — ${date}`;
  const htmlBody = buildEmail(briefText, date);

  await transporter.sendMail({
    from: `"Daily Health Brief" <${process.env.EMAIL_FROM}>`,
    to: process.env.EMAIL_TO,
    subject,
    html: htmlBody,
    text: briefText,
  });

  console.log(`✅ Email sent to ${process.env.EMAIL_TO}`);
}

// ─── Update state ─────────────────────────────────────────────────────────────

function updateState(newIds) {
  const MAX_STATE_IDS = 500; // prevent unbounded growth
  const updated = {
    last_run: new Date().toISOString(),
    seen_ids: [...new Set([...(state.seen_ids || []), ...newIds])].slice(-MAX_STATE_IDS),
  };
  fs.writeFileSync(statePath, JSON.stringify(updated, null, 2));
  console.log(`✅ state-feed.json updated (${updated.seen_ids.length} seen IDs)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const bi = digest.sections.builder_insight;
  const totalItems =
    digest.sections.daily_news.length +
    (bi.substacks?.length || 0) +
    (bi.podcasts?.length || 0) +
    (bi.podcast_guests?.length || 0) +
    (bi.interviews?.length || 0) +
    (bi.youtube?.length || 0) +
    (bi.mentions?.length || 0);

  if (totalItems === 0) {
    console.log('ℹ No new content to deliver. Skipping email.');
    updateState([]);
    return;
  }

  const date = new Date(digest.generated_at).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const prompt = buildPrompt(digest);
  const briefText = await generateBrief(prompt);

  if (DRY_RUN) {
    const previewPath = path.join(ROOT, 'digest-preview.md');
    fs.writeFileSync(previewPath, `# Daily Consumer Health Brief — ${date}\n\n${briefText}`);
    console.log(`\n✅ Dry run complete — brief saved to digest-preview.md`);
    console.log('   (No email sent, state not updated)\n');
    console.log('─'.repeat(60));
    console.log(briefText);
    console.log('─'.repeat(60));
    return;
  }

  await sendEmail(briefText, date);
  updateState(digest.new_ids || []);
}

main().catch(err => {
  console.error('Fatal error in deliver:', err);
  process.exit(1);
});
