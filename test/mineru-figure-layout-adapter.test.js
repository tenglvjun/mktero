import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { extractMinerUResultFromZip } from '../src/mineru/zip-markdown.js';
import { decodeMinerUFigureInput } from '../src/mineru/figure-layout-adapter.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';

function fixture(extra = {}) {
    const body = (bbox, path) => ({ type: 'image_body', bbox,
        lines: [{ spans: [{ type: 'image', bbox, image_path: path }] }] });
    const middle = { _backend: 'vlm', _version_name: '3.4.5', pdf_info: [{ page_idx: 0, page_size: [600, 800], para_blocks: [{
        type: 'image', bbox: [60, 80, 540, 752],
        blocks: [body([60, 80, 270, 640], 'a.png'), body([330, 80, 540, 640], 'b.png'),
            { type: 'image_caption', bbox: [60, 696, 540, 752],
                lines: [{ spans: [{ type: 'text', content: 'Figure 1. Two panels.' }] }] }],
    }, { type: 'title', bbox: [60, 760, 540, 790],
        lines: [{ spans: [{ type: 'text', content: 'Discussion' }] }] }] }] };
    return zipSync({
        'result/full.md': strToU8('![](images/a.png)\n\n![](images/b.png)\n\nFigure 1. Two panels.\n\n# Discussion'),
        'result/paper_content_list.json': strToU8(JSON.stringify([{
            type: 'image', img_path: 'images/a.png', image_caption: ['Figure 1. Two panels.'],
            page_idx: 0, bbox: [100, 100, 900, 940],
        }])),
        'result/paper_middle.json': strToU8(JSON.stringify(middle)),
        'result/images/a.png': createTestPNG(),
        'result/images/b.png': createTestPNG(),
        ...extra,
    });
}

test('reads all body spans with a separate caption instead of using the parent box', () => {
    const result = extractMinerUResultFromZip(fixture());
    assert.equal(result.detailedLayout.schema, 'mineru-middle-v1');
    const input = decodeMinerUFigureInput(result);
    const panels = input.blocks.filter(block => block.role === 'panel');
    assert.equal(panels.length, 2);
    assert.equal(panels[0].parentId, panels[1].parentId);
    assert.deepEqual(panels[0].bbox, [100, 100, 450, 800]);
    assert.deepEqual(input.blocks.find(block => block.role === 'caption').bbox, [100, 870, 900, 940]);
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].panelBlockIds.length, 2);
    assert.equal(candidates[0].captionBlockIds.length, 1);
});

test('ignores ambiguous, oversized or malformed optional detailed layouts', () => {
    const cases = [
        [fixture({ 'result/other_middle.json': strToU8('{}') }), {}],
        [fixture(), { maxDetailedLayoutBytes: 5 }],
        [fixture({ 'result/paper_middle.json': strToU8('{invalid') }), {}],
        [fixture({ 'result/paper_middle.json': strToU8('{"pdf_info":false}') }), {}],
    ];
    for (const [archive, options] of cases) {
        const result = extractMinerUResultFromZip(archive, options);
        assert.equal(result.detailedLayout, undefined);
        assert.ok(result.markdown.includes('Figure 1.'));
        assert.equal(result.assets.length, 2);
        assert.ok(decodeMinerUFigureInput(result).blocks.every(block => block.bboxKind !== 'visual-body'));
    }
});

test('does not select a detailed layout outside the Markdown result root', () => {
    const result = extractMinerUResultFromZip(fixture({ 'other/paper_middle.json': strToU8('{}') }));
    assert.equal(decodeMinerUFigureInput(result).blocks.filter(block => block.role === 'panel').length, 2);
});

test('reads the hosted API layout.json as the detailed layout', () => {
    const files = unzipSync(fixture());
    const middle = files['result/paper_middle.json'];
    delete files['result/paper_middle.json'];
    files['result/paper_layout.json'] = middle;
    const result = extractMinerUResultFromZip(zipSync(files));
    assert.equal(result.detailedLayout?.schema, 'mineru-middle-v1');
    const input = decodeMinerUFigureInput(result);
    assert.ok(input.pages.every(page => page.coordinateFrame === 'display-cropbox'));
    assert.equal(input.blocks.filter(block => block.role === 'panel').length, 2);
    assert.equal(input.blocks.filter(block => block.role === 'caption').length, 1);
});

