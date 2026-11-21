import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { createMinerUFigureInput, prepareMinerUResult, serializeDocumentIR } from '../src/mineru/document/prepare.js';
import { createFigureInputFromIR } from '../src/mineru/document/figure-input.js';
import { attachFloatNotes } from '../src/mineru/document/floats.js';
import { ingestMinerULayout } from '../src/mineru/document/ingest-layout.js';
import { attachPDFGeometry, pdfLines, pdfTextItemsByPage } from '../src/mineru/document/pdf-geometry.js';
import { nativeLineText } from '../src/mineru/document/caption-regions.js';
import { classifyBlocks } from '../src/mineru/document/classify.js';
import { restorePDFFigureCaptions } from '../src/mineru/document/figure-captions.js';
import { blockPlainText, fragmentText, unionBBox } from '../src/mineru/document/ir.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { collectFigureImageNodes } from '../src/figures/figure-model.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { sha256Hex } from '../src/core/sha256.js';
import { noteDirective } from '../src/markdown/markdown-directives.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

// Purely synthetic vector-page text: OCR crops exclude two chart titles,
// and the preceding table mistakenly owns the upper title as a raw footnote.
// Neither native image containers nor bitmap evidence participates in repair.
const PAGE = 1000;
const WIDTH = 432;
const SIZE = 7.5;
const UPPER_TITLE = 'CALM Run3 - Validation Set - Score 86.4';
const LOWER_TITLE = 'MINT Run2 - Reference Set - Score 91.6';
const TABLE_NOTE = 'Values are means over independent measurements.';
const TABLE_HTML = '<table><tr><th>Condition</th><th>Estimate</th></tr><tr><td>Control</td><td>0.73</td></tr></table>';
const hash = data => sha256Hex(data, { crypto: webcrypto });

function text(type, bbox, content) {
    return { type, bbox, lines: [{ bbox, spans: [{ type: 'text', bbox, content }] }] };
}

function picture(type, bbox, name, captions = []) {
    return { type, bbox, blocks: [
        { type: `${type}_body`, bbox,
            lines: [{ bbox, spans: [{ type: 'image', bbox, image_path: name }] }] },
        ...captions.map(([box, value]) => text(`${type}_caption`, box, value)),
    ] };
}

function pdfLine(value, bbox, { size = bbox[3] - bbox[1] } = {}) {
    return { text: value, width: bbox[2] - bbox[0], height: size, fontName: 'SyntheticSans',
        transform: [size, 0, 0, size, bbox[0], PAGE - bbox[3]] };
}

// Adjacent fragments have a real sub-glyph gap. Word spaces have a normal
// advance; they must survive even when every letter is a separate PDF item.
function titleItems(value, left, top, style = 'fragments') {
    const chunks = style === 'fragments' ? value.match(/.{1,3}|.{1,2}$/gu) : [...value];
    const items = [];
    let x = left;
    let previous = '';
    for (const chunk of chunks) {
        if (!chunk.trim()) {
            x += SIZE * 0.5;
            previous = chunk;
            continue;
        }
        const script = ['subscript', 'superscript'].includes(style) && /\d/u.test(chunk) && /n/u.test(previous);
        const size = script ? 5 : SIZE;
        const bottom = top + SIZE + (script ? style === 'subscript' ? 1 : -1 : 0);
        const width = chunk.trim().length * 3.5;
        items.push(pdfLine(chunk, [x, bottom - size, x + width, bottom], { size }));
        x += width + (/[\s]$/u.test(chunk) ? SIZE * 0.5 : 0.25);
        previous = chunk;
    }
    return { items, bbox: unionBBox(items.map(item => [item.transform[4],
        PAGE - item.transform[5] - item.transform[3], item.transform[4] + item.width,
        PAGE - item.transform[5]])) };
}

