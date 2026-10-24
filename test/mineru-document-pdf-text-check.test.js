import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTextAgainstPDF, compareWords } from '../src/mineru/document/pdf-text-check.js';
import { DOCUMENT_IR_SCHEMA, fragmentText } from '../src/mineru/document/ir.js';

// A PDF.js text item on a 1000 x 1000 page, placed by its top edge.
function item(text, x, top, width, { size = 10, font = 'Body' } = {}) {
    return { text, width, height: size, fontName: font, direction: 'ltr', transform: [size, 0, 0, size, x, 1000 - top - size] };
}

let counter = 0;
// A MinerU block of lines at `top`, 15 units apart, and the PDF items that
// print them (one item per line unless `printed` says otherwise).
function block(lines, top, { kind = 'text', printed = lines, font = 'Body', spans } = {}) {
    const bottom = top + 15 * lines.length;
    const bbox = [100, top, 900, bottom];
    const fragment = {
        pageIndex: 0,
        bbox,
        lines: spans
            ? [{ bbox, spans }]
            : lines.map((line, index) => ({ bbox: [100, top + 15 * index, 900, top + 15 * index + 12], spans: [{ type: 'text', content: line }] })),
    };
    // A printed line is a string, a styled segment, or segments side by side.
    const items = printed.flatMap((line, index) => {
        const segments = [].concat(line).map(segment => (typeof segment === 'string' ? { text: segment } : segment));
        let x = 100;
        return segments.map(segment => {
            const width = segment.width || 7 * segment.text.length;
            const placed = item(segment.text, x, top + 2 + 15 * index + (segment.raise || 0), width,
                { font: segment.font || font, size: segment.size || 10 });
            x += width + (segment.gap ?? 5);
            return placed;
        });
    });
    return { block: { id: `t${counter++}`, kind, pageIndex: 0, bbox, fragments: [fragment], children: [], mergedFrom: [], absorbed: [] }, items };
}

const VOCABULARY = ['signal', 'model', 'cohort', 'measure', 'outcome', 'sample', 'protocol', 'response', 'baseline', 'variance',
    'estimate', 'trial', 'group', 'factor', 'pattern', 'record', 'window', 'feature', 'method', 'result',
    'subject', 'session', 'channel', 'reading', 'interval', 'average', 'profile', 'segment', 'marker', 'device',
    'season', 'period', 'context', 'region', 'volume', 'number', 'series', 'matrix', 'vector', 'domain'];
function fillerLine(index) {
    return Array.from({ length: 5 }, (_, offset) => VOCABULARY[(index * 7 + offset * 3) % VOCABULARY.length]).join(' ');
}

// Typeset body text the PDF prints exactly as MinerU read it: enough words
// for the text layer to be judged.
function document(extra, { filler = 150, misread = 0 } = {}) {
    const parts = [...extra];
    let top = 400;
    for (let index = 0; index < filler; index++) {
        const lines = [fillerLine(2 * index), fillerLine(2 * index + 1)];
        const printed = index < misread ? [lines[0].replace(/^(\w+) (\w+)/u, '$1 wrongword'), lines[1]] : lines;
        parts.push(block(lines, top, { printed }));
        top += 15;
        if (top > 960) top = 400;
    }
    // Filler fragments share a band of the page; each sits on its own page.
    const pages = [{ pageIndex: 0, width: 1000, height: 1000 }];
    const pdfPages = [{ pageIndex: 0, viewport: { transform: [1, 0, 0, -1, 0, 1000], width: 1000, height: 1000 }, items: [] }];
    const blocks = [];
    parts.forEach((part, index) => {
        const pageIndex = index < extra.length ? 0 : index - extra.length + 1;
        if (pageIndex > 0) {
            pages.push({ pageIndex, width: 1000, height: 1000 });
            pdfPages.push({ pageIndex, viewport: { transform: [1, 0, 0, -1, 0, 1000], width: 1000, height: 1000 }, items: [] });
        }
        part.block.pageIndex = pageIndex;
        for (const fragment of part.block.fragments) fragment.pageIndex = pageIndex;
        pdfPages[pageIndex].items.push(...part.items);
        blocks.push(part.block);
    });
    return {
        ir: { schema: DOCUMENT_IR_SCHEMA, pages, blocks, diagnostics: {} },
        pdfText: { pages: pdfPages },
    };
}

const text = block => block.fragments.map(fragment => fragmentText(fragment)).join(' | ');