test('ignores an archive that carries both layout.json and middle.json', () => {
    const files = unzipSync(fixture());
    files['result/paper_layout.json'] = files['result/paper_middle.json'];
    const result = extractMinerUResultFromZip(zipSync(files));
    assert.equal(result.detailedLayout, undefined);
});

test('preserves content when the middle layout backend or version is not supported', () => {
    const base = JSON.parse(strFromU8(unzipSync(fixture())['result/paper_middle.json']));
    for (const identity of [
        { _backend: 'pipeline', _version_name: '3.4.5' },
        { _backend: 'vlm', _version_name: '999.0.0' },
    ]) {
        const archive = fixture({
            'result/paper_middle.json': strToU8(JSON.stringify({ ...base, ...identity })),
        });
        const input = decodeMinerUFigureInput(extractMinerUResultFromZip(archive));
        assert.ok(input.pages.every(page => page.coordinateFrame === 'unknown'));
        assert.ok(input.blocks.some(block => block.role === 'panel'));
    }
});

test('accepts the hosted hybrid layout identity', () => {
    const base = JSON.parse(strFromU8(unzipSync(fixture())['result/paper_middle.json']));
    for (const identity of [
        { _backend: 'vlm', _version_name: '3.4.5' },
        { _backend: 'hybrid', _version_name: '3.4.4' },
    ]) {
        const archive = fixture({
            'result/paper_middle.json': strToU8(JSON.stringify({ ...base, ...identity })),
        });
        const input = decodeMinerUFigureInput(extractMinerUResultFromZip(archive));
        assert.ok(input.pages.every(page => page.coordinateFrame === 'display-cropbox'),
            JSON.stringify(identity));
    }
});

test('composes a hosted hybrid figure whose caption is a sibling block', () => {
    const middle = {
        _backend: 'hybrid', _version_name: '3.4.4',
        pdf_info: [{
            page_idx: 0, page_size: [600, 800],
            para_blocks: [
                { type: 'text', bbox: [60, 190, 540, 215], lines: [{ spans: [{
                    type: 'text', content: 'Figure 1. Study flowchart.', bbox: [60, 190, 540, 215],
                }] }] },
                { type: 'image', bbox: [60, 220, 540, 700], blocks: [
                    { type: 'image_body', bbox: [60, 220, 540, 700], lines: [{ spans: [{
                        type: 'image', bbox: [60, 220, 540, 700], image_path: 'images/figure.png',
                    }] }] }] },
                { type: 'text', bbox: [300, 300, 530, 330], lines: [{ spans: [{
                    type: 'text', content: '68 women assessed for eligibility', bbox: [300, 300, 530, 330],
                }] }] },
            ],
        }],
    };
    const markdown = [
        'Figure 1. Study flowchart.',
        '',
        '68 women assessed for eligibility',
        '',
        '![](images/figure.png)',
    ].join('\n');
    const archive = zipSync({
        'full.md': strToU8(markdown),
        'layout.json': strToU8(JSON.stringify(middle)),
        'images/figure.png': createTestPNG(),
    });
    const input = decodeMinerUFigureInput(extractMinerUResultFromZip(archive));
    assert.ok(input.pages.every(page => page.coordinateFrame === 'display-cropbox'));
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].captionBlockIds.length, 1);
    assert.deepEqual(candidates[0].ownedTextBlockIds, ['mineru:p0:b3']);
});