function fixture({ figureOnRight = false, number = 17, style = 'fragments',
    upperTitle = UPPER_TITLE, change = () => {} } = {}) {
    const figureLeft = figureOnRight ? 508 : 60;
    const bodyLeft = figureOnRight ? 60 : 508;
    const upperBox = [figureLeft, 240, figureLeft + WIDTH, 420];
    const lowerBox = [figureLeft, 444, figureLeft + WIDTH, 624];
    const upper = titleItems(upperTitle, figureLeft + 28, 230, style);
    const lower = titleItems(LOWER_TITLE, figureLeft + 28, 434, style);
    const legendLines = [
        `Fig. ${number}. Measurements from four synthetic conditions.`,
        '(a) The first condition and (b) the second share one scale.',
        '(c) The third condition and (d) the fourth repeat the protocol.',
        'Intervals show uncertainty over independent trials.',
    ];
    const caption = legendLines.join(' ');
    const captionBBox = [figureLeft, 636, figureLeft + WIDTH, 673.5];
    const tableBox = [figureLeft, 80, figureLeft + WIDTH, 180];
    const tableNoteBox = [figureLeft + 8, 188, figureLeft + 300, 195.5];
    const table = { type: 'table', bbox: tableBox, blocks: [
        { type: 'table_body', bbox: tableBox, lines: [{ bbox: tableBox, spans: [
            { type: 'table', bbox: tableBox, html: TABLE_HTML },
        ] }] },
        text('table_footnote', tableNoteBox, TABLE_NOTE),
        text('table_footnote', upper.bbox, upperTitle),
    ] };
    const upperPicture = picture('image', upperBox, 'upper.png');
    const lowerPicture = picture('chart', lowerBox, 'lower.png', [
        [lower.bbox, LOWER_TITLE], [captionBBox, caption],
    ]);
    const bodyLines = Array.from({ length: 38 }, (_, index) =>
        `Independent observation ${index + 1} follows the stated sampling procedure.`);
    const body = { bbox: [bodyLeft, 227.5, bodyLeft + WIDTH, 681.5], text: bodyLines.join(' ') };
    const blocks = [table, upperPicture, lowerPicture, text('text', body.bbox, body.text)];
    const items = [pdfLine(TABLE_NOTE, tableNoteBox), ...upper.items, ...lower.items,
        ...legendLines.map((value, index) => pdfLine(value,
            [figureLeft, 636 + index * 10, figureLeft + WIDTH, 643.5 + index * 10])),
        ...bodyLines.map((value, index) => pdfLine(value,
            [bodyLeft, 227.5 + index * 12, bodyLeft + WIDTH, 237.5 + index * 12])),
    ];
    const values = { figureLeft, bodyLeft, table, upperPicture, lowerPicture, blocks, items,
        upperBox, lowerBox, titleBBox: upper.bbox, lowerTitleBBox: lower.bbox,
        title: upperTitle, caption, captionBBox, tableBox, tableNoteBox, body,
        upperItems: upper.items, lowerItems: lower.items };
    change(values);
    const result = {
        markdown: '', assetBasePath: '',
        assets: ['upper.png', 'lower.png', 'independent.png'].map(name => ({
            path: `images/${name}`, mimeType: 'image/png', data: createTestPNG(),
        })),
        layout: projectMinerULayout({ _backend: 'synthetic', _version_name: '3.4.5', pdf_info: [{
            page_idx: 0, page_size: [PAGE, PAGE], para_blocks: blocks, discarded_blocks: [],
        }] }),
    };
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: PAGE, height: PAGE, transform: [1, 0, 0, -1, 0, PAGE] }, items,
    }] };
    return { ...values, result, pdfText };
}

function childrenWithText(ir, value) {
    return ir.blocks.flatMap(parent => (parent.children || []).filter(child => blockPlainText(child) === value)
        .map(child => ({ parent, child })));
}

function originalIR(values) {
    const ir = ingestMinerULayout(values.result.layout, { assets: values.result.assets });
    attachPDFGeometry(ir, values.pdfText);
    classifyBlocks(ir);
    return ir;
}

function figureInput(values) {
    const before = structuredClone(values.result);
    const input = bindFigureSourceRanges(createMinerUFigureInput(values.result, { pdfText: values.pdfText }));
    assert.deepEqual(values.result, before, 'repair must leave the OCR result and its assets unchanged');
    return { input, ir: input.providerState.mineruDocument.ir, candidates: resolveFigureCandidates(input) };
}

function summary(candidates) {
    return JSON.stringify(candidates.map(candidate => ({ label: candidate.label,
        panels: candidate.panelBlockIds.length, decision: candidate.decision, reason: candidate.reason })));
}

function assertValidMap(document) {
    assert.ok(document.sourceMap.length > 0);
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
}

function assertLocated(document, value, bbox) {
    assert.equal(document.markdown.split(value).length - 1, 1, value);
    assert.ok(document.sourceMap.some(entry =>
        document.markdown.slice(entry.markdownFrom, entry.markdownTo).includes(value)
        && entry.locations.some(location => location.pageIndex === 0
            && JSON.stringify(location.bbox) === JSON.stringify(bbox))),
    `${value} must retain its original source box`);
}

function assertIndependentContent(document, values) {
    assertValidMap(document);
    assert.ok(document.markdown.includes(TABLE_HTML));
    assertLocated(document, TABLE_NOTE, values.tableNoteBox);
    assertLocated(document, values.body.text, values.body.bbox);
    assert.equal(document.markdown.split(noteDirective('table')).length - 1, 1,
        'only the real table footnote keeps a table-note directive');
    assert.equal(document.markdown.split(values.caption).length - 1, 1);
}

