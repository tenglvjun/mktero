import { GFM, parser as markdownParser } from '@lezer/markdown';
import { analyzeMarkdownCitations } from '../markdown/markdown-citations.js';
import { findMarkdownDirectives } from '../markdown/markdown-directives.js';
import { analyzeMarkdownFootnotes } from '../markdown/markdown-footnotes.js';
import { createMarkdownExportPlan } from '../markdown/markdown-export.js';
import { renderMarkdownHTML } from '../markdown/markdown-html.js';
import { buildEpubPackage } from './epub-package.js';

const PARSER = markdownParser.configure(GFM);
const REFERENCE_HEADING = /^(?:references?|bibliography|works\s+cited|literature\s+cited|参考文献|引用文献)$/iu;
const REFERENCE_CITATION = /reference|citation/iu;
const MAX_TABLE_WIDTH = 560;
const MAX_TABLE_COLUMNS = 8;
const IMAGE_EXTENSIONS = Object.freeze({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
});

export async function createEpub({
    title,
    markdown,
    assets = [],
    assetBasePath = '',
    language = 'en',
    renderWideTable,
    renderImageToPNG,
    modified = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
} = {}) {
    if (typeof title !== 'string' || !title.trim()) {
        throw new TypeError('An EPUB title is required');
    }
    if (typeof markdown !== 'string' || !markdown.trim()) {
        throw new TypeError('Markdown content is required for EPUB export');
    }

    const sourceChapters = splitMarkdownChapters(markdown, title);
    const footnoteResult = analyzeMarkdownFootnotes(markdown);
    const footnoteDirectives = findMarkdownDirectives(markdown).notes
        .filter(note => note.kind === 'footnote');
    const citationAnalysis = analyzeMarkdownCitations(markdown);
    const referenceHeading = findReferenceHeading(markdown);
    const referenceChapterIndex = referenceHeading
        ? chapterIndexAt(sourceChapters, referenceHeading.from)
        : -1;
    const edits = [];
    const notesByChapter = sourceChapters.map(() => []);
    const citationLinks = [];
    const noteCounters = sourceChapters.map(() => 0);
    const directiveByQuote = new Map(footnoteDirectives.map(note => [
        note.quote.from,
        note,
    ]));

    for (const note of footnoteResult.notes) {
        const chapterIndex = chapterIndexAt(sourceChapters, note.quote.from);
        if (chapterIndex < 0) continue;
        const number = ++noteCounters[chapterIndex];
        const noteId = `footnote-${number}`;
        const chapterFile = chapterFileName(chapterIndex);
        const directive = directiveByQuote.get(note.quote.from);
        if (directive) {
            edits.push({
                from: directive.from,
                to: note.quote.to,
                replacement: '',
                priority: 3,
            });
        }
        const body = footnoteBody(markdown, note);
        notesByChapter[chapterIndex].push({
            id: noteId,
            label: String(number),
            body,
        });
        if (note.citation) {
            const label = markdown.slice(
                note.citation.wrapperFrom,
                note.citation.wrapperTo
            );
            const href = `${chapterFile}#${noteId}`;
            edits.push({
                from: note.citation.wrapperFrom,
                to: note.citation.wrapperTo,
                replacement: `[${escapeMarkdownLinkLabel(label)}](${href})`,
                priority: 2,
            });
            citationLinks.push({
                from: note.citation.wrapperFrom,
                to: note.citation.wrapperTo,
            });
        }
    }

    if (citationAnalysis.references.length && referenceHeading
        && referenceChapterIndex >= 0) {
        const referenceFile = chapterFileName(referenceChapterIndex);
        const referenceFragment = slugHeading(referenceHeading.label);
        for (const citation of citationAnalysis.citations) {
            if (!citation.referenceIds?.length
                || citationLinks.some(link => rangesOverlap(link, citation))) {
                continue;
            }
            const href = `${referenceFile}#${referenceFragment}`;
            const label = markdown.slice(citation.from, citation.to);
            if (!label.trim()) continue;
            edits.push({
                from: citation.from,
                to: citation.to,
                replacement: `[${escapeMarkdownLinkLabel(label)}](${href})`,
                priority: 1,
            });
            citationLinks.push({ from: citation.from, to: citation.to });
        }
    }

    const rewrittenMarkdown = applyMarkdownEdits(markdown, edits);
    const plan = createMarkdownExportPlan({
        markdown: rewrittenMarkdown,
        assets,
        assetBasePath,
        assetDirectoryName: 'assets',
    });
    const resourceState = await prepareImageResources(plan.assets, renderImageToPNG);
    const assetByMarkdownURL = new Map();
    for (const [index, asset] of resourceState.assets.entries()) {
        const sourcePath = plan.assets[index]?.relativePath;
        if (sourcePath) {
            const key = normalizeAssetPath(`assets/${sourcePath}`);
            assetByMarkdownURL.set(key, `blob:mktero-epub/asset-${index + 1}`);
        }
    }
    const renderOptions = {
        target: 'epub',
        exposeImageAssetPath: true,
        resolveImageURL: href => assetByMarkdownURL.get(normalizeAssetPath(href)) || null,
    };
    const markdownSections = splitMarkdownChapters(plan.markdown, title);
    const linkDefinitions = extractLinkDefinitions(plan.markdown);
    const renderedChapters = [];
    const headingTargets = new Map();
    const chapterNotes = [];

    for (const [index, section] of markdownSections.entries()) {
        const chapterId = chapterID(index);
        let chapterHTML = renderMarkdownHTML(
            withLinkDefinitions(section.markdown, linkDefinitions),
            renderOptions
        );
        chapterHTML = replaceImageURLs(chapterHTML, resourceState.assetByBlobURL);
        const notes = notesByChapter[index] || [];
        const headingResult = addHeadingIDs(
            chapterHTML,
            section.headings,
            notes.map(note => note.id)
        );
        chapterHTML = headingResult.html;
        for (const heading of headingResult.headings) {
            if (!headingTargets.has(heading.slug)) {
                headingTargets.set(heading.slug, {
                    file: chapterFileName(index),
                    id: heading.id,
                });
            }
        }
        chapterNotes[index] = notes;
        renderedChapters.push({
            id: chapterId,
            file: chapterFileName(index),
            title: section.title || `${title} ${index + 1}`,
            html: chapterHTML,
        });
    }

    const chapters = [];
    const packagedImages = [...resourceState.assets];
    let wideTableIndex = 0;
    for (const chapter of renderedChapters) {
        let html = rewriteFragmentLinks(
            chapter.html,
            chapter.file,
            headingTargets
        );
        const notes = chapterNotes[Number(chapter.id.slice('chapter-'.length)) - 1] || [];
        if (notes.length) {
            let notesHTML = '<section class="chapter-notes" epub:type="footnotes">'
                + '<h2>Chapter notes</h2><ol>';
            for (const note of notes) {
                const noteHTML = renderMarkdownHTML(note.body, renderOptions);
                const linkedNoteHTML = rewriteFragmentLinks(
                    replaceImageURLs(noteHTML, resourceState.assetByBlobURL),
                    chapter.file,
                    headingTargets
                );
                notesHTML += `<li id="${note.id}" epub:type="footnote">${linkedNoteHTML}</li>`;
            }
            notesHTML += '</ol></section>';
            html += notesHTML;
        }
        const tableResult = await replaceWideTables(
            html,
            renderWideTable,
            index => `table-${String(++wideTableIndex).padStart(4, '0')}.png`,
            resourceState.assets
        );
        html = tableResult.html;
        packagedImages.push(...tableResult.assets);
        chapters.push({
            id: chapter.id,
            title: chapter.title,
            xhtml: completeXHTML({
                title: chapter.title,
                language,
                body: normalizeVoidTags(html),
            }),
        });
    }

    return buildEpubPackage({
        title,
        language,
        chapters,
        assets: packagedImages,
        metadata: { modified },
    });
}

