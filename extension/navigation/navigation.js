/**
 * Capability-Aware Navigation Layer
 *
 * Pure, deterministic helpers (no chrome dependency) shared by the agent
 * controller and the action executor:
 *
 * - classifyPageCapability(): is the current tab DOM-automatable?
 * - resolveNavigationTarget(): deterministic site/domain/URL resolution
 * - validateNavigationUrl(): strict allow-scheme URL validation
 * - urlsMatchForVerification(): redirect-tolerant navigation verification
 * - isPureNavigateTask() / getNavigationGoal(): reuse of task semantics
 *
 * Security: navigation URLs NEVER come from raw LLM output. They are
 * resolved deterministically from the sanitized user task (or from an
 * allowlisted site map) and must pass validateNavigationUrl() before any
 * chrome.tabs.update() call.
 */

export const PageCapability = Object.freeze({
  AUTOMATABLE_WEB: 'AUTOMATABLE_WEB',
  BROWSER_INTERNAL: 'BROWSER_INTERNAL',
  EXTENSION_INTERNAL: 'EXTENSION_INTERNAL',
  ABOUT_BLANK: 'ABOUT_BLANK',
  UNKNOWN: 'UNKNOWN'
});

// Deterministic allowlisted/common-site resolver. Small on purpose: only
// well-known public homepages. Everything else must be a valid domain/URL.
export const COMMON_SITES = Object.freeze({
  youtube: 'https://www.youtube.com/',
  google: 'https://www.google.com/',
  github: 'https://github.com/',
  stackoverflow: 'https://stackoverflow.com/',
  bing: 'https://www.bing.com/',
  duckduckgo: 'https://duckduckgo.com/',
  gmail: 'https://mail.google.com/',
  drive: 'https://drive.google.com/',
  maps: 'https://www.google.com/maps'
});

// Schemes that must never be navigated to / executed.
const BLOCKED_SCHEMES = Object.freeze([
  'javascript:', 'data:', 'vbscript:', 'file:', 'chrome:', 'chrome-extension:',
  'edge:', 'brave:', 'opera:', 'vivaldi:', 'about:', 'moz-extension:',
  'safari-extension:', 'blob:', 'view-source:', 'devtools:', 'chrome-devtools:',
  'chrome-search:', 'chrome-native:', 'content:'
]);

/**
 * Classify what the agent may do with the tab showing `url`.
 * NON-DOM-AUTOMATABLE != TASK-UNEXECUTABLE: a NAVIGATE task can still leave.
 */
export function classifyPageCapability(url) {
  if (url == null || typeof url !== 'string' || !url.trim()) return PageCapability.UNKNOWN;
  const u = url.trim().toLowerCase();
  if (u === 'about:blank') return PageCapability.ABOUT_BLANK;
  if (
    u.startsWith('chrome://') || u.startsWith('chrome-search://') ||
    u.startsWith('chrome-native://') || u.startsWith('edge://') ||
    u.startsWith('brave://') || u.startsWith('opera://') ||
    u.startsWith('vivaldi://') || u.startsWith('about:') ||
    u.startsWith('view-source:') || u.startsWith('devtools://') ||
    u.startsWith('chrome-devtools://') || u.startsWith('file://') ||
    u.startsWith('data:') || u.startsWith('blob:')
  ) {
    return PageCapability.BROWSER_INTERNAL;
  }
  if (
    u.startsWith('chrome-extension://') || u.startsWith('moz-extension://') ||
    u.startsWith('safari-extension://')
  ) {
    return PageCapability.EXTENSION_INTERNAL;
  }
  if (u.startsWith('http://') || u.startsWith('https://')) return PageCapability.AUTOMATABLE_WEB;
  return PageCapability.UNKNOWN;
}