function assertContains(outer, inner) {
    assert.ok(outer[0] <= inner[0] && outer[1] <= inner[1]
        && outer[2] >= inner[2] && outer[3] >= inner[3], `${outer} must include ${inner}`);
}

function assertMoved(values) {
    const original = originalIR(values);
    const [{ parent: source, child: note }] = childrenWithText(original, values.title);
    assert.equal(source.kind, 'table');
    assert.equal(note.kind, 'footnote');
    assert.deepEqual(note.originalFootnote, { ownerId: source.id, ownerKind: source.kind });
    const native = pdfTextItemsByPage(original, values.pdfText).get(0).filter(item =>
        item.bbox[0] >= values.titleBBox[0] && item.bbox[2] <= values.titleBBox[2]
        && item.bbox[1] >= values.titleBBox[1] && item.bbox[3] <= values.titleBBox[3]);
    assert.deepEqual(pdfLines(native).map(line => nativeLineText(line.items)), [values.title],
        'the synthetic native title must read completely with ordinary glyph advances');
    const { input, ir, candidates } = figureInput(values);
    const matches = childrenWithText(ir, values.title);
    assert.equal(matches.length, 1, 'the original child must have exactly one parent');
    const [{ parent, child }] = matches;
    assert.equal(parent.kind, 'image');
    assert.equal(child.kind, 'figure-text');
    assert.equal(child.id, note.id);
    assert.deepEqual(child.fragments, note.fragments);
    assert.deepEqual(child.bbox, note.bbox);
    assert.deepEqual(child.originalFootnote, note.originalFootnote);
    const tableAfter = ir.blocks.find(block => block.id === source.id);
    assert.deepEqual(tableAfter.children, source.children.filter(member => member.id !== note.id),
        'the table body and genuine footnote must not change');
    assert.deepEqual(tableAfter.bbox, source.bbox);
    assert.deepEqual(tableAfter.fragments, source.fragments);
    assert.deepEqual((ir.captionMoves || []).filter(move => move.reason === 'figure-annotation'), [
        { from: source.id, to: parent.id, ids: [note.id], pageIndex: 0, reason: 'figure-annotation' },
    ]);
    assert.equal(candidates.length, 1, summary(candidates));
    const [candidate] = candidates;
    assert.equal(candidate.decision, 'compose', summary(candidates));
    assert.equal(candidate.panelBlockIds.length, 2);
    assert.equal(candidate.captionBlockIds.length, 1);
    assert.ok(candidate.ownedTextBlockIds.includes(child.id));
    const lower = input.blocks.find(block => block.text === LOWER_TITLE);
    assert.equal(lower.role, 'figure-text');
    assert.ok(candidate.ownedTextBlockIds.includes(lower.id));
    const mapped = input.blocks.find(block => block.id === note.id);
    assert.equal(mapped.parentId, parent.id);
    assert.deepEqual(mapped.bbox, values.titleBBox);
    assertContains(candidate.visualBBox, values.titleBBox);
    assertContains(candidate.visualBBox, values.lowerTitleBBox);
    assertLocated(prepareMinerUResult(input), values.title, values.titleBBox);
    return { input, ir, candidate, child };
}

function compose(input, candidate, options) {
    const draft = composeFigureDraft(input, [{ candidate,
        assetPath: 'generated/figures/float-annotations.png',
        crop: { data: createTestPNG(432, 400), mimeType: 'image/png', width: 432, height: 400 },
    }], options);
    return { draft, document: prepareMinerUResult(draft.input) };
}

for (const [number, style, figureOnRight] of [
    [3, 'fragments', false], [21, 'characters', true],
    [108, 'subscript', false], [46, 'superscript', true],
]) {
    test(`moves a native ${style} title to the upper panel of Fig. ${number} in the ${figureOnRight ? 'right' : 'left'} column`, () => {
        const values = fixture({ number, style, figureOnRight });
        const { input, candidate, child } = assertMoved(values);
        const { draft, document } = compose(input, candidate);
        assert.deepEqual(draft.preserved, []);
        assert.equal(draft.blueprints.length, 1);
        const [blueprint] = draft.blueprints;
        assertContains(blueprint.visualBBox, values.titleBBox);
        assert.deepEqual(blueprint.provenance.fragments.filter(fragment => fragment.blockId === child.id), [
            { blockId: child.id, role: 'figure-text', bbox: values.titleBBox, markdown: values.title },
        ]);
        const images = collectFigureImageNodes(document.markdown);
        assert.equal(images.length, 1);
        assert.equal(images[0].assetPath, 'generated/figures/float-annotations.png');
        assert.ok(document.markdown.includes(`![${values.caption}](generated/figures/float-annotations.png)`));
        assert.equal(document.markdown.includes(values.title), false);
        assert.equal(document.markdown.includes(LOWER_TITLE), false);
        assertIndependentContent(document, values);
    });
}

