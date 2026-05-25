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

export function evaluateCoverage(proposedOutline, comments) {
  const sections = readOutlineSections(proposedOutline);
  const missing = [];
  let total = 0;
  let covered = 0;

  for (const section of sections) {
    for (const keyClaim of section.keyClaims) {
      total += 1;
      const hit = comments.some((comment) => commentCoversClaim(comment, keyClaim));
      if (hit) {
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
