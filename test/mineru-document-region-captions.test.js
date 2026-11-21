import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import {
    buildMinerUDocumentIR,
    createMinerUFigureInput,
    prepareMinerUResult,
    serializeDocumentIR,
} from '../src/mineru/document/prepare.js';
import { restorePDFFigureCaptions } from '../src/mineru/document/figure-captions.js';
import { blockPlainText, fragmentText } from '../src/mineru/document/ir.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';
import { isValidSourceMapEntry, resolveSourceMapLocation } from '../src/core/markdown-source-map.js';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';

const PAGE = 1000;
const PITCH = 12;
const CAPTION_SIZE = 7.5;
const PROSE = 'An independent paragraph follows the figure and remains part of the article.';
const PROSE_END = 'The next sentence describes the study rather than the displayed measurements.';
const AXIS = 'Internal axis label';

function text(bbox, content, type = 'text') {
    const spans = Array.isArray(content) ? content : [{ type: 'text', content }];
    return { type, bbox, lines: [{ bbox, spans: spans.map(span => ({ bbox, ...span })) }] };
}

function picture(bbox, name = 'main.png', type = 'chart', caption = '') {
    return { type, bbox, blocks: [
        { type: `${type}_body`, bbox,
            lines: [{ bbox, spans: [{ type, bbox, image_path: name }] }] },
        ...(caption ? [text([bbox[0], bbox[3] + 10, bbox[2], bbox[3] + 30], caption, `${type}_caption`)] : []),
    ] };
}

function pdfLine(value, top, { left = 100, width = 800, size = CAPTION_SIZE, fontName = 'caption' } = {}) {
    return { text: value, width, height: size, fontName,
        transform: [size, 0, 0, size, left, PAGE - top - size] };
}

function captionLines(number, count) {
    return [
        `Figure ${number}: Comparison of independent measurements.`,
        ...Array.from({ length: Math.max(0, count - 2) }, (_, index) =>
            `The interval for sample ${index + 1} summarizes repeated observations from the cohort.`),
        ...(count > 1 ? ['All estimates use the same reference population.'] : []),
    ];
}

function fixture({ number = 12, count = 3, placement = 'right', lines = captionLines(number, count),
    nativeLines = lines, ocrText = lines.join(' '), spans = null, type = 'chart', mixedAxis = true,
    ownCaption = '', extraBlocks = [], pitch = PITCH, captionTop = null } = {}) {
    const side = placement === 'left' || placement === 'right';
    const top = captionTop ?? (side ? 220 : placement === 'above' ? 210 - (lines.length - 1) * pitch : 395);
    const captionBBox = placement === 'right' ? [520, top, 920, top + (lines.length - 1) * pitch + 9]
        : placement === 'left' ? [80, top, 480, top + (lines.length - 1) * pitch + 9]
            : [100, top, 900, top + (lines.length - 1) * pitch + 9];
    const plotBBox = placement === 'right' ? [80, 80, 480, 570]
        : placement === 'left' ? [520, 80, 920, 570]
            : placement === 'above' ? [100, 260, 900, 650] : [100, 100, 900, 370];
    const rawBlocks = [
        picture(plotBBox, 'main.png', type, ownCaption),
        text(captionBBox, spans || ocrText),
        text([100, 790, 900, 825], `${PROSE} ${PROSE_END}`),
        ...extraBlocks,
    ];
    const result = {
        markdown: '', assetBasePath: '',
        assets: [{ path: 'images/main.png', mimeType: 'image/png', data: createTestPNG() }],
        layout: projectMinerULayout({ _backend: 'synthetic', _version_name: '3.4.5', pdf_info: [{
            page_idx: 0, page_size: [PAGE, PAGE], discarded_blocks: [], para_blocks: rawBlocks,
        }] }),
    };
    const items = nativeLines.map((value, index) => pdfLine(value, top + index * pitch, {
        left: captionBBox[0], width: captionBBox[2] - captionBBox[0] - (index === nativeLines.length - 1 ? 60 : 0),
    }));
    if (mixedAxis && side) {
        // The gap from this larger plot label to the legend is under 120 page
        // units. Whole-page baseline grouping therefore mixes the two regions.
        items.push(pdfLine(AXIS, top + CAPTION_SIZE - 11, {
            left: placement === 'right' ? plotBBox[2] - 90 : plotBBox[0] + 10,
            width: 75, size: 11, fontName: 'plot-label',
        }));
    }
    items.push(
        pdfLine(PROSE, 790, { size: 10, fontName: 'body' }),
        pdfLine(PROSE_END, 805, { size: 10, fontName: 'body' }),
    );
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: PAGE, height: PAGE, transform: [1, 0, 0, -1, 0, PAGE] }, items,
    }] };
    return { result, pdfText, captionBBox, plotBBox, lines, ocrText, top, number };
}

