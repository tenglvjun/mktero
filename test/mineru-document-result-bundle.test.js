import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { extractMinerUResultFromZip } from '../src/mineru/zip-markdown.js';
import {
    MINERU_LAYOUT_SCHEMA,
    projectMinerULayout,
    validateMinerULayout,
} from '../src/mineru/document/result-bundle.js';

function line(bbox, content, extra = {}) {
    return { bbox, spans: [{ bbox, type: 'text', content, ...extra }] };
}

function layoutFixture() {
    return {
        _backend: 'hybrid',
        _version_name: '3.4.4',
        _effort: 'medium',
        _ocr_enable: true,
        pdf_info: [
            {
                page_idx: 0,
                page_size: [612, 792],
                preproc_blocks: [{ type: 'text', bbox: [0, 0, 1, 1] }],
                para_blocks: [
                    { type: 'title', bbox: [50, 50, 560, 80], index: 1, level: 1, angle: 0,
                        lines: [line([50, 50, 560, 80], 'A Paper')] },
                    { type: 'text', bbox: [50, 700, 300, 760], index: 2, merge_prev: false,
                        lines: [
                            line([50, 700, 300, 760], 'The first half'),
                            line([50, 60, 300, 100], 'continues here', { cross_page: true }),
                        ] },
                    { type: 'code', sub_type: 'code', guess_lang: 'python', bbox: [50, 300, 560, 400],
                        blocks: [{ type: 'code_body', bbox: [50, 300, 560, 400],
                            lines: [line([50, 300, 560, 400], 'print(1)')] }] },
                ],
                discarded_blocks: [
                    { type: 'header', bbox: [50, 10, 560, 30], index: 0,
                        lines: [line([50, 10, 560, 30], 'Journal of Tests')] },
                    { type: 'page_footnote', bbox: [50, 770, 560, 790], index: 5,
                        lines: [line([50, 770, 560, 790], '1 A footnote.')] },
                ],
            },
            {
                page_idx: 1,
                page_size: [612, 792],
                para_blocks: [
                    { type: 'text', bbox: [50, 60, 300, 100], index: 0, lines_deleted: true, lines: [] },
                    { type: 'table', bbox: [50, 200, 560, 400], index: 1, blocks: [
                        { type: 'table_caption', bbox: [50, 180, 560, 198],
                            lines: [line([50, 180, 560, 198], 'TABLE I')] },
                        { type: 'table_body', bbox: [50, 200, 560, 400], lines: [{ bbox: [50, 200, 560, 400],
                            spans: [{ type: 'table', bbox: [50, 200, 560, 400],
                                html: '<table><tr><td>1</td></tr></table>', image_path: 't.jpg' }] }] },
                    ] },
                ],
                discarded_blocks: [],
            },
        ],
    };
}

test('projects every field the document pipeline reads', () => {
    const layout = projectMinerULayout(layoutFixture());
    assert.equal(layout.schema, MINERU_LAYOUT_SCHEMA);
    assert.deepEqual([layout.backend, layout.version, layout.effort, layout.ocrEnabled],
        ['hybrid', '3.4.4', 'medium', true]);
    assert.equal(layout.pages.length, 2);
    const [title, text, code] = layout.pages[0].blocks;
    assert.deepEqual([title.index, title.level, title.angle], [1, 1, 0]);
    assert.equal(text.lines[1].spans[0].crossPage, true);
    assert.equal(text.mergePrev, undefined);
    assert.deepEqual([code.subType, code.guessLang], ['code', 'python']);
    assert.deepEqual(layout.pages[0].discarded.map(block => block.type), ['header', 'page_footnote']);
    assert.equal(layout.pages[1].blocks[0].linesDeleted, true);
    const tableSpan = layout.pages[1].blocks[1].blocks[1].lines[0].spans[0];
    assert.equal(tableSpan.html, '<table><tr><td>1</td></tr></table>');
    assert.equal(tableSpan.imagePath, 't.jpg');
    assert.equal('preproc' in layout.pages[0], false);
    assert.deepEqual(layout.diagnostics, { droppedPages: 0, droppedFields: 0, truncatedStrings: 0 });
    assert.equal(validateMinerULayout(layout), true);
});