test('merges adjacent hosted chart blocks into one captioned figure', () => {
    const chart = (bbox, imagePath, extra = []) => ({
        type: 'chart', bbox, blocks: [
            ...extra,
            { type: 'chart_body', bbox, lines: [{ spans: [{
                type: 'chart', bbox, image_path: imagePath,
            }] }] },
        ],
    });
    const caption = (bbox, content) => ({ type: 'chart_caption', bbox, lines: [{ spans: [{
        type: 'text', content, bbox,
    }] }] });
    const middle = {
        _backend: 'hybrid', _version_name: '3.4.4',
        pdf_info: [{
            page_idx: 0, page_size: [600, 800],
            para_blocks: [
                chart([60, 100, 220, 200], 'images/a.png', [
                    caption([40, 70, 560, 90], 'Figure 1. Three panels.'),
                ]),
                chart([230, 100, 390, 200], 'images/b.png'),
                chart([400, 100, 560, 200], 'images/c.png', [
                    caption([400, 210, 560, 240], 'Following body paragraph.'),
                ]),
            ],
        }],
    };
    const markdown = [
        'Figure 1. Three panels.  ',
        '![](images/a.png)',
        '',
        '![](images/b.png)',
        '',
        '![](images/c.png)  ',
        'Following body paragraph.',
    ].join('\n');
    const archive = zipSync({
        'full.md': strToU8(markdown),
        'layout.json': strToU8(JSON.stringify(middle)),
        'images/a.png': createTestPNG(),
        'images/b.png': createTestPNG(),
        'images/c.png': createTestPNG(),
    });
    const input = decodeMinerUFigureInput(extractMinerUResultFromZip(archive));
    assert.match(input.markdown, /Figure 1\. Three panels\.\s*\n\n!\[\]\(images\/a\.png\)/);
    assert.match(input.markdown, /!\[\]\(images\/c\.png\)\s*\n\nFollowing body paragraph\./);
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].panelBlockIds.length, 3);
    assert.equal(candidates[0].captionBlockIds.length, 1);
    assert.equal(candidates[0].label, 'Figure 1.');
});

test('leaves image lines without a matching asset untouched', () => {
    const markdown = 'Prose ![](images/other.png) continues.  \n![](images/missing.png)';
    const input = decodeMinerUFigureInput({
        provider: 'mineru', markdown,
        assets: [{ path: 'images/known.png', mimeType: 'image/png', data: createTestPNG() }],
        contentList: [],
    });
    assert.equal(input.markdown, markdown);
});

test('merges a 2x2 hosted chart grid with panel labels into one figure', () => {
    const chart = (bbox, imagePath, label) => {
        const labelBox = [bbox[0] + 10, bbox[1] - 20, bbox[0] + 30, bbox[1] - 8];
        return {
            type: 'chart', bbox, blocks: [
                { type: 'chart_caption', bbox: labelBox, lines: [{ spans: [{
                    type: 'text', content: label, bbox: labelBox,
                }] }] },
                { type: 'chart_body', bbox, lines: [{ spans: [{
                    type: 'chart', bbox, image_path: imagePath,
                }] }] },
            ],
        };
    };
    const captionBox = [60, 490, 540, 540];
    const last = chart([320, 300, 540, 480], 'images/d.png', 'D');
    last.blocks.push({ type: 'chart_caption', bbox: captionBox, lines: [{ spans: [{
        type: 'text', content: 'Fig. 1 Four panels.', bbox: captionBox,
    }] }] });
    const middle = {
        _backend: 'hybrid', _version_name: '3.4.4',
        pdf_info: [{
            page_idx: 0, page_size: [600, 800],
            para_blocks: [
                chart([60, 60, 280, 240], 'images/a.png', 'A'),
                chart([320, 60, 540, 240], 'images/b.png', 'B'),
                chart([60, 300, 280, 480], 'images/c.png', 'C'),
                last,
            ],
        }],
    };
    const markdown = [
        'A  ', '![](images/a.png)', '',
        'B  ', '![](images/b.png)', '',
        'C  ', '![](images/c.png)', '',
        'D  ', '![](images/d.png)  ',
        'Fig. 1 Four panels.',
    ].join('\n');
    const archive = zipSync({
        'full.md': strToU8(markdown),
        'layout.json': strToU8(JSON.stringify(middle)),
        'images/a.png': createTestPNG(),
        'images/b.png': createTestPNG(),
        'images/c.png': createTestPNG(),
        'images/d.png': createTestPNG(),
    });
    const input = decodeMinerUFigureInput(extractMinerUResultFromZip(archive));
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].panelBlockIds.length, 4);
    assert.equal(candidates[0].captionBlockIds.length, 1);
    assert.deepEqual(candidates[0].ownedTextBlockIds,
        ['mineru:p0:b1', 'mineru:p0:b4', 'mineru:p0:b7', 'mineru:p0:b10']);
});

