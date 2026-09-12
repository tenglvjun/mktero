import test from 'node:test';
import assert from 'node:assert/strict';
import { FigureReadingOrderService, collectFigureReadingOrderGroups } from '../src/figures/figure-reading-order.js';
import { analyzeDocumentFigures } from '../src/figures/figure-analysis.js';
import { collectFigureImageNodes, validateFigureMap } from '../src/figures/figure-model.js';
import { sha256Hex } from '../src/core/sha256.js';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { makeRestoredFigureDocument } from './helpers/restored-figure-fixture.js';
import { mapFigureMapThroughEdits } from '../src/figures/figure-map-transforms.js';

function fixture({ count = 4, columns = 2, wholeRow = false, marker = false, embeddedCaption = false,
    hardBreakCaption = false, assetPrefix = '' } = {}) {
    const title = 'Daily observations across independent markets';
    const caption = embeddedCaption ? 'Fig. 12 Measurements in each market.'
        : 'Fig. 12 Measurements in each market. See [2](#ref-2).';
    const ordered = Array.from({ length: count }, (_, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        return { path: `images/${assetPrefix}panel-${index}.png`, bbox: [100 + column * 200, 150 + row * 140,
            280 + column * 200, 260 + row * 140] };
    });
    if (wholeRow) ordered.splice(columns * 2, columns, { path: 'images/whole-row.png',
        bbox: [100, 430, 100 + columns * 200 - 20, 540] });
    const orphanIndex = wholeRow ? columns * 2 : ordered.length - (embeddedCaption ? 2 : 1);
    const order = [ordered[orphanIndex], ...ordered.filter((_, index) => index !== orphanIndex)];
    let markdown = 'Body before the figure.\n\n';
    const sourceMap = [];
    const image = (panel, last) => {
        const from = markdown.length;
        markdown += `![${last && embeddedCaption ? caption : ''}](${panel.path})`;
        sourceMap.push({ type: 'chart', markdownFrom: from, markdownTo: markdown.length,
            locations: [{ pageIndex: 1, bbox: panel.bbox }] });
        markdown += '\n\n';
    };
    image(order[0]);
    const titleFrom = markdown.length;
    markdown += title + '  \n';
    if (marker) markdown += `<!-- mktero-figure-layout: columns=1 rows=${order.slice(1).map(() => 1).join(',')} -->\n`;
    else markdown += '\n';
    order.slice(1).forEach((panel, index) => image(panel, index === order.length - 2));
    if (!embeddedCaption) {
        if (hardBreakCaption) markdown = markdown.slice(0, -2) + '  \n';
        markdown += caption + '\n\n';
        if (hardBreakCaption) sourceMap.at(-1).markdownTo = markdown.length - 2;
    }
    const bodyFrom = markdown.length;
    markdown += 'Body after the figure.\n';
    sourceMap.push({ type: 'text', markdownFrom: bodyFrom, markdownTo: markdown.length - 1,
        locations: [{ pageIndex: 2, bbox: [100, 100, 800, 130] }],
        locationRanges: [{ markdownFrom: bodyFrom, markdownTo: markdown.length - 1,
            location: { pageIndex: 2, bbox: [100, 100, 800, 130] } }] });
    return { title, caption, titleFrom, ordered,
        document: { markdown, sourceMap, assets: ordered.map(panel => ({ path: panel.path,
            data: createTestPNG(), mimeType: 'image/png' })),
        chromeRanges: [{ from: bodyFrom, to: markdown.length - 1 }], assetBasePath: '',
        figureMap: { version: 1, pipeline: 'figure-region-v1', markdownHash: null, figures: [], preserved: [] } } };
}

function harness({ verify = async () => ({ titleBBox: [120, 100, 850, 120],
    captionBBox: [100, 900, 900, 940] }) } = {}) {
    let opened = 0;
    let closed = 0;
    const requests = [];
    const service = new FigureReadingOrderService({ hash: sha256Hex, openPDF: async () => {
        opened++;
        return { verifyFigureOrder: async request => { requests.push(request); return verify(request); },
            close: async () => { closed++; } };
    } });
    return { service, requests, counts: () => ({ opened, closed }) };
}

