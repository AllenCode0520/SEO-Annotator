import { normalizeWhitespace } from "../utils/text.js";

function buildCheckpointText(grounded) {
  const parts = [];
  if (grounded.verificationWarning) parts.push(grounded.verificationWarning);
  if (grounded.warning) parts.push(grounded.warning);
  parts.push(grounded.claim.text);
  return normalizeWhitespace(parts.join(" "));
}

function buildLabel(source, index) {
  const sourceName = normalizeWhitespace(source?.text || source?.url || "Unknown source");
  return `【來源 ${index + 1}】${sourceName}`;
}

function pickPlacement(grounded) {
  return grounded.claim.placementHint === "run" ? "run" : "paragraph";
}

function mergeSameSourceComments(comments) {
  const groups = new Map();
  for (const comment of comments) {
    const key = [comment._articleId, comment.search_text, comment.url, comment.placement].join("::");
    if (!groups.has(key)) {
      groups.set(key, { ...comment });
      continue;
    }
    const merged = groups.get(key);
    merged.checkpoint = normalizeWhitespace(`${merged.checkpoint}；${comment.checkpoint}`);
    if (!merged.supplemental && comment.supplemental) merged.supplemental = comment.supplemental;
    if (!merged.scope && comment.scope) merged.scope = comment.scope;
    if (!merged.fallback && comment.fallback) merged.fallback = comment.fallback;
  }
  return [...groups.values()];
}

export function buildCommentsFromGrounded(groundedClaims) {
  const raw = groundedClaims.map((grounded, index) => ({
    id: index,
    search_text: grounded.claim.searchText,
    placement: pickPlacement(grounded),
    label: buildLabel(grounded.source, index),
    checkpoint: buildCheckpointText(grounded),
    url: grounded.source?.url ?? "",
    position: grounded.position ?? "",
    verbatim: grounded.verbatim ?? "",
    scope: grounded.scope ?? "",
    supplemental: grounded.supplemental ?? "",
    fallback: grounded.fallback ?? "",
    _articleId: grounded.claim.articleId
  }));

  const merged = mergeSameSourceComments(raw);
  return merged.map((comment, index) => ({
    id: index,
    search_text: comment.search_text,
    placement: comment.placement,
    label: buildLabel({ text: comment.label.replace(/^【來源 \d+】/, "") }, index),
    checkpoint: comment.checkpoint,
    url: comment.url,
    position: comment.position,
    verbatim: comment.verbatim,
    scope: comment.scope,
    supplemental: comment.supplemental,
    fallback: comment.fallback,
    _articleId: comment._articleId
  }));
}

export function buildQualityLog(comments, articleProseLookup) {
  return comments.map((comment, index) => {
    const prose = articleProseLookup.get(comment._articleId) ?? [];
    const searchHit = prose.some((text) => text.includes(comment.search_text));
    const verbatimSearchable = comment.verbatim === "⚠️ 原文待確認" || comment.verbatim.length >= 5;
    return {
      row: index + 1,
      urlFetched: Boolean(comment.url),
      verbatimSearchable,
      searchTextInProse: searchHit,
      placementRule: comment.placement
    };
  });
}

export function stripInternalFields(comments) {
  return comments.map(({ _articleId, ...comment }) => comment);
}