function inputFromIR(ir, values) {
    return bindFigureSourceRanges(createFigureInputFromIR(ir, serializeDocumentIR(ir), values.result));
}

function assertRetained(values, changeIR = () => {}) {
    const ir = originalIR(values);
    const [{ parent: source, child }] = childrenWithText(ir, values.title);
    changeIR(ir, source, child);
    const before = structuredClone(child);
    restorePDFFigureCaptions(ir, values.pdfText);
    const matches = ir.blocks.flatMap(parent => parent.children.filter(member => member.id === child.id)
        .map(member => ({ parent, child: member })));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].parent.id, source.id, 'uncertain title ownership must keep the original table parent');
    assert.deepEqual(matches[0].child, before, 'rejected evidence must not alter the source child');
    assert.equal((ir.captionMoves || []).some(move => move.ids.includes(child.id)), false);
    const input = inputFromIR(ir, values);
    const document = prepareMinerUResult(input);
    assertLocated(document, values.titleMarkdown || values.title, values.titleBBox);
    assertValidMap(document);
    assert.ok(document.markdown.includes(TABLE_HTML));
    if (values.tableNoteBox) assertLocated(document, TABLE_NOTE, values.tableNoteBox);
    assert.ok(resolveFigureCandidates(input).every(candidate =>
        !candidate.ownedTextBlockIds.includes(child.id)), 'a rejected table note must not become crop-owned text');
    return { ir, input, source, child, document };
}

function sourceNoteChainFixture({ title = UPPER_TITLE, preceding = [
    { bbox: [100, 210, 500, 220], value: TABLE_NOTE },
], titleBBox = [100, 234, 480, 244], tableBottom = 200, interleavedCaption = false } = {}) {
    return fixture({ upperTitle: title, change: values => {
        values.tableBox.splice(0, 4, 100, 100, 900, tableBottom);
        values.upperBox.splice(0, 4, 100, 250, 480, 450);
        values.lowerBox.splice(0, 4, 500, 250, 900, 450);
        values.titleBBox = titleBBox;
        values.tableNoteBox = preceding.find(note => note.value === TABLE_NOTE)?.bbox;
        const notes = preceding.map(({ bbox, value, lines }) => lines
            ? { type: 'table_footnote', bbox, lines: lines.map(([lineBBox, content]) =>
                text('table_footnote', lineBBox, content).lines[0]) }
            : text('table_footnote', bbox, value));
        values.table.blocks = [
            { type: 'table_body', bbox: values.tableBox, lines: [{ bbox: values.tableBox, spans: [
                { type: 'table', bbox: values.tableBox, html: TABLE_HTML },
            ] }] },
            ...notes,
            text('table_footnote', titleBBox, title),
        ];
        if (interleavedCaption) values.table.blocks.splice(2, 0,
            text('table_caption', [100, 80, 900, 90], 'Table 4. Synthetic estimates.'));
        values.caption = 'Fig. 61. (a) Calibration measurements and (b) reference measurements share one protocol.';
        values.captionBBox = [100, 460, 900, 470];
        values.lowerPicture.blocks = [values.lowerPicture.blocks[0],
            text('chart_caption', values.captionBBox, values.caption)];
        values.body = { bbox: [100, 520, 900, 560],
            text: 'Independent observations below the figure retain their original reading position.' };
        values.blocks.splice(0, values.blocks.length, values.table, values.upperPicture, values.lowerPicture,
            text('text', values.body.bbox, values.body.text));
        values.upperItems = [pdfLine(title, titleBBox)];
        values.lowerItems = [];
        values.items.splice(0, values.items.length,
            ...preceding.flatMap(({ bbox, value, lines }) => lines
                ? lines.map(([lineBBox, content]) => pdfLine(content, lineBBox)) : [pdfLine(value, bbox)]),
            ...values.upperItems, pdfLine(values.caption, values.captionBBox),
            pdfLine(values.body.text, values.body.bbox),
            ...(interleavedCaption ? [pdfLine('Table 4. Synthetic estimates.', [100, 80, 900, 90])] : []));
    } });
}

