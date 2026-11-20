import test from 'node:test';
import assert from 'node:assert/strict';
import { createPDFCaptionExclusions } from '../src/pdf/pdf-caption-evidence.js';

const sourceHash = 'b'.repeat(64);
const selected = 'The independently validated observation continues across the physical page boundary and preserves all original scientific measurements.';

function fixture() {
    const lines = [
        'Figure 3: The calibrated estimate x1 + x2 is shown for every experimental trial.',
        'Each curve retains all independent measurements and the complete set of controls.',
        'The discussion below must remain part of the original scientific argument.',
    ];
    let rawText = '';
    const items = lines.map((text, index) => {
        const sourceFrom = rawText.length;
        rawText += text + '\n';
        return {
            text, sourceFrom, sourceTo: sourceFrom + text.length,
            transform: [12, 0, 0, 12, 72, index < 2 ? 500 - index * 14 : 400],
            width: 450, height: 12, fontName: 'F1',
        };
    });
    const page = {
        pageIndex: 0, rawText, items, styles: {},
        viewport: { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] },
    };
    const evidence = {
        sourceHash, markdownHash: 'c'.repeat(64),
        captions: [{
            text: lines.slice(0, 2).join(' ').replace('x1 + x2', 'x_{1} + x_{2}'),
            pageIndex: 0,
            captionBBox: [110, 350, 860, 400],
            visualBBox: [110, 100, 860, 330],
            coordinateFrame: 'display-cropbox', rotation: 0,
            pdfGeometry: {
                width: 612, height: 792, rotation: 0, userUnit: 1,
                viewBox: [0, 0, 612, 792], mediaBox: null,
                viewportTransform: [1, 0, 0, -1, 0, 792],
            },
        }],
    };
    return { pages: [page], evidence };
}

const exclusions = ({ pages, evidence }, text = selected) => createPDFCaptionExclusions(pages, text, evidence, sourceHash);

test('verifies complete TeX captions and returns only their original item identities', () => {
    const value = fixture();
    const before = JSON.stringify(value);
    const result = exclusions(value);
    assert.deepEqual([...result.get(value.pages[0])], value.pages[0].items.slice(0, 2));
    assert.equal(JSON.stringify(value), before);
});

test('requires the entire caption rather than an item substring or partial caption box', () => {
    for (const corrupt of [
        value => { value.evidence.captions[0].text = value.evidence.captions[0].text.slice(10); },
        value => { value.evidence.captions[0].text = value.evidence.captions[0].text.split(' Each curve')[0]; },
        value => { value.evidence.captions[0].captionBBox[0] = 200; },
        value => { value.evidence.captions[0].captionBBox[3] = 370; },
        value => { value.evidence.captions[0].captionBBox[3] = 600; },
        value => { value.pages[0].items[2].transform[5] = 483; },
    ]) {
        const value = fixture();
        corrupt(value);
        assert.equal(exclusions(value), null);
    }
});

test('rejects globally repeated captions even when the supplied region selects one copy', () => {
    const value = fixture();
    const other = structuredClone(value.pages[0]);
    other.pageIndex = 1;
    value.pages.push(other);
    assert.equal(exclusions(value), null);
});

test('rejects evidence for a different PDF, unknown frame, or inconsistent page geometry', () => {
    for (const corrupt of [
        value => { value.evidence.sourceHash = 'd'.repeat(64); },
        value => { value.evidence.markdownHash = ''; },
        value => { value.evidence.markdownHash = ['c'.repeat(64)]; },
        value => { value.evidence.captions[0].coordinateFrame = 'unknown'; },
        value => { value.evidence.captions[0].rotation = 180; },
        value => { value.evidence.captions[0].pdfGeometry.rotation = 180; },
        value => { value.evidence.captions[0].pdfGeometry.width = Infinity; },
        value => { value.evidence.captions[0].pdfGeometry.userUnit = 2; },
        value => { value.evidence.captions[0].pdfGeometry.viewBox[2]++; },
        value => { value.evidence.captions[0].pdfGeometry.mediaBox = [0, 0, 20, 20]; },
        value => { value.evidence.captions[0].pdfGeometry.viewportTransform[4] = 20; },
        value => { value.evidence.captions[0].visualBBox = [100, 340, 900, 390]; },
        value => { value.pages[0].items[0].sourceFrom++; },
        value => { value.pages[0].items[0].transform[4] = NaN; },
        value => { value.pages[0].styles.F1 = { vertical: true }; },
    ]) {
        const value = fixture();
        corrupt(value);
        assert.equal(exclusions(value), null);
    }
});