for (const options of [{ count: 4, columns: 2 }, { count: 16, columns: 4 },
    { count: 12, columns: 3, wholeRow: true, marker: true }, { embeddedCaption: true },
    { count: 12, columns: 3, wholeRow: true, marker: true, hardBreakCaption: true }]) {
    test(`reunites a figure split by its title with ${JSON.stringify(options)}`, async () => {
        const sample = fixture(options);
        const h = harness();
        const original = structuredClone(sample.document);
        const result = await h.service.recover(sample.document, { fileData: Uint8Array.of(1) });
        const figures = analyzeDocumentFigures(result.markdown, { figureMap: result.figureMap });
        assert.equal(figures.length, 1);
        assert.equal(figures[0].images.length, sample.ordered.length);
        assert.deepEqual(collectFigureImageNodes(result.markdown).map(node => node.assetPath),
            sample.ordered.map(panel => panel.path));
        assert.ok(result.markdown.indexOf(sample.title) < figures[0].from);
        assert.equal(result.markdown.split(sample.title).length, 2);
        assert.ok(result.markdown.includes(sample.caption));
        assert.equal(result.assets, sample.document.assets);
        const title = result.sourceMap.find(entry => entry.type === 'text'
            && result.markdown.slice(entry.markdownFrom, entry.markdownTo).trim() === sample.title);
        assert.deepEqual(title.locations[0].bbox, [120, 100, 850, 120]);
        for (const image of collectFigureImageNodes(result.markdown)) {
            const entry = result.sourceMap.find(entry => entry.markdownFrom === image.from);
            assert.deepEqual(entry.locations[0].bbox, sample.ordered.find(panel => panel.path === image.assetPath).bbox);
        }
        const body = result.sourceMap.at(-1);
        assert.equal(result.markdown.slice(body.locationRanges[0].markdownFrom, body.locationRanges[0].markdownTo),
            'Body after the figure.');
        assert.deepEqual(result.chromeRanges, [{ from: body.markdownFrom, to: body.markdownTo }]);
        validateFigureMap(result.figureMap, result);
        assert.deepEqual(sample.document, original);
        assert.equal(await h.service.recover(result), result);
        assert.deepEqual(h.counts(), { opened: 1, closed: 1 });
    });
}

test('keeps unsafe or ambiguous candidates unchanged before opening the PDF', async () => {
    for (const mutate of [
        doc => { doc.userEdited = true; },
        doc => { doc.sourceMap = []; },
        doc => { doc.sourceMap[0].locations[0].pageIndex = 0; },
        doc => { doc.assets.push({ ...doc.assets[0] }); },
        doc => { doc.markdown += '\n![](images/panel-0.png)'; },
        doc => { doc.markdown = '```\n' + doc.markdown + '\n```'; },
        doc => { doc.markdown = doc.markdown.replace('Daily observations', '<script>alert(1)</script> Daily observations'); },
        doc => { doc.markdown = doc.markdown.replace('Daily observations', '[Daily observations](https://example.test)'); },
        doc => { doc.markdown = doc.markdown.replace('Daily observations', 'Fig. 9: Daily observations'); },
        doc => { doc.sourceMap[0].markdownFrom--; },
        doc => { doc.sourceMap.push(structuredClone(doc.sourceMap[0])); },
        doc => { doc.figureMap.figures = [{}]; },
        doc => { doc.chromeRanges.push({ from: doc.markdown.indexOf('Daily'), to: doc.markdown.indexOf('Daily') + 20 }); },
        doc => { doc.assets[0].path = '../escape.png'; },
        doc => { doc.assets[0].path = 'https://example.test/panel.png'; },
    ]) {
        const { document } = fixture();
        mutate(document);
        const h = harness();
        assert.equal(await h.service.recover(document), document);
        assert.equal(h.counts().opened, 0);
    }
});

test('preserves a document on missing PDF evidence and decoder failures', async () => {
    for (const verify of [async () => null, async () => { throw new Error('No pixels'); }]) {
        const { document } = fixture();
        const h = harness({ verify });
        assert.equal(await h.service.recover(document), document);
        assert.deepEqual(h.counts(), { opened: 1, closed: 1 });
    }
});

