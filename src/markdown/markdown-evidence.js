import {
    findUniqueContainingSourceMapEntry,
} from '../core/markdown-source-map.js';
import { findAcademicFigures } from './markdown-figures.js';
import { createVisibleMarkdownTextIndex } from './markdown-visible-text.js';
import { parseGFMTableRow } from './markdown-tables.js';

const SOURCE_UNAVAILABLE = 'MKTERO_EVIDENCE_SOURCE_UNAVAILABLE';
const INVALID_EVIDENCE = 'MKTERO_EVIDENCE_INVALID';
const UNSUPPORTED_EVIDENCE = 'MKTERO_EVIDENCE_UNSUPPORTED';
const EVIDENCE_TOO_LARGE = 'MKTERO_EVIDENCE_TOO_LARGE';
const DEFAULT_MAX_EVIDENCE_CONTENT_LENGTH = 256 * 1024;
const DEFAULT_MAX_EVIDENCE_LOCATIONS = 256;
const UNSAFE_MATH_COMMAND = /\\(?:catcode|csname|def|edef|futurelet|gdef|global|href|htmlClass|htmlData|htmlId|htmlStyle|include|includegraphics|input|let|newcommand|openin|openout|providecommand|read|renewcommand|url|usepackage|write|xdef)\b/;
const MARKDOWN_ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

export function createEvidenceSnippet({
    markdown,
    sourceMap,
    target,
    maxContentLength = DEFAULT_MAX_EVIDENCE_CONTENT_LENGTH,
    maxLocations = DEFAULT_MAX_EVIDENCE_LOCATIONS,
} = {}) {
    const source = String(markdown || '');
    const range = evidenceTargetRange(target, source.length);
    const contentLimit = normalizedLimit(maxContentLength);
    if (range.to - range.from > contentLimit
        || (target.kind === 'selection'
            && target.text.length > contentLimit)) {
        throw evidenceError('Evidence content is too large', EVIDENCE_TOO_LARGE);
    }
    const entry = findUniqueContainingSourceMapEntry(
        sourceMap,
        range,
        source.length
    );
    if (!entry) {
        throw evidenceError(
            'A reliable PDF source is unavailable for this content',
            SOURCE_UNAVAILABLE
        );
    }

    const locations = uniqueLocations(entry.locations);
    if (locations.length > normalizedLimit(maxLocations)) {
        throw evidenceError('Evidence has too many source locations', EVIDENCE_TOO_LARGE);
    }
    if (target.kind === 'selection'
        && normalizedEvidenceText(target.text)
            !== normalizedEvidenceText(
                createVisibleMarkdownTextIndex(
                    source.slice(range.from, range.to)
                ).text
            )) {
        throw evidenceError(
            'Evidence selection does not match its Markdown range',
            INVALID_EVIDENCE
        );
    }
    const content = target.kind === 'selection'
        ? quoteMarkdownText(target.text)
        : blockEvidenceMarkdown(
            source.slice(range.from, range.to),
            entry.type,
            source,
            range
        );
    if (!content) {
        throw evidenceError('Evidence content is empty', INVALID_EVIDENCE);
    }
    if (content.length > contentLimit) {
        throw evidenceError('Evidence content is too large', EVIDENCE_TOO_LARGE);
    }

    return {
        kind: target.kind,
        markdown: content,
        locations,
        pageIndexes: [...new Set(locations.map(location => location.pageIndex))]
            .sort((left, right) => left - right),
    };
}

export function formatEvidenceMarkdown(
    snippet,
    reference,
    translate,
    { maxContentLength = DEFAULT_MAX_EVIDENCE_CONTENT_LENGTH } = {}
) {
    if (typeof snippet?.markdown !== 'string' || !snippet.markdown.trim()) {
        throw evidenceError('Evidence content is unavailable', INVALID_EVIDENCE);
    }
    if (typeof translate !== 'function') {
        throw new TypeError('An evidence translator is required');
    }
    const title = escapeMarkdownLabel(reference?.title);
    const pages = normalizeReferencePages(reference?.pages, snippet.pageIndexes);
    const source = pages.length === 1
        ? translate('evidence.source.single', {
            title,
            page: pages[0].pageNumber,
            href: pages[0].href,
        })
        : translate('evidence.source.multiple', {
            title,
            pages: pages.map(page => translate('evidence.pageLink', {
                page: page.pageNumber,
                href: page.href,
            })).join(translate('evidence.pageSeparator')),
        });
    const markdown = `${snippet.markdown.trim()}\n\n${source}`;
    if (markdown.length > normalizedLimit(maxContentLength)) {
        throw evidenceError('Evidence content is too large', EVIDENCE_TOO_LARGE);
    }
    return markdown;
}

