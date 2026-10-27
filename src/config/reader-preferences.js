export const MARKDOWN_READER_FONT_SIZE_PREF
    = 'extensions.mktero.readerFontSize';
export const MARKDOWN_READER_FONT_SIZE_DEFAULT = 18;
export const MARKDOWN_READER_FONT_SIZE_MIN = 14;
export const MARKDOWN_READER_FONT_SIZE_MAX = 28;
export const MARKDOWN_READER_FONT_PREF = 'extensions.mktero.readerFont';
export const MARKDOWN_READER_FONT_DEFAULT = 'system-serif';
export const MARKDOWN_READER_SOURCE_PEEK_PREF
    = 'extensions.mktero.readerSourcePeek';
export const MARKDOWN_READER_SOURCE_PEEK_DEFAULT = true;
export const MARKDOWN_READER_LINE_HEIGHT_PREF
    = 'extensions.mktero.readerLineHeight';
export const MARKDOWN_READER_LINE_HEIGHT_DEFAULT = 'standard';
export const MARKDOWN_READER_WIDTH_PREF = 'extensions.mktero.readerWidth';
export const MARKDOWN_READER_WIDTH_DEFAULT = 'standard';
export const MARKDOWN_READER_ALIGNMENT_PREF
    = 'extensions.mktero.readerAlignment';
export const MARKDOWN_READER_ALIGNMENT_DEFAULT = 'start';
// Side panel layout. Every Mktero tab opens with the layout the reader left in
// the last one: visibility and width per column, and the left column segment.
export const MARKDOWN_READER_OUTLINE_VISIBLE_PREF
    = 'extensions.mktero.readerOutlineVisible';
export const MARKDOWN_READER_OUTLINE_WIDTH_PREF
    = 'extensions.mktero.readerOutlineWidth';
export const MARKDOWN_READER_OUTLINE_SEGMENT_PREF
    = 'extensions.mktero.readerOutlineSegment';
export const MARKDOWN_READER_NOTES_VISIBLE_PREF
    = 'extensions.mktero.readerNotesVisible';
export const MARKDOWN_READER_NOTES_WIDTH_PREF
    = 'extensions.mktero.readerNotesWidth';
export const MARKDOWN_READER_OUTLINE_WIDTH_DEFAULT = 256;
export const MARKDOWN_READER_OUTLINE_WIDTH_MIN = 180;
export const MARKDOWN_READER_OUTLINE_WIDTH_MAX = 480;
export const MARKDOWN_READER_NOTES_WIDTH_DEFAULT = 300;
export const MARKDOWN_READER_NOTES_WIDTH_MIN = 220;
export const MARKDOWN_READER_NOTES_WIDTH_MAX = 480;
export const MARKDOWN_READER_OUTLINE_SEGMENTS = Object.freeze([
    'headings',
    'figures',
    'annotations',
]);
export const MARKDOWN_READER_OUTLINE_SEGMENT_DEFAULT = 'headings';
export const MARKDOWN_READER_FONT_OPTIONS = Object.freeze([
    Object.freeze({
        value: 'system-serif',
        labelKey: 'viewer.fontSystemSerif',
        family: '"STIX Two Text", "Noto Serif SC", ui-serif, "Iowan Old Style", Charter, "Bitstream Charter", Georgia, serif',
    }),
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
]);

export const MARKDOWN_READER_LINE_HEIGHT_OPTIONS = Object.freeze([
    Object.freeze({
        value: 'tight',
        labelKey: 'viewer.lineHeightTight',
        css: '1.55',
    }),
    Object.freeze({
        value: 'standard',
        labelKey: 'viewer.lineHeightStandard',
        css: '1.78',
    }),
    Object.freeze({
        value: 'loose',
        labelKey: 'viewer.lineHeightLoose',
        css: '2.05',
    }),
]);
// `css` is the widest the reading column may grow. The column itself follows
// the window and stops growing at this cap, so a wide window gets wider lines
// and text, figures, tables, and code all share one edge.
export const MARKDOWN_READER_WIDTH_OPTIONS = Object.freeze([
    Object.freeze({
        value: 'narrow',
        labelKey: 'viewer.widthNarrow',
        css: '45rem',
    }),
    Object.freeze({
        value: 'standard',
        labelKey: 'viewer.widthStandard',
        css: '80rem',
    }),
    Object.freeze({
        value: 'wide',
        labelKey: 'viewer.widthWide',
        css: '120rem',
    }),
]);
export const MARKDOWN_READER_ALIGNMENT_OPTIONS = Object.freeze([
    Object.freeze({
        value: 'justify',
        labelKey: 'viewer.alignmentJustify',
        css: 'justify',
    }),
    Object.freeze({
        value: 'start',
        labelKey: 'viewer.alignmentStart',
        css: 'start',
    }),
]);