test('composes a two-column hosted figure with footnotes and an unpunctuated caption', () => {
    const middle = {
        _backend: 'hybrid', _version_name: '3.4.4',
        pdf_info: [{
            page_idx: 0, page_size: [600, 800],
            para_blocks: [
                { type: 'image', bbox: [60, 300, 290, 500], blocks: [
                    { type: 'image_body', bbox: [60, 300, 290, 500], lines: [{ spans: [{
                        type: 'image', bbox: [60, 300, 290, 500], image_path: 'images/a.jpg',
                    }] }] },
                    { type: 'image_footnote', bbox: [65, 498, 285, 506], lines: [{ spans: [{
                        type: 'text', content: '(a) Left panel.', bbox: [65, 498, 285, 506],
                    }] }] },
                ] },
                { type: 'chart', bbox: [310, 300, 540, 498], blocks: [
                    { type: 'chart_body', bbox: [310, 300, 540, 498], lines: [{ spans: [{
                        type: 'chart', bbox: [310, 300, 540, 498], image_path: 'images/b.jpg',
                    }] }] },
                    { type: 'chart_footnote', bbox: [315, 497, 535, 505], lines: [{ spans: [{
                        type: 'text', content: '(b) Right panel.', bbox: [315, 497, 535, 505],
                    }] }] },
                ] },
                { type: 'text', bbox: [50, 520, 550, 560], lines: [{ spans: [{
                    type: 'text', content: 'Figure 1 The impact of reusable skills. (a) Left; (b) Right.',
                    bbox: [50, 520, 550, 560],
                }] }] },
            ],
        }],
    };
    const markdown = [
        '![](images/a.jpg)  ',
        '(a) Left panel.',
        '',
        '![](images/b.jpg)  ',
        '(b) Right panel.',
        '',
        'Figure 1 The impact of reusable skills. (a) Left; (b) Right.',
    ].join('\n');
    const archive = zipSync({
        'full.md': strToU8(markdown),
        'layout.json': strToU8(JSON.stringify(middle)),
        'images/a.jpg': createTestPNG(),
        'images/b.jpg': createTestPNG(),
    });
    const input = decodeMinerUFigureInput(extractMinerUResultFromZip(archive));
    const bound = bindFigureSourceRanges(input);
    const candidates = resolveFigureCandidates(bound);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.deepEqual(candidates[0].panelBlockIds, ['mineru:p0:b1', 'mineru:p0:b4']);
    assert.deepEqual(candidates[0].ownedTextBlockIds, ['mineru:p0:b2', 'mineru:p0:b5']);
    assert.deepEqual(candidates[0].captionBlockIds, ['mineru:p0:b6']);
    const draft = composeFigureDraft(bound, candidates.map(candidate => ({
        candidate,
        crop: { data: createTestPNG(400, 350), mimeType: 'image/png', width: 400, height: 350 },
        assetPath: `generated/figures/${candidate.id}.png`,
    })));
    assert.deepEqual(draft.blueprints.map(blueprint => blueprint.id), [candidates[0].id]);
    assert.equal(draft.blueprints[0].renderCaption,
        'Figure 1 The impact of reusable skills. (a) Left; (b) Right.');
});

test('keeps validated page geometry when another detailed page is malformed', () => {
    const base = JSON.parse(strFromU8(unzipSync(fixture())['result/paper_middle.json']));
    const malformed = {
        ...base,
        pdf_info: [
            base.pdf_info[0],
            {
                page_idx: 1, page_size: [600, 800],
                para_blocks: [{ type: 'image', bbox: [60, 80, 540, 752], blocks: [] }],
            },
        ],
    };
    const archive = fixture({
        'result/paper_middle.json': strToU8(JSON.stringify(malformed)),
    });
    const input = decodeMinerUFigureInput(extractMinerUResultFromZip(archive));
    const page = input.pages.find(candidate => candidate.pageIndex === 0);
    assert.equal(page.coordinateFrame, 'display-cropbox');
    assert.ok(input.blocks.some(block => block.pageIndex === 0
        && block.bboxKind === 'visual-body'));
});
