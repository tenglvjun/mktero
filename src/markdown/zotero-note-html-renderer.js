import { renderMarkdownHTML } from './markdown-html.js';
import { translateEnglish } from '../i18n/localization.js';

export function renderZoteroNoteHTML(
    markdown,
    {
        resolveImageAttachmentKey = () => null,
        translate = translateEnglish,
    } = {}
) {
    const rendered = renderMarkdownHTML(markdown, {
        target: 'zotero-note',
        resolveImageAttachmentKey,
        translate,
    });
    return normalizeZoteroNoteHTML(rendered);
}

export function normalizeZoteroNoteHTML(html) {
    if (typeof html !== 'string') {
        throw new TypeError('Zotero note HTML must be a string');
    }

    // Zotero's native note schema keeps the content of unknown containers but
    // does not preserve their layout. Convert Mktero-only wrappers into
    // ordinary paragraphs or remove them before the note is synced.
    return html
        .replace(
            /<div\b[^>]*class="[^"]*mktero-figure-panel-label[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
            '<p>$1</p>'
        )
        .replace(/<section\b[^>]*>/gi, '')
        .replace(/<\/section>/gi, '')
        .replace(/<figure\b[^>]*>/gi, '')
        .replace(/<\/figure>/gi, '')
        .replace(/<div\b[^>]*class="[^"]*mktero-figure-panels-[^"]*"[^>]*>/gi, '')
        .replace(/<div\b[^>]*class="[^"]*mktero-figure-panel(?!-label)[^"]*"[^>]*>/gi, '')
        .replace(/<\/div>/gi, '')
        .replace(/<figcaption>/gi, '<p class="mktero-caption">')
        .replace(/<\/figcaption>/gi, '</p>')
        .replace(/<div\b[^>]*class="[^"]*mktero-algorithm[^"]*"[^>]*>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