function assertTableNotesSurviveCrop(values, { nativeTitle = values.title } = {}) {
    const original = originalIR(values);
    const [{ parent, child }] = childrenWithText(original, values.title);
    assert.equal(parent.kind, 'table');
    assert.equal(child.kind, 'footnote');
    assert.deepEqual(child.originalFootnote, { ownerId: parent.id, ownerKind: 'table' });
    const local = pdfTextItemsByPage(original, values.pdfText).get(0).filter(item => {
        const x = (item.bbox[0] + item.bbox[2]) / 2;
        return x >= values.titleBBox[0] - 6 && x <= values.titleBBox[2] + 6
            && item.centerY >= values.titleBBox[1] - 6 && item.centerY <= values.titleBBox[3] + 6;
    });
    assert.deepEqual(pdfLines(local).map(line => nativeLineText(line.items)), [nativeTitle],
        'the complete native note must be present at the proposed picture-title location');
    const sourceNotes = parent.children.filter(member => member.kind === 'footnote');
    const before = structuredClone(parent);
    const { ir, input, source } = assertRetained(values);
    assert.deepEqual(source, before, 'the entire original table and its longer footnote region must survive');
    const candidates = resolveFigureCandidates(input);
    assert.equal(candidates.length, 1, summary(candidates));
    const [candidate] = candidates;
    assert.equal(candidate.decision, 'compose', summary(candidates));
    assert.equal(candidate.panelBlockIds.length, 2);
    assert.equal(candidate.captionBlockIds.length, 1);
    for (const note of sourceNotes) {
        assert.ok(!candidate.ownedTextBlockIds.includes(note.id), 'a genuine source note must not be crop-owned');
        assert.ok(![...candidate.panelBlockIds, ...candidate.captionBlockIds].includes(note.id),
            'a genuine source note must not be a figure member');
        assert.ok(candidate.visualBBox[1] >= note.bbox[3], 'the figure crop must remain below the true note region');
    }
    const { draft, document } = compose(input, candidate);
    assert.deepEqual(draft.preserved, []);
    assert.equal(draft.blueprints.length, 1);
    assert.equal(collectFigureImageNodes(document.markdown).length, 1);
    assert.equal(document.markdown.split(values.caption).length - 1, 1);
    assert.ok(document.markdown.includes(TABLE_HTML));
    assertLocated(document, values.body.text, values.body.bbox);
    assert.equal(document.markdown.split(noteDirective('table')).length - 1, sourceNotes.length,
        'every original table footnote must remain a readable table note after the figure crop');
    for (const note of sourceNotes) {
        const content = note.fragments.map(fragment => fragmentText(fragment)).join(' ');
        assertLocated(document, content, note.bbox);
        assert.ok(!draft.blueprints[0].provenance.fragments.some(fragment => fragment.blockId === note.id),
            'figure provenance must not consume a genuine table footnote');
    }
    assertValidMap(document);
    const restored = structuredClone(ir.blocks);
    const moves = structuredClone(ir.captionMoves || []);
    restorePDFFigureCaptions(ir, values.pdfText);
    assert.deepEqual(ir.blocks, restored);
    assert.deepEqual(ir.captionMoves || [], moves);
}

for (const title of [
    'Note: All values are means.',
    'Abbreviations: CI, confidence interval.',
    'Values are means.',
    'Source: Independent measurements.',
    '* An independent estimate.',
    '† An independent estimate.',
    '^{a} An independent estimate.',
]) {
    test(`keeps an explicitly marked true table footnote outside a successful figure crop: ${title}`, () => {
        // The preceding note ends more than fourteen units above this one:
        // the prefix must protect it independently of note-chain continuity.
        assertTableNotesSurviveCrop(fixture({ style: 'characters', upperTitle: title }));
    });
}

test('keeps an inline-math superscript marker and its original table-note source map after cropping', () => {
    const content = 'An independent estimate.';
    const title = `^{a} ${content}`;
    const nativeTitle = `a ${content}`;
    const values = fixture({ upperTitle: title, change: values => {
        const bbox = values.titleBBox;
        const markerBBox = [bbox[0], bbox[1], bbox[0] + 5, bbox[3]];
        values.table.blocks.at(-1).lines[0].spans = [
            { type: 'inline_equation', bbox: markerBBox, content: '^{a}' },
            { type: 'text', bbox, content },
        ];
        const removed = new Set(values.upperItems);
        values.items.splice(0, values.items.length, ...values.items.filter(item => !removed.has(item)),
            pdfLine(nativeTitle, bbox));
        values.titleMarkdown = `$^{a}$ ${content}`;
    } });
    const [{ child }] = childrenWithText(originalIR(values), title);
    assert.equal(child.fragments[0].lines[0].spans[0].type, 'math');
    assert.equal(child.fragments[0].lines[0].spans[0].content, '^{a}');
    assertTableNotesSurviveCrop(values, { nativeTitle });
});

test('keeps the second raw Note footnote in the source table above a side-by-side shared-caption figure', () => {
    assertTableNotesSurviveCrop(sourceNoteChainFixture({ title: 'Note: All values are means.',
        titleBBox: [100, 230, 500, 240] }));
});

