import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createPDFPageBodyViews,
    createPDFPageReadingViews,
    originalPDFBodyRanges,
} from '../src/pdf/pdf-page-chrome.js';

for (const [name, width, height] of [
    ['Letter portrait', 612, 792],
    ['A4 portrait', 595, 842],
    ['landscape', 842, 595],
]) {
    test(`derives a mapped body view for ${name} without changing the raw index`, () => {
        const pages = [0, 1].map(index => page(index, [
            { text: 'The first portion of the scientific argument.', y: height * 0.45 },
            { text: 'Repository circulation notice / experimental methods', y: height - 16 },
            { text: 'The second portion remains in its original position.', y: height * 0.4 },
        ], { width, height }));
        const before = JSON.stringify(pages);
        const views = createPDFPageBodyViews(pages);
        assert.equal(JSON.stringify(pages), before);
        assert.equal(createPDFPageBodyViews(pages), views);
        for (const view of views) {
            assert.equal(view.page.rawText.includes('Repository'), false);
            assert.equal(view.original, pages[view.original.pageIndex]);
            const ranges = originalPDFBodyRanges(view, { from: 0, to: view.page.rawText.length });
            assert.equal(ranges.map(range => view.original.rawText.slice(range.from, range.to)).join(''), view.page.rawText);
            for (const item of view.page.items) {
                assert.equal(view.page.rawText.slice(item.sourceFrom, item.sourceTo), item.text);
            }
        }
    });
}

test('uses transformed page coordinates for rotated and cropped pages', () => {
    for (const rotated of [false, true]) {
        const pages = [0, 1].map(index => {
            const original = page(index, [
                { text: 'A repeated edge notice in a transformed coordinate system', x: 72, y: 776 },
                { text: 'Body text retains its original geometry and source offsets.', x: 72, y: 500 },
            ]);
            if (rotated) {
                original.viewport.transform = [0, 1, 1, 0, 0, 0];
                original.items.forEach(item => {
                    const [, , , , x, y] = item.transform;
                    item.transform = [0, 12, -12, 0, 792 - y, x];
                });
            }
            else {
                original.viewport.transform = [1, 0, 0, -1, -20, 812];
                original.items.forEach(item => {
                    item.transform[4] += 20;
                    item.transform[5] += 20;
                });
            }
            return original;
        });
        const views = createPDFPageBodyViews(pages);
        assert.ok(views.every(view => !view.page.rawText.includes('repeated edge notice')));
        assert.ok(views.every(view => view.page.rawText.includes('Body text retains')));
    }
});

test('matches repeated visual lines when their text items are emitted in a different order', () => {
    const fragments = [
        { text: 'A public record ', x: 45, y: 778, width: 90 },
        { text: 'with independent review', x: 140, y: 778, width: 150 },
    ];
    const body = { text: 'Scientific prose with an unchanged original source offset.', y: 500 };
    const pages = [
        page(0, [body, ...fragments]),
        page(1, [...fragments].reverse().concat(body)),
    ];
    const views = createPDFPageBodyViews(pages);
    assert.ok(views.every(view => view.page.rawText.trim() === body.text));
    assert.equal(views[1].page.items[0].sourceFrom, views[1].page.rawText.indexOf('Scientific'));
});

test('keeps recurring edge-like lines adjacent to the reading text', () => {
    const pages = [0, 1].map(index => page(index, [
        { text: 'A repeated first line of an ordinary paragraph', y: 755 },
        { text: 'continues directly below as normal reading text.', y: 741 },
    ]));
    const views = createPDFPageBodyViews(pages);
    assert.ok(views.every((view, index) => view.page === pages[index]));
});

test('keeps body references, one-off edge text, and matching text at different locations', () => {
    const text = 'DOI https://doi.org/10.9999/example.2033 and a license are discussed here.';
    const pages = [
        page(0, [{ text, y: 778 }, { text: 'First page reading prose.', y: 500 }]),
        page(1, [{ text, y: 500 }, { text: 'Second page reading prose.', y: 470 }]),
    ];
    const views = createPDFPageBodyViews(pages);
    assert.ok(views.every((view, index) => view.page === pages[index]));
});

