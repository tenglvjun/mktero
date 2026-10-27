// Pure helpers between the Markdown reader and Zotero notes. Nothing here
// touches Zotero: the platform adapter supplies items, and the view supplies
// annotations and drafts.

export const NOTE_EDITOR_UNAVAILABLE = 'MKTERO_NOTE_EDITOR_UNAVAILABLE';
export const NOTE_ANNOTATION_NOT_IN_PDF = 'MKTERO_NOTE_ANNOTATION_NOT_IN_PDF';
export const NOTE_SELECTION_NOT_LOCATED = 'MKTERO_NOTE_SELECTION_NOT_LOCATED';
export const NOTE_NO_PARENT_ITEM = 'MKTERO_NOTE_NO_PARENT_ITEM';
export const NOTES_UNAVAILABLE = 'MKTERO_NOTES_UNAVAILABLE';

const DEFAULT_HIGHLIGHT_COLOR = '#ffd400';
const MAX_PREVIEW_SOURCE_LENGTH = 4_000;
const MAX_TITLE_LENGTH = 120;
const MAX_PREVIEW_LENGTH = 200;
const NAMED_ENTITIES = Object.freeze({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: '\'',
    nbsp: ' ',
});

export function noteBridgeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

// The JSON `insertAnnotations()` accepts for a passage that is not saved as
// a Zotero annotation. It is what the Zotero reader passes when a text
// selection goes to a note: a highlight with a PDF position and no id.
export function selectionPartsToNoteAnnotations(parts, attachmentItemID) {
    if (!Array.isArray(parts) || !parts.length) {
        throw noteBridgeError(
            NOTE_SELECTION_NOT_LOCATED,
            'The selection has no PDF position'
        );
    }
    if (!Number.isSafeInteger(attachmentItemID) || attachmentItemID <= 0) {
        throw new Error('A PDF attachment is required');
    }
    return parts.map(part => ({
        type: 'highlight',
        attachmentItemID,
        text: String(part?.text || ''),
        comment: '',
        color: DEFAULT_HIGHLIGHT_COLOR,
        pageLabel: String(part?.pageLabel || ''),
        sortIndex: String(part?.sortIndex || ''),
        position: clonePosition(part?.position),
    }));
}

// A saved Zotero annotation as `insertAnnotations()` and
// `createNoteFromAnnotations()` expect it: the reader JSON plus the
// attachment it belongs to, and its key as the id.
export function annotationJSONForNote(json, { attachmentItemID, key }) {
    if (!json || typeof json !== 'object') {
        throw new Error('Annotation data is unavailable');
    }
    return {
        ...json,
        attachmentItemID,
        id: String(key || json.key || json.id || ''),
    };
}

// Title and first line of a note for the notes column, from the note HTML,
// the way Zotero's own notes list reads them: the first line is the title and
// the second is the preview. The text is only ever assigned with textContent.
export function summarizeNoteHTML(html, { title = '' } = {}) {
    const lines = noteHTMLToLines(html);
    return {
        title: truncate(
            String(title || '').trim() || lines[0] || '',
            MAX_TITLE_LENGTH
        ),
        preview: truncate(lines[1] || '', MAX_PREVIEW_LENGTH),
    };
}

function noteHTMLToLines(html) {
    const source = String(html || '').slice(0, MAX_PREVIEW_SOURCE_LENGTH);
    const text = source
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)\s*>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => (
            decodeEntity(entity) ?? match
        ));
    return text
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

function decodeEntity(entity) {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
        return codePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith('#')) {
        return codePoint(Number.parseInt(lower.slice(1), 10));
    }
    return NAMED_ENTITIES[lower];
}

function codePoint(value) {
    // Lone surrogates are not Unicode scalar values. fromCodePoint accepts
    // them, so a numeric entity such as &#xD800; would otherwise land in the
    // note title as a lone surrogate.
    if (!Number.isSafeInteger(value)
        || value < 0
        || value > 0x10ffff
        || (value >= 0xd800 && value <= 0xdfff)) {
        return null;
    }
    try {
        return String.fromCodePoint(value);
    }
    catch {
        return null;
    }
}

function truncate(value, limit) {
    const text = String(value || '');
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function clonePosition(position) {
    if (!position || typeof position !== 'object') {
        throw noteBridgeError(
            NOTE_SELECTION_NOT_LOCATED,
            'The selection has no PDF position'
        );
    }
    return {
        pageIndex: position.pageIndex,
        rects: Array.isArray(position.rects)
            ? position.rects.map(rect => [...rect])
            : [],
    };
}
