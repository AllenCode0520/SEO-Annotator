import { extractKeyTerms } from "../utils/text.js";

function isHighRiskClaim(text) {
  return [
    /(?:學名|商品名|tamoxifen|vepdegestrant|osimertinib|repotrectinib)/i,
    /(?:健保|給付|金額|受惠人數|作業天數|必備文件|生效日|函號)/,
    /(?:PFS|OS|收案|trial|試驗|Category|NCCN|台灣已有|台灣尚未|FDA)/i,
    /https?:\/\//i
  ].some((pattern) => pattern.test(text));
}

export async function verifyHighRiskGrounding(grounded) {
  if (!isHighRiskClaim(grounded.claim.text) || !grounded.source?.url) {
    return {
      ...grounded,
      verificationWarning: ""
    };
  }

  try {
    const response = await fetch(grounded.source.url, { headers: { "user-agent": "AnnotatorRobot/0.1" } });
    const text = await response.text();
    const normalized = text.toLowerCase();
    const missingTokens = extractKeyTerms(grounded.claim.text)
      .slice(0, 4)
      .filter((token) => !normalized.includes(token.toLowerCase()));

    if (missingTokens.length) {
      return {
        ...grounded,
        verificationWarning: `⚠️ 雙重驗證警示：來源頁面未再次命中關鍵要素 ${missingTokens.join(", ")}`
      };
    }

    return {
      ...grounded,
      verificationWarning: ""
    };
  } catch (error) {
    return {
      ...grounded,
      verificationWarning: `⚠️ 雙重驗證警示：二次 fetch 失敗 (${error.message})`
    };
  }
}
