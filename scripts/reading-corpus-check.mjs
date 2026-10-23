import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { strFromU8, unzipSync } from 'fflate';
import { GFM, parser as markdownParser } from '@lezer/markdown';
import { extractMinerUResultFromZip } from '../src/mineru/zip-markdown.js';
import { createVisibleMarkdownTextIndex } from '../src/markdown/markdown-visible-text.js';
import { visibleDocumentChromeRanges } from '../src/markdown/chrome-ranges.js';
import { extractAlignedMarkdownOutline } from '../src/markdown/markdown-outline.js';
import { analyzeMarkdownCitations } from '../src/markdown/markdown-citations.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';

export const READING_CORPUS_ENV = 'MKTERO_READING_CORPUS';
export const READING_CORPUS_FALLBACK_ENV = 'MKTERO_FIGURE_CORPUS';
export const READING_CORPUS_EXPECTATION_DIR = fileURLToPath(
    new URL('../test/fixtures/reading-corpus/', import.meta.url)
);
// `ir-pdf` also reads the PDF that MinerU puts in its archive
// (`*_origin.pdf`) with PDF.js, as the extension does, so the document gets
// the PDF's lines and fonts.
export const READING_PIPELINES = ['ir', 'ir-pdf'];

const PARSER = markdownParser.configure(GFM);
const CHROME_TYPES = new Set(['header', 'footer', 'page_number', 'aside_text']);
const SHINGLE = 8;
const SHINGLE_STEP = 4;
const MIN_CHROME_KEY = 8;
const OPEN_END = /[\p{L}\p{N},;\-–]$/u;
const LOWER_START = /^\p{Ll}/u;
const IMAGE_TOKEN = /!\[[^\n]*?\]\([^\s)]+\)/g;
const IMAGE_ONLY = /^(?:!\[[^\n]*?\]\([^\s)]+\)\s*)+$/;
const BLOCK_KIND_BY_NODE = new Map([
    ['ATXHeading1', 'heading'], ['ATXHeading2', 'heading'], ['ATXHeading3', 'heading'],
    ['ATXHeading4', 'heading'], ['ATXHeading5', 'heading'], ['ATXHeading6', 'heading'],
    ['SetextHeading1', 'heading'], ['SetextHeading2', 'heading'],
    ['BulletList', 'list'], ['OrderedList', 'list'],
    ['Blockquote', 'quote'],
    ['FencedCode', 'code'], ['CodeBlock', 'code'],
    ['Table', 'table'],
    ['HorizontalRule', 'rule'],
    ['CommentBlock', 'comment'],
    ['LinkReference', 'comment'],
]);

// Pure metric helpers. They are exported so the unit tests can pin their
// definitions on synthetic data without a local corpus.

export function normalizeMetricText(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function textShingles(value, { size = SHINGLE, step = SHINGLE_STEP } = {}) {
    const text = normalizeMetricText(value);
    const shingles = [];
    if (text.length < size) return shingles;
    for (let index = 0; index + size <= text.length; index += step) {
        shingles.push(text.slice(index, index + size));
    }
    if ((text.length - size) % step) shingles.push(text.slice(-size));
    return shingles;
}

export function readLayoutFromArchive(archive) {
    const files = unzipSync(archive, {
        filter(file) {
            return /(?:^|\/)(?:.+_)?(?:middle|layout)\.json$/i.test(file.name);
        },
    });
    const names = Object.keys(files);
    if (names.length !== 1) return null;
    try {
        const parsed = JSON.parse(strFromU8(files[names[0]]));
        return Array.isArray(parsed?.pdf_info) ? parsed : null;
    }
    catch {
        return null;
    }
}

export function collectLayoutSignals(layout) {
    const signals = {
        pages: 0,
        chrome: [],
        pageNotes: [],
        bodySpans: [],
        references: 0,
        floats: { image: 0, chart: 0, table: 0, code: 0, captioned: 0 },
    };
    if (!Array.isArray(layout?.pdf_info)) return signals;
    signals.pages = layout.pdf_info.length;
    for (const [pageIndex, page] of layout.pdf_info.entries()) {
        for (const block of page?.discarded_blocks || []) {
            const text = blockText(block);
            if (!text) continue;
            if (CHROME_TYPES.has(block.type)) {
                const bbox = normalizedBox(block.bbox, page?.page_size);
                signals.chrome.push({ type: block.type, text, ...(bbox ? { pageIndex, bbox } : {}) });
            }
            else if (block.type === 'page_footnote') signals.pageNotes.push(text);
        }
        for (const block of page?.para_blocks || []) collectBodyBlock(block, signals);
    }
    return signals;
}

function collectBodyBlock(block, signals) {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'ref_text') signals.references++;
    if (Object.hasOwn(signals.floats, block.type)) {
        signals.floats[block.type]++;
        if ((block.blocks || []).some(child => /_caption$/.test(child?.type || ''))) {
            signals.floats.captioned++;
        }
    }
    if (Array.isArray(block.blocks)) {
        for (const child of block.blocks) {
            if (/_(?:caption|footnote)$/.test(child?.type || '')) collectSpans(child, signals.bodySpans);
        }
        return;
    }
    if (block.type === 'interline_equation') return;
    collectSpans(block, signals.bodySpans);
}