test('cancels without applying changes and closes its PDF session', async () => {
    const controller = new AbortController();
    const h = harness({ verify: async () => { controller.abort(); return null; } });
    await assert.rejects(h.service.recover(fixture().document, { signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(h.counts(), { opened: 1, closed: 1 });
});

test('collects the title even when its source map was lost during OCR normalization', () => {
    const sample = fixture({ marker: true });
    const groups = collectFigureReadingOrderGroups(sample.document);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title.text, sample.title);
    assert.equal(groups[0].panels.length, 4);
});

test('preserves source ranges within a moved title and resolves nested asset directories', async () => {
    const sample = fixture();
    const document = sample.document;
    const to = sample.titleFrom + sample.title.length;
    document.sourceMap.push({ type: 'text', markdownFrom: sample.titleFrom, markdownTo: to,
        locations: [{ pageIndex: 1, bbox: [120, 100, 850, 120] }],
        locationRanges: [{ markdownFrom: sample.titleFrom, markdownTo: to,
            location: { pageIndex: 1, bbox: [120, 100, 850, 120] } }] });
    document.assetBasePath = 'result/paper';
    document.assets.forEach(asset => { asset.path = document.assetBasePath + '/' + asset.path; });
    document.markdownHash = await sha256Hex(new TextEncoder().encode(document.markdown));
    const result = await harness().service.recover(document);
    const titleEntries = result.sourceMap.filter(entry => result.markdown.slice(entry.markdownFrom, entry.markdownTo) === sample.title);
    assert.equal(titleEntries.length, 1);
    assert.equal(titleEntries[0].markdownFrom, collectFigureReadingOrderGroups(document)[0].from);
    const range = titleEntries[0].locationRanges[0];
    assert.equal(result.markdown.slice(range.markdownFrom, range.markdownTo), sample.title);
    assert.equal(result.markdownHash, await sha256Hex(new TextEncoder().encode(result.markdown)));
    validateFigureMap(result.figureMap, result);
});

function shiftEntry(entry, offset) {
    return { ...entry, markdownFrom: entry.markdownFrom + offset, markdownTo: entry.markdownTo + offset,
        ...(entry.locationRanges ? { locationRanges: entry.locationRanges.map(range => ({
            ...range, markdownFrom: range.markdownFrom + offset, markdownTo: range.markdownTo + offset,
        })) } : {}) };
}

test('reorders independent pages and preserves a following restored figure and its metadata', async () => {
    const first = fixture({ assetPrefix: 'first-' }).document;
    const second = fixture({ assetPrefix: 'second-' }).document;
    second.sourceMap.forEach(entry => entry.locations.forEach(location => { location.pageIndex += 3; }));
    const existing = await makeRestoredFigureDocument();
    const offset = first.markdown.length + second.markdown.length;
    const markdown = first.markdown + second.markdown + existing.markdown;
    const document = { ...first, markdown,
        sourceMap: [...first.sourceMap, ...second.sourceMap.map(entry => shiftEntry(entry, first.markdown.length)),
            ...existing.sourceMap.map(entry => shiftEntry(entry, offset))],
        assets: [...first.assets, ...second.assets, ...existing.assets],
        figureMap: mapFigureMapThroughEdits(existing.figureMap,
            [{ from: 0, to: 0, replacementLength: offset }], markdown),
    };
    const h = harness();
    const result = await h.service.recover(document);
    assert.deepEqual(h.requests.map(request => request.pageIndex), [1, 4]);
    const figures = analyzeDocumentFigures(result.markdown, { figureMap: result.figureMap });
    assert.deepEqual(figures.map(figure => figure.images.length), [4, 4, 1]);
    assert.deepEqual(result.figureMap.figures[0].provenance, existing.figureMap.figures[0].provenance);
    const range = result.figureMap.figures[0].render.range;
    const originalRange = existing.figureMap.figures[0].render.range;
    assert.equal(result.markdown.slice(range.from, range.to), existing.markdown.slice(originalRange.from, originalRange.to));
    validateFigureMap(result.figureMap, result);
});

test('preserves unsupported embedded captions instead of emitting a partial group', async () => {
    const { document, ordered } = fixture({ embeddedCaption: true });
    const images = collectFigureImageNodes(document.markdown);
    const lastEntry = document.sourceMap.find(entry => entry.markdownFrom === images.at(-1).from);
    const firstRowEntry = document.sourceMap.find(entry => entry.markdownFrom === images[1].from);
    [lastEntry.locations[0].bbox, firstRowEntry.locations[0].bbox] = [ordered[0].bbox, ordered.at(-1).bbox];
    assert.equal(await harness().service.recover(document), document);
});

test('limits candidate work before opening the PDF', async () => {
    const { document } = fixture();
    for (const limits of [{ maxMarkdownBytes: 1 }, { maxPanels: 1 }, { maxComparisons: 1 },
        { maxInputAssets: 1 }, { maxLayoutBlocks: 1 }, { maxFragmentLength: 10 }]) {
        const service = new FigureReadingOrderService({ hash: sha256Hex, limits,
            openPDF: () => assert.fail('No PDF work for over-budget candidates') });
        assert.equal(await service.recover(document), document);
    }
});