function captionChildren(block) {
    return (block?.children || []).filter(child => child.kind === 'caption');
}

function assertRecovered(values) {
    const input = createMinerUFigureInput(values.result, { pdfText: values.pdfText });
    const ir = input.providerState.mineruDocument.ir;
    const owner = ir.blocks.find(block => block.id === 'p0-0');
    const source = ir.blocks.find(block => block.id === 'p0-1');
    assert.equal(captionChildren(owner).length, 1, 'the one picture must carry one complete caption');
    assert.equal(source?.captionConsumed, true, 'the verified source block must leave body flow');
    assert.equal(source.captionConsumedFor, owner.id);
    assert.equal(input.markdown.split(`Figure ${values.number}:`).length - 1, 1);
    assert.equal(captionChildren(owner)[0].fragments.map(fragment => fragmentText(fragment)).join(' '), values.ocrText,
        'the complete OCR text must survive the migration');
    assert.ok(input.markdown.includes(PROSE));
    assert.ok(input.markdown.includes(PROSE_END));
    assert.equal(input.markdown.includes(AXIS), false, 'plot text must not enter the legend');
    const pieces = input.blocks.filter(block => block.role === 'caption' && block.parentId === owner.id);
    assert.equal(pieces.length, 1);
    assert.ok(pieces[0].sourceRanges.length > 0);
    const range = pieces[0].sourceRanges[0];
    assert.ok(input.markdown.slice(range.from, range.to).includes(`Figure ${values.number}:`));
    const document = prepareMinerUResult(input);
    assert.ok(document.sourceMap.length > 0);
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    return { input, ir, owner, source, document };
}

function assertRetained(values, { pdfText = values.pdfText } = {}) {
    const ir = buildMinerUDocumentIR(values.result, { pdfText });
    const source = ir.blocks.find(block => block.id === 'p0-1');
    assert.ok(source, 'uncertain evidence must preserve the original source block');
    assert.notEqual(source.captionConsumed, true);
    assert.equal(blockPlainText(source), values.ocrText);
    const document = serializeDocumentIR(ir);
    assert.ok(document.markdown.includes(values.ocrText));
    const label = `Figure ${values.number}:`;
    assert.equal(document.markdown.split(label).length - 1, values.ocrText.split(label).length - 1,
        'a partial native reading must not introduce a second legend');
    assert.ok(document.markdown.includes(PROSE));
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    return ir;
}

for (const [number, placement, count, type] of [
    [1, 'right', 1, 'image'],
    [12, 'left', 3, 'chart'],
    [37, 'right', 14, 'chart'],
    [1, 'left', 12, 'image'],
    [37, 'below', 3, 'image'],
    [12, 'above', 3, 'chart'],
]) {
    test(`attaches Figure ${number} from a ${count}-line body block ${placement} of an uncaptioned ${type}`, () => {
        assertRecovered(fixture({ number, placement, count, type }));
    });
}

test('uses the complete OCR legend when native PDF text spaces compound-word hyphens differently', () => {
    const lines = [
        'Figure 12: Survey-weighted estimates of independent observations.',
        'The self-reported measurements use the same reference population.',
        'Intervals describe uncertainty for each measurement.',
    ];
    const values = fixture({ lines, nativeLines: lines.map(value => value.replaceAll('-', ' - ')) });
    assertRecovered(values);
});

