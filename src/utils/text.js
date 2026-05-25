const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "than", "then",
  "have", "has", "had", "are", "was", "were", "will", "would", "could", "should",
  "about", "after", "before", "their", "them", "they", "your", "ours", "ourselves",
  "一個", "一些", "以及", "這個", "那個", "可以", "可能", "如果", "因此", "或者",
  "是否", "需要", "患者", "病人", "研究", "試驗", "結果", "數據", "治療", "顯示"
]);

export function flattenRuns(runs) {
  if (typeof runs === "string") {
    return { text: runs, spans: runs ? [{ start: 0, end: runs.length, text: runs }] : [] };
  }

  if (!Array.isArray(runs)) {
    return { text: "", spans: [] };
  }

  let cursor = 0;
  const spans = [];
  const parts = [];
  for (const run of runs) {
    const text = typeof run === "string" ? run : String(run?.text ?? "");
    if (!text) continue;
    parts.push(text);
    spans.push({ start: cursor, end: cursor + text.length, text, attrs: run });
    cursor += text.length;
  }

  return { text: parts.join(""), spans };
}

export function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\u000b/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitSentences(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const raw = normalized
    .split(/(?<=[。！？!?；;])\s+|(?<=[。！？!?；;])|(?<=\.)\s+(?=[A-Z0-9])/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  if (raw.length) {
    return raw;
  }

  return [normalized];
}

export function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function toSearchText(text) {
  const normalized = normalizeWhitespace(text);
  return normalized.length > 160 ? normalized.slice(0, 160).trim() : normalized;
}

export function tokenizeForClaims(text) {
  const normalized = normalizeWhitespace(text).toLowerCase();
  const asciiTokens = normalized.match(/[a-z0-9.+%-]{2,}/g) ?? [];
  const hanTokens = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const tokens = [...asciiTokens, ...hanTokens].filter((token) => !STOPWORDS.has(token));
  return uniqueStrings(tokens);
}

export function extractKeyTerms(text) {
  const tokens = tokenizeForClaims(text);
  return tokens
    .filter((token) => /\d/.test(token) || token.length >= 3)
    .slice(0, 8);
}

export function containsClaimSignal(text) {
  const value = normalizeWhitespace(text);
  if (!value) return false;

  const patterns = [
    /\d/,
    /\b(?:FDA|NCCN|PFS|OS|HR|CI|Phase|Trial|VERITAC|COMET|ESR1|DCIS|AI|PROTAC|Taiwan|Category)\b/i,
    /(?:年|月|日|核准|生效|給付|篩檢|突變|存活率|風險|比例|藥物|商品名|試驗|顯著|較|優於|不劣於|最常見)/,
    /["「].+["」]/,
  ];

  return patterns.some((pattern) => pattern.test(value));
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
