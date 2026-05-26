# SEO-Annotator

Annotator Robot for the workflow-driven review stage. Reads articles
that Writer has finished (`content_queue.status = 'writer_done'`),
verifies their factual claims against external sources, and produces
the fixed-schema `comments[]` that the planner UI's `DraftViewer`
renders as an inline annotation margin. **Never mutates article body
content.**

## What it does

1. **Pulls** one `writer_done` queue group (atomically, with
   `FOR UPDATE SKIP LOCKED`) or reads a local JSON payload.
2. **Extracts** fact-like claims from `draft_json.meta.description` and
   `draft_json.content[]` (9 categories — numbers, dates, drug names,
   mechanism, epidemiology, comparative, etc).
3. **Matches** sources to each claim in this priority order:
   inline `draft_json.sources[]` (zero-score sources still tried) →
   `proposed_outline[i].source_hints[]` → `queue.source_hints[]`.
4. **Grounds** each claim against the source URL:
   - Layer 1: `fetchWithRetry` (15 s timeout, 1 retry on transient 5xx)
   - Layer 2c: Playwright browser fetch (same URL, JS rendering /
     reCAPTCHA / login walls). **Optional dependency** — skipped
     gracefully if not installed.
   - Layer 2a/2b: WebSearch alternates / secondary citations.
   - Layer 3: emit a placeholder comment with `⚠️ 原文待確認`.
5. **Double-verifies** high-risk values (dates, percentages, month
   counts, NCCN Category, hazard ratios, Taiwan availability).
   Surfaces mismatches via `checkpoint` warnings — content stays
   untouched.
6. **Calculates `key_claims` coverage** against
   `proposed_outline[*].key_claims[]`. Below 50% → fails the queue.
7. **Validates** the produced `comments[]` against the 11-key schema
   before writing.
8. **Submits** comments + flips `articles.status` and
   `content_queue.status` to `needs_review` in one transaction.

## Supported content blocks

Extracts claims from: `h1`, `h2`, `h3`, `p`, `bullet`, `numbered`,
`table`, `faq`. Reads but skips: `meta_box`, `disclaimer`, `spacer`,
`page_break`.

## Group-level failure conditions

If any of the following triggers, the whole group is `mark_failed`
(reviewer must reset to `writer_done` in the planner UI before
re-attempting):

| Condition | Reason text starts with |
|---|---|
| `key_claims` coverage < 50% for any article | `Writer 成稿覆蓋率不足` |
| Grounded ratio < 30% for any article (all comments would be placeholders) | `Source grounding 失敗率過高` |
| Schema validation fails | `Schema validation failed` |
| Runtime exception during a group | `Annotator crashed` |

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

Sets `DATABASE_URL`, then:

```bash
node ./src/cli.js run-once
```

Runs a schema precheck first (rejects DBs that haven't been migrated
with the `writer_done` / `annotating` / `needs_review` enum values or
the `failure_reason` column).

### 3. Recover queues stuck in `annotating`

If a worker crashes mid-job, the queue can sit in `annotating`
indefinitely. To reset rows that have been stuck longer than 60 minutes
(adjustable) back to `writer_done`:

```bash
node ./src/cli.js cleanup-stale --minutes 60
```

Returns JSON with the list of reset ids. Wire this into a separate
hourly cron alongside `run-once`.

## Environment

Copy `.env.example` to `.env`:

```bash
DATABASE_URL=postgres://user:password@host:5432/dbname
```

### Optional: install Playwright for Layer 2c browser fallback

```bash
npm install playwright
npx playwright install chromium
```

Without Playwright, `browserFetch` returns an immediate `not installed`
miss and the grounder falls back to search-based rescue (Layer 2a/2b
only). Many plain-HTML medical sites work fine without it; install
Playwright when you start seeing many `⚠️ 原文待確認` comments due to
reCAPTCHA / JS-rendered targets.

## Payload expectations

### Queue row

- `id`
- `topic`
- `proposed_h1`
- `proposed_outline` — array of `{ h2, key_claims, source_hints }`
- `proposed_satellites`
- `source_hints` — global URL pool
- `target_reader`
- `planner_mode` — when `"news"`, the verifier becomes stricter on
  dated/percentage claims (appends an extra advisory note even when
  the page values match).

### Article row

- `id`, `title`, `slug`
- `content_tier`, `target_reader`, `status`
- `journey_stage_id`
- `is_main`
- `draft_json`
- `meta_description`

### `draft_json`

- `meta.description`
- `content[]`
- `sources[]` — `[{ text, url }]`
- `comments[]` — must start as `[]`; non-empty means already annotated
  and the article is skipped.

## Comment schema (11 fixed keys)

Every comment written back must have exactly:

```ts
{
  id:           number;     // sequential, per-article
  search_text:  string;     // must exist as a substring in prose
  placement:    "run" | "paragraph";
  label:        string;     // "【來源 N】<source display name>"
  checkpoint:   string;
  url:          string;
  position:     string;     // e.g. "Section: \"Results\""
  verbatim:     string;     // copy-paste-able from the fetched page
  scope:        string;     // country / population / phase / year
  supplemental: string;
  fallback:     string;
}
```

Schema validation runs before SQL write — any malformed comment fails
the whole group with a `Schema validation failed` reason.

## What the Annotator never modifies

- `articles.draft_json.content`
- `articles.draft_json.sources`
- `articles.title`
- `articles.meta_description`
- `articles.word_count`
- `content_queue.completed_at` (preserves Writer's timestamp)
- `content_queue.proposed_*`

If the verifier disagrees with a number in the article, it surfaces
the mismatch via the comment's `checkpoint` field as a
`⚠️ 雙重驗證警示：` prefix. Human reviewers decide whether to push
the queue back to Writer (status reset to `running`) or accept.

## Notes

- `proposed_outline` is adapted as an H2-array shape:
  `[{ h2, key_claims, source_hints }]`. If the real payload differs,
  update `src/adapters/outline-adapter.js`.
- Reviewer-rich fields from the previous document workflow are
  intentionally not written into `comments[]`.

## Push to a new repo

Inside this folder:

```bash
git remote add origin <your-new-repo-url>
git push -u origin main
```