test('recomputes local line geometry for a larger bold number and a smaller superscript', () => {
    const lines = [
        'Figure 37: Measurements of R² across the independent groups.',
        'Intervals describe repeated measurements in the same population.',
        'All estimates use the same reference population.',
    ];
    const values = fixture({ number: 37, lines });
    const items = values.pdfText.pages[0].items;
    const left = values.captionBBox[0];
    items.splice(0, 1,
        pdfLine('Figure 37:', values.top - 1.5, { left, width: 48, size: 9, fontName: 'caption-bold' }),
        pdfLine('Measurements of R', values.top, { left: left + 54, width: 120 }),
        pdfLine('²', values.top + 1.5, { left: left + 174, width: 4, size: 4.5 }),
        pdfLine('across the independent groups.', values.top, { left: left + 185, width: 180 }),
    );
    assertRecovered(values);
});

test('preserves OCR mathematical and hyperlink spans while relocating a verified text block', () => {
    const values = fixture({ number: 37, spans: [
        { type: 'text', content: 'Figure 37: Comparison of ' },
        { type: 'inline_equation', content: 'x^2' },
        { type: 'text', content: ' across independent measurements. ' },
        { type: 'hyperlink', content: 'Reference data', url: 'https://example.org/reference_data' },
        { type: 'text', content: ' use the same cohort. All intervals describe uncertainty.' },
    ], lines: [
        'Figure 37: Comparison of x² across independent measurements.',
        'Reference data use the same cohort.',
        'All intervals describe uncertainty.',
    ] });
    values.ocrText = 'Figure 37: Comparison of $x^2$ across independent measurements. Reference data use the same cohort. All intervals describe uncertainty.';
    const { owner, input, document } = assertRecovered(values);
    const spans = captionChildren(owner).flatMap(child => child.fragments.flatMap(fragment =>
        fragment.lines.flatMap(line => line.spans)));
    assert.ok(spans.some(span => span.type === 'math' && span.content === 'x^2'));
    assert.ok(spans.some(span => span.content === 'Reference data'
        && span.linkURL === 'https://example.org/reference_data'));
    assert.ok(document.markdown.includes('https://example.org/reference_data'));
    assert.ok(document.markdown.includes('$x^2$'));
    const caption = input.blocks.find(block => block.role === 'caption');
    assert.equal(caption.text, values.ocrText, 'link destinations are not part of matching evidence');
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates[0].decision, 'compose');
    const draft = composeFigureDraft(input, [{ candidate: candidates[0], assetPath: 'generated/figures/links.png',
        crop: { data: createTestPNG(400, 490), mimeType: 'image/png', width: 400, height: 490 } }]);
    for (const output of [document, prepareMinerUResult(draft.input)]) {
        assert.ok(output.markdown.includes('https://example.org/reference_data'));
        assert.ok(output.markdown.includes('$x^2$'));
        const html = renderMarkdownHTML(output.markdown);
        assert.match(html, /<a href="https:\/\/example\.org\/reference_data"[^>]*>Reference data<\/a>/u);
        assert.equal(output.markdown.split('Figure 37:').length - 1, 1);
        assert.ok(output.sourceMap.every(entry => isValidSourceMapEntry(entry, output.markdown.length)));
    }
});

test('preserves PDF-native links that override provider links before a region caption moves', () => {
    const lines = [
        'Figure 12: Comparison of independent measurements.',
        'Reference data use the same cohort.',
        'All intervals describe uncertainty.',
    ];
    const values = fixture({ lines, spans: [
        { type: 'text', content: lines[0] },
        { type: 'hyperlink', content: 'Reference data', url: 'https://provider.example/old' },
        { type: 'text', content: 'use the same cohort. All intervals describe uncertainty.' },
    ] });
    const linkBox = [values.captionBBox[0], values.top + PITCH, values.captionBBox[0] + 80,
        values.top + PITCH + CAPTION_SIZE];
    values.result.layout.pages[0].blocks[1].lines[0].spans[1].bbox = linkBox;
    const url = 'https://example.org/native_reference';
    values.pdfText.pages[0].links = [{ url, rects: [linkBox] }];
    const { input, owner, document } = assertRecovered(values);
    const spans = captionChildren(owner).flatMap(child => child.fragments.flatMap(fragment =>
        fragment.lines.flatMap(line => line.spans)));
    assert.ok(spans.some(span => span.nativeLinkURL === url && span.linkURL === 'https://provider.example/old'));
    const [candidate] = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidate.decision, 'compose');
    const draft = composeFigureDraft(input, [{ candidate, assetPath: 'generated/figures/native-link.png',
        crop: { data: createTestPNG(400, 490), mimeType: 'image/png', width: 400, height: 490 } }]);
    for (const output of [document, prepareMinerUResult(draft.input)]) {
        assert.ok(output.markdown.includes(url));
        assert.equal(output.markdown.includes('https://provider.example/old'), false);
        assert.match(renderMarkdownHTML(output.markdown),
            /<a href="https:\/\/example\.org\/native_reference"[^>]*>Reference data<\/a>/u);
        assert.equal(output.markdown.split('Figure 12:').length - 1, 1);
    }
});

