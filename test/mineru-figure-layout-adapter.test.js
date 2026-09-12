import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { extractMinerUResultFromZip } from '../src/mineru/zip-markdown.js';
import { decodeMinerUFigureInput } from '../src/mineru/figure-layout-adapter.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';

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
    assert.equal(candidates[0].decision, 'preserve');
    assert.equal(candidates[0].reason, 'ambiguous-source-range');
    assert.equal(candidates[0].panelBlockIds.length, 2);
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
