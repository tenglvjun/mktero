import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

const LINES = [
    'Figure 12: Evaluation of the selection methods. The curves on the left show the average score over time.',
    'The bars on the right show final performance, with error bars indicating uncertainty across the independent experiments.',
    'Dashed lines indicate the baseline and the two reference methods. The orange curve improves steadily throughout the experiment.',
    'The green curve starts slowly because each step requires additional computation, then accelerates and eventually surpasses the baseline.',
    'All methods use the same data and the same total time budget.',
];
const CAPTION = LINES.join(' ');
const PROSE = 'The following paragraph remains independent of the figure and keeps its original text.';

function text(type, bbox, content) {
    return { type, bbox, lines: [{ bbox, spans: [{ type: 'text', bbox, content }] }] };
}

function picture(bbox, name, caption = '') {
    return { type: 'chart', bbox, blocks: [
        { type: 'chart_body', bbox, lines: [{ bbox, spans: [{ type: 'chart', bbox, image_path: name }] }] },
        ...(caption ? [text('chart_caption', [100, 320, 900, 388], caption)] : []),
    ] };
}

function line(value, bottom, size = 9, width = 800) {
    return { text: value, width, height: size, transform: [size, 0, 0, size, 100, 1000 - bottom] };
}

function fixture({ ocrCaption = CAPTION, nativeLines = LINES, threePanels = false } = {}) {
    const panels = threePanels ? [
        [[100, 100, 340, 280], 'left.png'],
        [[360, 100, 600, 288], 'middle.png'],
        [[620, 100, 900, 300], 'right.png'],
    ] : [
        [[100, 100, 480, 300], 'left.png'],
        [[500, 100, 900, 300], 'right.png'],
    ];
    const result = {
        markdown: '', assetBasePath: '',
        assets: panels.map(([, name]) => ({
            path: `images/${name}`, mimeType: 'image/png', data: createTestPNG(),
        })),
        layout: projectMinerULayout({ _backend: 'vlm', _version_name: '3.4.5', pdf_info: [{
            page_idx: 0, page_size: [1000, 1000], discarded_blocks: [], para_blocks: [
                ...panels.map(([bbox, name], index) => picture(bbox, name,
                    index === panels.length - 1 ? ocrCaption : '')),
                text('text', [100, 500, 900, 540], PROSE),
            ],
        }] }),
    };
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: 1000, height: 1000, transform: [1, 0, 0, -1, 0, 1000] },
        items: [
            ...nativeLines.map((value, index) => line(value, 330 + index * 14, 9, index === nativeLines.length - 1 ? 500 : 800)),
            line(PROSE, 515, 10),
            line('The next line of the article also remains readable.', 529, 10),
        ],
    }] };
    return { result, pdfText };
}

for (const withPDF of [false, true]) {
    test(`keeps one complete legend for a two-panel chart ${withPDF ? 'with' : 'without'} native PDF text`, () => {
        assert.ok(CAPTION.split(/\s+/u).length > 60);
        const { result, pdfText } = fixture();
        const input = bindFigureSourceRanges(createMinerUFigureInput(result, { pdfText: withPDF ? pdfText : null }));
        const candidates = resolveFigureCandidates(input);
        assert.equal(candidates.length, 1);
        const candidate = candidates[0];
        assert.equal(candidate.decision, 'compose');
        assert.equal(candidate.panelBlockIds.length, 2);
        assert.equal(candidate.captionBlockIds.length, 1);
        assert.equal(input.markdown.split('Figure 12:').length - 1, 1);
        assert.ok(input.markdown.includes(CAPTION));
        const draft = composeFigureDraft(input, [{ candidate, assetPath: 'generated/figures/chart.png',
            crop: { data: createTestPNG(800, 200), mimeType: 'image/png', width: 800, height: 200 } }]);
        const document = prepareMinerUResult(draft.input);
        assert.ok(document.markdown.includes(`![${CAPTION}](generated/figures/chart.png)`));
        assert.equal(document.markdown.split('Figure 12:').length - 1, 1);
        assert.equal(document.markdown.includes('images/'), false);
        assert.ok(document.markdown.includes(PROSE));
        assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    });
}

test('reads a full-width native caption longer than sixty words without consuming prose', () => {
    const { result, pdfText } = fixture({ ocrCaption: '' });
    result.layout.pages[0].blocks.splice(1, 1);
    const input = createMinerUFigureInput(result, { pdfText });
    const ir = input.providerState.mineruDocument.ir;
    const legend = ir.blocks.flatMap(block => block.children || []).find(child => child.pdfNativeCaption);
    assert.equal(legend.nativeText, CAPTION);
    assert.equal(ir.blocks.find(block => block.role === 'body').captionConsumed, undefined);
});