for (const [reason, options] of [
    ['the same left-aligned column', {
        preceding: [{ bbox: [100, 214, 500, 224], value: TABLE_NOTE }],
    }],
    ['a fourteen-unit vertical gap', {}],
    ['overlapping columns without the same left edge', {
        preceding: [{ bbox: [300, 214, 700, 224], value: TABLE_NOTE }],
    }],
    ['a twelve-unit left-edge offset', {
        preceding: [{ bbox: [112, 214, 512, 224], value: TABLE_NOTE }],
    }],
    ['an unmarked first footnote connected to the table body', {
        preceding: [
            { bbox: [100, 210, 500, 220], value: 'Independent estimates across repeated trials.' },
        ],
    }],
]) {
    test(`keeps an unprefixed title-like tail in its original footnote chain with ${reason}`, () => {
        assertTableNotesSurviveCrop(sourceNoteChainFixture(options));
    });
}

for (const noteOnRight of [false, true]) {
    test(`keeps a ${noteOnRight ? 'right' : 'left'}-column table-note continuation across interleaved notes in the other column`, () => {
        const x = noteOnRight ? 520 : 100;
        const otherX = noteOnRight ? 100 : 650;
        assertTableNotesSurviveCrop(sourceNoteChainFixture({
            preceding: [
                { bbox: [x, 210, x + 280, 220], value: TABLE_NOTE },
                { bbox: [otherX, 214, otherX + 200, 224], value: 'Separate estimates retain the original scale.' },
            ],
            titleBBox: [x, 234, x + 280, 244],
        }));
    });
}

for (const interleavedCaption of [false, true]) {
    test(`keeps the title-like final line of a longer multiline table-note chain${interleavedCaption ? ' across a non-footnote child' : ''}`, () => {
        assertTableNotesSurviveCrop(sourceNoteChainFixture({ tableBottom: 170, interleavedCaption,
            preceding: [
                { bbox: [100, 180, 500, 200], value: 'Measurements use independent samples. Intervals retain the original scale.',
                    lines: [
                        [[100, 180, 500, 187.5], 'Measurements use independent samples.'],
                        [[100, 192.5, 500, 200], 'Intervals retain the original scale.'],
                    ] },
                { bbox: [100, 210, 500, 220], value: TABLE_NOTE },
            ],
        }));
    });
}

function harness({ fail = false, limits } = {}) {
    const requests = [];
    let closed = 0;
    const render = request => {
        requests.push(request);
        if (fail) throw new Error('Synthetic vector-page crop failed');
        return { data: createTestPNG(432, 400), mimeType: 'image/png', width: 432, height: 400 };
    };
    const service = new FigureRestorationService({ hash, limits, openPDF: async () => ({
        getPageGeometry: async () => ({ pageIndex: 0, width: PAGE, height: PAGE,
            rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
            viewBox: [0, 0, PAGE, PAGE], viewportTransform: [1, 0, 0, -1, 0, PAGE] }),
        renderRegion: async request => render(request),
        renderPageCrops: async request => ({ crops: request.regions.map(region => ({
            id: region.id, crop: render(region),
        })) }),
        close: async () => { closed++; },
    }) });
    return { service, requests, closed: () => closed };
}

test('renders a vector figure with both complete titles without native bitmap containers', async () => {
    const values = fixture({ style: 'characters' });
    const { input } = assertMoved(values);
    const { service, requests, closed } = harness();
    const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
    assert.deepEqual(draft.preserved, []);
    assert.equal(draft.blueprints.length, 1);
    assert.equal(requests.length, 1);
    assertContains(requests[0].bbox, values.titleBBox);
    assertContains(requests[0].bbox, values.lowerTitleBBox);
    const document = prepareMinerUResult(draft.input);
    assert.equal(collectFigureImageNodes(document.markdown).length, 1);
    assert.equal(document.markdown.includes(values.title), false);
    assertIndependentContent(document, values);
    assert.equal(closed(), 1);
});

for (const mode of ['plan', 'failed crop', 'transaction budget']) {
    test(`keeps the migrated title readable at its original source box after ${mode}`, async () => {
        const values = fixture({ style: 'characters' });
        const { input, candidate, child } = assertMoved(values);
        const before = structuredClone(input);
        let output;
        if (mode === 'transaction budget') {
            const { draft } = compose(input, candidate, { limits: { maxMapBytes: 10 } });
            assert.deepEqual(draft.blueprints, []);
            assert.equal(draft.preserved.length, 1);
            assert.equal(draft.preserved[0].reason, 'resource-limit');
            output = draft.input;
        }
        else {
            const { service, requests, closed } = harness({ fail: mode === 'failed crop' });
            const draft = await service.restore(input, { fileData: Uint8Array.of(1),
                mode: mode === 'plan' ? 'plan' : 'render' });
            output = draft.input;
            if (mode === 'plan') {
                assert.equal(requests.length, 0, 'planning must not render a crop');
                assert.equal(draft.candidates.filter(value => value.decision === 'compose').length, 1);
            }
            else {
                assert.deepEqual(draft.blueprints, []);
                assert.ok(draft.preserved.some(value => value.reason === 'render-failed'));
                assert.ok(requests.length > 0);
            }
            assert.equal(closed(), 1);
        }
        assert.deepEqual(input, before, 'planning and failed rendering must not consume the input');
        const document = prepareMinerUResult(output);
        assert.equal(collectFigureImageNodes(document.markdown).length, 2);
        assertLocated(document, values.title, values.titleBBox);
        assertLocated(document, LOWER_TITLE, values.lowerTitleBBox);
        assertIndependentContent(document, values);
        const mapped = output.blocks.find(block => block.id === child.id);
        assert.deepEqual(mapped.bbox, values.titleBBox);
        assert.equal(output.markdown.slice(mapped.sourceRanges[0].from, mapped.sourceRanges[0].to), values.title);
    });
}

