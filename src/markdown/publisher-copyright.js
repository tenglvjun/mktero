const MAX_CLUSTER_PARAGRAPHS = 8;
const MAX_VENUE_LENGTH = 100;
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const COPYRIGHT_MARK = '(?:©|\\(c\\))';
const ACM_PERMISSION_PATTERN = /^Permission to make digital or hard copies\b/iu;
const IEEE_AUTHORIZED_PATTERN = /^Authorized licensed use limited to:/iu;
const OWNER_COPYRIGHT_PATTERN = new RegExp(
    `^${COPYRIGHT_MARK}\\s*(?:19|20)\\d{2}\\s+Copyright held by the owner/authors?\\(s\\)\\.?$`,
    'iu'
);
const IEEE_COPYRIGHT_PATTERN = new RegExp(
    `^${COPYRIGHT_MARK}\\s*(?:19|20)\\d{2}\\s+IEEE\\b`,
    'iu'
);
const ACM_ISBN_PATTERN = /^ACM ISBN\b/iu;
const BARE_DOI_PATTERN = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\/10\.\S+$/iu;
const RESTRICTIONS_APPLY_PATTERN = /^Restrictions apply\.?$/iu;
const VENUE_PATTERN = new RegExp(
    `^[A-Z0-9][^\\n]{0,40},\\s+(?:${MONTHS})\\s+\\d{1,2}`
    + `(?:\\s*[-–—]\\s*(?:[A-Z][a-z]+\\s+)?\\d{1,2})?,\\s+(?:19|20)\\d{2},\\s+\\S.{0,80}$`,
    'u'
);
const AUTHOR_INITIALS_PATTERN = /\b[A-Z]\.\s*[A-Z]\./u;
const MARKDOWN_LINK_PATTERN = /^\[([^\]]+)\]\([^)\s]+\)$/u;

// ACM and IEEE put a copyright notice in the first-page column beside the
// abstract. A DOI or venue line alone also appears in running headers and
// references, so those lines only extend a cluster that already has an anchor.
export function findPublisherCopyrightRanges(markdown) {
    if (typeof markdown !== 'string' || !markdown) return [];
    const paragraphs = paragraphSpans(markdown);
    const ranges = [];
    let index = 0;
    while (index < paragraphs.length) {
        if (!isCopyrightAnchor(paragraphs[index].key)) {
            index += 1;
            continue;
        }
        let start = index;
        let end = index;
        while (start > 0
            && end - start + 1 < MAX_CLUSTER_PARAGRAPHS
            && isCopyrightSatellite(paragraphs[start - 1].key)
            && isAdjacent(markdown, paragraphs[start - 1], paragraphs[start])) {
            start -= 1;
        }
        while (end + 1 < paragraphs.length
            && end - start + 1 < MAX_CLUSTER_PARAGRAPHS
            && isCopyrightSatellite(paragraphs[end + 1].key)
            && isAdjacent(markdown, paragraphs[end], paragraphs[end + 1])) {
            end += 1;
        }
        ranges.push({
            from: paragraphs[start].from,
            to: paragraphs[end].to,
        });
        index = end + 1;
    }
    return ranges;
}

export function isPublisherCopyrightGap(text) {
    if (typeof text !== 'string' || !text.trim()) return false;
    const ranges = findPublisherCopyrightRanges(text);
    if (ranges.length !== 1) return false;
    return !text.slice(0, ranges[0].from).trim()
        && !text.slice(ranges[0].to).trim();
}

export function isPublisherCopyrightParagraph(text) {
    const key = comparableParagraph(text);
    return Boolean(key) && (isCopyrightAnchor(key) || isCopyrightSatellite(key));
}

function paragraphSpans(markdown) {
    const spans = [];
    let cursor = 0;
    while (cursor < markdown.length) {
        const blank = /^(?:[ \t]*\r?\n)+/u.exec(markdown.slice(cursor));
        if (blank) {
            cursor += blank[0].length;
            continue;
        }
        const separator = /\r?\n[ \t]*\r?\n/u.exec(markdown.slice(cursor));
        const end = separator ? cursor + separator.index : markdown.length;
        const text = markdown.slice(cursor, end);
        const key = comparableParagraph(text);
        if (key) spans.push({ from: cursor, to: end, key });
        if (!separator) break;
        cursor = end + separator[0].length;
    }
    return spans;
}

function isAdjacent(markdown, left, right) {
    return !markdown.slice(left.to, right.from).trim();
}

function comparableParagraph(text) {
    let value = String(text || '').replace(/\s+/gu, ' ').trim();
    const link = MARKDOWN_LINK_PATTERN.exec(value);
    if (link) value = link[1].trim();
    return value;
}

function isCopyrightAnchor(text) {
    return ACM_PERMISSION_PATTERN.test(text)
        || IEEE_AUTHORIZED_PATTERN.test(text)
        || OWNER_COPYRIGHT_PATTERN.test(text)
        || IEEE_COPYRIGHT_PATTERN.test(text)
        || ACM_ISBN_PATTERN.test(text);
}

function isCopyrightSatellite(text) {
    return isCopyrightAnchor(text)
        || BARE_DOI_PATTERN.test(text)
        || RESTRICTIONS_APPLY_PATTERN.test(text)
        || isVenueLine(text);
}

function isVenueLine(text) {
    return text.length <= MAX_VENUE_LENGTH
        && !AUTHOR_INITIALS_PATTERN.test(text)
        && !/https?:|copyright|isbn/iu.test(text)
        && VENUE_PATTERN.test(text);
}
