export const MARKDOWN_READER_FONT_SIZE_PREF
    = 'extensions.mktero.readerFontSize';
export const MARKDOWN_READER_FONT_SIZE_DEFAULT = 18;
export const MARKDOWN_READER_FONT_SIZE_MIN = 16;
export const MARKDOWN_READER_FONT_SIZE_MAX = 22;
export const MARKDOWN_READER_FONT_PREF = 'extensions.mktero.readerFont';
export const MARKDOWN_READER_FONT_DEFAULT = 'georgia';
export const MARKDOWN_READER_FONT_OPTIONS = Object.freeze([
    Object.freeze({
        value: 'georgia',
        labelKey: 'viewer.fontGeorgia',
        family: 'Georgia, Cambria, "Times New Roman", serif',
    }),
    Object.freeze({
        value: 'cambria',
        labelKey: 'viewer.fontCambria',
        family: 'Cambria, Georgia, "Times New Roman", serif',
    }),
    Object.freeze({
        value: 'times-new-roman',
        labelKey: 'viewer.fontTimesNewRoman',
        family: '"Times New Roman", Georgia, Cambria, serif',
    }),
    Object.freeze({
        value: 'system-serif',
        labelKey: 'viewer.fontSystemSerif',
        family: 'serif',
    }),
]);

const MARKDOWN_READER_FONT_VALUES = new Set(
    MARKDOWN_READER_FONT_OPTIONS.map(option => option.value)
);

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

export function getMarkdownReaderFont(zotero) {
    return normalizeMarkdownReaderFont(
        zotero?.Prefs?.get?.(MARKDOWN_READER_FONT_PREF, true)
    );
}

export function setMarkdownReaderFont(zotero, value) {
    const normalized = normalizeMarkdownReaderFont(value);
    zotero?.Prefs?.set?.(MARKDOWN_READER_FONT_PREF, normalized, true);
    return normalized;
}

export function observeMarkdownReaderFont(zotero, onChange) {
    if (typeof zotero?.Prefs?.registerObserver !== 'function'
        || typeof onChange !== 'function') {
        return () => {};
    }
    const observer = zotero.Prefs.registerObserver(
        MARKDOWN_READER_FONT_PREF,
        value => onChange(normalizeMarkdownReaderFont(value)),
        true
    );
    return () => zotero.Prefs.unregisterObserver?.(observer);
}

export function normalizeMarkdownReaderFont(value) {
    const normalized = String(value ?? '').trim();
    return MARKDOWN_READER_FONT_VALUES.has(normalized)
        ? normalized
        : MARKDOWN_READER_FONT_DEFAULT;
}

export function getMarkdownReaderFontFamily(value) {
    const normalized = normalizeMarkdownReaderFont(value);
    return MARKDOWN_READER_FONT_OPTIONS.find(option => (
        option.value === normalized
    )).family;
}