test('rejects untrusted source offsets or non-finite geometry without stripping content', () => {
    for (const corrupt of [
        item => { item.sourceFrom = -1; },
        item => { item.sourceTo = 100_000; },
        item => { item.transform[4] = Infinity; },
    ]) {
        const pages = [0, 1].map(index => page(index, [
            { text: 'Repeated archive notice with a stable visual location', y: 778 },
            { text: 'The scientific argument stays in the body.', y: 500 },
        ]));
        corrupt(pages[1].items[0]);
        const views = createPDFPageBodyViews(pages);
        assert.ok(views.every((view, index) => view.page === pages[index]));
    }
});

test('bounds page-margin work by the existing PDF item budget', () => {
    const original = page(0, [{ text: 'Text exceeding an aggregate item budget is left unchanged.', y: 500 }]);
    original.items = Array(250_001).fill(original.items[0]);
    const pages = [original];
    const views = createPDFPageBodyViews(pages);
    assert.equal(views[0].page, original);
});

test('maps a reading view through geometric columns without changing source spans', () => {
    const original = page(0, [
        { text: 'Right column ends with the selected experimental argument.', x: 320, y: 80, width: 220 },
        ...[500, 480, 460, 440].map(y => ({ text: 'Earlier observations in the left column remain available.', x: 60, y, width: 230 })),
        ...[500, 480, 460, 440].map(y => ({ text: 'Earlier observations in the right column remain available.', x: 320, y, width: 220 })),
    ]);
    const before = JSON.stringify(original);
    const views = createPDFPageReadingViews([original]);
    assert.equal(JSON.stringify(original), before);
    assert.equal(views[0].page.rawText.trim().endsWith('Right column ends with the selected experimental argument.'), true);
    const ranges = originalPDFBodyRanges(views[0], { from: 0, to: views[0].page.rawText.length });
    assert.equal(ranges.length, original.items.length);
    assert.equal(new Set(ranges.map(range => range.from)).size, original.items.length);
    for (const span of views[0].ranges) {
        assert.equal(views[0].page.rawText.slice(span.bodyFrom, span.bodyTo), original.rawText.slice(span.from, span.to));
    }
    for (const item of views[0].page.items) {
        assert.equal(views[0].page.rawText.slice(item.sourceFrom, item.sourceTo), item.text);
    }
});

test('separates a smaller isolated full-width caption while retaining the body', () => {
    const original = page(0, [
        { text: 'A long scientific body observation provides the normal reading font and complete experimental context.', y: 700, width: 450 },
        { text: 'Figure 2. Independent measurements from the experimental instrument.', y: 500, width: 450, height: 8 },
        { text: 'Error bars indicate independent measurements.', y: 489, width: 300, height: 8 },
        { text: 'The complete scientific argument continues below the isolated caption using the original body font.', y: 450, width: 450 },
    ]);
    const [view] = createPDFPageReadingViews([original]);
    assert.equal(view.page.rawText.includes('Figure 2.'), false);
    assert.equal(view.page.rawText.includes('Error bars'), false);
    assert.equal(view.page.rawText.includes('complete scientific argument'), true);
});

test('requires layout evidence beyond a figure label and surrounding blank space', () => {
    const text = 'Figure 2: the comparison is discussed as a substantive part of the scientific argument.';
    const original = page(0, [
        { text: 'The opening body paragraph must retain every independent experimental observation.', y: 700, width: 450 },
        { text, y: 500, width: 450 },
        { text: 'The final body paragraph is separated by space but remains part of the same discussion.', y: 300, width: 450 },
    ]);
    assert.equal(createPDFPageReadingViews([original])[0].page.rawText.includes(text), true);
});

test('requires a sparse small-font grid before excluding a caption in the body font', () => {
    const original = page(0, [
        { text: 'An independent scientific observation establishes the original body font and the complete experimental context.', y: 700, width: 450 },
        ...[560, 550, 540].map((y, index) => ({ text: `${index + 1} 20 30 40`, x: 100, y, width: 300, height: 6 })),
        { text: 'Figure 2. Independent measurements from a separately calibrated instrument.', y: 500, width: 450 },
        { text: 'The complete scientific argument continues after the grid with all its original experimental observations.', y: 450, width: 450 },
    ]);
    const [view] = createPDFPageReadingViews([original]);
    assert.equal(view.page.rawText.includes('Figure 2.'), false);
    assert.equal(view.page.rawText.includes('20 30 40'), false);
    assert.equal(view.page.rawText.includes('complete scientific argument'), true);
});