test('repeating native restoration preserves the moved child, source fragments and move history', () => {
    const values = fixture({ style: 'characters' });
    const { ir } = assertMoved(values);
    const blocks = structuredClone(ir.blocks);
    const moves = structuredClone(ir.captionMoves || []);
    const released = structuredClone(ir.releasedCaptions || []);
    restorePDFFigureCaptions(ir, values.pdfText);
    restorePDFFigureCaptions(ir, values.pdfText);
    assert.deepEqual(ir.blocks, blocks);
    assert.deepEqual(ir.captionMoves || [], moves);
    assert.deepEqual(ir.releasedCaptions || [], released);
});

for (const [reason, change] of [
    ['different native words', values => { values.upperItems[0].text = 'OTHER'; }],
    ['a missing native title', values => {
        const removed = new Set(values.upperItems);
        values.items.splice(0, values.items.length, ...values.items.filter(item => !removed.has(item)));
    }],
    ['a missing glyph in the native title', values => {
        values.items.splice(values.items.indexOf(values.upperItems[5]), 1);
    }],
    ['an extra native word inside the note box', values => {
        const original = values.upperItems[4];
        values.items.push({ ...original, text: 'EXTRA', transform: [...original.transform] });
    }],
    ['a repeated native glyph', values => {
        const original = values.upperItems[3];
        values.items.push({ ...original, transform: [...original.transform] });
    }],
]) {
    test(`retains a raw table note with ${reason}`, () => {
        assertRetained(fixture({ style: 'characters', change }));
    });
}

for (const title of [
    'Fig. 24. An independent measurement with its own legend.',
    'Table 6. Estimates for the independently sampled cohort.',
    'Figure 32',
    'The independent paragraph describes every measurement and explains the complete sampling procedure.',
]) {
    test(`keeps numbered captions or long prose in their original footnote: ${title}`, () => {
        assertRetained(fixture({ style: 'characters', upperTitle: title }));
    });
}

for (const [reason, changeIR] of [
    ['no original-footnote marker', (_ir, _source, child) => { delete child.originalFootnote; }],
    ['a conflicting original owner id', (_ir, _source, child) => { child.originalFootnote.ownerId = 'another-float'; }],
    ['a conflicting original owner kind', (_ir, _source, child) => { child.originalFootnote.ownerKind = 'image'; }],
]) {
    test(`does not migrate an otherwise matching note with ${reason}`, () => {
        assertRetained(fixture({ style: 'characters' }), changeIR);
    });
}

test('never moves an original float footnote classified as page chrome', () => {
    const values = fixture({ style: 'characters' });
    const ir = originalIR(values);
    const [{ parent, child }] = childrenWithText(ir, values.title);
    child.role = 'chrome';
    const before = structuredClone(parent);
    restorePDFFigureCaptions(ir, values.pdfText);
    assert.deepEqual(parent, before);
    assert.deepEqual(childrenWithText(ir, values.title), [{ parent, child }]);
    assert.equal(child.kind, 'footnote');
    assert.equal((ir.captionMoves || []).some(move => move.ids.includes(child.id)), false);
    const input = inputFromIR(ir, values);
    assert.ok(resolveFigureCandidates(input).every(candidate => !candidate.ownedTextBlockIds.includes(child.id)));
    const document = prepareMinerUResult(input);
    assert.equal(document.markdown.includes(values.title), false, 'page chrome remains excluded from reading text');
    assertLocated(document, TABLE_NOTE, values.tableNoteBox);
    assertValidMap(document);
});

