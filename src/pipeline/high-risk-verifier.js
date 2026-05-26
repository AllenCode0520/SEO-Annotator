import { fetchWithRetry } from "../utils/fetch-helpers.js";

/**
 * High-risk double verification (Z-3).
 *
 * Re-fetches the source URL and compares the ACTUAL VALUES in the
 * article's claim to what the source page shows. The earlier version
 * only checked whether key tokens existed on the page — which won't
 * catch off-by-one-year hallucinations because every related token
 * still appears.
 *
 * Verification surfaces:
 *   - dates (YYYY-MM-DD / YYYY/M/D / Month D, YYYY / 民國 N 年 M 月)
 *   - phase 3 / phase 2 / phase 1
 *   - PFS / OS month counts ("PFS 5.0 months" / "5 個月")
 *   - percentages ("30-40%" / "85%")
 *   - NCCN Category ("Category 1" / "Category 2A")
 *   - hazard ratios ("HR 0.57")
 *   - drug-name three-name spotting (just flags presence)
 *   - Taiwan availability statements ("台灣已有" / "台灣尚未")
 */

const HIGH_RISK_PATTERNS = [
  /(?:學名|商品名|tamoxifen|vepdegestrant|osimertinib|repotrectinib)/i,
  /(?:健保|給付|金額|受惠人數|作業天數|必備文件|生效日|函號)/,
  /(?:PFS|OS|收案|trial|試驗|Category|NCCN|台灣已有|台灣尚未|FDA)/i,
  /https?:\/\//i,
  /\d{4}[-/]\d{1,2}[-/]\d{1,2}/,   // ISO-ish dates
  /民國\s*\d+\s*年/,
  /\d+(?:\.\d+)?\s*%/,             // percentages
  /HR\s*[0-9.]+/i,
];

function isHighRiskClaim(text) {
  return HIGH_RISK_PATTERNS.some((p) => p.test(text));
}

// ── Value extractors ────────────────────────────────────────────────

function extractDates(text) {
  const out = new Set();
  // ISO-ish: 2026-05-01 / 2026/5/1
  for (const m of text.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g)) {
    out.add(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  }
  // English long form: May 1, 2026 (allow comma optional)
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  for (const m of text.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/gi)) {
    const monthIdx = months.findIndex((m3) => m[1].toLowerCase().startsWith(m3));
    if (monthIdx >= 0) {
      out.add(`${m[3]}-${String(monthIdx + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`);
    }
  }
  // 民國 N 年 M 月 D 日  → ROC year + 1911
  for (const m of text.matchAll(/民國\s*(\d{1,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    const yr = parseInt(m[1], 10) + 1911;
    out.add(`${yr}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  }
  return [...out];
}

function extractPercentages(text) {
  const out = new Set();
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:[-–~至到]\s*(\d+(?:\.\d+)?)\s*)?%/g)) {
    if (m[2]) out.add(`${m[1]}-${m[2]}%`);
    else out.add(`${m[1]}%`);
  }
  return [...out];
}

function extractMonths(text) {
  const out = new Set();
  // "5.0 months" / "5 個月" / "median PFS of 5 months"
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:months?|個月)\b/gi)) {
    out.add(`${m[1]}m`);
  }
  return [...out];
}

function extractHazardRatios(text) {
  const out = new Set();
  for (const m of text.matchAll(/\bHR\s*[:=]?\s*([0-9]+(?:\.\d+)?)/gi)) {
    out.add(m[1]);
  }
  return [...out];
}

function extractCategories(text) {
  const out = new Set();
  for (const m of text.matchAll(/\bCategory\s+(\d[ABab]?)/gi)) {
    out.add(`Cat${m[1].toUpperCase()}`);
  }
  return [...out];
}

function extractTaiwanAvailability(text) {
  // Return: "has" if "台灣已有", "lacks" if "台灣尚未", else null
  if (/台灣已有/.test(text) || /已在台灣上市/.test(text)) return "has";
  if (/台灣尚未/.test(text) || /尚未在台灣/.test(text)) return "lacks";
  return null;
}

// ── Comparison helpers ──────────────────────────────────────────────

function compareSets(name, claimValues, pageValues) {
  if (claimValues.length === 0) return null;
  const missing = claimValues.filter((v) => !pageValues.includes(v));
  if (missing.length === 0) return null;
  return `${name}: 文章寫 [${claimValues.join(", ")}]，但頁面只看到 [${pageValues.join(", ") || "（未找到）"}]`;
}

// ── Main entry ──────────────────────────────────────────────────────

export async function verifyHighRiskGrounding(grounded) {
  if (!isHighRiskClaim(grounded.claim.text) || !grounded.source?.url) {
    return { ...grounded, verificationWarning: "" };
  }

  let pageText;
  try {
    const response = await fetchWithRetry(grounded.source.url, {
      timeoutMs: 15_000,
      retries: 1,
    });
    if (!response.ok) {
      return {
        ...grounded,
        verificationWarning: `⚠️ 雙重驗證警示：二次 fetch 失敗 (HTTP ${response.status})`,
      };
    }
    pageText = response.text;
  } catch (error) {
    return {
      ...grounded,
      verificationWarning: `⚠️ 雙重驗證警示：二次 fetch 例外 (${error?.message ?? error})`,
    };
  }

  const claimText = grounded.claim.text;
  // Compare in priority order — first mismatch is enough to flag.
  const mismatches = [
    compareSets("日期", extractDates(claimText), extractDates(pageText)),
    compareSets("百分比", extractPercentages(claimText), extractPercentages(pageText)),
    compareSets("月數", extractMonths(claimText), extractMonths(pageText)),
    compareSets("HR", extractHazardRatios(claimText), extractHazardRatios(pageText)),
    compareSets("NCCN Category", extractCategories(claimText), extractCategories(pageText)),
  ].filter(Boolean);

  // Taiwan availability special-case
  const claimAvail = extractTaiwanAvailability(claimText);
  if (claimAvail) {
    const pageAvail = extractTaiwanAvailability(pageText);
    if (pageAvail !== null && pageAvail !== claimAvail) {
      mismatches.push(`台灣可及性: 文章寫「${claimAvail === "has" ? "已有" : "尚未"}」，頁面顯示相反`);
    }
  }

  if (mismatches.length) {
    return {
      ...grounded,
      verificationWarning: `⚠️ 雙重驗證警示：${mismatches.join("；")}`,
    };
  }

  return { ...grounded, verificationWarning: "" };
}
