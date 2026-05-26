import { normalizeWhitespace } from "../utils/text.js";

function buildCheckpointText(grounded) {
  const parts = [];
  if (grounded.verificationWarning) parts.push(grounded.verificationWarning);
  if (grounded.warning) parts.push(grounded.warning);
  parts.push(grounded.claim.text);
  return normalizeWhitespace(parts.join(" "));
}

function sourceDisplayName(source) {
  if (!source) return "Unknown source";
  return normalizeWhitespace(source.text || source.url || "Unknown source");
}

function pickPlacement(grounded) {
  return grounded.claim.placementHint === "run" ? "run" : "paragraph";
}

/**
 * Same-source merging key.
 * Spec §3 規則 2:「同一段內多個 claim 同一 URL → 合併為一條」
 * Old key included `search_text`, which never matched two different
 * claims. New key uses (articleId, blockIndex, url, placement) so claims
 * in the same physical block referencing the same source merge into a
 * single comment with a combined checkpoint.
 */
function mergeSameSourceComments(comments) {
  const groups = new Map();
  for (const comment of comments) {
    const blockIndex = comment._blockIndex ?? "noblock";
    const key = [comment._articleId, blockIndex, comment.url, comment.placement].join("::");
    if (!groups.has(key)) {
      groups.set(key, { ...comment, _sourceText: comment._sourceText });
      continue;
    }
    const merged = groups.get(key);
    merged.checkpoint = normalizeWhitespace(`${merged.checkpoint}；${comment.checkpoint}`);
    if (!merged.supplemental && comment.supplemental) merged.supplemental = comment.supplemental;
    if (!merged.scope && comment.scope) merged.scope = comment.scope;
    if (!merged.fallback && comment.fallback) merged.fallback = comment.fallback;
    // Pick the shorter (more precise) search_text on merge to maximize the
    // chance of a clean in-prose hit.
    if (
      typeof merged.search_text === "string" &&
      typeof comment.search_text === "string" &&
      comment.search_text.length > 0 &&
      comment.search_text.length < merged.search_text.length
    ) {
      merged.search_text = comment.search_text;
    }
  }
  return [...groups.values()];
}

export function buildCommentsFromGrounded(groundedClaims) {
  const raw = groundedClaims.map((grounded, index) => ({
    id: index,
    search_text: grounded.claim.searchText,
    placement: pickPlacement(grounded),
    label: "",                                          // filled after merge re-index
    checkpoint: buildCheckpointText(grounded),
    url: grounded.source?.url ?? "",
    position: grounded.position ?? "",
    verbatim: grounded.verbatim ?? "",
    scope: grounded.scope ?? "",
    supplemental: grounded.supplemental ?? "",
    fallback: grounded.fallback ?? "",
    _articleId: grounded.claim.articleId,
    _blockIndex: grounded.claim.blockIndex,
    _sourceText: sourceDisplayName(grounded.source),
  }));

  const merged = mergeSameSourceComments(raw);

  return merged.map((comment, index) => ({
    id: index,
    search_text: comment.search_text,
    placement: comment.placement,
    label: `【來源 ${index + 1}】${comment._sourceText ?? "Unknown source"}`,
    checkpoint: comment.checkpoint,
    url: comment.url,
    position: comment.position,
    verbatim: comment.verbatim,
    scope: comment.scope,
    supplemental: comment.supplemental,
    fallback: comment.fallback,
    _articleId: comment._articleId,
  }));
}

export function buildQualityLog(comments, articleProseLookup) {
  return comments.map((comment, index) => {
    const prose = articleProseLookup.get(comment._articleId) ?? [];
    const searchHit = prose.some((text) => text.includes(comment.search_text));
    const verbatimSearchable =
      comment.verbatim === "⚠️ 原文待確認" || comment.verbatim.length >= 5;
    return {
      row: index + 1,
      urlFetched: Boolean(comment.url),
      verbatimSearchable,
      searchTextInProse: searchHit,
      placementRule: comment.placement,
    };
  });
}

export function stripInternalFields(comments) {
  return comments.map((comment) => {
    const clean = {};
    for (const [k, v] of Object.entries(comment)) {
      if (!k.startsWith("_")) clean[k] = v;
    }
    return clean;
  });
}