test('keeps a complete OCR legend when the native continuation cannot be read', () => {
    const { result, pdfText } = fixture({ nativeLines: [LINES[0]] });
    const input = createMinerUFigureInput(result, { pdfText });
    assert.equal(input.markdown.split('Figure 12:').length - 1, 1);
    assert.ok(input.markdown.includes(CAPTION));
    assert.equal(input.providerState.mineruDocument.ir.diagnostics.pdfCaptions.restored, 0);
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].panelBlockIds.length, 2);
});

for (const [name, ending, continuation] of [
    ['compound word', 'cross-', 'cohort selection agrees with the independent measurements.'],
    ['word broken across lines', 'compart-', 'ments remain consistent across all independent measurements.'],
    ['hyphenated word with the same token count', 'cross-', 'cohort'],
    ['Unicode hyphen', 'compart‐', 'ments remain consistent across all independent measurements.'],
]) {
    test(`keeps one three-panel figure when a bounded native caption ends in a ${name}`, () => {
        const first = `Figure 12: Comparison of independent measurements in ${ending}`;
        const caption = first.replace(/[-‐]$/u, '') + (ending === 'cross-' ? '-' : '') + continuation;
        const { result, pdfText } = fixture({ ocrCaption: caption, nativeLines: [first], threePanels: true });
        const input = bindFigureSourceRanges(createMinerUFigureInput(result, { pdfText }));
        assert.equal(input.providerState.mineruDocument.ir.diagnostics.pdfCaptions.restored, 0);
        assert.equal(input.markdown.split('Figure 12:').length - 1, 1);
        assert.ok(input.markdown.includes(caption));
        const candidates = resolveFigureCandidates(input);
        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].decision, 'compose');
        assert.equal(candidates[0].panelBlockIds.length, 3);
        assert.equal(candidates[0].captionBlockIds.length, 1);
        const draft = composeFigureDraft(input, [{ candidate: candidates[0], assetPath: 'generated/figures/chart.png',
            crop: { data: createTestPNG(800, 200), mimeType: 'image/png', width: 800, height: 200 } }]);
        const document = prepareMinerUResult(draft.input);
        assert.ok(document.markdown.includes(`![${caption}](generated/figures/chart.png)`));
        assert.equal(document.markdown.includes('images/'), false);
        assert.equal(document.markdown.split('Figure 12:').length - 1, 1);
        assert.ok(document.markdown.includes(PROSE));
        assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    });
}

for (const [name, adjust] of [
    ['a different figure number', (result) => {
        result.layout.pages[0].blocks[2].blocks[1].lines[0].spans[0].content =
            'Figure 13: Comparison of independent measurements in cross-cohort selection agrees with the independent measurements.';
    }],
    ['a different printed location', (result) => {
        result.layout.pages[0].blocks[2].blocks[1].bbox = [100, 400, 900, 450];
    }],
    ['a different ordered prefix', (result) => {
        result.layout.pages[0].blocks[2].blocks[1].lines[0].spans[0].content =
            'Figure 12: Results from a separate trial in cross-cohort selection agree with the observations.';
    }],
]) {
    test(`does not suppress a native caption using an OCR copy with ${name}`, () => {
        const { result, pdfText } = fixture({
            nativeLines: ['Figure 12: Comparison of independent measurements in cross-'],
            ocrCaption: 'Figure 12: Comparison of independent measurements in cross-cohort selection agrees with the independent measurements.',
            threePanels: true,
        });
        adjust(result);
        const input = createMinerUFigureInput(result, { pdfText });
        assert.equal(input.providerState.mineruDocument.ir.diagnostics.pdfCaptions.restored, 1);
    });
}

test('does not treat an unhyphenated partial word as evidence of a complete OCR caption', () => {
    const { result, pdfText } = fixture({
        ocrCaption: 'Figure 12: Evaluation of methodology in the reference cohort.',
        nativeLines: ['Figure 12: Evaluation of method'],
    });
    const input = createMinerUFigureInput(result, { pdfText });
    assert.equal(input.providerState.mineruDocument.ir.diagnostics.pdfCaptions.restored, 1);
});

test('does not create another legend when a native caption exceeds the line budget', () => {
    const nativeLines = ['Figure 12: Repeated measurement results.', ...Array(9).fill('The same repeated result is reported again.')];
    const caption = nativeLines.join(' ');
    const { result, pdfText } = fixture({ nativeLines, ocrCaption: caption });
    const input = createMinerUFigureInput(result, { pdfText });
    assert.equal(input.markdown.split('Figure 12:').length - 1, 1);
    assert.ok(input.markdown.includes(caption));
    assert.equal(input.providerState.mineruDocument.ir.diagnostics.pdfCaptions.restored, 0);
});