test('drops invalid fields and pages without rejecting the layout', () => {
    const raw = layoutFixture();
    raw.pdf_info[0].para_blocks[0].bbox = [0, Number.NaN, 1, 1];
    raw.pdf_info[0].para_blocks[0].index = -1;
    raw.pdf_info[0].para_blocks[0].level = 1.5;
    raw.pdf_info[0].para_blocks[1].type = 42;
    raw.pdf_info[0].para_blocks.push('not a block');
    raw.pdf_info.push({ page_idx: 0, page_size: [1, 1], para_blocks: [] });
    raw.pdf_info.push({ page_idx: 7, page_size: [0, 1], para_blocks: [] });
    raw.pdf_info.push({ page_idx: 8, page_size: [1], para_blocks: [] });
    const layout = projectMinerULayout(raw);
    assert.equal(layout.pages.length, 2);
    const title = layout.pages[0].blocks[0];
    assert.equal(title.bbox, undefined);
    assert.equal(title.index, undefined);
    assert.equal(title.level, undefined);
    assert.equal(layout.pages[0].blocks[1].type, undefined);
    assert.equal(layout.pages[0].blocks.length, 3);
    assert.equal(layout.diagnostics.droppedPages, 3);
    assert.equal(layout.diagnostics.droppedFields, 5);
});

test('truncates oversized strings and caps the block budget', () => {
    const raw = layoutFixture();
    raw.pdf_info[0].para_blocks[0].lines[0].spans[0].content = 'x'.repeat(600 * 1024);
    const layout = projectMinerULayout(raw);
    assert.equal(layout.pages[0].blocks[0].lines[0].spans[0].content.length, 512 * 1024);
    assert.equal(layout.diagnostics.truncatedStrings, 1);
    assert.throws(() => projectMinerULayout(layoutFixture(), { maxBlocks: 3 }), /block limit/);
    assert.equal(projectMinerULayout({ pdf_info: false }), null);
    assert.equal(projectMinerULayout(null), null);
    assert.equal(projectMinerULayout(layoutFixture(), { maxPages: 1 }), null);
});

test('rejects layouts with unordered or malformed pages', () => {
    const layout = projectMinerULayout(layoutFixture());
    assert.equal(validateMinerULayout({ ...layout, pages: [...layout.pages].reverse() }), false);
    assert.equal(validateMinerULayout({ ...layout, pages: [{ pageIndex: 0, pageSize: [1, 1] }] }), false);
});

test('extracts the projected layout from a ZIP', () => {
    const archive = zipSync({
        'result/full.md': strToU8('# A Paper'),
        'result/layout.json': strToU8(JSON.stringify(layoutFixture())),
    });
    const result = extractMinerUResultFromZip(archive);
    assert.equal(result.layout.schema, MINERU_LAYOUT_SCHEMA);
    assert.equal(result.layout.pages[0].discarded.length, 2);
    assert.equal('detailedLayout' in result, false);
    const broken = extractMinerUResultFromZip(zipSync({
        'result/full.md': strToU8('# A Paper'),
        'result/layout.json': strToU8('{"pdf_info":'),
    }));
    assert.equal(broken.layout, undefined);
    assert.equal(broken.markdown, '# A Paper');
});

test('ignores a layout.json outside the Markdown result root', () => {
    const result = extractMinerUResultFromZip(zipSync({
        'result/full.md': strToU8('# A Paper'),
        'other/layout.json': strToU8(JSON.stringify(layoutFixture())),
        'result/images/a.jpg': strToU8('img'),
    }));
    assert.equal(result.layout, undefined);
    assert.equal(result.markdown, '# A Paper');
    assert.equal(result.assets.length, 1);
});

test('does not project a root that contains both layout.json and middle.json', () => {
    const raw = JSON.stringify(layoutFixture());
    const result = extractMinerUResultFromZip(zipSync({
        'result/full.md': strToU8('# A Paper'),
        'result/layout.json': strToU8(raw),
        'result/paper_middle.json': strToU8(raw),
        'result/images/a.jpg': strToU8('img'),
    }));
    assert.equal(result.layout, undefined);
    assert.equal(result.markdown, '# A Paper');
    assert.equal(result.assets.length, 1);
});

test('keeps Markdown and assets when the layout exceeds the byte cap', () => {
    const result = extractMinerUResultFromZip(zipSync({
        'result/full.md': strToU8('# A Paper'),
        'result/layout.json': strToU8(JSON.stringify(layoutFixture())),
        'result/images/a.jpg': strToU8('img'),
    }), { maxLayoutBytes: 5 });
    assert.equal(result.layout, undefined);
    assert.equal(result.markdown, '# A Paper');
    assert.equal(result.assets.length, 1);
});
