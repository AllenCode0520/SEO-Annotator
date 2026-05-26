import { extractKeyTerms, normalizeWhitespace } from "../utils/text.js";
import { fetchWithRetry } from "../utils/fetch-helpers.js";
import { browserFetch } from "../utils/browser-fetch.js";

// ─── HTML helpers ────────────────────────────────────────────────────

function stripHtmlPreserveBreaks(html) {
  // Less aggressive than the old stripHtml: preserve paragraph-internal
  // single-spacing so the verbatim is closer to what a human Ctrl+F sees
  // in a browser (browsers also collapse whitespace, so multiple spaces
  // becoming one is OK; we don't want to bash newlines down to spaces
  // because some pages render verses / lists with meaningful breaks).
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function paragraphsFromHtml(html) {
  // Split on block-element close tags BEFORE doing the heavy strip so we
  // keep paragraph identity. Then strip each paragraph individually.
  return String(html ?? "")
    .split(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/h[1-6]>/i)
    .map((chunk) => stripHtmlPreserveBreaks(chunk))
    .filter((chunk) => chunk.length >= 20);
}

function findBestParagraph(claimText, pageText) {
  const paragraphs = paragraphsFromHtml(pageText);
  const tokens = extractKeyTerms(claimText);
  let best = null;

  for (const paragraph of paragraphs) {
    let score = 0;
    for (const token of tokens) {
      if (paragraph.toLowerCase().includes(token.toLowerCase())) {
        score += token.length;
      }
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
    /\bPhase\s+\d\b/gi,
    /\b(?:n\s*=\s*\d+|\d+\s+patients?)\b/gi,
    /\b(?:United States|Taiwan|global|multicenter)\b/gi,
    /\b(?:20\d{2}|19\d{2})\b/g,
  ];

  for (const pattern of scopePatterns) {
    for (const match of snippet.matchAll(pattern)) {
      matches.push(match[0]);
    }
  }
  return matches.join(", ").slice(0, 200);
}

// Try to label where in the page the matched paragraph lives. We do this
// by finding the most recent heading text above the matched paragraph.
function inferPosition(pageText, paragraph) {
  if (!paragraph) return "";
  const stripped = stripHtmlPreserveBreaks(pageText);
  const idx = stripped.indexOf(paragraph.slice(0, 60));
  if (idx < 0) return "Matched paragraph from fetched page";

  // Look at the 600 chars preceding the paragraph and try to find a
  // heading-looking line (short, no terminal punctuation).
  const lookback = stripped.slice(Math.max(0, idx - 600), idx);
  const lines = lookback
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.length < 4 || line.length > 120) continue;
    if (/[。！？.;]\s*$/.test(line)) continue;
    return `Section: "${line}"`;
  }
  return "Matched paragraph from fetched page";
}

// ─── Search-based rescue (Layer 2a/2b) ───────────────────────────────

async function searchDuckDuckGo(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchWithRetry(url, { timeoutMs: 10_000, retries: 1 });
  if (!response.ok) return [];
  const html = response.text;
  // DDG sometimes wraps result URLs in /l/?uddg= redirects. Pull out the
  // raw URL when that wrapper appears.
  const candidates = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/g)]
    .map((match) => {
      const href = match[1];
      const wrapped = href.match(/uddg=([^&]+)/);
      if (wrapped) return decodeURIComponent(wrapped[1]);
      return href;
    })
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 3);
  return candidates;
}

// ─── Main entry ──────────────────────────────────────────────────────

/**
 * Ground a single (claim, candidate sources) match.
 *
 * Order of operations per the spec:
 *   1. fetchWithRetry on the primary URL (Layer 1, with built-in retry)
 *   2. If body didn't yield a matching paragraph: try Playwright browser
 *      fetch on the same URL (Layer 2c — JS rendering / reCAPTCHA / login)
 *   3. WebSearch alternates for the same source / number (Layer 2a + 2b)
 *      → fetch each candidate
 *   4. Iterate the next candidate URLs in claimMatch.candidates (if any)
 *   5. Give up → return ungrounded + warning + detailed fallback string
 */