test('keeps a caption-like row when its other column contains ordinary prose', () => {
    const other = 'This ordinary right-column argument must never be excluded with a left-column caption.';
    const original = page(0, [
        { text: 'A long body paragraph establishes the normal font for this independent scientific discussion.', y: 700, width: 450 },
        { text: 'Figure 2: isolated experimental results.', x: 60, y: 500, width: 230, height: 8 },
        { text: other, x: 320, y: 500, width: 220, height: 8 },
        { text: 'The scientific discussion continues after the two separate columns and their original source spans.', y: 300, width: 450 },
    ]);
    const [view] = createPDFPageReadingViews([original]);
    assert.equal(view.page.rawText.includes(other), true);
    assert.equal(view.page.rawText.includes('Figure 2:'), true);
});

test('keeps numeric body lines and sentences referring to several figures', () => {
    const original = page(0, [
        { text: 'Table 2 and Table 3 summarize the complete experimental results discussed in the following paragraphs.', y: 650, width: 450 },
        { text: '1', y: 500, width: 10 },
        { text: 'The numerical response is a body measurement rather than an isolated page label.', y: 300, width: 450 },
    ]);
    const [view] = createPDFPageReadingViews([original]);
    assert.equal(view.page.rawText.includes('Table 2 and Table 3'), true);
    assert.equal(view.page.rawText.includes('\n1\n'), true);
});

test('keeps the original stream order of scripts and emits only mapped characters', () => {
    const original = page(0, [
        { text: 'The estimate uses the variance', x: 72, y: 500, width: 160 },
        { text: 'σ', x: 240, y: 500, width: 8 },
        { text: '2', x: 248, y: 504, width: 4, height: 8 },
        { text: 'G', x: 247, y: 497, width: 5, height: 8 },
        { text: 'and an independent experimental estimate.', x: 260, y: 500, width: 230 },
    ]);
    const [view] = createPDFPageReadingViews([original]);
    assert.equal(view.page.rawText.replace(/\s+/gu, '').includes('σ2Gand'), true);
    assert.equal(view.page.rawText.replace(/\s+/gu, ''), original.rawText.replace(/\s+/gu, ''));
});

test('bounds reading-view item and text work without mutating cached body views', () => {
    for (const count of [10_001, 250_001]) {
        const original = page(0, [{ text: 'A retained scientific observation.', y: 500 }]);
        original.items = Array(count).fill(original.items[0]);
        const pages = [original];
        const body = createPDFPageBodyViews(pages);
        const views = createPDFPageReadingViews(pages);
        assert.equal(views[0].page, original);
        assert.equal(createPDFPageBodyViews(pages), body);
    }
    const original = page(0, [{ text: 'Retained input.', y: 500 }]);
    original.rawText = 'x'.repeat(1_000_001);
    assert.equal(createPDFPageReadingViews([original])[0].page, original);
    const overlapping = page(0, [{ text: 'Overlapping cached spans must not multiply the reading text.', y: 500 }]);
    overlapping.items = Array(10_000).fill(overlapping.items[0]);
    assert.equal(createPDFPageReadingViews([overlapping])[0].page, overlapping);
});

test('refuses malformed reading-view geometry and original offsets', () => {
    for (const corrupt of [
        value => { value.items[0].transform = [1]; },
        value => { value.items[0].transform[4] = Infinity; },
        value => { value.items[0].sourceFrom = -1; },
        value => { value.viewport.width = 0; },
    ]) {
        const original = page(0, [{ text: 'An untrusted record must keep its original text.', y: 500 }]);
        corrupt(original);
        assert.equal(createPDFPageReadingViews([original])[0].page, original);
    }
});

function page(pageIndex, values, { width = 612, height = 792 } = {}) {
    let rawText = '';
    const items = values.map(({ text, x = 72, y = 500, width: itemWidth = 320, height: itemHeight = 12 }) => {
        const sourceFrom = rawText.length;
        rawText += text + '\n';
        return {
            text,
            sourceFrom,
            sourceTo: sourceFrom + text.length,
            transform: [itemHeight, 0, 0, itemHeight, x, y],
            width: itemWidth,
            height: itemHeight,
        };
    });
    return {
        pageIndex,
        pageLabel: String(pageIndex + 1),
        rawText,
        items,
        viewport: { width, height, transform: [1, 0, 0, -1, 0, height] },
    };
}