function normalizedBox(bbox, pageSize) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !Array.isArray(pageSize)) return null;
    const [width, height] = pageSize;
    if (!(width > 0 && height > 0)) return null;
    return [bbox[0] / width * 1000, bbox[1] / height * 1000, bbox[2] / width * 1000, bbox[3] / height * 1000];
}

function collectSpans(block, output) {
    for (const line of block?.lines || []) {
        for (const span of line?.spans || []) {
            if (span?.type === 'text' && typeof span.content === 'string' && span.content.trim()) {
                output.push(span.content);
            }
        }
    }
}

function blockText(block) {
    const parts = [];
    for (const line of block?.lines || []) {
        for (const span of line?.spans || []) {
            if (typeof span?.content === 'string') parts.push(span.content);
        }
    }
    for (const child of block?.blocks || []) {
        const text = blockText(child);
        if (text) parts.push(text);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function summarizeMarkdownBlocks(markdown, visibleIndex = null) {
    const source = String(markdown || '');
    const index = visibleIndex || createVisibleMarkdownTextIndex(source);
    const blocks = [];
    const tree = PARSER.parse(source);
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        const raw = source.slice(node.from, node.to);
        const kind = classifyTopLevelNode(node.name, raw);
        if (kind === 'comment') continue;
        blocks.push({
            kind,
            from: node.from,
            to: node.to,
            ...(kind === 'image' ? { images: raw.match(IMAGE_TOKEN).length } : {}),
            text: index.textForSourceRange(node.from, node.to).replace(/\s+/g, ' ').trim(),
        });
    }
    return blocks;
}

function classifyTopLevelNode(name, raw) {
    if (BLOCK_KIND_BY_NODE.has(name)) return BLOCK_KIND_BY_NODE.get(name);
    if (name === 'HTMLBlock') {
        if (/^\s*<!--/.test(raw)) return 'comment';
        if (/^\s*<table\b/i.test(raw)) return 'table';
        return /mineru-algorithm/.test(raw) ? 'algorithm' : 'html';
    }
    if (name === 'Paragraph') {
        const trimmed = raw.trim();
        if (/^\$\$[\s\S]*\$\$$/.test(trimmed)) return 'math';
        if (IMAGE_ONLY.test(trimmed)) return 'image';
        return 'text';
    }
    return 'other';
}

// A break is two text paragraphs that read as one sentence: the first ends
// open and the second starts in lower case, with only floats or display
// math between them. The source map then tells whether the PDF separated
// them by a page, a column, or nothing.
export function countParagraphBreaks(blocks, sourceMap = []) {
    const result = { total: 0, page: 0, column: 0, float: 0, math: 0, adjacent: 0, unmapped: 0 };
    let previous = null;
    let between = new Set();
    for (const block of blocks) {
        if (block.kind === 'text') {
            if (previous && OPEN_END.test(previous.text) && LOWER_START.test(block.text)) {
                result.total++;
                result[breakKind(previous, block, between, sourceMap)]++;
            }
            previous = block;
            between = new Set();
            continue;
        }
        if (block.kind === 'image' || block.kind === 'table' || block.kind === 'algorithm'
            || block.kind === 'math' || block.kind === 'code') {
            between.add(block.kind === 'math' ? 'math' : 'float');
            continue;
        }
        previous = null;
        between = new Set();
    }
    return result;
}

function breakKind(previous, next, between, sourceMap) {
    const before = lastLocation(previous, sourceMap);
    const after = firstLocation(next, sourceMap);
    if (before && after) {
        if (before.pageIndex !== after.pageIndex) return 'page';
        if (after.bbox[0] >= before.bbox[2] - 20 || after.bbox[3] < before.bbox[1]) return 'column';
    }
    if (between.has('float')) return 'float';
    if (between.has('math')) return 'math';
    return before && after ? 'adjacent' : 'unmapped';
}

function blockLocations(block, sourceMap) {
    return overlappingEntries(block, sourceMap).flatMap(entry => (
        entry.locationRanges?.filter(range => range.markdownFrom < block.to && range.markdownTo > block.from)
            .map(range => range.location) || entry.locations
    ));
}

function overlappingEntries(block, sourceMap) {
    return (Array.isArray(sourceMap) ? sourceMap : []).filter(entry => (
        entry && entry.markdownFrom < block.to && entry.markdownTo > block.from
        && Array.isArray(entry.locations) && entry.locations.length
    ));
}

function lastLocation(block, sourceMap) {
    const entries = overlappingEntries(block, sourceMap);
    const entry = entries.at(-1);
    if (!entry) return null;
    const ranges = entry.locationRanges?.filter(range => range.markdownFrom < block.to);
    return ranges?.length ? ranges.at(-1).location : entry.locations.at(-1);
}

function firstLocation(block, sourceMap) {
    const entry = overlappingEntries(block, sourceMap)[0];
    if (!entry) return null;
    const ranges = entry.locationRanges?.filter(range => range.markdownTo > block.from);
    return ranges?.length ? ranges[0].location : entry.locations[0];
}

// A leak is a discarded page decoration whose text survived as a visible
// block of its own (or as the start or end of one). When the source map
// places the block, it must also overlap a decoration with that text on the
// same page and height: a paper title that repeats as the running header,
// or a first-page DOI, is not a leak.
export function countChromeLeaks(blocks, chrome, sourceMap = []) {
    const keys = new Map();
    const places = new Map();
    for (const item of chrome) {
        const key = normalizeMetricText(item.text);
        if (key.length < MIN_CHROME_KEY) continue;
        keys.set(key, (keys.get(key) || 0) + 1);
        if (item.bbox) {
            if (!places.has(key)) places.set(key, []);
            places.get(key).push(item);
        }
    }
    const seen = new Map();
    for (const block of blocks) {
        const text = normalizeMetricText(block.text);
        if (!text) continue;
        const locations = blockLocations(block, sourceMap);
        for (const key of keys.keys()) {
            if (text === key || (text.length < key.length * 3
                && (text.startsWith(key) || text.endsWith(key)))) {
                if (locations.length && places.has(key) && !locations.some(location => (
                    places.get(key).some(place => place.pageIndex === location.pageIndex
                        && place.bbox[1] < location.bbox[3] + 10 && location.bbox[1] < place.bbox[3] + 10)
                ))) {
                    continue;
                }
                seen.set(key, (seen.get(key) || 0) + 1);
            }
        }
    }
    let leaks = 0;
    for (const [key, count] of seen) leaks += Math.min(count, keys.get(key));
    return { candidates: [...keys.values()].reduce((sum, count) => sum + count, 0), leaks };
}

export function measureTextCoverage(visibleText, spans) {
    const visible = new Set(textShingles(visibleText, { step: 1 }));
    let total = 0;
    let found = 0;
    for (const span of spans) {
        for (const shingle of textShingles(span)) {
            total++;
            if (visible.has(shingle)) found++;
        }
    }
    return { total, found, ratio: total ? round4(found / total) : 1 };
}

export function countVisibleNotes(visibleText, notes) {
    const visible = new Set(textShingles(visibleText, { step: 1 }));
    let found = 0;
    for (const note of notes) {
        const shingles = textShingles(note);
        if (!shingles.length) continue;
        const hits = shingles.filter(shingle => visible.has(shingle)).length;
        if (hits / shingles.length >= 0.8) found++;
    }
    return { total: notes.length, found };
}

export function measureSourceMapCoverage(blocks, sourceMap, markdownLength) {
    const entries = (Array.isArray(sourceMap) ? sourceMap : [])
        .filter(entry => isValidSourceMapEntry(entry, markdownLength));
    let covered = 0;
    let total = 0;
    for (const block of blocks) {
        if (!block.text && block.kind !== 'image') continue;
        total++;
        if (entries.some(entry => entry.markdownFrom < block.to && entry.markdownTo > block.from)) covered++;
    }
    const crossPage = entries.filter(entry => (
        new Set((entry.locationRanges?.map(range => range.location) || entry.locations)
            .map(location => location.pageIndex)).size > 1
    )).length;
    return { total, covered, ratio: total ? round4(covered / total) : 1, crossPage };
}

export function headingHistogram(outline) {
    const levels = {};
    for (const heading of outline) levels[heading.level] = (levels[heading.level] || 0) + 1;
    return {
        count: outline.length,
        levels,
        sequence: outline.map(heading => (
            `${heading.level}:${sha256Hex(normalizeMetricText(heading.text)).slice(0, 12)}`
        )),
    };
}

export function countMarkdownFloats(blocks) {
    const result = { image: 0, captionedImage: 0, table: 0, algorithm: 0, code: 0, math: 0 };
    for (const block of blocks) {
        if (block.kind === 'image') {
            result.image += block.images || 1;
            if (block.text) result.captionedImage++;
        }
        else if (Object.hasOwn(result, block.kind)) result[block.kind]++;
    }
    return result;
}

export function summarizeReadingDocument(prepared, layout) {
    const markdown = String(prepared?.markdown || '');
    const chromeRanges = visibleDocumentChromeRanges(markdown, prepared?.chromeRanges || [], '');
    const index = createVisibleMarkdownTextIndex(markdown, chromeRanges);
    const blocks = summarizeMarkdownBlocks(markdown, index).filter(block => (
        !chromeRanges.some(range => range.from <= block.from && block.to <= range.to)
    ));
    const signals = collectLayoutSignals(layout);
    const outline = extractAlignedMarkdownOutline(markdown, chromeRanges, [], '', {
        headingLevels: prepared?.documentStructure === 'mineru-ir-v1' ? 'structural' : 'inferred',
    });
    const citations = analyzeMarkdownCitations(markdown);
    return {
        pages: signals.pages,
        breaks: countParagraphBreaks(blocks, prepared?.sourceMap),
        chrome: countChromeLeaks(blocks, signals.chrome, prepared?.sourceMap),
        textCoverage: measureTextCoverage(index.text, signals.bodySpans),
        pageNotes: countVisibleNotes(index.text, signals.pageNotes),
        headings: headingHistogram(outline),
        sourceMap: measureSourceMapCoverage(blocks, prepared?.sourceMap, markdown.length),
        floats: { markdown: countMarkdownFloats(blocks), layout: signals.floats },
        references: { markdown: citations.references.length, layout: signals.references },
    };
}

// Corpus runner.

export async function loadPipeline(name) {
    if (name === 'ir') {
        const { prepareMinerUDocument } = await import('../src/mineru/document/prepare.js');
        return raw => prepareMinerUDocument(raw);
    }
    if (name === 'ir-pdf') {
        const { prepareMinerUDocument } = await import('../src/mineru/document/prepare.js');
        const { createPDFJSTextEngine } = await import('../src/pdf/pdfjs-text-engine.js');
        return async (raw, archive) => {
            const pdf = readOriginPDFFromArchive(archive);
            let pdfText = null;
            if (pdf) {
                const engine = createPDFJSTextEngine({
                    standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)),
                });
                try { pdfText = await engine.extract(pdf); }
                finally { await engine.dispose(); }
            }
            return prepareMinerUDocument(raw, { pdfText });
        };
    }
    throw new TypeError(`Unknown reading pipeline ${name}`);
}

