import { flattenRuns, normalizeWhitespace, splitSentences, toSearchText } from "../utils/text.js";

function pushReadableBlock(blocks, entry) {
  if (!entry.text) return;
  blocks.push({
    articleBlockIndex: entry.articleBlockIndex,
    blockType: entry.blockType,
    sectionH1: entry.sectionH1,
    sectionH2: entry.sectionH2,
    sectionH3: entry.sectionH3,
    text: normalizeWhitespace(entry.text),
    searchText: toSearchText(entry.searchText ?? entry.text),
    part: entry.part ?? "",
  });
}

export function readDraftContent(draftJson = {}) {
  const blocks = [];
  let currentH1 = "";
  let currentH2 = "";
  let currentH3 = "";

  const content = Array.isArray(draftJson.content) ? draftJson.content : [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index] ?? {};
    const type = block.type;

    if (type === "h1" || type === "h2" || type === "h3") {
      const heading = normalizeWhitespace(flattenRuns(block.runs).text);
      if (type === "h1") currentH1 = heading;
      if (type === "h2") {
        currentH2 = heading;
        currentH3 = "";
      }
      if (type === "h3") currentH3 = heading;
      pushReadableBlock(blocks, {
        articleBlockIndex: index,
        blockType: type,
        sectionH1: currentH1,
        sectionH2: currentH2,
        sectionH3: currentH3,
        text: heading
      });
      continue;
    }

    if (type === "p") {
      const { text } = flattenRuns(block.runs);
      pushReadableBlock(blocks, {
        articleBlockIndex: index,
        blockType: type,
        sectionH1: currentH1,
        sectionH2: currentH2,
        sectionH3: currentH3,
        text
      });
      continue;
    }

    if (type === "bullet" || type === "numbered") {
      const items = Array.isArray(block.items) ? block.items : [];
      items.forEach((item, itemIndex) => {
        pushReadableBlock(blocks, {
          articleBlockIndex: index,
          blockType: type,
          sectionH1: currentH1,
          sectionH2: currentH2,
          sectionH3: currentH3,
          text: item,
          part: `${type}[${itemIndex}]`
        });
      });
      continue;
    }

    if (type === "table") {
      const rows = Array.isArray(block.rows) ? block.rows : [];
      rows.forEach((row, rowIndex) => {
        const cells = Array.isArray(row.cells) ? row.cells : [];
        cells.forEach((cell, cellIndex) => {
          pushReadableBlock(blocks, {
            articleBlockIndex: index,
            blockType: type,
            sectionH1: currentH1,
            sectionH2: currentH2,
            sectionH3: currentH3,
            text: cell,
            part: `table[row=${rowIndex},cell=${cellIndex}]`
          });
        });
      });
      continue;
    }

    if (type === "faq") {
      const pairs = Array.isArray(block.pairs) ? block.pairs : [];
      pairs.forEach((pair, pairIndex) => {
        const answer = typeof pair.a === "string" ? pair.a : flattenRuns(pair.a).text;
        pushReadableBlock(blocks, {
          articleBlockIndex: index,
          blockType: type,
          sectionH1: currentH1,
          sectionH2: currentH2,
          sectionH3: currentH3,
          text: pair.q,
          part: `faq[${pairIndex}].q`
        });
        pushReadableBlock(blocks, {
          articleBlockIndex: index,
          blockType: type,
          sectionH1: currentH1,
          sectionH2: currentH2,
          sectionH3: currentH3,
          text: answer,
          part: `faq[${pairIndex}].a`
        });
      });
      continue;
    }

    if (type === "disclaimer") {
      const { text } = flattenRuns(block.runs);
      pushReadableBlock(blocks, {
        articleBlockIndex: index,
        blockType: type,
        sectionH1: currentH1,
        sectionH2: currentH2,
        sectionH3: currentH3,
        text
      });
    }
  }

  return blocks;
}

export function makeClaimSegments(block) {
  if (!block?.text) return [];
  if (["meta_box", "spacer", "page_break"].includes(block.blockType)) return [];

  if (block.blockType === "disclaimer") {
    return [];
  }

  const sentences = splitSentences(block.text);
  if (["bullet", "numbered", "table", "faq"].includes(block.blockType)) {
    return sentences.length ? sentences : [block.text];
  }

  return sentences.length ? sentences : [block.text];
}
