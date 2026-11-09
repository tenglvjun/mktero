import { strToU8, zipSync } from 'fflate';
import { toUint8Array } from '../mineru/binary.js';

export const EPUB_PACKAGE_LIMITS = Object.freeze({
    maxChapters: 1_000,
    maxAssets: 2_000,
    maxXHTMLBytes: 50 * 1024 * 1024,
    maxAssetBytes: 25 * 1024 * 1024,
    maxTotalAssetBytes: 150 * 1024 * 1024,
    maxArchiveBytes: 256 * 1024 * 1024,
    maxMetadataLength: 64 * 1024,
});

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
const DEFAULT_MODIFIED = '2000-01-01T00:00:00Z';
const CHAPTER_ID = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;
const LANGUAGE = /^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*|x(?:-[A-Za-z0-9]{1,8})+)$/u;
const INVALID_XML_CHARACTER = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const IMAGE_EXTENSIONS = new Map([
    ['image/png', /\.png$/iu],
    ['image/jpeg', /\.jpe?g$/iu],
    ['image/gif', /\.gif$/iu],
    ['image/svg+xml', /\.svg$/iu],
]);
const STYLESHEET_LINK = '<link rel="stylesheet" type="text/css" href="../styles/book.css" />';
const BOOK_CSS = `body { margin: 0 5%; line-height: 1.55; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; page-break-after: avoid; }
p { margin: .65em 0; }
a { text-decoration: underline; }
img, svg { max-width: 100%; height: auto; }
figure { margin: 1em 0; text-align: center; }
figcaption, caption { color: #68717b; font-size: .82em; line-height: 1.5; text-align: center; }
figcaption { margin: .6em 0 0; }
.mktero-figure-label, .mktero-table-label { color: #20252b; font-weight: 650; }
.mktero-figure-panel { margin: .5em 0; }
table { max-width: 100%; border-collapse: collapse; font-size: .85em; }
th, td { border: 1px solid; padding: .3em .45em; vertical-align: top; }
caption { caption-side: top; margin: 0 0 .6em; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
code { font-family: monospace; }
blockquote { margin: 1em 1.25em; }
math { font-size: 1em; }
.math-display { margin: 1em 0; text-align: center; page-break-inside: avoid; }
.math-display-equation-number { display: none; }
.chapter-notes { margin-top: 2em; border-top: 1px solid; padding-top: .5em; }
.chapter-notes, .footnote { font-size: .9em; }
.epub-table-image { display: block; margin: 1em auto; }
@media (prefers-color-scheme: dark) {
    figcaption, caption { color: #aab2bc; }
    .mktero-figure-label, .mktero-table-label { color: #edf1f5; }
}
`;

/**
 * Chapters are complete XHTML documents, stored at OEBPS/text/<id>.xhtml.
 * Asset paths are relative to OEBPS, and chapter image URLs use ../<path>.
 * Supply metadata.modified (UTC ISO seconds) for the actual export time.
 */
export function buildEpubPackage({
    title,
    language = 'en',
    chapters,
    assets = [],
    metadata = {},
} = {}) {
    const bookTitle = boundedText(title, 'title', 4_096);
    if (typeof language !== 'string' || language.length > 64 || !LANGUAGE.test(language)) {
        throw new Error('The EPUB language is invalid');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new TypeError('The EPUB metadata is invalid');
    }
    const bookChapters = prepareChapters(chapters);
    const bookAssets = prepareAssets(assets);
    const entries = Object.create(null);
    entries.mimetype = [strToU8('application/epub+zip'), { level: 0 }];
    entries['META-INF/container.xml'] = strToU8(XML_DECLARATION
        + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
        + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />'
        + '</rootfiles></container>');
    for (const chapter of bookChapters) {
        entries[`OEBPS/${chapter.path}`] = chapter.data;
    }
    for (const asset of bookAssets) {
        entries[`OEBPS/${asset.path}`] = asset.data;
    }
    const identifier = metadata.identifier === undefined
        ? `urn:mktero:epub:${packageFingerprint(bookTitle, language, entries)}`
        : boundedText(metadata.identifier, 'identifier', 4_096);
    const modified = modifiedTimestamp(metadata.modified);
    const metadataXML = renderMetadata(bookTitle, language, identifier, modified, metadata);
    entries['OEBPS/styles/book.css'] = strToU8(BOOK_CSS);
    entries['OEBPS/nav.xhtml'] = strToU8(renderNavigation(bookTitle, language, bookChapters));
    entries['OEBPS/toc.ncx'] = strToU8(renderNCX(bookTitle, identifier, bookChapters));
    entries['OEBPS/content.opf'] = strToU8(renderPackage(metadataXML, bookChapters, bookAssets));
    // DOS timestamps have no timezone. Construct local midnight so the encoded
    // date stays identical in every host timezone, without reading the clock.
    const archive = zipSync(entries, { level: 6, mtime: new Date(2000, 0, 1) });
    if (archive.byteLength > EPUB_PACKAGE_LIMITS.maxArchiveBytes) {
        throw new Error('The EPUB archive exceeds the size limit');
    }
    return archive;
}