export function readOriginPDFFromArchive(archive) {
    if (!archive) return null;
    const files = unzipSync(archive, { filter: file => /(?:^|\/)[^/]*_origin\.pdf$/iu.test(file.name) });
    const names = Object.keys(files);
    return names.length === 1 ? files[names[0]] : null;
}

export async function checkReadingCorpus({
    corpusDir,
    pipeline = 'ir',
    update = false,
    ids = null,
    log = console.log,
} = {}) {
    if (!corpusDir || typeof corpusDir !== 'string') {
        throw new TypeError(`Set ${READING_CORPUS_ENV} to a directory of MinerU result archives`);
    }
    const prepare = await loadPipeline(pipeline);
    const report = { pipeline, checked: [], skipped: [], failures: [], updated: [], documents: [] };
    for (const id of await discoverCorpusIds(corpusDir)) {
        if (ids?.length && !ids.includes(id)) continue;
        const archive = new Uint8Array(await readFile(path.join(corpusDir, `${id}.zip`)));
        const archiveSha256 = sha256Hex(archive);
        const raw = extractMinerUResultFromZip(archive);
        const layout = readLayoutFromArchive(archive);
        const started = performance.now();
        const prepared = await prepare(raw, archive);
        const timeMs = Math.round(performance.now() - started);
        const summary = summarizeReadingDocument(prepared, layout);
        report.documents.push({ id, timeMs, ...summary });
        const expectation = await loadExpectation(id);
        if (update) {
            await writeExpectation(id, {
                schema: 1,
                id,
                archiveSha256,
                pipelines: { ...(expectation?.pipelines || {}), [pipeline]: summary },
            });
            report.updated.push(id);
            continue;
        }
        const expected = expectation?.pipelines?.[pipeline];
        if (!expected) {
            report.skipped.push(id);
            continue;
        }
        if (expectation.archiveSha256 !== archiveSha256) {
            report.failures.push({ id, message: `${id}: archive sha256 changed; rerun with --update` });
            continue;
        }
        const differences = diffSummaries(expected, summary);
        report.checked.push(id);
        if (differences.length) {
            report.failures.push({ id, message: `${id}: ${differences.join('; ')}` });
        }
    }
    log(formatReport(report));
    return report;
}