const MARKDOWN_READER_FONT_VALUES = new Set(
    MARKDOWN_READER_FONT_OPTIONS.map(option => option.value)
);
const MARKDOWN_READER_LINE_HEIGHT_VALUES = new Set(
    MARKDOWN_READER_LINE_HEIGHT_OPTIONS.map(option => option.value)
);
const MARKDOWN_READER_WIDTH_VALUES = new Set(
    MARKDOWN_READER_WIDTH_OPTIONS.map(option => option.value)
);
const MARKDOWN_READER_ALIGNMENT_VALUES = new Set(
    MARKDOWN_READER_ALIGNMENT_OPTIONS.map(option => option.value)
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

export function getMarkdownReaderSourcePeek(zotero) {
    return normalizeMarkdownReaderSourcePeek(
        zotero?.Prefs?.get?.(MARKDOWN_READER_SOURCE_PEEK_PREF, true)
    );
}

export function setMarkdownReaderSourcePeek(zotero, value) {
    const normalized = normalizeMarkdownReaderSourcePeek(value);
    zotero?.Prefs?.set?.(MARKDOWN_READER_SOURCE_PEEK_PREF, normalized, true);
    return normalized;
}

export function observeMarkdownReaderSourcePeek(zotero, onChange) {
    if (typeof zotero?.Prefs?.registerObserver !== 'function'
        || typeof onChange !== 'function') {
        return () => {};
    }
    const observer = zotero.Prefs.registerObserver(
        MARKDOWN_READER_SOURCE_PEEK_PREF,
        value => onChange(normalizeMarkdownReaderSourcePeek(value)),
        true
    );
    return () => zotero.Prefs.unregisterObserver?.(observer);
}

export function normalizeMarkdownReaderSourcePeek(value) {
    if (value === false || value === 0 || value === 'false') return false;
    if (value === true || value === 1 || value === 'true') return true;
    return MARKDOWN_READER_SOURCE_PEEK_DEFAULT;
}

export function getMarkdownReaderLineHeight(zotero) {
    return normalizeMarkdownReaderLineHeight(
        zotero?.Prefs?.get?.(MARKDOWN_READER_LINE_HEIGHT_PREF, true)
    );
}

export function setMarkdownReaderLineHeight(zotero, value) {
    const normalized = normalizeMarkdownReaderLineHeight(value);
    zotero?.Prefs?.set?.(MARKDOWN_READER_LINE_HEIGHT_PREF, normalized, true);
    return normalized;
}

export function observeMarkdownReaderLineHeight(zotero, onChange) {
    return observeReaderPreference(
        zotero,
        MARKDOWN_READER_LINE_HEIGHT_PREF,
        value => onChange(normalizeMarkdownReaderLineHeight(value))
    );
}

export function normalizeMarkdownReaderLineHeight(value) {
    const normalized = String(value ?? '').trim();
    return MARKDOWN_READER_LINE_HEIGHT_VALUES.has(normalized)
        ? normalized
        : MARKDOWN_READER_LINE_HEIGHT_DEFAULT;
}

export function getMarkdownReaderLineHeightCss(value) {
    return cssForReaderOption(
        MARKDOWN_READER_LINE_HEIGHT_OPTIONS,
        normalizeMarkdownReaderLineHeight(value)
    );
}

export function getMarkdownReaderWidth(zotero) {
    return normalizeMarkdownReaderWidth(
        zotero?.Prefs?.get?.(MARKDOWN_READER_WIDTH_PREF, true)
    );
}

export function setMarkdownReaderWidth(zotero, value) {
    const normalized = normalizeMarkdownReaderWidth(value);
    zotero?.Prefs?.set?.(MARKDOWN_READER_WIDTH_PREF, normalized, true);
    return normalized;
}

export function observeMarkdownReaderWidth(zotero, onChange) {
    return observeReaderPreference(
        zotero,
        MARKDOWN_READER_WIDTH_PREF,
        value => onChange(normalizeMarkdownReaderWidth(value))
    );
}

export function normalizeMarkdownReaderWidth(value) {
    const normalized = String(value ?? '').trim();
    return MARKDOWN_READER_WIDTH_VALUES.has(normalized)
        ? normalized
        : MARKDOWN_READER_WIDTH_DEFAULT;
}

export function getMarkdownReaderWidthCss(value) {
    return cssForReaderOption(
        MARKDOWN_READER_WIDTH_OPTIONS,
        normalizeMarkdownReaderWidth(value)
    );
}

export function getMarkdownReaderAlignment(zotero) {
    return normalizeMarkdownReaderAlignment(
        zotero?.Prefs?.get?.(MARKDOWN_READER_ALIGNMENT_PREF, true)
    );
}

export function setMarkdownReaderAlignment(zotero, value) {
    const normalized = normalizeMarkdownReaderAlignment(value);
    zotero?.Prefs?.set?.(MARKDOWN_READER_ALIGNMENT_PREF, normalized, true);
    return normalized;
}

export function observeMarkdownReaderAlignment(zotero, onChange) {
    return observeReaderPreference(
        zotero,
        MARKDOWN_READER_ALIGNMENT_PREF,
        value => onChange(normalizeMarkdownReaderAlignment(value))
    );
}

export function normalizeMarkdownReaderAlignment(value) {
    const normalized = String(value ?? '').trim();
    return MARKDOWN_READER_ALIGNMENT_VALUES.has(normalized)
        ? normalized
        : MARKDOWN_READER_ALIGNMENT_DEFAULT;
}

export function getMarkdownReaderAlignmentCss(value) {
    return cssForReaderOption(
        MARKDOWN_READER_ALIGNMENT_OPTIONS,
        normalizeMarkdownReaderAlignment(value)
    );
}

// The layout the reader left in the last Mktero tab. Every value is clamped,
// so a hand-edited preference cannot open a column wider than it can be
// dragged.
export function getMarkdownReaderPanelLayout(zotero) {
    const read = pref => zotero?.Prefs?.get?.(pref, true);
    return normalizeMarkdownReaderPanelLayout({
        outline: {
            visible: read(MARKDOWN_READER_OUTLINE_VISIBLE_PREF),
            width: read(MARKDOWN_READER_OUTLINE_WIDTH_PREF),
        },
        notes: {
            visible: read(MARKDOWN_READER_NOTES_VISIBLE_PREF),
            width: read(MARKDOWN_READER_NOTES_WIDTH_PREF),
        },
        outlineSegment: read(MARKDOWN_READER_OUTLINE_SEGMENT_PREF),
    });
}

// Writes only the fields present in `changes`, and returns the normalized
// layout after the write.
export function setMarkdownReaderPanelLayout(zotero, changes = {}) {
    const current = getMarkdownReaderPanelLayout(zotero);
    const next = normalizeMarkdownReaderPanelLayout({
        outline: { ...current.outline, ...(changes.outline || {}) },
        notes: { ...current.notes, ...(changes.notes || {}) },
        outlineSegment: changes.outlineSegment ?? current.outlineSegment,
    });
    const write = (pref, value) => zotero?.Prefs?.set?.(pref, value, true);
    if (changes.outline && 'visible' in changes.outline) {
        write(MARKDOWN_READER_OUTLINE_VISIBLE_PREF, next.outline.visible);
    }
    if (changes.outline && 'width' in changes.outline) {
        write(MARKDOWN_READER_OUTLINE_WIDTH_PREF, next.outline.width);
    }
    if (changes.notes && 'visible' in changes.notes) {
        write(MARKDOWN_READER_NOTES_VISIBLE_PREF, next.notes.visible);
    }
    if (changes.notes && 'width' in changes.notes) {
        write(MARKDOWN_READER_NOTES_WIDTH_PREF, next.notes.width);
    }
    if ('outlineSegment' in changes) {
        write(MARKDOWN_READER_OUTLINE_SEGMENT_PREF, next.outlineSegment);
    }
    return next;
}

export function normalizeMarkdownReaderPanelLayout(layout = {}) {
    return {
        outline: {
            visible: normalizePanelVisible(layout?.outline?.visible),
            width: normalizePanelWidth(
                layout?.outline?.width,
                MARKDOWN_READER_OUTLINE_WIDTH_DEFAULT,
                MARKDOWN_READER_OUTLINE_WIDTH_MIN,
                MARKDOWN_READER_OUTLINE_WIDTH_MAX
            ),
        },
        notes: {
            visible: normalizePanelVisible(layout?.notes?.visible),
            width: normalizePanelWidth(
                layout?.notes?.width,
                MARKDOWN_READER_NOTES_WIDTH_DEFAULT,
                MARKDOWN_READER_NOTES_WIDTH_MIN,
                MARKDOWN_READER_NOTES_WIDTH_MAX
            ),
        },
        outlineSegment: normalizeMarkdownReaderOutlineSegment(
            layout?.outlineSegment
        ),
    };
}

export function normalizeMarkdownReaderOutlineSegment(value) {
    const normalized = String(value ?? '').trim();
    return MARKDOWN_READER_OUTLINE_SEGMENTS.includes(normalized)
        ? normalized
        : MARKDOWN_READER_OUTLINE_SEGMENT_DEFAULT;
}

function normalizePanelVisible(value) {
    if (value === false || value === 0 || value === 'false') return false;
    return true;
}

function normalizePanelWidth(value, fallback, min, max) {
    const numeric = Number(value);
    if (value === null || value === undefined || value === ''
        || !Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(numeric)));
}

function observeReaderPreference(zotero, pref, onChange) {
    if (typeof zotero?.Prefs?.registerObserver !== 'function'
        || typeof onChange !== 'function') {
        return () => {};
    }
    const observer = zotero.Prefs.registerObserver(pref, onChange, true);
    return () => zotero.Prefs.unregisterObserver?.(observer);
}

function cssForReaderOption(options, value) {
    return options.find(option => option.value === value).css;
}
