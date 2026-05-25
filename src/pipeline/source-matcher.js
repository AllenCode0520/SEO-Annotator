import { matchSectionForH2 } from "../adapters/outline-adapter.js";
import { extractKeyTerms, normalizeWhitespace, uniqueStrings } from "../utils/text.js";

function scoreSource(claimText, source) {
  const haystack = `${source.text ?? ""} ${source.url ?? ""}`.toLowerCase();
  let score = 0;
  for (const token of extractKeyTerms(claimText)) {
    if (haystack.includes(token.toLowerCase())) score += 2;
  }
  if (haystack.includes("guideline") || haystack.includes("study") || haystack.includes("trial")) score += 1;
  return score;
}

function normalizeSource(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return { text: value, url: value };
  }
  return {
    text: normalizeWhitespace(value.text ?? value.title ?? value.url ?? ""),
    url: normalizeWhitespace(value.url ?? "")
  };
}

export function matchSourcesForClaim(claim, article, queueRow, outlineSections) {
  const draftSources = (article?.draft_json?.sources ?? []).map(normalizeSource).filter(Boolean);
  const section = matchSectionForH2(outlineSections, claim.sectionH2);
  const sectionHints = (section?.sourceHints ?? []).map((value) => normalizeSource({ text: value, url: value })).filter(Boolean);
  const queueHints = (queueRow?.source_hints ?? []).map((value) => normalizeSource({ text: value, url: value })).filter(Boolean);

  const rankedDraft = draftSources
    .map((source) => ({ source, score: scoreSource(claim.text, source) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const ordered = uniqueStrings([
    ...rankedDraft.map((entry) => JSON.stringify({ ...entry.source, tier: "inline_source" })),
    ...sectionHints.map((source) => JSON.stringify({ ...source, tier: "section_hint" })),
    ...queueHints.map((source) => JSON.stringify({ ...source, tier: "queue_hint" }))
  ]).map((value) => JSON.parse(value));

  if (!ordered.length) {
    return {
      claim,
      section,
      candidates: [],
      unmatched: true
    };
  }

  return {
    claim,
    section,
    candidates: ordered,
    unmatched: false
  };
}
