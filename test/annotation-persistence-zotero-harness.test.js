import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseHTML } from 'linkedom';
import { MarkdownCache } from '../src/cache/markdown-cache.js';
import { PDFAnnotationLocator } from '../src/pdf/pdf-annotation-locator.js';
import { createPDFJSTextEngine } from '../src/pdf/pdfjs-text-engine.js';
import { createPDFPageBodyViews } from '../src/pdf/pdf-page-chrome.js';
import { findAcademicFigures } from '../src/markdown/markdown-figures.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';
import { NOTICE_LINES, prepareFixtures } from '../scripts/annotation-persistence-zotero/fixtures.mjs';
import { checkNormalExit } from '../scripts/research-note-zotero/isolation.mjs';

const execute = promisify(execFile);
const createEngine = () => createPDFJSTextEngine({ standardFontDataUrl: fileURLToPath(
    new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)) });

test('synthetic retain PDF places a repeated long notice after the body in stream order but inside the top page margin', async () => {
    const run = await mkdtemp(path.join(tmpdir(), 'mktero-persistence-fixtures-test-'));
    const engine = createEngine();
    try {
        const fixtures = await prepareFixtures(run, path.join(run, 'profile'));
        assert.deepEqual(fixtures.map(value => value.label), ['retain', 'delete', 'retry', 'caption']);
        const retain = fixtures[0];
        assert.ok(NOTICE_LINES.join(' ').length > 240);
        const index = await engine.extract(await readFile(retain.pdfPath));
        assert.equal(index.pages.length, 2);
        const views = createPDFPageBodyViews(index.pages);
        for (const [pageIndex, page] of index.pages.entries()) {
            assert.ok(page.viewport.height > page.viewport.width);
            assert.ok(page.rawText.indexOf(retain.pages[pageIndex]) < page.rawText.indexOf(NOTICE_LINES[0]));
            for (const notice of NOTICE_LINES) {
                const item = page.items.find(value => value.text === notice);
                assert.ok(item, `Missing notice on page ${pageIndex}`);
                assert.ok(item.transform[5] >= page.viewport.height * 0.95);
                assert.equal(views[pageIndex].page.rawText.includes(notice), false);
            }
            assert.equal(views[pageIndex].page.rawText.trim(), retain.pages[pageIndex]);
        }
        const locator = new PDFAnnotationLocator({ engine,
            createSourceHash: bytes => createHash('sha256').update(bytes).digest('hex') });
        try {
            await locator.prepare(42, { fileData: await readFile(retain.pdfPath) });
            const located = await locator.locate(42, retain.text);
            assert.deepEqual(located.segments.map(value => value.text), retain.pages);
            assert.deepEqual(located.segments.map(value => value.position.pageIndex), [0, 1]);
            assert.ok(located.segments.every(value => value.position.rects.every(rect => rect[1] > 580 && rect[3] < 620)));
        }
        finally { locator.dispose(); }
    }
    finally { await engine.dispose(); await rm(run, { recursive: true, force: true }); }
});

test('retry environment fixture is genuinely invalid until its same-text two-page PDF is restored', async () => {
    const run = await mkdtemp(path.join(tmpdir(), 'mktero-persistence-retry-test-'));
    const engine = createEngine();
    try {
        const fixtures = await prepareFixtures(run, path.join(run, 'profile'));
        const fixture = fixtures.find(value => value.label === 'retry');
        const damaged = await readFile(fixture.pdfPath);
        await assert.rejects(engine.extract(damaged), /PDF|Invalid|format/iu);
        assert.notEqual(fixture.cacheKey, fixture.recoveryCacheKey);
        const recovered = await engine.extract(await readFile(fixture.recoveryPath));
        assert.deepEqual(recovered.pages.map(value => value.rawText.trim()), fixture.pages);
        assert.equal(recovered.pages.map(value => value.rawText.trim()).join(' '), fixture.markdown);
    }
    finally { await engine.dispose(); await rm(run, { recursive: true, force: true }); }
});

