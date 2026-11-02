import { BLOCK_KIND, BLOCK_ROLE, blockPlainText, childText } from './ir.js';
import { classifyPageNote } from './notes.js';

const ARTICLE_OPENING = /^(?:abstract|summary|introduction)\b/iu;
const COVER_METADATA = /^(?:to (?:cite|link to) this article\s*:|published online\s*:)/iu;
const CITATION_METADATA = /^to (?:cite|link to) this article\s*:/iu;
const CONTROLS = [
    /^submit your article to this journal\s*[↗→.]?$/iu,
    /^article views\s*:\s*[\d,]+\s*$/iu,
    /^view related articles\s*[↗→.]?$/iu,
    /^view crossmark data\s*[↗→.]?$/iu,
    /^(?:citing articles\s*:\s*[\d,]+\s*)?view citing articles\s*[↗→.]?$/iu,
];
const MAX_ICON_SIDE = 70;
const MAX_ICON_GAP = 35;
const LABEL_LEFT_TOLERANCE = 10;

// A publisher cover is confirmed by several independent controls, citation
// metadata, and the same article title followed by an abstract/introduction
// on the next page. Only identified controls and their icons are hidden;
// publication fields keep their original PDF locations in article-info.
export function classifyPublisherCover(ir) {
    const cover = ir.blocks.filter(block => block.pageIndex === 0 && block.role !== BLOCK_ROLE.CHROME);
    const article = ir.blocks.filter(block => block.pageIndex === 1 && block.role !== BLOCK_ROLE.CHROME);
    const controls = cover.filter(block => controlKind(block) >= 0);
    if (new Set(controls.map(controlKind)).size < 2
        || !cover.some(block => CITATION_METADATA.test(blockPlainText(block).trim()))
        || cover.some(isArticleOpening)) return ir;
    const openingAt = article.findIndex(isArticleOpening);
    if (openingAt < 0) return ir;
    const coverTitles = new Map(cover.filter(isTitle).map(block => [textKey(block), block]));
    const title = article.slice(0, openingAt).find(block => isTitle(block) && coverTitles.has(textKey(block)));
    if (!title) return ir;
    const duplicateTitle = coverTitles.get(textKey(title));
    // Unknown long text can be an abstract or research prose. Its presence
    // makes the page ambiguous, even if it also carries publisher controls.
    if (cover.some(block => block !== duplicateTitle && block.kind === BLOCK_KIND.TEXT
        && !COVER_METADATA.test(blockPlainText(block).trim())
        && blockPlainText(block).trim().split(/\s+/u).length >= 40)) return ir;
    if (cover.some(block => block.role === BLOCK_ROLE.HEADING && block !== duplicateTitle)) return ir;

    ir.articleStartPage = title.pageIndex;
    ir.diagnostics.publisherCover = { pageIndex: 0, articleStartPage: title.pageIndex, titleId: title.id };
    hide(duplicateTitle, ir, 'publisher-cover-duplicate-title');
    const titleAt = article.indexOf(title);
    const byline = new Set(article.slice(titleAt + 1, openingAt)
        .filter(block => block.kind === BLOCK_KIND.TEXT).map(bylineKey));
    const metadata = cover.filter(block => block.kind === BLOCK_KIND.TEXT
        && COVER_METADATA.test(blockPlainText(block).trim()));
    for (const block of metadata) markMetadata(block);
    for (const block of cover) {
        if (block.kind === BLOCK_KIND.TEXT && block.role === BLOCK_ROLE.BODY
            && byline.has(bylineKey(block)) && bylineKey(block)) {
            hide(block, ir, 'publisher-cover-duplicate-byline');
        }
    }
    for (const block of controls) hide(block, ir, 'publisher-cover-control');
    const labels = [...controls, ...metadata];
    for (const block of cover) {
        if (isControlIcon(block) && labels.some(label => besideLabel(block, label))) {
            hide(block, ir, 'publisher-cover-icon');
        }
    }
    // Short uppercase labels above the confirmed article title are journal
    // categories, not section headings. Other text is left untouched.
    for (const block of article.slice(0, titleAt)) {
        const text = blockPlainText(block).trim();
        if (block.role === BLOCK_ROLE.BODY && block.kind === BLOCK_KIND.TEXT
            && block.bbox && title.bbox && block.bbox[3] <= title.bbox[1]
            && /^[\p{Lu}\s&-]+$/u.test(text) && text.split(/\s+/u).length <= 6) markMetadata(block);
    }
    for (const block of article) {
        if (block.role === BLOCK_ROLE.PAGE_NOTE) classifyPageNote(block, { articleStartPage: title.pageIndex });
    }
    return ir;
}

function isArticleOpening(block) {
    return !isTitle(block) && ARTICLE_OPENING.test(blockPlainText(block).trim());
}

function isTitle(block) {
    return block.role === BLOCK_ROLE.HEADING && block.mineruLevel === 1
        && blockPlainText(block).trim().split(/\s+/u).length >= 5;
}

function bylineKey(block) {
    return normalizeKey(blockPlainText(block).replace(/(?:\{\s*\})?\^\s*(?:\{[a-z\d,*†‡\s]+\}|[a-z\d*])/giu, ''));
}

function textKey(block) {
    return normalizeKey(blockPlainText(block));
}

function normalizeKey(text) {
    return text.normalize('NFKC').toLowerCase()
        .replace(/&/gu, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function controlKind(block) {
    if (block.kind !== BLOCK_KIND.TEXT || block.role !== BLOCK_ROLE.BODY) return -1;
    const text = blockPlainText(block).trim();
    return CONTROLS.findIndex(pattern => pattern.test(text));
}

function markMetadata(block) {
    block.role = BLOCK_ROLE.FRONT_MATTER;
    block.publisherMetadata = true;
}

function hide(block, ir, rule) {
    block.role = BLOCK_ROLE.CHROME;
    ir.diagnostics.chromeFallbacks.push({ id: block.id, pageIndex: block.pageIndex, rule });
}

function isControlIcon(block) {
    return block.kind === BLOCK_KIND.IMAGE && block.role === BLOCK_ROLE.FLOAT && block.bbox
        && block.bbox[2] - block.bbox[0] <= MAX_ICON_SIDE
        && block.bbox[3] - block.bbox[1] <= MAX_ICON_SIDE
        && !childText(block, 'caption').some(Boolean)
        && !childText(block, 'footnote').some(Boolean);
}

function besideLabel(icon, label) {
    if (!label.bbox || label.pageIndex !== icon.pageIndex) return false;
    const [left, top, right, bottom] = icon.bbox;
    const [labelLeft, labelTop, , labelBottom] = label.bbox;
    const overlap = Math.min(bottom, labelBottom) - Math.max(top, labelTop);
    // OCR can include the icon in the label box, a few units left of the
    // separate image box. The icon must still sit at the label's left edge.
    return left <= labelLeft + LABEL_LEFT_TOLERANCE && labelLeft - right <= MAX_ICON_GAP
        && overlap >= Math.min(bottom - top, labelBottom - labelTop) / 2;
}