export function splitMarkdownChapters(markdown, fallbackTitle = 'Document') {
    const source = String(markdown || '');
    const headings = markdownHeadings(source);
    const levelOne = headings.filter(heading => heading.level === 1);
    if (!levelOne.length) {
        return [{
            title: fallbackTitle,
            markdown: source,
            from: 0,
            to: source.length,
            headings,
        }];
    }
    const chapters = [];
    const first = levelOne[0];
    if (source.slice(0, first.from).trim()) {
        chapters.push({
            title: fallbackTitle,
            markdown: source.slice(0, first.from),
            from: 0,
            to: first.from,
            headings: headings.filter(heading => heading.from < first.from),
        });
    }
    for (const [index, heading] of levelOne.entries()) {
        const to = levelOne[index + 1]?.from ?? source.length;
        chapters.push({
            title: heading.label || `${fallbackTitle} ${index + 1}`,
            markdown: source.slice(heading.from, to),
            from: heading.from,
            to,
            headings: headings.filter(item => item.from >= heading.from && item.from < to),
        });
    }
    return chapters;
}

export function estimateTableWidth(tableHTML) {
    const source = String(tableHTML || '');
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu;
    const cellPattern = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)\s*>/giu;
    const widths = [];
    let columns = 0;
    for (const row of source.matchAll(rowPattern)) {
        let column = 0;
        for (const cell of row[1].matchAll(cellPattern)) {
            const content = htmlText(cell[1]);
            let longestWord = 0;
            for (const word of content.split(/\s+/u)) {
                longestWord = Math.max(longestWord, [...word].length);
            }
            const measured = Math.max(32, Math.min(180, longestWord * 7.5 + 18));
            widths[column] = Math.max(widths[column] || 0, measured);
            column++;
        }
        columns = Math.max(columns, column);
    }
    return {
        columns,
        width: widths.reduce((sum, value) => sum + value + 16, 0),
    };
}

