/**
 * browser-fetch — Source Rescue Layer 2c.
 *
 * When plain `fetch()` keeps failing on the same URL (reCAPTCHA, JS-only
 * rendered pages, login walls that issue a 403 to unauthenticated bots),
 * we try again with a real headless browser. Playwright is an OPTIONAL
 * dependency — if it's not installed, this module exports a stub that
 * always returns { ok: false, reason: "playwright not installed" } so
 * the grounder can gracefully skip Layer 2c without crashing.
 *
 * To enable:   npm install playwright   &&   npx playwright install chromium
 *
 * Why optional: Playwright + Chromium is ~500MB and many deploys
 * don't need it (mostly-plain-HTML targets). The runtime check keeps
 * the package light by default and powerful when needed.
 */

let _playwright = null;
let _playwrightAttempted = false;

async function loadPlaywright() {
  if (_playwrightAttempted) return _playwright;
  _playwrightAttempted = true;
  try {
    const mod = await import("playwright");
    _playwright = mod;
  } catch {
    _playwright = null;
  }
  return _playwright;
}

let _browser = null;
let _browserClosing = null;

async function ensureBrowser(pw) {
  if (_browser) return _browser;
  _browser = await pw.chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  return _browser;
}

/** Allow the CLI to clean up the singleton at process exit. */
export async function shutdownBrowser() {
  if (!_browser) return;
  if (_browserClosing) return _browserClosing;
  _browserClosing = _browser.close().catch(() => {});
  await _browserClosing;
  _browser = null;
  _browserClosing = null;
}

/**
 * Fetch a URL via headless Chromium, returning the rendered HTML.
 * Mirrors the fetchWithRetry return shape so callers can swap freely.
 */
export async function browserFetch(url, { timeoutMs = 25_000 } = {}) {
  const pw = await loadPlaywright();
  if (!pw) {
    return {
      ok: false,
      status: 0,
      text: "",
      finalUrl: url,
      attempts: [{ n: 1, ok: false, errorMessage: "playwright not installed" }],
      reason: "playwright not installed",
    };
  }

  const browser = await ensureBrowser(pw);
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    // Let lazy content settle briefly
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    const html = await page.content();
    return {
      ok: response ? response.ok() : true,
      status: response ? response.status() : 0,
      text: html,
      finalUrl: page.url(),
      attempts: [{ n: 1, ok: true, status: response?.status() ?? 0, via: "playwright" }],
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: "",
      finalUrl: url,
      attempts: [
        { n: 1, ok: false, errorMessage: error?.message ?? String(error), via: "playwright" },
      ],
      error: error?.message ?? String(error),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export function isBrowserAvailable() {
  // Sync hint for CLI banner; doesn't trigger the dynamic import.
  return _playwright !== null;
}