test('verifies transformed text items in cropped and rotated display frames', () => {
    for (const rotation of [0, 90, 180, 270]) {
        const value = fixture();
        const page = value.pages[0];
        const geometry = value.evidence.captions[0].pdfGeometry;
        const matrices = {
            0: [1, 0, 0, -1, -20, 822],
            90: [0, 1, 1, 0, -30, -20],
            180: [-1, 0, 0, 1, 632, -30],
            270: [0, -1, -1, 0, 822, 632],
        };
        const matrix = matrices[rotation];
        const inverse = (x, y) => {
            const [a, b, c, d, e, f] = matrix;
            const det = a * d - b * c;
            return [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
        };
        for (const item of page.items) {
            const base = inverse(item.transform[4], 792 - item.transform[5]);
            const horizontal = inverse(12, 0);
            const up = inverse(0, -12);
            const origin = inverse(0, 0);
            item.transform = [horizontal[0] - origin[0], horizontal[1] - origin[1],
                up[0] - origin[0], up[1] - origin[1], ...base];
        }
        const width = rotation % 180 ? 792 : 612;
        const height = rotation % 180 ? 612 : 792;
        page.viewport = { width, height, transform: matrix };
        Object.assign(geometry, { width, height, rotation, viewBox: [20, 30, 632, 822], viewportTransform: matrix });
        Object.assign(value.evidence.captions[0], {
            rotation,
            captionBBox: [67 * 1000 / width, 277 * 1000 / height, 527 * 1000 / width, 317 * 1000 / height],
            visualBBox: [67 * 1000 / width, 100 * 1000 / height, 527 * 1000 / width, 260 * 1000 / height],
        });
        assert.equal(exclusions(value)?.get(page)?.size, 2, `rotation=${rotation}`);
    }
});

test('retains a caption when a selection anchor or the entire caption overlaps it', () => {
    const value = fixture();
    const caption = value.evidence.captions[0].text;
    for (const text of [caption, `${caption} ${selected}`, `${selected} ${caption}`,
        `${caption.slice(40, 100)} ${selected}`, `${selected} ${caption.slice(40, 100)}`]) {
        assert.equal(exclusions(value, text), null);
    }
});

test('bounds caption evidence, page items, source text and aggregate document size', () => {
    for (const corrupt of [
        value => { value.evidence.captions = Array(65).fill(value.evidence.captions[0]); },
        value => { value.evidence.captions[0].text = 'x'.repeat(8_193); },
        value => { value.evidence.captions = Array.from({ length: 9 }, () => ({ ...value.evidence.captions[0], text: 'x'.repeat(8_000) })); },
        value => { value.pages[0].items = Array(10_001).fill(value.pages[0].items[0]); },
        value => { value.pages[0].rawText = 'x'.repeat(1_000_001); },
        value => { value.pages = Array.from({ length: 26 }, (_, pageIndex) => ({ ...value.pages[0], pageIndex, items: Array(10_000).fill(value.pages[0].items[0]) })); },
        value => { value.pages = Array.from({ length: 11 }, (_, pageIndex) => ({ ...value.pages[0], pageIndex, rawText: 'x'.repeat(950_000) })); },
    ]) {
        const value = fixture();
        corrupt(value);
        assert.equal(exclusions(value), null);
    }
});
