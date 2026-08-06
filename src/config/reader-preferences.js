export const MARKDOWN_READER_FONT_SIZE_PREF
    = 'extensions.mktero.readerFontSize';
export const MARKDOWN_READER_FONT_SIZE_DEFAULT = 18;
export const MARKDOWN_READER_FONT_SIZE_MIN = 16;
export const MARKDOWN_READER_FONT_SIZE_MAX = 22;

export function getMarkdownReaderFontSize(zotero) {
    return normalizeMarkdownReaderFontSize(
        zotero?.Prefs?.get?.(MARKDOWN_READER_FONT_SIZE_PREF, true)
    );
}

export function setMarkdownReaderFontSize(zotero, value) {
    const normalized = normalizeMarkdownReaderFontSize(value);
    zotero?.Prefs?.set?.(MARKDOWN_READER_FONT_SIZE_PREF, normalized, true);
    return normalized;
}

export function observeMarkdownReaderFontSize(zotero, onChange) {
    if (typeof zotero?.Prefs?.registerObserver !== 'function'
        || typeof onChange !== 'function') {
        return () => {};
    }
    const observer = zotero.Prefs.registerObserver(
        MARKDOWN_READER_FONT_SIZE_PREF,
        value => onChange(normalizeMarkdownReaderFontSize(value)),
        true
    );
    return () => zotero.Prefs.unregisterObserver?.(observer);
}

export function normalizeMarkdownReaderFontSize(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return MARKDOWN_READER_FONT_SIZE_DEFAULT;
    return Math.min(
        MARKDOWN_READER_FONT_SIZE_MAX,
        Math.max(MARKDOWN_READER_FONT_SIZE_MIN, Math.round(numeric))
    );
}