function evidenceTargetRange(target, documentLength) {
    if (target?.kind === 'selection') {
        if (typeof target.text !== 'string' || !target.text.trim()
            || !Array.isArray(target.ranges) || target.ranges.length !== 1) {
            throw evidenceError('Evidence selection is invalid', INVALID_EVIDENCE);
        }
        return validRange(target.ranges[0], documentLength);
    }
    if (target?.kind === 'block') {
        return validRange(target, documentLength);
    }
    throw evidenceError('Evidence target is invalid', INVALID_EVIDENCE);
}

function validRange(range, documentLength) {
    if (!Number.isSafeInteger(range?.from)
        || !Number.isSafeInteger(range?.to)
        || range.from < 0
        || range.to <= range.from
        || range.to > documentLength) {
        throw evidenceError('Evidence range is invalid', INVALID_EVIDENCE);
    }
    return { from: range.from, to: range.to };
}

function uniqueLocations(locations) {
    const seen = new Set();
    const result = [];
    for (const location of locations) {
        const key = `${location.pageIndex}:${location.bbox.join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
            pageIndex: location.pageIndex,
            bbox: [...location.bbox],
        });
    }
    return result;
}

function quoteMarkdownText(value) {
    const text = String(value).trim();
    if (!text) return '';
    return text.split(/\r?\n/).map(line => (
        `> ${escapeMarkdownText(line)}`.trimEnd()
    )).join('\n');
}

function blockEvidenceMarkdown(source, type, document, range) {
    const value = String(source || '').trim();
    if (type === 'equation') {
        const body = /^\$\$([\s\S]*)\$\$$/.exec(value)?.[1];
        if (body === undefined
            || body.includes('$$')
            || UNSAFE_MATH_COMMAND.test(value)) {
            throw evidenceError(
                'Evidence equation cannot be exported safely',
                UNSUPPORTED_EVIDENCE
            );
        }
        return value;
    }
    if (type === 'table') {
        const table = safeGFMTable(value);
        if (table) return table;
        throw evidenceError(
            'Evidence table cannot be exported safely',
            UNSUPPORTED_EVIDENCE
        );
    }
    if (type === 'image' || type === 'chart') {
        const figure = findAcademicFigures(document).find(candidate => (
            candidate.from <= range.from && candidate.to >= range.to
        ));
        if (figure?.caption?.text) return quoteMarkdownText(figure.caption.text);
        throw evidenceError(
            'Evidence image caption is unavailable',
            UNSUPPORTED_EVIDENCE
        );
    }
    return quoteMarkdownText(createVisibleMarkdownTextIndex(source).text);
}

function safeGFMTable(source) {
    const lines = source.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) return null;
    const rows = lines.map(parseGFMTableRow);
    const columnCount = rows[0].length;
    if (!columnCount
        || rows.some(row => row.length !== columnCount)
        || rows[1].some(cell => !/^:?-{3,}:?$/.test(cell))) {
        return null;
    }
    const safeRows = [rows[0], ...rows.slice(2)].map(row => row.map(cell => (
        escapeMarkdownText(createVisibleMarkdownTextIndex(cell).text.trim())
    )));
    safeRows.splice(1, 0, Array(columnCount).fill('---'));
    return safeRows.map(row => `| ${row.join(' | ')} |`).join('\n');
}

function escapeMarkdownText(value) {
    return String(value).replace(MARKDOWN_ASCII_PUNCTUATION, '\\$&');
}

function escapeMarkdownLabel(value) {
    const title = String(value || '').replace(/[\r\n]+/g, ' ').trim();
    if (!title) throw evidenceError('Evidence title is unavailable', INVALID_EVIDENCE);
    return escapeMarkdownText(title);
}

function normalizeReferencePages(pages, expectedPageIndexes) {
    if (!Array.isArray(pages) || !Array.isArray(expectedPageIndexes)
        || pages.length !== expectedPageIndexes.length || !pages.length) {
        throw evidenceError('Evidence page references are invalid', INVALID_EVIDENCE);
    }
    return pages.map((page, index) => {
        if (page?.pageIndex !== expectedPageIndexes[index]
            || page.pageIndex < 0
            || !Number.isSafeInteger(page.pageNumber)
            || page.pageNumber !== page.pageIndex + 1
            || !validZoteroPageHref(page.href, page.pageNumber)) {
            throw evidenceError('Evidence page reference is invalid', INVALID_EVIDENCE);
        }
        return page;
    });
}

function validZoteroPageHref(value, pageNumber) {
    if (typeof value !== 'string') return false;
    const match = value.match(
        /^zotero:\/\/open-pdf\/(?:library|groups\/[1-9]\d*)\/items\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+\?page=([1-9]\d*)$/
    );
    return match?.[1] === String(pageNumber);
}

function normalizedLimit(value) {
    if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER));
}

function normalizedEvidenceText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function evidenceError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}