test('retains a caption whose figure label is itself linked when an image alt cannot expose that link', () => {
    const lines = captionLines(12, 3);
    const url = 'https://example.org/linked_label';
    const values = fixture({ lines, spans: [
        { type: 'hyperlink', content: 'Figure 12:', url },
        { type: 'text', content: lines.join(' ').slice('Figure 12:'.length).trim() },
    ] });
    const ir = buildMinerUDocumentIR(values.result, { pdfText: values.pdfText });
    const source = ir.blocks.find(block => block.id === 'p0-1');
    assert.notEqual(source.captionConsumed, true);
    assert.equal(blockPlainText(source), values.ocrText);
    const document = prepareMinerUResult(createMinerUFigureInput(values.result, { pdfText: values.pdfText }));
    assert.equal(captionChildren(ir.blocks.find(block => block.id === 'p0-0')).length, 0);
    assert.match(renderMarkdownHTML(document.markdown), /<a href="https:\/\/example\.org\/linked_label"[^>]*>Figure 12:<\/a>/u);
    assert.equal(document.markdown.split('Figure 12:').length - 1, 1);
});

for (const placement of ['right', 'below']) {
    test(`locates a recovered caption ${placement} of its picture and preserves its complete source chain`, () => {
        const values = fixture({ number: 37, count: 12, placement });
        const originalLines = structuredClone(values.result.layout.pages[0].blocks[1].lines);
        const { input, ir, owner, source, document } = assertRecovered(values);
        const [caption] = captionChildren(owner);
        assert.equal(caption.sourceBlockId, source.id);
        assert.equal(caption.pdfRegionCaption, true);
        assert.equal(caption.fragments, source.fragments, 'the caption retains the actual source fragments');
        assert.equal(source.fragments.length, 1);
        assert.deepEqual(source.fragments[0].bbox, values.captionBBox);
        assert.deepEqual(source.fragments[0].lines, originalLines);
        assert.equal(source.role, 'caption');
        assert.deepEqual(ir.releasedCaptions, [{
            id: source.id, from: owner.id, reason: 'native-caption', pageIndex: 0,
            captionId: source.nativeCaptionId,
        }]);
        assert.equal(input.blocks.some(block => block.id === source.id), false);

        const serialized = serializeDocumentIR(ir);
        const pieces = serialized.pieces.filter(piece => piece.part === 'caption');
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0].sourceBlockId, source.id);
        assert.equal(pieces[0].parentId, owner.id);
        assert.deepEqual(pieces[0].bbox, caption.bbox);
        assert.equal(serialized.markdown.slice(pieces[0].from, pieces[0].to), values.ocrText);

        const from = document.markdown.indexOf(values.ocrText);
        const to = from + values.ocrText.length;
        const mapping = document.sourceMap.find(entry => entry.markdownFrom <= from && entry.markdownTo >= to);
        assert.ok(mapping, 'the uncomposed image retains a source map for its caption');
        const captionLocation = { pageIndex: 0, bbox: caption.bbox };
        assert.deepEqual(mapping.locations, [{ pageIndex: 0, bbox: values.plotBBox }, captionLocation]);
        const image = serialized.pieces.find(piece => piece.part === 'panel' && piece.blockId === owner.id);
        assert.ok(image);
        const imageLocation = { pageIndex: 0, bbox: values.plotBBox };
        assert.deepEqual(mapping.locationRanges, [
            { markdownFrom: image.from, markdownTo: from, location: imageLocation },
            { markdownFrom: from, markdownTo: to, location: captionLocation },
            { markdownFrom: to, markdownTo: image.to, location: imageLocation },
        ]);
        assert.deepEqual(resolveSourceMapLocation(mapping, {
            from: to, to: image.to,
        }, document.markdown.length), imageLocation, 'image asset selection keeps its original source');
        assert.deepEqual(resolveSourceMapLocation(mapping, { from, to }, document.markdown.length), captionLocation);
        const selectionFrom = from + values.ocrText.indexOf('sample 5');
        assert.ok(selectionFrom > from);
        assert.deepEqual(resolveSourceMapLocation(mapping, {
            from: selectionFrom, to: selectionFrom + 'sample 5'.length,
        }, document.markdown.length), captionLocation);
        assert.equal(resolveSourceMapLocation(mapping, {
            from: mapping.markdownFrom, to: mapping.markdownTo,
        }, document.markdown.length), null, 'the caption range must not claim the entire image');
    });
}

