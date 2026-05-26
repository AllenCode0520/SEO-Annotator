/**
 * fetchWithRetry — node global fetch with timeout + transient-failure retry.
 *
 * Why: source-grounder must not hang the whole run on a single slow URL
 * (cron scenario) and must not give up on a single transient network
 * blip (Source Rescue Layer 1).
 *
 * - timeoutMs:    AbortController timer; default 15s
 * - retries:      number of additional attempts after the first failure;
 *                 default 1 (= 2 total attempts)
 * - retryDelayMs: backoff between attempts; default 500ms (constant; small)
 *
 * Returns the same shape as the original ad-hoc helper:
 *   { ok, status, text, finalUrl, attempts }
 * `attempts` is an array of {n, ok, status, errorMessage?} per attempt,
 * useful for the `fallback` debug field of an unverifiable claim.
 */

const DEFAULT_USER_AGENT =
  "AnnotatorRobot/0.1 (+https://local.annotator; node-fetch)";

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  url,
  {
    timeoutMs = 15_000,
    retries = 1,
    retryDelayMs = 500,
    headers,
  } = {}
) {
  const attempts = [];
  const totalAttempts = retries + 1;
  let lastError;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
          "accept-language": "en-US,en;q=0.9,zh-TW;q=0.8",
          ...headers,
        },
        redirect: "follow",
      });
      const text = await response.text();
      clearTimeout(timer);

      attempts.push({ n: attempt, ok: response.ok, status: response.status });

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          text,
          finalUrl: response.url,
          attempts,
        };
      }

      // Non-OK but not transient → don't retry (4xx mostly)
      if (!TRANSIENT_STATUSES.has(response.status) || attempt === totalAttempts) {
        return {
          ok: false,
          status: response.status,
          text,
          finalUrl: response.url,
          attempts,
        };
      }
    } catch (error) {
      clearTimeout(timer);
      const errorMessage =
        error?.name === "AbortError"
          ? `timeout after ${timeoutMs}ms`
          : error?.message ?? String(error);
      attempts.push({ n: attempt, ok: false, errorMessage });
      lastError = error;
    }

    if (attempt < totalAttempts) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  return {
    ok: false,
    status: 0,
    text: "",
    finalUrl: url,
    attempts,
    error: lastError ? (lastError.message ?? String(lastError)) : "fetch failed",
  };
}