function prepareChapters(chapters) {
    if (!Array.isArray(chapters) || chapters.length < 1
        || chapters.length > EPUB_PACKAGE_LIMITS.maxChapters) {
        throw new Error('The EPUB chapter count is invalid');
    }
    const ids = new Set();
    let totalBytes = 0;
    return Array.from(chapters, (chapter, index) => {
        if (!chapter || typeof chapter.id !== 'string' || !CHAPTER_ID.test(chapter.id)) {
            throw new Error('The EPUB chapter ID is invalid');
        }
        const identity = chapter.id.toLowerCase();
        if (ids.has(identity)) throw new Error('The EPUB contains duplicate chapter IDs');
        ids.add(identity);
        const title = boundedText(chapter.title, 'chapter title', 4_096);
        if (typeof chapter.xhtml !== 'string'
            || chapter.xhtml.length + totalBytes > EPUB_PACKAGE_LIMITS.maxXHTMLBytes) {
            throw new Error('The EPUB XHTML exceeds the size limit or is invalid');
        }
        assertXHTMLByteBudget(chapter.xhtml, EPUB_PACKAGE_LIMITS.maxXHTMLBytes - totalBytes);
        const xhtml = prepareXHTML(chapter.xhtml);
        const data = strToU8(xhtml);
        totalBytes += data.byteLength;
        if (totalBytes > EPUB_PACKAGE_LIMITS.maxXHTMLBytes) {
            throw new Error('The EPUB XHTML exceeds the size limit');
        }
        const properties = [];
        if (/<(?:[A-Za-z_][\w.-]*:)?math(?:\s|>)/u.test(xhtml)) properties.push('mathml');
        if (/<(?:[A-Za-z_][\w.-]*:)?svg(?:\s|>)/u.test(xhtml)) properties.push('svg');
        return { id: `chapter-${index + 1}`, path: `text/${chapter.id}.xhtml`, title, data, properties };
    });
}

function assertXHTMLByteBudget(value, maximum) {
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff
            && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4;
            index++;
        }
        else bytes += 3;
        if (bytes > maximum) throw new Error('The EPUB XHTML exceeds the size limit');
    }
}

function prepareXHTML(value) {
    const root = /^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!DOCTYPE\s+html\s*>\s*)?<html\s[^>]*>/u.exec(value)?.[0] || '';
    const head = /<head(?:\s[^>]*)?>/u.exec(value);
    const headEnd = value.indexOf('</head>', head?.index ?? 0);
    const body = /<body(?:\s[^>]*)?>/u.exec(value);
    const ending = value.trimEnd();
    if (INVALID_XML_CHARACTER.test(value)
        || /<!DOCTYPE(?!\s+html\s*>)/iu.test(value)
        || /<!ENTITY\b/iu.test(value)
        || !/\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/1999\/xhtml\1/u.test(root)
        || !head || head.index < root.length || headEnd < head.index + head[0].length
        || !body || body.index < headEnd + '</head>'.length
        || !ending.endsWith('</html>') || !ending.slice(0, -'</html>'.length).trimEnd().endsWith('</body>')) {
        throw new Error('The EPUB chapter must be a complete XHTML document');
    }
    let linked = false;
    const xhtml = value.replace(/<link\b(?:"[^"]*"|'[^']*'|[^'">])*>/gu, tag => {
        if (attribute(tag, 'rel') !== 'stylesheet' || attribute(tag, 'href') !== '../styles/book.css') {
            throw new Error('The EPUB chapter stylesheet path is invalid');
        }
        linked = true;
        return STYLESHEET_LINK;
    });
    return linked ? xhtml : xhtml.replace('</head>', `${STYLESHEET_LINK}</head>`);
}

function attribute(tag, name) {
    const pattern = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'u');
    return pattern.exec(tag)?.[2] || '';
}