test('finds a complete region caption whose bold figure number and description occupy separate spans', () => {
    const lines = captionLines(12, 3);
    const values = fixture({ lines, spans: [
        { type: 'text', content: 'Figure 12:' },
        { type: 'text', content: lines.join(' ').slice('Figure 12:'.length).trim() },
    ] });
    const left = values.captionBBox[0];
    values.pdfText.pages[0].items.splice(0, 1,
        pdfLine('Figure 12:', values.top - 1.5, { left, width: 48, size: 9, fontName: 'caption-bold' }),
        pdfLine(lines[0].slice('Figure 12:'.length).trim(), values.top, { left: left + 56, width: 330 }),
    );
    const { owner, source } = assertRecovered(values);
    const spans = captionChildren(owner)[0].fragments[0].lines[0].spans;
    assert.equal(spans.length, 2);
    assert.equal(spans[0].content, 'Figure 12:');
    assert.equal(spans[1].content, values.ocrText.slice('Figure 12:'.length).trim());
    assert.equal(captionChildren(owner)[0].sourceBlockId, source.id);
});

test('keeps a recovered long legend intact when its picture is composed or left unrendered', () => {
    const values = fixture({ count: 12, number: 37 });
    const { input } = assertRecovered(values);
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose', JSON.stringify(candidates.map(candidate => ({
        decision: candidate.decision, reason: candidate.reason, label: candidate.label,
    }))));
    assert.equal(candidates[0].panelBlockIds.length, 1);
    assert.equal(candidates[0].captionBlockIds.length, 1);
    const draft = composeFigureDraft(input, [{ candidate: candidates[0], assetPath: 'generated/figures/complete.png',
        crop: { data: createTestPNG(400, 490), mimeType: 'image/png', width: 400, height: 490 } }]);
    const composed = prepareMinerUResult(draft.input);
    assert.ok(composed.markdown.includes(values.ocrText));
    assert.ok(composed.markdown.includes('generated/figures/complete.png'));
    assert.equal(composed.markdown.split('Figure 37:').length - 1, 1);
    assert.ok(composed.markdown.includes(PROSE));
    assert.ok(composed.sourceMap.every(entry => isValidSourceMapEntry(entry, composed.markdown.length)));
    const from = composed.markdown.indexOf(values.ocrText);
    const to = from + values.ocrText.length;
    const mapping = composed.sourceMap.find(entry => entry.markdownFrom <= from && entry.markdownTo >= to);
    assert.deepEqual(resolveSourceMapLocation(mapping, { from, to }, composed.markdown.length), {
        pageIndex: 0, bbox: input.blocks.find(block => block.role === 'caption').bbox,
    }, 'a successful crop keeps the recovered caption source distinct from the picture');
});

test('does not add another caption or consumption record when restoration runs twice', () => {
    const values = fixture({ count: 12 });
    const { ir } = assertRecovered(values);
    const before = JSON.stringify({ blocks: ir.blocks, releasedCaptions: ir.releasedCaptions });
    const markdown = serializeDocumentIR(ir).markdown;
    restorePDFFigureCaptions(ir, values.pdfText);
    assert.equal(JSON.stringify({ blocks: ir.blocks, releasedCaptions: ir.releasedCaptions }), before);
    assert.equal(serializeDocumentIR(ir).markdown, markdown);
});

