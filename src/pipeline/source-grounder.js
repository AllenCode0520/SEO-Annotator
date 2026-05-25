import { extractKeyTerms, normalizeWhitespace, safeJsonParse } from "../utils/text.js";

const DEFAULT_USER_AGENT = "AnnotatorRobot/0.1 (+https://local.annotator)";

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      "accept-language": "en-US,en;q=0.9,zh-TW;q=0.8"
    }
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text, finalUrl: response.url };
}

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function paragraphsFromHtml(html) {
  return String(html ?? "")
    .split(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/h[1-6]>/i)
    .map((chunk) => stripHtml(chunk))
    .filter((chunk) => chunk.length >= 20);
}

function findBestParagraph(claimText, pageText) {
  const paragraphs = paragraphsFromHtml(pageText);
  const tokens = extractKeyTerms(claimText);
  let best = null;

  for (const paragraph of paragraphs) {
    let score = 0;
    for (const token of tokens) {
      if (paragraph.toLowerCase().includes(token.toLowerCase())) score += token.length;
    }
    if (!best || score > best.score) {
      best = { score, paragraph };
    }
  }

  if (best?.score > 0 && best.paragraph.length >= 5) {
    return best.paragraph;
  }
  return "";
}

function inferScope(paragraph) {
  const snippet = normalizeWhitespace(paragraph);
  const matches = [];
  const scopePatterns = [
    /\bPhase\s+\d\b/ig,
    /\b(?:n\s*=\s*\d+|\d+\s+patients?)\b/ig,
    /\b(?:United States|Taiwan|global|multicenter)\b/ig,
    /\b(?:20\d{2}|19\d{2})\b/g,
  ];

  for (const pattern of scopePatterns) {
    for (const match of snippet.matchAll(pattern)) {
      matches.push(match[0]);
    }
  }

  return matches.join(", ").slice(0, 200);
}

async function searchDuckDuckGo(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchText(url);
  const html = response.text;
  const candidates = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/g)]
    .map((match) => match[1])
    .slice(0, 3);
  return candidates;
}

export async function groundClaimWithSource(claimMatch) {
  const attempts = [];
  const candidates = claimMatch.candidates.length ? claimMatch.candidates : [{ text: "", url: "" }];
  const primary = candidates[0];

  if (!primary.url) {
    return {
      claim: claimMatch.claim,
      source: primary,
      grounded: false,
      warning: "⚠️ 此宣稱來源無法驗證，建議移除或改寫",
      verbatim: "⚠️ 原文待確認",
      position: "",
      scope: "",
      supplemental: "",
      fallback: "No source candidate could be derived from article sources or source_hints.",
      attempts
    };
  }

  const tryUrls = [primary.url];
  for (const url of tryUrls) {
    const response = await fetchText(url);
    attempts.push({ stage: "fetch", url, status: response.status, ok: response.ok });
    if (response.ok) {
      const paragraph = findBestParagraph(claimMatch.claim.text, response.text);
      if (paragraph) {
        return {
          claim: claimMatch.claim,
          source: primary,
          grounded: true,
          warning: "",
          verbatim: paragraph,
          position: "Matched paragraph from fetched page",
          scope: inferScope(paragraph),
          supplemental: "",
          fallback: "",
          attempts
        };
      }
    }
  }

  const rescueQueries = [
    `${primary.text || primary.url} 替代版本`,
    `${primary.text || claimMatch.claim.text} ${extractKeyTerms(claimMatch.claim.text).join(" ")}`
  ];

  for (const query of rescueQueries) {
    const rescueUrls = await searchDuckDuckGo(query);
    attempts.push({ stage: "search", query, found: rescueUrls.length });
    for (const rescueUrl of rescueUrls) {
      const response = await fetchText(rescueUrl);
      attempts.push({ stage: "rescue_fetch", url: rescueUrl, status: response.status, ok: response.ok });
      if (!response.ok) continue;
      const paragraph = findBestParagraph(claimMatch.claim.text, response.text);
      if (!paragraph) continue;
      return {
        claim: claimMatch.claim,
        source: { text: primary.text, url: rescueUrl },
        grounded: true,
        warning: "",
        verbatim: paragraph,
        position: "Matched paragraph from rescue result",
        scope: inferScope(paragraph),
        supplemental: primary.url,
        fallback: `Search query: ${query}`,
        attempts
      };
    }
  }

  return {
    claim: claimMatch.claim,
    source: primary,
    grounded: false,
    warning: "⚠️ 此宣稱來源無法驗證，建議移除或改寫",
    verbatim: "⚠️ 原文待確認",
    position: "",
    scope: "",
    supplemental: "",
    fallback: attempts.map((attempt) => safeJsonParse(JSON.stringify(attempt)) ? JSON.stringify(attempt) : String(attempt)).join(" | "),
    attempts
  };
}