test('restores a word MinerU wrote differently from a typeset PDF', () => {
    const target = block([
        'We are grateful to T. Andersson and I. Warofsky for their help with',
        'the cohort, and we optimize the protocol for (Warofsky) each site.',
    ], 100, { printed: [
        'We are grateful to T. Andersson and I. Warsofsky for their help with',
        'the cohort, and we optimize the protocol for (Warsofsky) each site.',
    ] });
    const { ir, pdfText } = document([target]);
    checkTextAgainstPDF(ir, pdfText);
    assert.equal(text(target.block), 'We are grateful to T. Andersson and I. Warsofsky for their help with '
        + 'the cohort, and we optimize the protocol for (Warsofsky) each site.');
    assert.deepEqual(ir.diagnostics.pdfText, {
        trusted: true, fragments: 151, words: 1524, disagreements: 2, ocrSignatures: 0, replaced: 2, duplicateHeadings: 0,
    });
});

test('leaves the text alone when the text layer looks scanned or disagrees often', () => {
    const scanned = block([
        'The pNN50 count and the cohort were recorded over the first two weeks of',
        'the trial, and as we optimize the protocol each site keeps its own schedule.',
    ], 100, { printed: [
        'The pNNSO count and the cohort were recorded over the first two weeks of',
        'the trial, and as we optimizes the protocol each site keeps its own schedule.',
    ] });
    const first = document([scanned]);
    checkTextAgainstPDF(first.ir, first.pdfText);
    assert.match(text(scanned.block), /^The pNN50 count .* we optimize the protocol/u);
    assert.equal(first.ir.diagnostics.pdfText.trusted, false);
    assert.equal(first.ir.diagnostics.pdfText.ocrSignatures, 1);

    const typo = block(['The count and the cohort were recorded as we optimize the protocol here.'], 100,
        { printed: ['The count and the cohort were recorded as we optimizes the protocol here.'] });
    const second = document([typo], { misread: 2 });
    assert.equal(second.ir.blocks.length, 151);
    checkTextAgainstPDF(second.ir, second.pdfText);
    assert.equal(second.ir.diagnostics.pdfText.trusted, false);
    assert.match(text(typo.block), /we optimize the/u);

    const short = block(['The count and the cohort were recorded as we optimize the protocol here.'], 100,
        { printed: ['The count and the cohort were recorded as we optimizes the protocol here.'] });
    const third = document([short], { filler: 10 });
    checkTextAgainstPDF(third.ir, third.pdfText);
    assert.equal(third.ir.diagnostics.pdfText.trusted, false);

    const none = document([block(['Plain words only, in a short fragment of text here today.'], 100)]);
    checkTextAgainstPDF(none.ir, null);
    assert.deepEqual(none.ir.diagnostics.pdfText, {
        trusted: false, fragments: 0, words: 0, disagreements: 0, ocrSignatures: 0, replaced: 0, duplicateHeadings: 0,
    });
});

test('keeps formulas and changes several words of one span', () => {
    const target = block([], 100, {
        spans: [
            { type: 'text', content: 'In this study the modulation of the signal at a fixed rate' },
            { type: 'math', content: '\\alpha' },
            { type: 'text', content: 'shows how a patient would respond over the day to the modulation of light in the ward, '
                + 'where the nurses kept the curtains open in the morning and closed them again after the evening round.' },
        ],
        printed: [
            'In this study the modulaton of the signal at a fixed rate α shows how a patien',
            'would respond over the day to the modulaton of light in the ward, where the nurses',
            'kept the curtains open in the morning and closed them again after the evening round.',
        ],
    });
    target.block.fragments[0].bbox = [100, 100, 900, 145];
    const { ir, pdfText } = document([target], { filler: 300 });
    checkTextAgainstPDF(ir, pdfText);
    assert.equal(text(target.block), 'In this study the modulaton of the signal at a fixed rate $\\alpha$ shows how a patien '
        + 'would respond over the day to the modulaton of light in the ward, where the nurses kept the curtains open '
        + 'in the morning and closed them again after the evening round.');
    assert.equal(ir.diagnostics.pdfText.replaced, 3);
});