test('keeps a paragraph beginning with a figure reference as body text', () => {
    const lines = [
        'Figure 12 shows how the measured values change throughout the study.',
        'This paragraph explains the article rather than naming the displayed chart.',
        'The next section considers the remaining uncertainty.',
    ];
    const values = fixture({ lines });
    const ir = assertRetained(values);
    assert.equal(captionChildren(ir.blocks.find(block => block.id === 'p0-0')).length, 0);
});

for (const [name, adjust] of [
    ['only an ordered prefix', lines => lines.slice(0, 1)],
    ['a missing middle line', lines => [lines[0], lines[2]]],
    ['reordered words', lines => [lines[0], lines[1].split(' ').reverse().join(' '), lines[2]]],
    ['a different printed figure number', lines => [lines[0].replace('Figure 12:', 'Figure 13:'), ...lines.slice(1)]],
]) {
    test(`retains the complete body block when native text has ${name}`, () => {
        const lines = captionLines(12, 3);
        assertRetained(fixture({ lines, nativeLines: adjust(lines) }));
    });
}

for (const missingFrom of ['native PDF', 'OCR']) {
    test(`rejects ordered coverage missing a repeated word in the ${missingFrom} text`, () => {
        const complete = [
            'Figure 12: Comparison of independent measurements.',
            'Each sample is compared with the reference sample from the same cohort.',
            'All estimates use the same reference population.',
        ];
        const incomplete = complete.map(line => line.replace('reference sample', 'reference'));
        const values = fixture({
            lines: missingFrom === 'native PDF' ? complete : incomplete,
            nativeLines: missingFrom === 'native PDF' ? incomplete : complete,
        });
        const ir = assertRetained(values);
        assert.equal(captionChildren(ir.blocks.find(block => block.id === 'p0-0')).length, 0);
        assert.equal((ir.releasedCaptions || []).length, 0);
    });
}

for (const [printed, native] of [
    ['-0.5', '0.5'],
    ['−0.5', '0.5'],
    ['0.5', '0.05'],
    ['x + y', 'x - y'],
]) {
    test(`retains the original caption block when native text changes ${printed} to ${native}`, () => {
        const lines = [
            'Figure 12: Comparison of independent measurements.',
            `The reported estimate is ${printed} for the reference cohort.`,
            'All intervals describe uncertainty in the same population.',
        ];
        const values = fixture({ lines, nativeLines: lines.map(line => line.replace(printed, native)) });
        const ir = assertRetained(values);
        assert.equal(captionChildren(ir.blocks.find(block => block.id === 'p0-0')).length, 0);
        assert.equal((ir.releasedCaptions || []).length, 0);
    });
}

test('does not consume a body block containing two independent numbered legends', () => {
    const values = fixture({ lines: [
        'Figure 12: Comparison of independent measurements.',
        'Figure 13: Results from a separate population.',
        'All intervals describe uncertainty in the separate population.',
    ] });
    const ir = assertRetained(values);
    assert.equal(captionChildren(ir.blocks.find(block => block.id === 'p0-0')).length, 0);
});

test('does not consume prose that OCR appended to a caption in the same text block', () => {
    const values = fixture({ lines: [
        ...captionLines(12, 3),
        'We next discuss the independent biological implications of these findings.',
        'The article continues with a separate analysis of the study population.',
    ] });
    const rawSource = values.result.layout.pages[0].blocks[1];
    rawSource.bbox[3] = 330;
    rawSource.lines[0].bbox[3] = 330;
    for (const span of rawSource.lines[0].spans) span.bbox[3] = 330;
    const items = values.pdfText.pages[0].items;
    for (const [index, top] of [[3, 282], [4, 299]]) {
        items[index] = pdfLine(values.lines[index], top, {
            left: values.captionBBox[0] + 12, width: 370, size: 10, fontName: 'body',
        });
    }
    assertRetained(values);
});

test('leaves a shared-looking text block untouched when two pictures are equally plausible owners', () => {
    const values = fixture({ placement: 'below', extraBlocks: [picture([540, 100, 900, 370])] });
    const first = values.result.layout.pages[0].blocks[0];
    for (const box of [first.bbox, first.blocks[0].bbox, first.blocks[0].lines[0].bbox,
        first.blocks[0].lines[0].spans[0].bbox]) box[2] = 460;
    const ir = assertRetained(values);
    assert.equal(ir.blocks.filter(block => block.role === 'float').flatMap(captionChildren).length, 0);
});

