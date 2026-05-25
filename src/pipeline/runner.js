import { readOutlineSections } from "../adapters/outline-adapter.js";
import { readDraftContent } from "../adapters/content-adapter.js";
import { extractClaimsFromArticle } from "./claim-extractor.js";
import { matchSourcesForClaim } from "./source-matcher.js";
import { groundClaimWithSource } from "./source-grounder.js";
import { verifyHighRiskGrounding } from "./high-risk-verifier.js";
import { buildCommentsFromGrounded, buildQualityLog, stripInternalFields } from "./comment-builder.js";
import { buildCoverageMetaComments, evaluateCoverage } from "./coverage-checker.js";

export async function runAnnotatorGroup(queueRow, articles) {
  const outlineSections = readOutlineSections(queueRow?.proposed_outline ?? []);
  const articleResults = [];
  const articleProseLookup = new Map();

  for (const article of articles) {
    const existingComments = Array.isArray(article?.draft_json?.comments) ? article.draft_json.comments : [];
    if (existingComments.length) {
      articleResults.push({
        articleId: article.id,
        skipped: true,
        reason: "Article already has comments.",
        comments: existingComments,
        qualityLog: []
      });
      continue;
    }

    const proseBlocks = readDraftContent(article.draft_json);
    const metaDescription = article?.draft_json?.meta?.description;
    articleProseLookup.set(
      article.id,
      [
        ...proseBlocks.map((block) => block.text),
        typeof metaDescription === "string" ? metaDescription : ""
      ].filter(Boolean)
    );

    const claims = extractClaimsFromArticle(article, queueRow);
    const matched = claims.map((claim) => matchSourcesForClaim(claim, article, queueRow, outlineSections));
    const grounded = [];
    for (const match of matched) {
      const groundedClaim = await groundClaimWithSource(match);
      const verified = await verifyHighRiskGrounding(groundedClaim);
      grounded.push(verified);
    }

    let comments = buildCommentsFromGrounded(grounded);
    const coverage = evaluateCoverage(queueRow?.proposed_outline ?? [], comments);
    if (coverage.ratio >= 0.5 && coverage.missing.length) {
      const metaComments = buildCoverageMetaComments(article.id, coverage.missing, comments.length);
      comments = [...comments, ...metaComments];
    }

    const qualityLog = buildQualityLog(comments, articleProseLookup);
    const validComments = comments
      .filter((comment, index) => qualityLog[index]?.searchTextInProse || comment.label === "【規劃缺漏】")
      .map((comment, index) => ({
        ...comment,
        id: index
      }));

    articleResults.push({
      articleId: article.id,
      skipped: false,
      coverage,
      comments: stripInternalFields(validComments),
      qualityLog
    });
  }

  const coverageFailures = articleResults
    .filter((result) => !result.skipped && result.coverage && result.coverage.ratio < 0.5);

  if (coverageFailures.length) {
    const first = coverageFailures[0];
    return {
      ok: false,
      status: "failed",
      reason: `Writer 成稿覆蓋率不足，建議退回 Writer (article ${first.articleId}, coverage ${(first.coverage.ratio * 100).toFixed(1)}%)`,
      articleResults
    };
  }

  return {
    ok: true,
    status: "needs_review",
    articleResults
  };
}