export function diffSummaries(expected, actual, prefix = '') {
    const differences = [];
    const keys = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]);
    for (const key of keys) {
        const left = expected?.[key];
        const right = actual?.[key];
        const label = prefix ? `${prefix}.${key}` : key;
        if (left && right && typeof left === 'object' && typeof right === 'object'
            && !Array.isArray(left) && !Array.isArray(right)) {
            differences.push(...diffSummaries(left, right, label));
        }
        else if (JSON.stringify(left) !== JSON.stringify(right)) {
            differences.push(Array.isArray(left) || Array.isArray(right)
                ? `${label} changed`
                : `${label} expected ${JSON.stringify(left)}, actual ${JSON.stringify(right)}`);
        }
    }
    return differences;
}

export function formatReport(report) {
    const header = ['id', 'pages', 'breaks(p/c/f/m/a)', 'leak', 'cover', 'notes', 'map', 'xpage', 'h', 'fig', 'refs', 'ms'];
    const rows = report.documents.map(doc => [
        doc.id,
        doc.pages,
        `${doc.breaks.total}(${doc.breaks.page}/${doc.breaks.column}/${doc.breaks.float}`
            + `/${doc.breaks.math}/${doc.breaks.adjacent})`,
        `${doc.chrome.leaks}/${doc.chrome.candidates}`,
        doc.textCoverage.ratio.toFixed(4),
        `${doc.pageNotes.found}/${doc.pageNotes.total}`,
        doc.sourceMap.ratio.toFixed(3),
        doc.sourceMap.crossPage,
        Object.entries(doc.headings.levels).map(([level, count]) => `${level}:${count}`).join(' '),
        `${doc.floats.markdown.image}/${doc.floats.layout.image + doc.floats.layout.chart}`,
        `${doc.references.markdown}/${doc.references.layout}`,
        doc.timeMs,
    ]);
    const totals = report.documents.reduce((sum, doc) => {
        for (const key of Object.keys(sum.breaks)) sum.breaks[key] += doc.breaks[key];
        sum.leaks += doc.chrome.leaks;
        sum.candidates += doc.chrome.candidates;
        sum.coverFound += doc.textCoverage.found;
        sum.coverTotal += doc.textCoverage.total;
        sum.notesFound += doc.pageNotes.found;
        sum.notes += doc.pageNotes.total;
        sum.mapCovered += doc.sourceMap.covered;
        sum.mapTotal += doc.sourceMap.total;
        sum.crossPage += doc.sourceMap.crossPage;
        sum.times.push(doc.timeMs);
        return sum;
    }, {
        breaks: { total: 0, page: 0, column: 0, float: 0, math: 0, adjacent: 0, unmapped: 0 },
        leaks: 0, candidates: 0, coverFound: 0, coverTotal: 0, notesFound: 0, notes: 0,
        mapCovered: 0, mapTotal: 0, crossPage: 0, times: [],
    });
    const times = totals.times.sort((left, right) => left - right);
    const lines = [header, ...rows].map(row => row.join('\t'));
    lines.push([
        'TOTAL',
        report.documents.reduce((sum, doc) => sum + doc.pages, 0),
        `${totals.breaks.total}(${totals.breaks.page}/${totals.breaks.column}/${totals.breaks.float}`
            + `/${totals.breaks.math}/${totals.breaks.adjacent}) unmapped ${totals.breaks.unmapped}`,
        `${totals.leaks}/${totals.candidates}`,
        totals.coverTotal ? (totals.coverFound / totals.coverTotal).toFixed(4) : '1',
        `${totals.notesFound}/${totals.notes}`,
        totals.mapTotal ? (totals.mapCovered / totals.mapTotal).toFixed(3) : '1',
        totals.crossPage,
        '',
        '',
        '',
        times.length ? `median ${times[Math.floor(times.length / 2)]} max ${times.at(-1)}` : '',
    ].join('\t'));
    lines.push(`pipeline ${report.pipeline}: ${report.checked.length} checked, `
        + `${report.updated.length} updated, ${report.skipped.length} without expectations, `
        + `${report.failures.length} failed`);
    for (const failure of report.failures) lines.push(`DIFF ${failure.message}`);
    return lines.join('\n');
}