test('rejects two independent region captions competing for the same uncaptioned picture', () => {
    const otherLines = captionLines(37, 3);
    const values = fixture({ extraBlocks: [text([520, 300, 920, 333], otherLines.join(' '))] });
    values.pdfText.pages[0].items.push(...otherLines.map((value, index) =>
        pdfLine(value, 300 + index * PITCH, { left: 520, width: 400 })));
    const ir = assertRetained(values);
    assert.equal(captionChildren(ir.blocks.find(block => block.id === 'p0-0')).length, 0);
    const other = ir.blocks.find(block => block.id === 'p0-3');
    assert.notEqual(other.captionConsumed, true);
    assert.ok(serializeDocumentIR(ir).markdown.includes(otherLines.join(' ')));
});

test('moves two independent region captions to their own pictures on the same page', () => {
    const figures = [
        { number: 12, ownerId: 'p0-0', sourceId: 'p0-1', name: 'main.png',
            plotBBox: [60, 80, 420, 290], captionBBox: [60, 310, 420, 343] },
        { number: 37, ownerId: 'p0-2', sourceId: 'p0-3', name: 'right.png',
            plotBBox: [580, 440, 940, 650], captionBBox: [580, 670, 940, 703] },
    ].map(figure => ({ ...figure, lines: captionLines(figure.number, 3) }));
    const values = fixture();
    values.result.assets.push({ path: 'images/right.png', mimeType: 'image/png', data: createTestPNG() });
    values.result.layout = projectMinerULayout({ _backend: 'synthetic', _version_name: '3.4.5', pdf_info: [{
        page_idx: 0, page_size: [PAGE, PAGE], discarded_blocks: [], para_blocks: [
            ...figures.flatMap(figure => [
                picture(figure.plotBBox, figure.name), text(figure.captionBBox, figure.lines.join(' ')),
            ]),
            text([100, 790, 900, 825], `${PROSE} ${PROSE_END}`),
        ],
    }] });
    values.pdfText.pages[0].items = [
        ...figures.flatMap(figure => figure.lines.map((line, index) => pdfLine(
            line, figure.captionBBox[1] + index * PITCH,
            { left: figure.captionBBox[0], width: figure.captionBBox[2] - figure.captionBBox[0] },
        ))),
        pdfLine(PROSE, 790, { size: 10, fontName: 'body' }),
        pdfLine(PROSE_END, 805, { size: 10, fontName: 'body' }),
    ];
    const input = createMinerUFigureInput(values.result, { pdfText: values.pdfText });
    const ir = input.providerState.mineruDocument.ir;
    const document = prepareMinerUResult(input);
    assert.equal(ir.blocks.filter(block => block.captionConsumed).length, 2);
    assert.equal(input.blocks.filter(block => block.role === 'caption').length, 2);
    assert.equal(ir.releasedCaptions.length, 2);
    for (const figure of figures) {
        const owner = ir.blocks.find(block => block.id === figure.ownerId);
        const source = ir.blocks.find(block => block.id === figure.sourceId);
        const [caption] = captionChildren(owner);
        assert.equal(captionChildren(owner).length, 1);
        assert.equal(caption.sourceBlockId, source.id);
        assert.equal(caption.fragments, source.fragments);
        assert.equal(source.captionConsumedFor, owner.id);
        assert.equal(blockPlainText(caption), figure.lines.join(' '));
        assert.deepEqual(ir.releasedCaptions.find(record => record.id === source.id), {
            id: source.id, from: owner.id, reason: 'native-caption', pageIndex: 0, captionId: source.nativeCaptionId,
        });
        const piece = input.blocks.find(block => block.role === 'caption' && block.parentId === owner.id);
        assert.ok(piece);
        assert.equal(piece.text, figure.lines.join(' '));
        assert.equal(document.markdown.split(`Figure ${figure.number}:`).length - 1, 1);
        const from = document.markdown.indexOf(figure.lines.join(' '));
        const to = from + figure.lines.join(' ').length;
        const mapping = document.sourceMap.find(entry => entry.markdownFrom <= from && entry.markdownTo >= to);
        assert.deepEqual(resolveSourceMapLocation(mapping, { from, to }, document.markdown.length), {
            pageIndex: 0, bbox: caption.bbox,
        });
    }
    assert.ok(document.markdown.includes(PROSE));
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
});