test('synthetic figcaption has a real offline cache image and locates to one multiline PDF item on one page', async () => {
    const run = await mkdtemp(path.join(tmpdir(), 'mktero-persistence-caption-test-'));
    const engine = createEngine();
    try {
        const fixtures = await prepareFixtures(run, path.join(run, 'profile'));
        const fixture = fixtures.find(value => value.label === 'caption');
        const figures = findAcademicFigures(fixture.markdown);
        assert.equal(figures.length, 1);
        const resolvedPaths = [];
        const { document } = parseHTML(renderMarkdownHTML(fixture.markdown, { resolveImageURL: source => {
            resolvedPaths.push(source);
            return source === fixture.assets[0].path ? 'blob:synthetic-offline-caption' : null;
        } }));
        assert.deepEqual(resolvedPaths, [fixture.assets[0].path]);
        const caption = document.querySelector('figure figcaption');
        assert.ok(caption, 'The production renderer must create a real figcaption');
        assert.equal(caption.textContent, fixture.caption);
        assert.equal(caption.querySelector('.mktero-figure-label').textContent, 'Figure 1.');
        assert.equal(caption.closest('figure').querySelector('img').getAttribute('src'), 'blob:synthetic-offline-caption');
        const paragraphs = [...document.querySelectorAll('p')].map(node => node.textContent);
        assert.ok(paragraphs.includes(fixture.before));
        assert.ok(paragraphs.includes(fixture.after));
        assert.equal(fixture.caption, `Figure 1. ${fixture.text}`);
        assert.equal(fixture.markdown.includes(fixture.text), true);
        const { document: imageDocument } = parseHTML(await readFile(fixture.assets[0].filePath, 'utf8'));
        assert.equal(Number(imageDocument.querySelector('svg').getAttribute('width')), fixture.assets[0].width);
        assert.equal(Number(imageDocument.querySelector('svg').getAttribute('height')), fixture.assets[0].height);
        assert.equal(imageDocument.querySelector('script, image, foreignObject'), null);
        const pdf = await readFile(fixture.pdfPath);
        const index = await engine.extract(pdf);
        assert.equal(index.pages.length, 1);
        assert.equal(index.pages[0].rawText.trim().replace(/\s+/gu, ' '), fixture.caption);
        const locator = new PDFAnnotationLocator({ engine,
            createSourceHash: bytes => createHash('sha256').update(bytes).digest('hex') });
        try {
            await locator.prepare(43, { fileData: pdf });
            const located = await locator.locate(43, fixture.text);
            const segments = located.segments || [located];
            assert.equal(segments.length, 1);
            assert.equal(segments[0].text, fixture.text);
            assert.equal(segments[0].position.pageIndex, 0);
            const rects = segments[0].position.rects;
            assert.equal(rects.length, fixture.captionLines.length);
            for (const [index, rect] of rects.entries()) {
                const baseline = fixture.geometry.baseline - index * fixture.geometry.lineHeight;
                assert.ok(rect[0] >= 39 && rect[2] <= fixture.geometry.width);
                assert.ok(rect[1] >= baseline - 20 && rect[3] <= baseline + 20);
            }
        }
        finally { locator.dispose(); }
    }
    finally { await engine.dispose(); await rm(run, { recursive: true, force: true }); }
});

test('fixture-only CLI leaves reviewable synthetic artifacts and valid production cache records without starting Zotero', async () => {
    const { stdout } = await execute(process.execPath, ['scripts/validate-annotation-persistence-zotero.mjs', '--fixtures'], {
        cwd: new URL('../', import.meta.url), timeout: 15000,
    });
    const run = /^Isolated annotation persistence run: (.+)$/mu.exec(stdout)?.[1];
    assert.ok(run);
    try {
        const report = JSON.parse(await readFile(path.join(run, 'report.json'), 'utf8'));
        assert.equal(report.passed, true);
        assert.equal(report.zoteroLaunched, false);
        assert.equal(report.fixtureCount, 4);
        const fixtures = JSON.parse(await readFile(path.join(run, 'fixture-plan.json'), 'utf8'));
        const cache = new MarkdownCache({ rootPath: path.join(run, 'profile', 'mktero-cache', 'v1'),
            pathUtils: { ...path, parent: path.dirname, filename: path.basename },
            ioUtils: { exists: async file => { try { await readFile(file); return true; } catch { return false; } },
                readUTF8: file => readFile(file, 'utf8'), read: readFile, stat,
                writeUTF8: (file, value) => writeFile(file, value),
                remove: (file, options) => rm(file, { recursive: options?.recursive, force: true }) } });
        for (const fixture of fixtures) for (const key of new Set([fixture.cacheKey, fixture.recoveryCacheKey])) {
            const cached = await cache.get(key);
            assert.equal(cached.markdown, fixture.markdown);
            assert.equal(cached.assets.length, (fixture.assets || []).length);
            for (const [index, asset] of (fixture.assets || []).entries()) {
                assert.equal(cached.assets[index].path, asset.path);
                assert.equal(cached.assets[index].mimeType, asset.mimeType);
                assert.deepEqual(Buffer.from(cached.assets[index].data), await readFile(asset.filePath));
            }
        }
    }
    finally { await rm(run, { recursive: true, force: true }); }
});

test('forced cleanup and signalled exits can never be accepted as a successful persistence restart', () => {
    assert.doesNotThrow(() => checkNormalExit({ code: 0, signal: null, forcedTermination: false }));
    assert.throws(() => checkNormalExit({ code: 0, signal: null, forcedTermination: true }), /Failure cleanup/u);
    assert.throws(() => checkNormalExit({ code: 0, signal: 'SIGTERM', forcedTermination: false }), /signalled/u);
    assert.throws(() => checkNormalExit({ code: 1, signal: null, forcedTermination: false }), /exit successfully/u);
});