function markdownHeadings(markdown) {
    const source = String(markdown || '');
    const tree = PARSER.parse(source);
    const headings = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        const match = /^(?:ATXHeading|SetextHeading)([1-6])$/u.exec(node.name);
        if (!match) continue;
        const text = source.slice(node.from, node.to);
        headings.push({
            level: Number(match[1]),
            from: node.from,
            to: node.to,
            label: headingLabel(text, node.name),
        });
    }
    return headings;
}

function headingLabel(source, nodeName = '') {
    let text = String(source || '').trim();
    if (/^ATXHeading/u.test(nodeName)) {
        text = text.replace(/^#{1,6}[ \t]+/u, '').replace(/[ \t]+#+[ \t]*$/u, '');
    }
    else if (/^SetextHeading/u.test(nodeName)) {
        text = text.replace(/\r?\n[ \t]*[=-]+[ \t]*$/u, '');
    }
    return text.trim();
}

function findReferenceHeading(markdown) {
    return markdownHeadings(markdown).find(heading => (
        REFERENCE_HEADING.test(stripInlineMarkdown(heading.label))
    )) || null;
}

function chapterIndexAt(chapters, offset) {
    return chapters.findIndex(chapter => offset >= chapter.from && offset < chapter.to);
}

function chapterID(index) {
    return `chapter-${String(index + 1).padStart(2, '0')}`;
}

function chapterFileName(index) {
    return `${chapterID(index)}.xhtml`;
}

function footnoteBody(source, note) {
    const localFrom = note.mark.from - note.quote.from;
    const localTo = note.mark.to - note.quote.from;
    const raw = source.slice(note.quote.from, note.quote.to);
    return (raw.slice(0, localFrom) + raw.slice(localTo))
        .replace(/^>\s?/gmu, '')
        .replace(/\r?\n\s+/gu, '\n')
        .replace(/^[\s.,;:–—-]+/u, '')
        .trim();
}

function applyMarkdownEdits(source, edits) {
    const ordered = [...edits].sort((left, right) => (
        left.from - right.from || right.priority - left.priority || right.to - left.to
    ));
    const accepted = [];
    let end = -1;
    for (const edit of ordered) {
        if (edit.from < end) continue;
        accepted.push(edit);
        end = edit.to;
    }
    let output = source;
    for (const edit of accepted.reverse()) {
        output = output.slice(0, edit.from) + edit.replacement + output.slice(edit.to);
    }
    return output;
}

function rangesOverlap(left, right) {
    return left.from < right.to && right.from < left.to;
}

function escapeMarkdownLinkLabel(value) {
    return String(value).replace(/([\[\]])/gu, '\\$1');
}

function extractLinkDefinitions(markdown) {
    return String(markdown).match(/^ {0,3}\[[^\]\n]+\]:[ \t]*\S[^\n]*$/gmu) || [];
}

