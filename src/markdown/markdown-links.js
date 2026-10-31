// Markdown backslash escapes are syntax, not part of an HTTP URL. Keep this
// normalization shared by the HTML renderer and the editor's link opener so
// old cached Markdown remains usable after the serializer is fixed.
const MARKDOWN_LINK_ESCAPE_PATTERN = /\\([!-/:-@[-`{-~])/gu;
const MAX_MINERU_URL_LENGTH = 4096;

export function normalizeMarkdownLinkURL(value) {
    return String(value || '')
        .trim()
        .replace(MARKDOWN_LINK_ESCAPE_PATTERN, '$1')
        .replace(/[\u0000-\u001F\u007F]/gu, '');
}

export function safeMarkdownLinkURL(value) {
    const url = normalizeMarkdownLinkURL(value);
    if (/^https?:\/\//i.test(url)) {
        try {
            const parsed = new URL(url);
            if (!parsed.hostname || parsed.username || parsed.password) return null;
            return /[\s"'<>]/u.test(url) ? parsed.href : url;
        }
        catch {
            return null;
        }
    }
    if (/^zotero:\/\//i.test(url) || url.startsWith('#')) return url;
    return null;
}

// MinerU URLs are provider data, not Markdown syntax. Only absolute HTTP(S)
// URLs are allowed, and the raw value is not Markdown-unescaped.
export function safeMinerULinkURL(value) {
    const raw = String(value || '').trim();
    if (!raw || !/^https?:\/\//iu.test(raw) || raw.includes('\\')
        || /[\u0000-\u001F\u007F]/u.test(raw) || raw.length > MAX_MINERU_URL_LENGTH) return null;
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        return null;
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return /[\s"'<>]/u.test(raw) ? parsed.href : raw;
}

export function escapeMarkdownLinkDestination(value) {
    const url = safeMarkdownLinkURL(value);
    return url ? escapeLinkDestination(url) : null;
}

export function escapeMinerULinkDestination(value) {
    const url = safeMinerULinkURL(value);
    return url ? escapeLinkDestination(url) : null;
}

function escapeLinkDestination(url) {
    return url.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}
