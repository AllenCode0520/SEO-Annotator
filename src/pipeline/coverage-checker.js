import { matchSectionForH2, readOutlineSections } from "../adapters/outline-adapter.js";
import { extractKeyTerms, normalizeWhitespace } from "../utils/text.js";

function commentCoversClaim(comment, keyClaim) {
  const haystack = `${comment.checkpoint} ${comment.verbatim}`.toLowerCase();
  const tokens = extractKeyTerms(keyClaim);
  if (!tokens.length) {
    return haystack.includes(normalizeWhitespace(keyClaim).toLowerCase());
  }
  const matched = tokens.filter((token) => haystack.includes(token.toLowerCase()));
  return matched.length >= Math.min(2, tokens.length);
}

/**
 * Extract 2-char CJK bigrams from text for fuzzy prose matching.
 * Long CJK runs like "蛋白酶體系統降解目標蛋白" won't match the article
 * as a whole, but its 2-char windows (蛋白, 白酶, 酶體, ...) will.
 */
function extractCjkBigrams(text) {
  const cjkRuns = text.match(/[一-鿿㐀-䶿]+/g) ?? [];
  const bigrams = new Set();
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) {
      bigrams.add(run.slice(i, i + 2));
    }
    // Also keep 3-char grams for more signal
    for (let i = 0; i + 2 < run.length; i++) {
      bigrams.add(run.slice(i, i + 3));
    }
    // And the full run when short (≤ 4 chars) for exact matching
    if (run.length <= 4) bigrams.add(run);
  }
  return [...bigrams];
}

/**
 * Check whether the article prose itself mentions the claim terms.
 * This is the primary coverage signal when key_claims are in Chinese
 * but sources are in English — the Writer will have put the claim into
 * the article body even if the source verbatim is English.
 */
function proseCoversClaim(proseBlocks, keyClaim) {
  const proseFull = proseBlocks.join(" ").toLowerCase();
  const claimLower = normalizeWhitespace(keyClaim).toLowerCase();

  // Fast exact check first
  if (proseFull.includes(claimLower)) return true;

  // ASCII tokens from the claim (drug names, trial IDs, percentages, etc.)
  const asciiTokens = (claimLower.match(/[a-z0-9.+%-]{3,}/g) ?? [])
    .filter((t) => !["the", "and", "for", "with", "that"].includes(t));

  // CJK bigrams + trigrams from the claim
  const cjkNgrams = extractCjkBigrams(claimLower);

  // If we have ASCII tokens (e.g. "esr1", "veritac", "lilly"), weight them heavily
  if (asciiTokens.length >= 2) {
    const asciiMatched = asciiTokens.filter((t) => proseFull.includes(t));
    if (asciiMatched.length >= Math.ceil(asciiTokens.length / 2)) return true;
  }
  if (asciiTokens.length === 1 && proseFull.includes(asciiTokens[0])) {
    // Single-token claim like "VERITAC試驗設計" — if the drug name is in prose, pass
    // but only if we also have some CJK signal
    if (cjkNgrams.length === 0) return true;
  }

  if (cjkNgrams.length === 0) {
    // Pure ASCII claim — already handled above
    return asciiTokens.some((t) => proseFull.includes(t));
  }

  // Check bigrams: require ≥ 50% match (generous since bigrams are short)
  const cjkMatched = cjkNgrams.filter((ng) => proseFull.includes(ng));
  const cjkRatio = cjkMatched.length / cjkNgrams.length;

  if (cjkRatio >= 0.5) return true;

  // Fallback: if any single ASCII token + any CJK bigram both match, consider covered
  const hasAscii = asciiTokens.some((t) => proseFull.includes(t));
  if (hasAscii && cjkMatched.length > 0) return true;

  return false;
}

/**
 * @param {Array} proposedOutline
 * @param {Array} comments
 * @param {string[]} [proseBlocks]  - flat text blocks from the article body
 */
export function evaluateCoverage(proposedOutline, comments, proseBlocks = []) {
  const sections = readOutlineSections(proposedOutline);
  const missing = [];
  let total = 0;
  let covered = 0;

  for (const section of sections) {
    for (const keyClaim of section.keyClaims) {
      total += 1;
      // Primary: check comments (source-backed evidence)
      const hitComment = comments.some((comment) => commentCoversClaim(comment, keyClaim));
      // Secondary: check article prose (Writer covered it, even if source is English)
      const hitProse = proseBlocks.length > 0 && proseCoversClaim(proseBlocks, keyClaim);
      if (hitComment || hitProse) {
        covered += 1;
      } else {
        missing.push({ h2: section.h2, keyClaim });
      }
    }
  }

  const ratio = total === 0 ? 1 : covered / total;
  return { total, covered, ratio, missing, sections };
}

export function buildCoverageMetaComments(articleId, missingClaims, startId) {
  return missingClaims.map((entry, index) => ({
    id: startId + index,
    search_text: entry.h2,
    placement: "paragraph",
    label: "【規劃缺漏】",
    checkpoint: `規劃要求涵蓋「${entry.keyClaim}」但成稿未提及或未形成可驗證批注`,
    url: "",
    position: `H2: ${entry.h2}`,
    verbatim: "",
    scope: "",
    supplemental: "",
    fallback: "",
    _articleId: articleId
  }));
}
