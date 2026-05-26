import { matchSectionForH2 } from "../adapters/outline-adapter.js";
import { extractKeyTerms, normalizeWhitespace, uniqueStrings } from "../utils/text.js";

/**
 * Score a single (claim, source) pair.
 *  - Each key term hit in source.text or source.url: +2
 *  - Generic "trust" tokens (guideline/study/trial) anywhere: +1
 * The score is only used for *ordering*, never for filtering — see
 * matchSourcesForClaim below.
 */
function scoreSource(claimText, source) {
  const haystack = `${source.text ?? ""} ${source.url ?? ""}`.toLowerCase();
  let score = 0;
  for (const token of extractKeyTerms(claimText)) {
    if (haystack.includes(token.toLowerCase())) score += 2;
  }
  if (
    haystack.includes("guideline") ||
    haystack.includes("study") ||
    haystack.includes("trial")
  ) {
    score += 1;
  }
  return score;
}

function normalizeSource(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return { text: value, url: value };
  }
  const text = normalizeWhitespace(value.text ?? value.title ?? value.url ?? "");
  const url = normalizeWhitespace(value.url ?? "");
  if (!url) return null; // urls without a value cannot be fetched
  return { text, url };
}

/**
 * Build the ordered candidate list for a claim.
 *
 * Order:
 *   1. inline draft sources, by descending matching score
 *      — DO NOT drop zero-score sources: when no key token happens to be
 *        in source.text/url (common when Writer used pure institution names),
 *        we still want to try them. P0 fix from earlier review.
 *   2. section-level hints (proposed_outline[i].source_hints[])
 *   3. queue-level hints (queue.source_hints[])
 *
 * The grounder will iterate in order until one ground-truths the claim.
 */
export function matchSourcesForClaim(claim, article, queueRow, outlineSections) {
  const draftSources = (article?.draft_json?.sources ?? [])
    .map(normalizeSource)
    .filter(Boolean);
  const section = matchSectionForH2(outlineSections, claim.sectionH2);
  const sectionHints = (section?.sourceHints ?? [])
    .map((value) => normalizeSource({ text: value, url: value }))
    .filter(Boolean);
  const queueHints = (queueRow?.source_hints ?? [])
    .map((value) => normalizeSource({ text: value, url: value }))
    .filter(Boolean);

  const rankedDraft = draftSources
    .map((source) => ({ source, score: scoreSource(claim.text, source) }))
    .sort((a, b) => b.score - a.score);

  const ordered = uniqueStrings([
    ...rankedDraft.map((entry) =>
      JSON.stringify({ ...entry.source, tier: "inline_source", score: entry.score })
    ),
    ...sectionHints.map((source) =>
      JSON.stringify({ ...source, tier: "section_hint" })
    ),
    ...queueHints.map((source) =>
      JSON.stringify({ ...source, tier: "queue_hint" })
    ),
  ]).map((value) => JSON.parse(value));

  if (!ordered.length) {
    return {
      claim,
      section,
      candidates: [],
      unmatched: true,
    };
  }

  return {
    claim,
    section,
    candidates: ordered,
    unmatched: false,
  };
}
