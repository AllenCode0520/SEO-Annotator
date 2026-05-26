import test from "node:test";
import assert from "node:assert/strict";
import { readDraftContent } from "../src/adapters/content-adapter.js";
import { evaluateCoverage, buildCoverageMetaComments } from "../src/pipeline/coverage-checker.js";
import { matchSourcesForClaim } from "../src/pipeline/source-matcher.js";
import { readOutlineSections } from "../src/adapters/outline-adapter.js";
import {
  buildCommentsFromGrounded,
  stripInternalFields,
} from "../src/pipeline/comment-builder.js";
import { validateComments, validateComment } from "../src/utils/schema-validator.js";
import { fetchWithRetry } from "../src/utils/fetch-helpers.js";

// ─── content-adapter ────────────────────────────────────────────────

test("content adapter flattens paragraph and faq blocks", () => {
  const draftJson = {
    content: [
      { type: "h2", runs: "核准適應症" },
      { type: "p", runs: [{ text: "FDA 已核准 " }, { text: "vepdegestrant", bold: true }] },
      {
        type: "faq",
        pairs: [
          { q: "誰適合使用？", a: [{ text: "需確認 " }, { text: "ESR1", link: "https://example.com" }, { text: " 突變。" }] },
        ],
      },
    ],
  };

  const blocks = readDraftContent(draftJson);
  assert.equal(blocks[1].text, "FDA 已核准 vepdegestrant");
  assert.equal(blocks[2].text, "誰適合使用？");
  assert.equal(blocks[3].text, "需確認 ESR1 突變。");
});

// ─── coverage-checker ───────────────────────────────────────────────

test("coverage checker counts covered claims from checkpoint and verbatim", () => {
  const outline = [
    {
      h2: "核准適應症",
      key_claims: ["需確認 ESR1 突變", "FDA 核准日期 2026-05-01"],
      source_hints: [],
    },
  ];

  const comments = [
    {
      checkpoint: "需確認 ESR1 突變後再用藥",
      verbatim: "Use is limited to patients with ESR1 mutation.",
    },
    {
      checkpoint: "FDA 核准日期",
      verbatim: "Approved on May 1, 2026.",
    },
  ];

  const coverage = evaluateCoverage(outline, comments);
  assert.equal(coverage.total, 2);
  assert.equal(coverage.covered, 2);
  assert.equal(coverage.ratio, 1);
});

test("coverage checker flags missing key claims", () => {
  const outline = [
    {
      h2: "核准適應症",
      key_claims: ["FDA 核准日期 2026-05-01", "需確認 ESR1 突變", "二線治療定位"],
    },
  ];
  const comments = [{ checkpoint: "FDA 核准日期", verbatim: "Approved May 1, 2026" }];
  const coverage = evaluateCoverage(outline, comments);
  assert.equal(coverage.total, 3);
  assert.equal(coverage.covered, 1);
  assert.equal(coverage.missing.length, 2);
});

test("buildCoverageMetaComments produces well-shaped meta comments", () => {
  const meta = buildCoverageMetaComments(
    "article-1",
    [{ h2: "VERITAC", keyClaim: "PFS 5 個月" }],
    7
  );
  assert.equal(meta.length, 1);
  assert.equal(meta[0].id, 7);
  assert.equal(meta[0].label, "【規劃缺漏】");
  assert.equal(meta[0]._articleId, "article-1");
});

// ─── source-matcher: zero-score sources must NOT be dropped (P0 fix) ───

test("source-matcher keeps zero-score draft sources at the tail", () => {
  const article = {
    draft_json: {
      sources: [
        { text: "Random Institutional Page", url: "https://example.com/x" },
        { text: "VERITAC trial dossier", url: "https://example.com/veritac" },
      ],
    },
  };
  const queueRow = { source_hints: [] };
  const claim = {
    text: "Median PFS was 5 months",
    sectionH2: "VERITAC",
  };
  const outline = readOutlineSections([{ h2: "VERITAC", key_claims: [] }]);
  const match = matchSourcesForClaim(claim, article, queueRow, outline);
  assert.equal(match.candidates.length, 2);
  // veritac source must rank ahead of unrelated one
  assert.match(match.candidates[0].url, /veritac/);
  // unrelated one still present (would have been dropped by old impl)
  assert.match(match.candidates[1].url, /\/x$/);
});

