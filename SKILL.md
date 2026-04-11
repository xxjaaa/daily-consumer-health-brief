---
name: daily-health-brief
description: >
  Delivers a curated Daily Consumer Health Brief covering industry news and builder insights.
  Use this skill whenever the user runs /daily-health-brief, asks for their daily consumer health
  brief, wants to see what's happening in consumer health today, or asks about news from Fitt Insider,
  Out of Pocket, Rock Health, or what tracked founders and builders have published or said recently.
---

# Daily Consumer Health Brief

**Trigger**: When the user runs `/daily-health-brief` or asks for their daily consumer health brief.

---

## What This Skill Does

Delivers a curated daily brief covering:
1. **Daily News** — Fitt Insider, Out of Pocket, Rock Health
2. **Builder Insight** — what consumer health founders published, posted, or said in the last 24 hours

---

## Instructions for Claude

When this skill is triggered, follow these steps in order:

### Step 1 — Fetch latest content

Run the feed scripts from the `scripts/` directory:

```bash
cd scripts && node --env-file=../.env generate-feed.js && node --env-file=../.env prepare-digest.js
```

If the `.env` file doesn't exist yet, tell the user:
> "I need a `.env` file in the project root with at least `LOOKBACK_HOURS=168`. Run: `cp .env.example .env` and fill it in."

### Step 2 — Read the fetched content

Read the file `digest-ready.json`. This contains all the fetched news and builder content structured into sections.

### Step 3 — Read the prompt instructions

Read all four files in `prompts/`:
- `prompts/digest-intro.md` — how to assemble the final brief
- `prompts/summarize-news.md` — how to summarize news items
- `prompts/summarize-builder.md` — how to summarize builder posts and substacks
- `prompts/summarize-podcast.md` — how to summarize podcast episodes

### Step 4 — Generate the brief

Following the instructions in `prompts/digest-intro.md`, write the complete Daily Consumer Health Brief using the content from `digest-ready.json`.

Apply the summarization guidelines from the other prompt files as you write each section.

### Step 5 — Save and display

Write the complete brief to `digest-output.md` in the project root.

Display the brief to the user directly in chat.

### Step 6 — Offer email delivery

Ask the user:
> "Would you like me to send this to your email? If yes, make sure `EMAIL_TO`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS` are set in your `.env` file."

If they say yes, run:
```bash
cd scripts && node --env-file=../.env send-email.js
```

### Step 7 — Update state

After the user confirms they're satisfied with the brief, update `state-feed.json` by noting that the items in `digest-ready.json` have been seen, so they won't be repeated in tomorrow's brief.

---

## Setup (first time)

```bash
# 1. Install dependencies
cd scripts && npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — minimum required: LOOKBACK_HOURS=168
# For email delivery, also add SMTP credentials
```

## Customization

| What | Where |
|---|---|
| News sources | `feed-news.json` |
| Tracked builders & handles | `feed-builders.json` |
| Brief tone & format | `prompts/digest-intro.md` |
| How each section is written | `prompts/summarize-*.md` |
| Delivery schedule (GitHub Actions) | `.github/workflows/daily-brief.yml` |