function withLinkDefinitions(markdown, definitions) {
    return definitions.length
        ? `${markdown}\n\n${definitions.join('\n')}`
        : markdown;
}

function prepareImageResources(assets, renderImageToPNG) {
    return Promise.all(assets.map(async (asset, index) => {
        let data = asset.data;
        let mimeType = asset.mimeType;
        if (!Object.hasOwn(IMAGE_EXTENSIONS, mimeType)) {
            if (typeof renderImageToPNG !== 'function') {
                throw new Error(`EPUB export cannot embed ${mimeType || 'this image type'}`);
            }
            const converted = await renderImageToPNG({
                data,
                mimeType,
                sourcePath: asset.relativePath,
            });
            data = converted?.data;
            mimeType = converted?.mimeType || 'image/png';
            if (mimeType !== 'image/png') {
                throw new Error('Converted EPUB images must be PNG');
            }
        }
        const path = `images/image-${String(index + 1).padStart(4, '0')}.${IMAGE_EXTENSIONS[mimeType]}`;
        const packaged = { path, mimeType, data };
        return {
            ...packaged,
            sourcePath: asset.relativePath,
            blobURL: `blob:mktero-epub/asset-${index + 1}`,
        };
    })).then(resources => ({
        assets: resources.map(({ path, mimeType, data }) => ({ path, mimeType, data })),
        assetByBlobURL: new Map(resources.map(asset => [
            asset.blobURL.slice('blob:mktero-epub/'.length),
            asset.path,
        ])),
    }));
}

function normalizeAssetPath(value) {
    let path = String(value || '').trim();
    try { path = decodeURIComponent(path); }
    catch { return ''; }
    return path.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+/gu, '/');
}

function replaceImageURLs(html, assetByBlobURL) {
    return String(html || '')
        .replace(/src="blob:mktero-epub\/(asset-\d+)"/gu, (whole, key) => {
            const path = assetByBlobURL.get(key);
            return path ? `src="../${path}"` : 'src=""';
        })
        .replace(/\sdata-mktero-asset="[^"]*"/gu, '');
}

function addHeadingIDs(html, headings, reservedIDs = []) {
    let index = 0;
    const headingSlugs = headings.map((heading, headingIndex) => (
        slugHeading(heading?.label || `section-${headingIndex + 1}`)
    ));
    const usedIDs = new Set(reservedIDs);
    const primaryIDBySlug = new Map();
    for (const slug of headingSlugs) {
        if (primaryIDBySlug.has(slug)) continue;
        primaryIDBySlug.set(slug, allocateHeadingID(slug, usedIDs));
    }
    const occurrences = new Map();
    const outputHeadings = [];
    const output = String(html).replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/giu, (whole, level, attributes, content) => {
        const heading = headings[index];
        const slug = headingSlugs[index]
            || slugHeading(heading?.label || stripInlineMarkdown(content) || `section-${index + 1}`);
        index++;
        const occurrence = (occurrences.get(slug) || 0) + 1;
        occurrences.set(slug, occurrence);
        const id = occurrence === 1
            ? primaryIDBySlug.get(slug) || allocateHeadingID(slug, usedIDs)
            : allocateHeadingID(slug, usedIDs);
        outputHeadings.push({ slug, id, level: Number(level) });
        return `<h${level} id="${id}"${attributes}>${content}</h${level}>`;
    });
    return { html: output, headings: outputHeadings };
}

function allocateHeadingID(candidate, usedIDs) {
    let id = candidate;
    let suffix = 2;
    while (usedIDs.has(id)) id = `${candidate}-${suffix++}`;
    usedIDs.add(id);
    return id;
}

function slugHeading(value) {
    return stripInlineMarkdown(String(value || ''))
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .trim()
        .replace(/[\s_]+/gu, '-')
        .replace(/-+/gu, '-')
        .slice(0, 100) || 'section';
}