export async function groundClaimWithSource(claimMatch) {
  const attempts = [];
  const candidates = claimMatch.candidates.length
    ? claimMatch.candidates
    : [{ text: "", url: "" }];

  if (!candidates[0].url) {
    return makeUngrounded(claimMatch.claim, candidates[0], attempts,
      "No source candidate could be derived from article sources or source_hints.");
  }

  for (const primary of candidates) {
    if (!primary.url) continue;

    // 1) Layer 1: plain fetchWithRetry
    const layer1 = await fetchWithRetry(primary.url, { timeoutMs: 15_000, retries: 1 });
    attempts.push({ stage: "fetch", url: primary.url, ok: layer1.ok, status: layer1.status, tier: primary.tier ?? "primary" });

    if (layer1.ok) {
      const paragraph = findBestParagraph(claimMatch.claim.text, layer1.text);
      if (paragraph) {
        return makeGrounded(claimMatch.claim, primary, paragraph, layer1.text, attempts);
      }
    }

    // 2) Layer 2c: same URL via Playwright (only if Layer 1 failed OR
    //    succeeded but body didn't yield a paragraph — JS-rendered case).
    const layer2c = await browserFetch(primary.url, { timeoutMs: 25_000 });
    attempts.push({
      stage: "browser_fetch",
      url: primary.url,
      ok: layer2c.ok,
      status: layer2c.status,
      via: layer2c.reason ?? "playwright",
    });
    if (layer2c.ok) {
      const paragraph = findBestParagraph(claimMatch.claim.text, layer2c.text);
      if (paragraph) {
        return makeGrounded(claimMatch.claim, primary, paragraph, layer2c.text, attempts, { via: "browser" });
      }
    }
  }

  // 3) Layer 2a/2b: WebSearch on a rescue query, fetch each hit
  const primary = candidates.find((c) => c.url) ?? { text: "", url: "" };
  const rescueQueries = uniqueQueries([
    primary.text && `${primary.text} ${claimMatch.claim.text}`,
    primary.text && `${primary.text} 替代版本`,
    `${claimMatch.claim.text} ${extractKeyTerms(claimMatch.claim.text).join(" ")}`,
  ]);

  for (const query of rescueQueries) {
    const rescueUrls = await searchDuckDuckGo(query);
    attempts.push({ stage: "search", query, found: rescueUrls.length });
    for (const rescueUrl of rescueUrls) {
      const layer2 = await fetchWithRetry(rescueUrl, { timeoutMs: 15_000, retries: 1 });
      attempts.push({
        stage: "rescue_fetch",
        url: rescueUrl,
        ok: layer2.ok,
        status: layer2.status,
      });
      if (!layer2.ok) continue;
      const paragraph = findBestParagraph(claimMatch.claim.text, layer2.text);
      if (!paragraph) continue;
      return makeGrounded(
        claimMatch.claim,
        { text: primary.text, url: rescueUrl, tier: "rescue" },
        paragraph,
        layer2.text,
        attempts,
        { supplemental: primary.url, fallbackQuery: query }
      );
    }
  }

  // 4) All failed
  return makeUngrounded(
    claimMatch.claim,
    primary,
    attempts,
    `Layer 1+2c+2a/b all failed; ${attempts.length} attempts logged.`
  );
}

// ─── Result builders ─────────────────────────────────────────────────

function makeGrounded(claim, source, paragraph, pageText, attempts, extras = {}) {
  return {
    claim,
    source,
    grounded: true,
    warning: "",
    verbatim: paragraph,
    position: extras.via === "browser"
      ? `Section (browser-rendered): ${inferPosition(pageText, paragraph).replace(/^Section: /, "")}`
      : inferPosition(pageText, paragraph),
    scope: inferScope(paragraph),
    supplemental: extras.supplemental ?? "",
    fallback: extras.fallbackQuery ? `Search query: ${extras.fallbackQuery}` : "",
    attempts,
  };
}

function makeUngrounded(claim, source, attempts, summary) {
  return {
    claim,
    source: source ?? { text: "", url: "" },
    grounded: false,
    warning: "⚠️ 此宣稱來源無法驗證，建議移除或改寫",
    verbatim: "⚠️ 原文待確認",
    position: "",
    scope: "",
    supplemental: "",
    fallback: `${summary} attempts=${JSON.stringify(attempts).slice(0, 800)}`,
    attempts,
  };
}

function uniqueQueries(queries) {
  const out = [];
  const seen = new Set();
  for (const raw of queries) {
    if (!raw) continue;
    const q = normalizeWhitespace(raw);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  return out;
}
