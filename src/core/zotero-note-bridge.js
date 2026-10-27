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
    const text = plainTextFromNoteHTML(
        String(html || '').slice(0, MAX_PREVIEW_SOURCE_LENGTH)
    );
    return text
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

// Note HTML to plain text in one left-to-right scan, the way an HTML
// tokenizer reads it: a tag is skipped whole, script and style content is
// dropped, and a `<` that cannot open a tag stays text. Nothing is spliced
// and scanned again, so removing one tag cannot join its neighbours into a
// new one (`<s<script>cript>`). Entities are decoded after the scan, so a
// literal `&lt;` stays a character. The result is only ever assigned with
// textContent.
function plainTextFromNoteHTML(value) {
    return decodeNoteEntities(stripNoteMarkup(String(value || '')));
}

const RAW_TEXT_TAGS = new Set(['script', 'style']);
const LINE_BREAK_END_TAGS = new Set([
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'blockquote', 'pre', 'tr',
]);

function stripNoteMarkup(source) {
    let text = '';
    let index = 0;
    while (index < source.length) {
        const open = source.indexOf('<', index);
        if (open < 0) {
            text += source.slice(index);
            break;
        }
        text += source.slice(index, open);
        if (!opensMarkup(source, open)) {
            text += '<';
            index = open + 1;
            continue;
        }
        if (source.startsWith('<!--', open)) {
            const close = source.indexOf('-->', open + 4);
            index = close < 0 ? source.length : close + 3;
            continue;
        }
        const end = findTagEnd(source, open + 1);
        // An unterminated tag runs to the end of the input, as in a browser.
        if (end < 0) break;
        const tag = readTag(source.slice(open + 1, end));
        index = end + 1;
        if (!tag) continue;
        if (!tag.closing && RAW_TEXT_TAGS.has(tag.name)) {
            index = skipRawText(source, index, tag.name);
            text += ' ';
            continue;
        }
        if ((!tag.closing && tag.name === 'br')
            || (tag.closing && LINE_BREAK_END_TAGS.has(tag.name))) {
            text += '\n';
        }
    }
    return text;
}

// `<` opens markup only before a tag name, `/`, `!` or `?`. Anything else,
// such as `a < b`, is text.
function opensMarkup(source, open) {
    const next = source.charAt(open + 1);
    return /[a-z/!?]/i.test(next);
}

// The first `>` outside a quoted attribute value.
function findTagEnd(source, from) {
    let quote = '';
    for (let index = from; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (char === quote) quote = '';
        }
        else if (char === '"' || char === '\'') {
            quote = char;
        }
        else if (char === '>') {
            return index;
        }
    }
    return -1;
}

function readTag(inner) {
    const match = /^(\/?)([a-z][a-z0-9-]*)/i.exec(inner);
    if (!match) return null;
    return { closing: match[1] === '/', name: match[2].toLowerCase() };
}

// Script and style hold raw text up to their own end tag. Skip it whole.
function skipRawText(source, from, name) {
    const endTag = `</${name}`;
    let index = from;
    while (index < source.length) {
        const close = source.indexOf('</', index);
        if (close < 0) return source.length;
        const candidate = source.slice(close, close + endTag.length);
        const after = source.charAt(close + endTag.length);
        if (candidate.toLowerCase() === endTag
            && (after === '' || /[\s/>]/.test(after))) {
            const end = findTagEnd(source, close + 2);
            return end < 0 ? source.length : end + 1;
        }
        index = close + 2;
    }
    return source.length;
}

function decodeNoteEntities(value) {
    return value.replace(
        /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
        (match, entity) => decodeEntity(entity) ?? match
    );
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