function stripInlineMarkdown(value) {
    return String(value || '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
        .replace(/`([^`]+)`/gu, '$1')
        .replace(/\$\$?([\s\S]*?)\$\$?/gu, '$1')
        .replace(/[\\*_~]/gu, '')
        .replace(/<[^>]*>/gu, '')
        .trim();
}

function rewriteFragmentLinks(html, chapterFile, targets) {
    return String(html || '').replace(/href="#([^"]+)"/gu, (whole, fragment) => {
        const decoded = decodeURIComponentSafe(fragment);
        const target = targets.get(slugHeading(decoded));
        const href = target
            ? `${target.file}#${target.id}`
            : `${chapterFile}#${decoded}`;
        return `href="${escapeAttribute(href)}"`;
    });
}

function decodeURIComponentSafe(value) {
    try { return decodeURIComponent(value); }
    catch { return value; }
}

async function replaceWideTables(html, renderWideTable, fileNameForIndex, imageAssets) {
    const tables = [...String(html).matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/giu)];
    if (!tables.length) return { html, assets: [] };
    let output = '';
    let offset = 0;
    const assets = [];
    for (const [index, match] of tables.entries()) {
        const table = match[0];
        const estimate = estimateTableWidth(table);
        if (estimate.width <= MAX_TABLE_WIDTH && estimate.columns <= MAX_TABLE_COLUMNS) continue;
        if (typeof renderWideTable !== 'function') {
            throw new Error('A Zotero PNG renderer is required for wide EPUB tables');
        }
        output += String(html).slice(offset, match.index);
        const caption = tableCaption(table);
        const alt = caption || `Wide table with ${estimate.columns} columns`;
        const rendered = await renderWideTable({
            html: table,
            assets: imageAssets,
            index,
            estimatedWidth: estimate.width,
            columns: estimate.columns,
            alt,
        });
        const data = rendered?.data instanceof Uint8Array
            ? rendered.data
            : rendered?.data instanceof ArrayBuffer
                ? new Uint8Array(rendered.data)
                : null;
        if (!data?.byteLength || rendered?.mimeType !== 'image/png'
            || !isPNG(data)) {
            throw new Error('The wide EPUB table renderer did not return a PNG');
        }
        const path = fileNameForIndex(index);
        assets.push({ path: `images/${path}`, mimeType: 'image/png', data });
        output += `<figure class="epub-table-image"><img src="../images/${path}" alt="${escapeAttribute(alt)}" />`
            + (caption ? `<figcaption>${escapeHTML(caption)}</figcaption>` : '')
            + '</figure>';
        offset = match.index + table.length;
    }
    output += String(html).slice(offset);
    return { html: output, assets };
}

function tableCaption(table) {
    const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/iu.exec(table)?.[1];
    return caption ? htmlText(caption) : '';
}

function htmlText(value) {
    return decodeBasicEntities(String(value || '').replace(/<[^>]*>/gu, ' '))
        .replace(/\s+/gu, ' ')
        .trim();
}

function decodeBasicEntities(value) {
    return String(value)
        .replace(/&lt;/giu, '<')
        .replace(/&gt;/giu, '>')
        .replace(/&quot;/giu, '"')
        .replace(/&apos;/giu, "'")
        .replace(/&#39;/giu, "'")
        .replace(/&amp;/giu, '&')
        .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([\da-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function isPNG(data) {
    return data.length >= 8
        && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e
        && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a
        && data[6] === 0x1a && data[7] === 0x0a;
}

function completeXHTML({ title, language, body }) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<!DOCTYPE html>\n'
        + `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeAttribute(language)}" xml:lang="${escapeAttribute(language)}">`
        + `<head><title>${escapeHTML(title)}</title><meta charset="UTF-8" /></head>`
        + `<body>${body}</body></html>`;
}

function normalizeVoidTags(html) {
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    return String(html || '').replace(/<([a-z][a-z0-9-]*)(\s[^<>]*?)?\s*\/?\s*>/giu, (whole, name, attributes = '') => {
        if (!voidTags.has(name.toLowerCase())) return whole;
        return `<${name}${attributes.trimEnd()} />`;
    });
}

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&apos;');
}

function escapeAttribute(value) {
    return escapeHTML(value).replace(/[\u0000-\u001F\u007F]/gu, '');
}