test('judges single word differences', () => {
    const cases = [
        ['Warofsky,', 'Warsofsky,', 'replace'],
        ['hold', 'holds', 'replace'],
        ['co-occurring', 'co-occuring', 'replace'],
        ['patient’s', 'patien’s', 'replace'],
        ['Warofsky', 'WARSOFSKY', 'differ'],
        ['specific', 'specifc', 'differ'],
        ['effect', 'efect', 'differ'],
        ['There', 'Tere', 'differ'],
        ['x'.repeat(70), `${'x'.repeat(69)}y`, 'differ'],
        ['aggregate', 'aggregrate', 'replace'],
        ['Spreadsheet', 'SpreadSheet', 'differ'],
        ['München', 'Munchen', 'differ'],
        ['Évry,', 'Evry,', 'differ'],
        ['BRAIN', 'RAIN', 'differ'],
        ['the', 'tho', 'differ'],
        ['comparison', 'comparation', 'differ'],
        ['specific', 'specic', 'differ'],
        ['procedure', 'pro-cedure', 'differ'],
        ['receive,', 'receives.', 'differ'],
        ['alpha', 'αlpha', 'differ'],
        ['50', 'SO', 'ocr'],
        ['15', 'IS', 'ocr'],
        ['pNN50', 'pNNSO', 'ocr'],
        ['electrocardiography,', 'electrocardiograph^,', 'ocr'],
        ['cell', 'ce.l', 'ocr'],
    ];
    for (const [ours, theirs, verdict] of cases) assert.equal(compareWords(ours, theirs), verdict, `${ours} → ${theirs}`);
});

test('removes a run-in heading MinerU also wrote as a title, with its number as printed', () => {
    const heading = block(['5.2.2. Promoting circadian health through restricted eating: As noted'], 100, { kind: 'title', printed: [] });
    const paragraph = block([
        '3.2.2. Promoting circadian health through restricted eating. As noted above,',
        'the elderly may be less sensitive to light as a cue for the clock.',
    ], 112, { printed: [
        [{ text: '5.2.2. Promoting circadian health through restricted eating:', font: 'Bold' }, 'As noted above,'],
        'the elderly may be less sensitive to light as a cue for the clock.',
    ] });
    const { ir, pdfText } = document([heading, paragraph]);
    checkTextAgainstPDF(ir, pdfText);
    assert.equal(ir.blocks.includes(heading.block), false);
    assert.equal(text(paragraph.block), '5.2.2. Promoting circadian health through restricted eating: As noted above, '
        + 'the elderly may be less sensitive to light as a cue for the clock.');
    assert.equal(ir.diagnostics.pdfText.duplicateHeadings, 1);
});

test('keeps a label set in its own type and drops its copy from the paragraph', () => {
    const label = block(['CITATION'], 100, { kind: 'title', printed: [{ text: 'CITATION', font: 'Bold' }] });
    const value = block([
        'CITATION Liu L (2026) Effects of music listening habits on wellbeing in adults.',
    ], 116, { printed: ['Liu L (2026) Effects of music listening habits on wellbeing in adults.'] });
    const { ir, pdfText } = document([label, value]);
    checkTextAgainstPDF(ir, pdfText);
    assert.equal(ir.blocks.includes(label.block), true);
    assert.equal(text(value.block), 'Liu L (2026) Effects of music listening habits on wellbeing in adults.');
});

test('keeps a heading the paragraph below repeats in print', () => {
    const heading = block(['Participants'], 100, { kind: 'title', printed: [{ text: 'Participants', font: 'Bold' }] });
    const paragraph = block(['Participants were recruited from the cohort of the trial for this study.'], 116);
    const { ir, pdfText } = document([heading, paragraph]);
    checkTextAgainstPDF(ir, pdfText);
    assert.equal(ir.blocks.includes(heading.block), true);
    assert.equal(text(paragraph.block), 'Participants were recruited from the cohort of the trial for this study.');
    assert.equal(ir.diagnostics.pdfText.duplicateHeadings, 0);
});

test('gives a run-in heading the number the paragraph lacks', () => {
    const heading = block(['2.3 Sampling of the cohort'], 100, { kind: 'title', printed: [] });
    const paragraph = block([
        'Sampling of the cohort We drew the cohort from four sites over the first',
        'two years of the trial and kept the protocol fixed at each of the sites.',
    ], 112, { printed: [
        [{ text: '2.3 Sampling of the cohort', font: 'Bold' }, 'We drew the cohort from four sites over the first'],
        'two years of the trial and kept the protocol fixed at each of the sites.',
    ] });
    const { ir, pdfText } = document([heading, paragraph]);
    checkTextAgainstPDF(ir, pdfText);
    assert.equal(ir.blocks.includes(heading.block), false);
    assert.match(text(paragraph.block), /^2\.3 Sampling of the cohort We drew the cohort/u);
});