for (const secondLine of [UPPER_TITLE, 'An additional condition remains independently printed.']) {
    test(`retains a note whose native region has a second baseline: ${secondLine}`, () => {
        const values = fixture({ style: 'characters', change: ({ items, titleBBox }) => {
            // Six units separate the baselines, beyond pdfLines' same-row
            // tolerance. The second line's center still lies within the
            // note's six-unit matching margin, so checking one line alone
            // must not certify the complete OCR note region.
            const bottom = titleBBox[3] + 6;
            items.push(pdfLine(secondLine, [titleBBox[0], bottom - 5, titleBBox[2], bottom], { size: 5 }));
        } });
        const ir = originalIR(values);
        const local = pdfTextItemsByPage(ir, values.pdfText).get(0).filter(item =>
            item.bbox[0] >= values.titleBBox[0] && item.bbox[2] <= values.titleBBox[2]
            && item.centerY >= values.titleBBox[1] - 6 && item.centerY <= values.titleBBox[3] + 6);
        assert.deepEqual(pdfLines(local).map(line => nativeLineText(line.items)), [values.title, secondLine],
            'the fixture must contain two distinct native lines within the note matching region');
        assertRetained(values);
    });
}

test('does not manufacture raw-footnote provenance when body text is attached to a table later', () => {
    const values = fixture({ upperTitle: 'Values are means in the validation panel.', style: 'characters',
        change: ({ table, blocks, title, titleBBox, tableBox }) => {
            table.blocks.pop();
            tableBox[3] = 220;
            blocks.push(text('text', titleBBox, title));
        } });
    const ir = originalIR(values);
    const body = ir.blocks.find(block => blockPlainText(block) === values.title);
    assert.equal(body.role, 'body');
    assert.equal(body.originalFootnote, undefined);
    attachFloatNotes(ir);
    const source = ir.blocks.find(block => block.id === body.attachedTo);
    assert.ok(source);
    assert.equal(source.kind, 'table');
    assert.equal(body.role, 'float-note');
    const before = structuredClone(body);
    restorePDFFigureCaptions(ir, values.pdfText);
    assert.deepEqual(body, before);
    assert.equal(childrenWithText(ir, values.title).length, 0);
    assert.equal((ir.captionMoves || []).some(move => move.ids.includes(body.id)), false);
    const document = prepareMinerUResult(inputFromIR(ir, values));
    assertLocated(document, values.title, values.titleBBox);
    assertValidMap(document);
});

test('keeps a genuine source-table footnote when its own table body also contains the note geometrically', () => {
    assertRetained(fixture({ change: ({ tableBox }) => { tableBox[3] = 226; } }));
});

test('does not choose between two potential picture owners for the same native title', () => {
    assertRetained(fixture({ change: ({ blocks, figureLeft }) => {
        blocks.push(picture('image', [figureLeft + 16, 210, figureLeft + 300, 228], 'independent.png'));
    } }));
});

test('does not migrate an annotation before a shared caption group passes independent-caption boundaries', () => {
    assertRetained(fixture({ change: ({ upperPicture, items, figureLeft }) => {
        const bbox = [figureLeft, 423, figureLeft + WIDTH, 430.5];
        const value = 'Fig. 29. An independent upper measurement.';
        upperPicture.blocks.push(text('image_caption', bbox, value));
        items.push(pdfLine(value, bbox));
    } }));
});

for (const conflict of ['body paragraph', 'foreign table footnote', 'another float caption', 'native text without layout']) {
    test(`rejects title migration when the newly exposed crop band contains ${conflict}`, () => {
        assertRetained(fixture({ change: ({ blocks, table, items, figureLeft }) => {
            const bbox = [figureLeft + 300, 230, figureLeft + WIDTH, 237.5];
            const value = conflict === 'another float caption' ? 'Table 9. Independent estimates.'
                : 'Independent content belongs outside this figure.';
            if (conflict === 'body paragraph') blocks.push(text('text', bbox, value));
            else if (conflict === 'foreign table footnote') table.blocks.push(text('table_footnote', bbox, value));
            else if (conflict === 'another float caption') {
                table.blocks.push(text('table_caption', bbox, value));
                items.push(pdfLine(value, bbox));
            }
            else items.push(pdfLine(value, bbox));
        } }));
    });
}

test('leaves all source children unchanged when native page matching exhausts its comparison budget', () => {
    const values = fixture({ change: ({ blocks }) => {
        for (let index = 0; index < 48; index++) {
            const x = 30 + index % 8 * 110;
            const y = 820 + Math.floor(index / 8) * 20;
            blocks.push(picture('image', [x, y, x + 70, y + 15], 'independent.png'));
        }
    } });
    const ir = originalIR(values);
    const before = structuredClone(ir.blocks);
    restorePDFFigureCaptions(ir, values.pdfText);
    assert.ok(ir.diagnostics.pdfCaptions.skipped > 0);
    assert.deepEqual(ir.blocks, before);
    assert.deepEqual(ir.captionMoves || [], []);
    const document = prepareMinerUResult(inputFromIR(ir, values));
    assertLocated(document, values.title, values.titleBBox);
    assertLocated(document, TABLE_NOTE, values.tableNoteBox);
    assertValidMap(document);
});
