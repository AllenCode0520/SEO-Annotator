import { readDraftContent, makeClaimSegments } from "../adapters/content-adapter.js";
import { containsClaimSignal, normalizeWhitespace, toSearchText } from "../utils/text.js";

function classifyClaim(text) {
  if (/\b(?:FDA|NCCN|PFS|OS|HR|CI|Category|Phase)\b/i.test(text)) return "分類定義";
  if (/\d/.test(text) && /(?:年|月|日|date|approved|核准|生效)/i.test(text)) return "日期";
  if (/\d/.test(text)) return "數字";
  if (/(?:tamoxifen|vepdegestrant|fulvestrant|osimertinib|repotrectinib|藥|商品名)/i.test(text)) return "藥物存在性";
  if (/(?:mutat|ESR1|HER2|ERBB2|蛋白|泛素|PROTAC|機制|受體)/i.test(text)) return "分子機制";
  if (/(?:most common|最常見|約佔|比例|發生率|存活率)/i.test(text)) return "流行病學";
  if (/(?:四線|ECOG|資格|給付|保險|健保)/i.test(text)) return "給付條件";
  if (/(?:better|worse|inferior|superior|較|優於|不劣於|顯著)/i.test(text)) return "比較性宣稱";
  return "科學事實";
}

export function extractClaimsFromArticle(article, queueRow) {
  const draft = article?.draft_json ?? {};
  const readableBlocks = readDraftContent(draft);
  const claims = [];

  for (const block of readableBlocks) {
    if (["h1", "h2", "h3"].includes(block.blockType)) continue;
    const segments = makeClaimSegments(block);
    for (const segment of segments) {
      const text = normalizeWhitespace(segment);
      if (!containsClaimSignal(text)) continue;
      claims.push({
        articleId: article.id,
        articleTitle: article.title,
        blockType: block.blockType,
        sectionH2: block.sectionH2,
        sectionH3: block.sectionH3,
        text,
        searchText: toSearchText(text),
        factType: classifyClaim(text),
        blockIndex: block.articleBlockIndex,
        blockPart: block.part,
        sourceHints: [],
        placementHint: text.length <= 160 ? "run" : "paragraph"
      });
    }
  }

  return claims;
}
