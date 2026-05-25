# Annotator Robot

Standalone repo + CLI for the workflow-driven annotator stage.

## What it does

- Pulls one `writer_done` queue group or reads a local JSON payload
- Extracts fact-like claims from `draft_json.meta.description` and `draft_json.content[]`
- Matches sources from `sources[]`, H2 `source_hints[]`, queue `source_hints[]`, then Source Rescue
- Grounds claims with fetched page text and emits fixed-schema `comments[]`
- Runs high-risk double verification
- Calculates `key_claims` coverage and produces `【規劃缺漏】` comments when needed
- Writes only `draft_json.comments` and status fields

## Supported content blocks

- `h1`, `h2`, `h3`
- `p`
- `bullet`, `numbered`
- `table`
- `faq`
- Reads but skips claim annotation for `meta_box`, `disclaimer`, `spacer`, `page_break`

## CLI

### 1. Dry run with local JSON

```bash
node ./src/cli.js annotate-json --input ./fixtures/sample-payload.json
```

Optional output file:

```bash
node ./src/cli.js annotate-json --input ./fixtures/sample-payload.json --output ./tmp/result.json
```

### 2. Run once against Postgres / Neon

Set `DATABASE_URL` and run:

```bash
node ./src/cli.js run-once
```

## Environment

Copy `.env.example` to `.env` and fill in the database connection when using DB mode:

```bash
DATABASE_URL=postgres://user:password@host:5432/dbname
```

## Payload expectations

### Queue row

The runner expects queue-level fields equivalent to:

- `id`
- `topic`
- `proposed_h1`
- `proposed_outline`
- `proposed_satellites`
- `source_hints`
- `target_reader`
- `planner_mode`

### Article row

- `id`
- `title`
- `slug`
- `content_tier`
- `target_reader`
- `draft_json`
- `meta_description`
- `status`
- `journey_stage_id`
- `is_main`

### `draft_json`

- `meta.description`
- `content[]`
- `sources[]`
- `comments[]`

## Comment schema

Every output comment is written with exactly these 11 keys:

- `id`
- `search_text`
- `placement`
- `label`
- `checkpoint`
- `url`
- `position`
- `verbatim`
- `scope`
- `supplemental`
- `fallback`

## Notes

- `proposed_outline` is currently adapted as an H2-array shape:
  - `[{ h2, key_claims, source_hints }]`
- If the real payload differs, update `src/adapters/outline-adapter.js`
- Reviewer-rich fields from the previous document workflow are intentionally not written into `comments[]`

## Push to a new repo

Inside this folder:

```bash
git remote add origin <your-new-repo-url>
git push -u origin main
```
