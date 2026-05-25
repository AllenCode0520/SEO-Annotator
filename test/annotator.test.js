import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { readDraftContent } from "../src/adapters/content-adapter.js";
import { evaluateCoverage } from "../src/pipeline/coverage-checker.js";

test("content adapter flattens paragraph and faq blocks", () => {
  const draftJson = {
    content: [
      { type: "h2", runs: "核准適應症" },
      { type: "p", runs: [{ text: "FDA 已核准 " }, { text: "vepdegestrant", bold: true }] },
      { type: "faq", pairs: [{ q: "誰適合使用？", a: [{ text: "需確認 " }, { text: "ESR1", link: "https://example.com" }, { text: " 突變。" }] }] }
    ]
  };

  const blocks = readDraftContent(draftJson);
  assert.equal(blocks[1].text, "FDA 已核准 vepdegestrant");
  assert.equal(blocks[2].text, "誰適合使用？");
  assert.equal(blocks[3].text, "需確認 ESR1 突變。");
});

test("coverage checker counts covered claims from checkpoint and verbatim", () => {
  const outline = [
    {
      h2: "核准適應症",
      key_claims: ["需確認 ESR1 突變", "FDA 核准日期 2026-05-01"],
      source_hints: []
    }
  ];

  const comments = [
    {
      checkpoint: "需確認 ESR1 突變後再用藥",
      verbatim: "Use is limited to patients with ESR1 mutation."
    },
    {
      checkpoint: "FDA 核准日期",
      verbatim: "Approved on May 1, 2026."
    }
  ];

  const coverage = evaluateCoverage(outline, comments);
  assert.equal(coverage.total, 2);
  assert.equal(coverage.covered, 2);
  assert.equal(coverage.ratio, 1);
});
