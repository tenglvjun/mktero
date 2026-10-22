// How a website embeds the preview (embed version PREVIEW_EMBED_VERSION in
// scripts/build-preview.mjs). The website serves the release under these
// restrictions, so a tampered release cannot read its storage or cookies,
// reach the network, or navigate the page. The preview must keep working
// inside them; scripts/validate-preview-browser.mjs checks that it does.
//
// The website's copies live in mktero-web (next.config.ts, the nginx example,
// and features/marketing/hero-preview.tsx). Change them together.
export const EMBED_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
export const EMBED_CSP = [
    `sandbox ${EMBED_SANDBOX}`,
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
].join('; ');
export const READY_MESSAGE = 'mktero-preview-ready';

const DARK_QUERY = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/g;

export function isDarkSchemeQuery(query) {
    DARK_QUERY.lastIndex = 0;
    return DARK_QUERY.test(String(query));
}

// Turns every dark-scheme media condition into one that never matches.
export function lightOnlyStyles(styles) {
    return String(styles).replace(DARK_QUERY, 'not all');
}

// The reader picks its code theme with matchMedia, so that has to answer
// "light" too.
export function forceLightColorScheme(target) {
    const matchMedia = target.matchMedia.bind(target);
    target.matchMedia = query => matchMedia(isDarkSchemeQuery(query) ? 'not all' : query);
}

// Tells the embedding page the reader is up. Inside the website's sandbox the
// document has an opaque origin, but its location still names the site, so
// the message is addressed to that origin only. Pages opened directly, or
// from a file:// URL, are not told anything.
export function postReady(target) {
    if (!target.parent || target.parent === target) return false;
    const origin = target.location?.origin;
    if (!origin || origin === 'null') return false;
    try {
        target.parent.postMessage({ type: READY_MESSAGE }, origin);
        return true;
    }
    catch {
        return false;
    }
}