test('keeps an existing independent caption instead of replacing it with nearby body text', () => {
    const values = fixture({ ownCaption: 'Figure 1: An independently captioned chart.' });
    const ir = assertRetained(values);
    const captions = captionChildren(ir.blocks.find(block => block.id === 'p0-0'));
    assert.equal(captions.length, 1);
    assert.ok(captions[0].fragments[0].lines[0].spans[0].content.includes('Figure 1:'));
});

test('does not attach a region caption across an intervening article paragraph', () => {
    const values = fixture({ placement: 'below', extraBlocks: [
        text([100, 375, 900, 390], 'A separate article paragraph lies between the chart and its nearby text.'),
    ] });
    values.pdfText.pages[0].items.push(pdfLine(
        'A separate article paragraph lies between the chart and its nearby text.', 375, { size: 10, fontName: 'body' },
    ));
    const ir = assertRetained(values);
    assert.equal(captionChildren(ir.blocks.find(block => block.id === 'p0-0')).length, 0);
});

for (const reason of ['no native text index', 'mismatched PDF page geometry']) {
    test(`retains a region caption as body text with ${reason}`, () => {
        const values = fixture({ count: 12 });
        if (reason === 'mismatched PDF page geometry') values.pdfText.pages[0].viewport.width = 600;
        assertRetained(values, { pdfText: reason === 'no native text index' ? null : values.pdfText });
    });
}

test('retains an oversized complete OCR block instead of consuming a bounded native prefix', () => {
    const lines = [`Figure 12: ${'Independent observations retain their original order. '.repeat(190)}`.trim()];
    assert.ok(lines[0].length > 8192);
    assertRetained(fixture({ lines }));
});

test('does not mistake a truncated PDF text item for complete caption evidence', () => {
    const native = `Figure 12: ${'Independent observations retain their original order. '.repeat(50)}`;
    assert.ok(native.length > 2000 && native.length < 8192);
    const values = fixture({ lines: [native.slice(0, 2000)], nativeLines: [native] });
    const ir = assertRetained(values);
    assert.equal(captionChildren(ir.blocks.find(block => block.id === 'p0-0')).length, 0);
    assert.equal((ir.releasedCaptions || []).length, 0);
});

for (const count of [64, 65]) {
    test(`${count === 64 ? 'recovers' : 'retains'} a ${count}-line region caption below the character and item limits`, () => {
        const lines = [
            'Figure 12: Measurements from the reference cohort.',
            ...Array.from({ length: count - 1 }, (_, index) => `Sample ${index + 1}: independent measurements.`),
        ];
        const values = fixture({ lines, captionTop: 80, pitch: 10, mixedAxis: false });
        assert.ok(values.ocrText.length < 8192);
        assert.ok(values.pdfText.pages[0].items.length < 1024);
        assert.ok(values.captionBBox[3] < 790, 'the long caption must not intersect the following prose');
        if (count === 64) {
            assertRecovered(values);
            return;
        }
        const ir = assertRetained(values);
        assert.equal(captionChildren(ir.blocks.find(block => block.id === 'p0-0')).length, 0,
            'exceeding the region line limit must not attach an eight-line fallback');
        assert.equal((ir.releasedCaptions || []).length, 0);
        assert.equal(ir.diagnostics.pdfCaptions.restored, 0);
        const source = ir.blocks.find(block => block.id === 'p0-1');
        assert.equal(source.role, 'body');
        assert.equal(source.captionConsumedFor, undefined);
    });
}

test('leaves all region sources intact when page matching exceeds the comparison budget', () => {
    const extraBlocks = Array.from({ length: 48 }, (_, index) => picture([
        30 + index % 8 * 110, 600 + Math.floor(index / 8) * 20,
        100 + index % 8 * 110, 615 + Math.floor(index / 8) * 20,
    ]));
    const values = fixture({ count: 12, extraBlocks });
    const ir = assertRetained(values);
    assert.ok(ir.diagnostics.pdfCaptions.skipped > 0);
});