async function discoverCorpusIds(corpusDir) {
    let entries;
    try {
        entries = await readdir(corpusDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const ids = [];
    for (const entry of entries) {
        if (!entry.name.endsWith('.zip')) continue;
        try {
            if ((await stat(path.join(corpusDir, entry.name))).isFile()) ids.push(entry.name.slice(0, -4));
        }
        catch {
            // Skip unreadable entries.
        }
    }
    return ids.sort();
}

async function loadExpectation(id) {
    try {
        return JSON.parse(await readFile(
            path.join(READING_CORPUS_EXPECTATION_DIR, `${id}.expected.json`),
            'utf8'
        ));
    }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function writeExpectation(id, expectation) {
    await mkdir(READING_CORPUS_EXPECTATION_DIR, { recursive: true });
    await writeFile(
        path.join(READING_CORPUS_EXPECTATION_DIR, `${id}.expected.json`),
        `${JSON.stringify(expectation, null, 2)}\n`,
        'utf8'
    );
}

function sha256Hex(value) {
    return createHash('sha256').update(value).digest('hex');
}

function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}

async function main() {
    const args = process.argv.slice(2);
    const option = name => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : null;
    };
    const corpusDir = option('--corpus')
        || process.env[READING_CORPUS_ENV]
        || process.env[READING_CORPUS_FALLBACK_ENV];
    const ids = option('--ids')?.split(',').filter(Boolean) || null;
    const report = await checkReadingCorpus({
        corpusDir,
        pipeline: option('--pipeline') || 'ir',
        update: args.includes('--update'),
        ids,
        log: args.includes('--json') ? () => {} : console.log,
    });
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