test('keeps the title when a run-in heading cannot be repaired to its print', () => {
    const heading = block(['3.1 Sampling of the cohort'], 100, { kind: 'title', printed: [] });
    const paragraph = block([
        '3.1 Sampling of the cohort We drew the cohort from four sites over the first',
        'two years of the trial and kept the protocol fixed at each of the sites.',
    ], 112, { printed: [
        [{ text: '2.3 Sampling of the cohort', font: 'Bold' }, 'We drew the cohort from four sites over the first'],
        'two years of the trial and kept the protocol fixed at each of the sites.',
    ] });
    const { ir, pdfText } = document([heading, paragraph]);
    checkTextAgainstPDF(ir, pdfText);
    assert.equal(ir.blocks.includes(heading.block), true);
    assert.match(text(paragraph.block), /^3\.1 Sampling of the cohort We drew/u);
    assert.equal(ir.diagnostics.pdfText.duplicateHeadings, 0);
});

test('a heading on its own line in the body font, only larger, is not run in', () => {
    const heading = block(['Study participants'], 100, { kind: 'title', printed: [{ text: 'Study participants', size: 12 }] });
    const paragraph = block([
        'Study participants were drawn from the cohort of the trial at four sites over two years.',
    ], 118, { printed: ['were drawn from the cohort of the trial at four sites over two years.'] });
    const { ir, pdfText } = document([heading, paragraph]);
    checkTextAgainstPDF(ir, pdfText);
    assert.equal(ir.blocks.includes(heading.block), true);
    assert.equal(text(paragraph.block), 'were drawn from the cohort of the trial at four sites over two years.');
});

test('leaves headings the text layer does not print, or that are all of the paragraph', () => {
    const heading = block(['Participants'], 100, { kind: 'title', printed: [] });
    const paragraph = block(['Participants were recruited from the cohort of the trial for this study.'], 125);
    const missing = document([heading, paragraph]);
    checkTextAgainstPDF(missing.ir, missing.pdfText);
    assert.equal(missing.ir.blocks.includes(heading.block), true);
    assert.equal(text(paragraph.block), 'Participants were recruited from the cohort of the trial for this study.');

    const label = block(['Sampling of the cohort'], 100, { kind: 'title', printed: [{ text: 'Sampling of the cohort', font: 'Bold' }] });
    const copy = block(['Sampling of the cohort'], 116, { printed: [] });
    const whole = document([label, copy]);
    checkTextAgainstPDF(whole.ir, whole.pdfText);
    assert.equal(text(copy.block), 'Sampling of the cohort');
    assert.equal(copy.block.fragments[0].lines.length, 1);
});

test('a superscript letter printed after a word is not part of it', () => {
    const authors = block(['Jane Smith, Ann Author and Bob Builder wrote this paper for the cohort of the trial.'], 100, {
        printed: [[
            { text: 'Jane Smith', width: 70, gap: 0 },
            { text: 'a', size: 6, raise: -3, width: 4, gap: 2 },
            { text: ', Ann Author and Bob Builder wrote this paper for the cohort of the trial.', width: 500 },
        ]],
    });
    const { ir, pdfText } = document([authors]);
    checkTextAgainstPDF(ir, pdfText);
    assert.match(text(authors.block), /^Jane Smith, Ann/u);
    assert.equal(ir.diagnostics.pdfText.ocrSignatures, 0);
});

test('replaces words after a heading copy is stripped from the same span', () => {
    const label = block(['Sampling design'], 100, { kind: 'title', printed: [{ text: 'Sampling design', font: 'Bold' }] });
    const rest = 'for their help with the cohort of the trial, and the nurses of the four sites who kept the '
        + 'protocol fixed over the first two years of the study.';
    const paragraph = block([`Sampling design We thank Warofsky and the Warofsky team ${rest}`], 116,
        { printed: [`We thank Warsofsky and the Warsofsky team ${rest}`] });
    const { ir, pdfText } = document([label, paragraph], { filler: 300 });
    checkTextAgainstPDF(ir, pdfText);
    assert.equal(text(paragraph.block), `We thank Warsofsky and the Warsofsky team ${rest}`);
    assert.equal(ir.diagnostics.pdfText.duplicateHeadings, 1);
});
