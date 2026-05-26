import { readOutlineSections } from "../adapters/outline-adapter.js";
import { readDraftContent } from "../adapters/content-adapter.js";
import { extractClaimsFromArticle } from "./claim-extractor.js";
import { matchSourcesForClaim } from "./source-matcher.js";
import { groundClaimWithSource } from "./source-grounder.js";
import { verifyHighRiskGrounding } from "./high-risk-verifier.js";
import {
  buildCommentsFromGrounded,
  buildQualityLog,
  stripInternalFields,
} from "./comment-builder.js";
import { buildCoverageMetaComments, evaluateCoverage } from "./coverage-checker.js";
import { validateComments } from "../utils/schema-validator.js";

// Tunables. The grounding loop is now bounded by a small concurrency
// pool so a 30-claim article doesn't take 30× single-request latency,
// while still keeping us well below "scraping abusively" levels.
const GROUNDING_CONCURRENCY = 4;

// Minimum coverage; below this we fail the queue rather than submit a
// half-empty annotation set.
const COVERAGE_MIN_RATIO = 0.5;

// Minimum *grounded* claim ratio; below this every comment would be a
// "⚠️ 原文待確認" placeholder, which is worse than asking the human to
// retry against a fresh Writer run.
const GROUNDED_MIN_RATIO_OF_TOTAL = 0.3;

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

/**
 * planner_mode='news' tightens what counts as "high-risk", so the
 * verifier doesn't skip dated claims even if they don't match the
 * default heuristic patterns. Implemented by wrapping the verifier.
 */
function makeVerifier(plannerMode) {
  return async (grounded) => {
    const result = await verifyHighRiskGrounding(grounded);
    // For news mode, additionally tag the comment if it has any date or
    // percentage in the claim text but the verifier said "fine" — surface
    // the recommendation that humans double-check anyway.
    if (
      plannerMode === "news" &&
      !result.verificationWarning &&
      /\d/.test(grounded.claim.text) &&
      /(?:年|月|日|date|approved|核准|生效|%|百分)/i.test(grounded.claim.text)
    ) {
      return {
        ...result,
        verificationWarning:
          "ℹ️ News mode：claim 含日期/百分比，已自動通過比對，仍建議人工最後確認",
      };
    }
    return result;
  };
}

export async function runAnnotatorGroup(queueRow, articles) {
  const outlineSections = readOutlineSections(queueRow?.proposed_outline ?? []);
  const articleResults = [];
  const articleProseLookup = new Map();
  const verifier = makeVerifier(queueRow?.planner_mode);

  for (const article of articles) {
    const existingComments = Array.isArray(article?.draft_json?.comments)
      ? article.draft_json.comments
      : [];
    if (existingComments.length) {
      articleResults.push({
        articleId: article.id,
        skipped: true,
        reason: "Article already has comments.",
        comments: existingComments,
        qualityLog: [],
      });
      continue;
    }

    // Collect prose text used by the in-prose-substring quality check.
    const proseBlocks = readDraftContent(article.draft_json);
    const metaDescription = article?.draft_json?.meta?.description;
    articleProseLookup.set(
      article.id,
      [
        ...proseBlocks.map((block) => block.text),
        typeof metaDescription === "string" ? metaDescription : "",
      ].filter(Boolean)
    );

    // Z-0/Z-1: extract + match
    const claims = extractClaimsFromArticle(article, queueRow);
    const matched = claims.map((claim) =>
      matchSourcesForClaim(claim, article, queueRow, outlineSections)
    );

    // Z-2 + Z-3: bounded-concurrency grounding then verification
    const grounded = await runWithConcurrency(matched, GROUNDING_CONCURRENCY, async (match) => {
      const groundedClaim = await groundClaimWithSource(match);
      return verifier(groundedClaim);
    });

    // Z-5: build comments
    let comments = buildCommentsFromGrounded(grounded);

    // Z-4: coverage
    const coverage = evaluateCoverage(queueRow?.proposed_outline ?? [], comments);
    if (coverage.ratio >= COVERAGE_MIN_RATIO && coverage.missing.length) {
      const metaComments = buildCoverageMetaComments(
        article.id,
        coverage.missing,
        comments.length
      );
      comments = [...comments, ...metaComments];
    }

    // Z-6: quality self-check + drop comments whose search_text doesn't
    // anchor in prose (except meta-comments which intentionally anchor
    // at the H2 heading).
    const qualityLog = buildQualityLog(comments, articleProseLookup);
    const validComments = comments
      .filter(
        (comment, index) =>
          qualityLog[index]?.searchTextInProse || comment.label === "【規劃缺漏】"
      )
      .map((comment, index) => ({ ...comment, id: index }));

    // P0 guard: grounded ratio. Use the pre-merge grounded array because
    // merge can hide failure inside a combined comment.
    const totalGrounded = grounded.filter((g) => g.grounded).length;
    const groundedRatio = grounded.length === 0 ? 1 : totalGrounded / grounded.length;

    articleResults.push({
      articleId: article.id,
      skipped: false,
      coverage,
      groundedRatio,
      totalClaims: grounded.length,
      comments: stripInternalFields(validComments),
      qualityLog,
    });
  }

  // Group-level failure conditions (any single article failing fails
  // the whole group — the human reviewer should look at Writer output
  // before any annotation is committed).

  const coverageFailures = articleResults.filter(
    (result) => !result.skipped && result.coverage && result.coverage.ratio < COVERAGE_MIN_RATIO
  );
  if (coverageFailures.length) {
    const first = coverageFailures[0];
    return {
      ok: false,
      status: "failed",
      reason: `Writer 成稿覆蓋率不足，建議退回 Writer (article ${first.articleId}, coverage ${(first.coverage.ratio * 100).toFixed(1)}%)`,
      articleResults,
    };
  }

  const groundingFailures = articleResults.filter(
    (r) =>
      !r.skipped &&
      r.totalClaims > 0 &&
      r.groundedRatio < GROUNDED_MIN_RATIO_OF_TOTAL
  );
  if (groundingFailures.length) {
    const first = groundingFailures[0];
    return {
      ok: false,
      status: "failed",
      reason: `Source grounding 失敗率過高 (article ${first.articleId}, ${(first.groundedRatio * 100).toFixed(0)}% < ${(GROUNDED_MIN_RATIO_OF_TOTAL * 100).toFixed(0)}%) — 建議檢查 source URL 可用性後重撈`,
      articleResults,
    };
  }

  // Final schema validation — last line of defence before SQL.
  for (const result of articleResults) {
    if (result.skipped) continue;
    const { ok, errors } = validateComments(result.comments);
    if (!ok) {
      return {
        ok: false,
        status: "failed",
        reason: `Schema validation failed for article ${result.articleId}: ${errors.slice(0, 3).join("; ")}`,
        articleResults,
      };
    }
  }

  return {
    ok: true,
    status: "needs_review",
    articleResults,
  };
}