/** Strip wrapping quotes/trailing sentence punctuation from a candidate. */
function cleanCandidate(raw) {
  return String(raw || '').trim().replace(/^["'<]+|["'>.,!?;]+$/g, '').trim();
}

/**
 * Deterministically resolve a navigation destination from task text.
 * Returns { url, site } or null when the text is not a navigation request
 * with a resolvable destination. Never invents hosts.
 */
export function resolveNavigationTarget(text) {
  if (!text || typeof text !== 'string') return null;
  let remainder = String(text).trim();
  const verbMatch = remainder.match(/^(?:please\s+)?(?:could\s+you\s+)?(?:open|go\s+to|navigate\s+to|visit|go)\s+(.+)$/i);
  if (!verbMatch) return null;
  remainder = cleanCandidate(verbMatch[1]);
  if (!remainder) return null;
  const lower = remainder.toLowerCase();

  // 1. Bare allowlisted site name: "open youtube"
  if (COMMON_SITES[lower]) {
    return { url: COMMON_SITES[lower], site: lower };
  }
  // 2. Site name with noise stripped ("youtube homepage", "the youtube site")
  const siteKey = lower.replace(/^(the\s+)?/, '').replace(/\s+(homepage|website|site|app)$/, '').trim();
  if (COMMON_SITES[siteKey]) {
    return { url: COMMON_SITES[siteKey], site: siteKey };
  }

  // 2b. Compound action: "open youtube and play...", "go to amazon to buy...", "visit github then search..."
  const compoundMatch = lower.match(/^([a-z0-9.-]+)(?:\s+(?:and(?:\s+then)?|to|then|for)\s+.*)?$/i);
  if (compoundMatch) {
    const candidateSite = compoundMatch[1].replace(/^(the\s+)?/, '').trim();
    if (COMMON_SITES[candidateSite]) {
      return { url: COMMON_SITES[candidateSite], site: candidateSite };
    }
  }

  // 3. Explicit URL or bare domain: "open https://example.com", "go to github.com"
  const domainCandidate = remainder.replace(/(?:\s+(?:and(?:\s+then)?|to|then|for)\s+.*)$/i, '').trim();
  const withScheme = /^https?:\/\//i.test(domainCandidate) ? domainCandidate : `https://${domainCandidate}`;
  if (/^https?:\/\/[^\s"'<>\\]+$/i.test(withScheme)) {
    try {
      const parsed = new URL(withScheme);
      const host = parsed.hostname.toLowerCase();
      // Require a real host: dotted domain or localhost. Single bare words
      // ("open youtube videos") must NOT become https://youtube videos.
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host) || host === 'localhost') {
        const site = host.replace(/^www\./, '').split('.')[0];
        return { url: parsed.toString(), site };
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Strictly validate + normalize a navigation URL.
 * Allows http/https with a valid host only. Rejects scriptable and
 * browser-internal schemes. Returns { valid, normalizedUrl, host, reason }.
 */
export function validateNavigationUrl(url) {
  if (url == null || (typeof url !== 'string' && typeof url !== 'object')) {
    return { valid: false, normalizedUrl: null, host: null, reason: 'Empty navigation URL.' };
  }
  let candidate = cleanCandidate(String(url));
  if (!candidate) return { valid: false, normalizedUrl: null, host: null, reason: 'Empty navigation URL.' };

  const lower = candidate.toLowerCase();
  for (const scheme of BLOCKED_SCHEMES) {
    if (lower.startsWith(scheme)) {
      return { valid: false, normalizedUrl: null, host: null, reason: `Blocked navigation scheme: ${scheme}` };
    }
  }
  // Any other non-http(s) scheme (e.g. ftp:, intent:) is unsupported.
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^https?:\/\//i.test(candidate)) {
    return { valid: false, normalizedUrl: null, host: null, reason: 'Only http(s) navigation is supported.' };
  }
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, normalizedUrl: null, host: null, reason: 'Malformed navigation URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, normalizedUrl: null, host: null, reason: `Blocked navigation scheme: ${parsed.protocol}` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || /\s/.test(host) || host.includes('\\') || (!host.includes('.') && host !== 'localhost')) {
    return { valid: false, normalizedUrl: null, host: null, reason: 'Navigation URL has no valid host.' };
  }
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host) && host !== 'localhost') {
    return { valid: false, normalizedUrl: null, host: null, reason: 'Navigation URL has no valid host.' };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, normalizedUrl: null, host: null, reason: 'Credentialed URLs are not allowed.' };
  }
  return { valid: true, normalizedUrl: parsed.toString(), host, reason: null };
}

function normalizeHostForCompare(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return h.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Redirect-tolerant verification: hosts must match after lowercasing and
 * stripping a single leading "www.". Paths/queries may differ
 * (https://youtube.com → https://www.youtube.com/ is success).
 */
export function urlsMatchForVerification(expectedUrl, actualUrl) {
  if (!expectedUrl || !actualUrl) return false;
  const expectedHost = normalizeHostForCompare(expectedUrl);
  const actualHost = normalizeHostForCompare(actualUrl);
  if (!expectedHost || !actualHost) return false;
  return expectedHost === actualHost;
}

// Interaction verbs that disqualify a pure NAVIGATE (compound task).
const NON_NAV_VERBS = /\b(search|find|fill|type|click|tap|play|watch|login|log\s*in|sign\s*in|book|reserve|download|upload|attach|extract|cheapest|lowest|buy|compare|enable|disable|fill\s+out)\b/i;

/**
 * True only for tasks that are JUST navigation ("open youtube").
 * "search youtube for cats" is compound, not pure.
 */
export function isPureNavigateTask(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  const text = prompt.trim();
  if (!/^(?:please\s+)?(?:could\s+you\s+)?(?:open|go\s+to|navigate\s+to|visit|go)\b/i.test(text)) return false;
  const resolved = resolveNavigationTarget(text);
  if (!resolved) return false;
  const remainder = text.replace(/^(?:please\s+)?(?:could\s+you\s+)?(?:open|go\s+to|navigate\s+to|visit|go)\s+/i, '');
  if (NON_NAV_VERBS.test(remainder)) return false;
  return true;
}

/** Homepage for a known site key (used for compound bootstrap navigation). */
export function getSiteHomepage(site) {
  if (!site || typeof site !== 'string') return null;
  return COMMON_SITES[site.toLowerCase()] || null;
}

/**
 * Navigation goal for a task: { url, site, isPure } or null when the task
 * is not navigation-led. Reuses deterministic resolution; the caller may
 * additionally consult TaskState.site for compound tasks.
 */
export function getNavigationGoal(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const resolved = resolveNavigationTarget(prompt);
  if (!resolved) return null;
  return { url: resolved.url, site: resolved.site, isPure: isPureNavigateTask(prompt) };
}