function prepareAssets(assets) {
    if (!Array.isArray(assets) || assets.length > EPUB_PACKAGE_LIMITS.maxAssets) {
        throw new Error('The EPUB image count is invalid');
    }
    const paths = new Set();
    let totalBytes = 0;
    return Array.from(assets, asset => {
        const path = asset?.path;
        if (typeof path !== 'string' || path.length > 1_024
            || !/^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/u.test(path)
            || path.split('/').some(segment => (
                !segment || segment.length > 255 || segment === '.' || segment === '..' || segment.endsWith('.')
            ))) {
            throw new Error('The EPUB image path is invalid');
        }
        const identity = path.toLowerCase();
        if (paths.has(identity)) throw new Error('The EPUB contains duplicate image paths');
        paths.add(identity);
        const extension = IMAGE_EXTENSIONS.get(asset.mimeType);
        if (!extension?.test(path)) throw new Error('The EPUB image MIME type or extension is unsupported');
        const data = toUint8Array(asset.data, 'The EPUB image');
        if (data.byteLength < 1 || data.byteLength > EPUB_PACKAGE_LIMITS.maxAssetBytes) {
            throw new Error('The EPUB image exceeds the size limit or is empty');
        }
        totalBytes += data.byteLength;
        if (totalBytes > EPUB_PACKAGE_LIMITS.maxTotalAssetBytes) {
            throw new Error('The EPUB images exceed the total size limit');
        }
        return { path, mimeType: asset.mimeType, data };
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function renderMetadata(title, language, identifier, modified, metadata) {
    let output = `<dc:identifier id="book-id">${escapeXML(identifier)}</dc:identifier>`
        + `<dc:title>${escapeXML(title)}</dc:title><dc:language>${escapeXML(language)}</dc:language>`
        + `<meta property="dcterms:modified">${modified}</meta>`;
    for (const name of ['creator', 'publisher', 'description', 'date', 'source', 'rights', 'subject']) {
        const value = metadata[name];
        if (value === undefined) continue;
        const values = Array.isArray(value) ? value : [value];
        if (values.length > 100) throw new Error('The EPUB metadata count exceeds the limit');
        for (const text of values) {
            output += `<dc:${name}>${escapeXML(boundedText(text, name))}</dc:${name}>`;
        }
    }
    if (output.length > EPUB_PACKAGE_LIMITS.maxMetadataLength) {
        throw new Error('The EPUB metadata exceeds the size limit');
    }
    return output;
}

function renderPackage(metadata, chapters, assets) {
    const chapterItems = chapters.map(chapter => {
        const properties = chapter.properties.length ? ` properties="${chapter.properties.join(' ')}"` : '';
        return `<item id="${chapter.id}" href="${chapter.path}" media-type="application/xhtml+xml"${properties} />`;
    }).join('');
    const assetItems = assets.map((asset, index) => (
        `<item id="image-${index + 1}" href="${asset.path}" media-type="${asset.mimeType}" />`
    )).join('');
    return XML_DECLARATION
        + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">'
        + `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${metadata}</metadata><manifest>`
        + '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />'
        + '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />'
        + '<item id="css" href="styles/book.css" media-type="text/css" />'
        + chapterItems + assetItems + '</manifest><spine toc="ncx">'
        + chapters.map(chapter => `<itemref idref="${chapter.id}" />`).join('')
        + '</spine></package>';
}

function renderNavigation(title, language, chapters) {
    return XML_DECLARATION
        + `<html xmlns="${XHTML_NAMESPACE}" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}" xml:lang="${language}">`
        + `<head><title>${escapeXML(title)}</title>`
        + '<link rel="stylesheet" type="text/css" href="styles/book.css" /></head>'
        + `<body><nav epub:type="toc" id="toc"><h1>${escapeXML(title)}</h1><ol>`
        + chapters.map(chapter => `<li><a href="${chapter.path}">${escapeXML(chapter.title)}</a></li>`).join('')
        + '</ol></nav></body></html>';
}

function renderNCX(title, identifier, chapters) {
    return XML_DECLARATION
        + '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head>'
        + `<meta name="dtb:uid" content="${escapeXML(identifier)}" />`
        + '<meta name="dtb:depth" content="1" /><meta name="dtb:totalPageCount" content="0" />'
        + '<meta name="dtb:maxPageNumber" content="0" /></head>'
        + `<docTitle><text>${escapeXML(title)}</text></docTitle><navMap>`
        + chapters.map((chapter, index) => `<navPoint id="point-${index + 1}" playOrder="${index + 1}">`
            + `<navLabel><text>${escapeXML(chapter.title)}</text></navLabel>`
            + `<content src="${chapter.path}" /></navPoint>`).join('')
        + '</navMap></ncx>';
}

function boundedText(value, label, maximum = EPUB_PACKAGE_LIMITS.maxMetadataLength) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum
        || INVALID_XML_CHARACTER.test(value)) {
        throw new Error(`The EPUB ${label} is invalid or exceeds the size limit`);
    }
    return value;
}

function modifiedTimestamp(value = DEFAULT_MODIFIED) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace('Z', '.000Z')) {
        throw new Error('The EPUB modified timestamp is invalid');
    }
    return value;
}

function escapeXML(value) {
    return value.replace(/[&<>"']/gu, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    })[character]);
}

function packageFingerprint(title, language, entries) {
    // A stable fallback identifier, not a security or cache hash. Caller-provided
    // identifiers take precedence, and no clock or platform service is needed.
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    const update = bytes => {
        for (const byte of bytes) {
            first = Math.imul(first ^ byte, 0x01000193);
            second = Math.imul(second ^ byte, 0x85ebca6b);
        }
        first = Math.imul(first ^ 0xff, 0x01000193);
        second = Math.imul(second ^ 0xff, 0x85ebca6b);
    };
    update(strToU8(title));
    update(strToU8(language));
    for (const [path, value] of Object.entries(entries)) {
        update(strToU8(path));
        update(Array.isArray(value) ? value[0] : value);
    }
    return [first, second].map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
}