test("source-matcher orders inline > section > queue hints", () => {
  const article = { draft_json: { sources: [] } };
  const queueRow = { source_hints: ["https://global-hint.example.com/"] };
  const outline = readOutlineSections([
    { h2: "Section A", key_claims: [], source_hints: ["https://section-hint.example.com/"] },
  ]);
  const claim = { text: "study trial PFS 5 months", sectionH2: "Section A" };
  const match = matchSourcesForClaim(claim, article, queueRow, outline);
  assert.equal(match.candidates[0].tier, "section_hint");
  assert.equal(match.candidates[1].tier, "queue_hint");
});

// ─── comment-builder: same-source merging (now block-based) ─────────

test("comment-builder merges claims from same block + same URL", () => {
  const grounded = [
    {
      claim: { articleId: "a1", blockIndex: 5, searchText: "first sentence", placementHint: "run" },
      source: { text: "FDA approval page", url: "https://fda.gov/abc" },
      grounded: true,
      verbatim: "Verbatim 1",
      position: "Section: Approval",
      scope: "US 2026",
      supplemental: "",
      fallback: "",
    },
    {
      claim: { articleId: "a1", blockIndex: 5, searchText: "second sentence", placementHint: "run" },
      source: { text: "FDA approval page", url: "https://fda.gov/abc" },
      grounded: true,
      verbatim: "Verbatim 2",
      position: "Section: Approval",
      scope: "US 2026",
      supplemental: "",
      fallback: "",
    },
  ];
  const result = buildCommentsFromGrounded(grounded);
  assert.equal(result.length, 1, "two same-block+same-url claims should merge");
  assert.match(result[0].checkpoint, /；/, "merged checkpoint should join with ；");
  assert.equal(result[0].label, "【來源 1】FDA approval page");
});

test("comment-builder does NOT merge claims from different blocks", () => {
  const grounded = [
    {
      claim: { articleId: "a1", blockIndex: 2, searchText: "first", placementHint: "run" },
      source: { text: "Same Source", url: "https://example.com/a" },
      grounded: true,
      verbatim: "v1",
      position: "S1",
      scope: "",
      supplemental: "",
      fallback: "",
    },
    {
      claim: { articleId: "a1", blockIndex: 9, searchText: "second", placementHint: "run" },
      source: { text: "Same Source", url: "https://example.com/a" },
      grounded: true,
      verbatim: "v2",
      position: "S2",
      scope: "",
      supplemental: "",
      fallback: "",
    },
  ];
  const result = buildCommentsFromGrounded(grounded);
  assert.equal(result.length, 2);
});

// ─── schema-validator ──────────────────────────────────────────────

test("schema validator catches missing required fields", () => {
  const bad = { id: 0, search_text: "x" };
  const errors = validateComment(bad, { commentIndex: 0 });
  assert.ok(errors.length >= 5);
  assert.ok(errors.some((e) => e.includes("checkpoint")));
});

test("schema validator catches bad placement", () => {
  const all11 = {
    id: 0,
    search_text: "x",
    placement: "weird",
    label: "",
    checkpoint: "",
    url: "",
    position: "",
    verbatim: "",
    scope: "",
    supplemental: "",
    fallback: "",
  };
  const errors = validateComment(all11);
  assert.ok(errors.some((e) => e.includes("placement")));
});

test("schema validator passes well-formed comments and catches duplicate ids", () => {
  const good = {
    id: 0, search_text: "a", placement: "run",
    label: "", checkpoint: "", url: "", position: "",
    verbatim: "", scope: "", supplemental: "", fallback: "",
  };
  const dup = { ...good, id: 0 };
  const { ok, errors } = validateComments([good, dup]);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("duplicate")));
});

// ─── stripInternalFields removes anything starting with _ ──────────

test("stripInternalFields removes underscore-prefixed keys", () => {
  const stripped = stripInternalFields([
    { id: 0, _articleId: "a", _blockIndex: 1, _sourceText: "x", search_text: "s" },
  ]);
  assert.equal(stripped.length, 1);
  assert.equal(stripped[0]._articleId, undefined);
  assert.equal(stripped[0]._blockIndex, undefined);
  assert.equal(stripped[0]._sourceText, undefined);
  assert.equal(stripped[0].search_text, "s");
});

// ─── fetchWithRetry honors timeout (no live network) ──────────────

test("fetchWithRetry respects timeout against a slow handler", async () => {
  // 127.0.0.1:1 is blackholed on most systems; verify our timeout fires
  // before the OS gives up. We use a deliberately tiny timeout.
  const start = Date.now();
  const result = await fetchWithRetry("http://127.0.0.1:1/", {
    timeoutMs: 200,
    retries: 0,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 5_000, `should not take long; took ${elapsed}ms`);
});
