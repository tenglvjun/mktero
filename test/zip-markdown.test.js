import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import {
    extractMarkdownFromZip,
    extractMinerUResultFromZip,
} from '../src/mineru/zip-markdown.js';

test('extracts only full.md from a MinerU result archive', () => {
    const archive = zipSync({
        'result/full.md': strToU8('# MinerU Markdown'),
        'result/images/figure.png': new Uint8Array([1, 2, 3]),
    });

    assert.equal(extractMarkdownFromZip(archive), '# MinerU Markdown');
});

test('rejects a MinerU archive without full.md', () => {
    const archive = zipSync({
        'result/content.json': strToU8('{}'),
    });

    assert.throws(
        () => extractMarkdownFromZip(archive),
        /full\.md/
    );
});

test('rejects full.md before inflating beyond the configured limit', () => {
    const archive = zipSync({
        'result/full.md': strToU8('12345'),
    });

    assert.throws(
        () => extractMarkdownFromZip(archive, { maxMarkdownBytes: 4 }),
        /size limit/
    );
});

test('extracts supported MinerU images with the Markdown base path', () => {
    const archive = zipSync({
        'result/full.md': strToU8('![Figure](images/figure.png)'),
        'result/images/figure.png': new Uint8Array([1, 2, 3]),
        'result/images/vector.svg': strToU8('<svg onload="alert(1)"/>'),
    });

    const result = extractMinerUResultFromZip(archive);

    assert.equal(result.markdown, '![Figure](images/figure.png)');
    assert.equal(result.assetBasePath, 'result');
    assert.deepEqual(result.assets.map(asset => ({
        path: asset.path,
        mimeType: asset.mimeType,
        data: [...asset.data],
    })), [{
        path: 'result/images/figure.png',
        mimeType: 'image/png',
        data: [1, 2, 3],
    }]);
});

test('extracts stable MinerU content blocks used for PDF source navigation', () => {
    const archive = zipSync({
        'result/full.md': strToU8('# Paper\n\nA paragraph.\n\n$$E=mc^2$$'),
        'result/paper_content_list.json': strToU8(JSON.stringify([
            {
                type: 'text',
                text: 'A paragraph.',
                page_idx: 0,
                bbox: [100, 200, 900, 260],
            },
            {
                type: 'equation',
                latex: 'E=mc^2',
                page_idx: 1,
                bbox: [250, 300, 750, 420],
            },
            {
                type: 'image',
                img_path: 'images/figure.png',
                image_caption: ['Figure 1: Result'],
                page_idx: 2,
                bbox: [80, 100, 920, 700],
            },
            {
                type: 'table',
                table_body: '| A | B |\n| - | - |\n| 1 | 2 |',
                table_caption: ['Table 1: Values'],
                page_idx: 3,
                bbox: [120, 180, 880, 760],
            },
        ])),
        'result/content_list_v2.json': strToU8(JSON.stringify([
            { type: 'text', text: 'unstable' },
        ])),
    });

    const result = extractMinerUResultFromZip(archive);

    assert.deepEqual(result.contentList, [
        {
            type: 'text',
            text: 'A paragraph.',
            pageIndex: 0,
            bbox: [100, 200, 900, 260],
        },
        {
            type: 'equation',
            text: 'E=mc^2',
            pageIndex: 1,
            bbox: [250, 300, 750, 420],
        },
        {
            type: 'image',
            assetPath: 'images/figure.png',
            captions: ['Figure 1: Result'],
            pageIndex: 2,
            bbox: [80, 100, 920, 700],
        },
        {
            type: 'table',
            text: '| A | B |\n| - | - |\n| 1 | 2 |',
            captions: ['Table 1: Values'],
            pageIndex: 3,
            bbox: [120, 180, 880, 760],
        },
    ]);
});

test('rejects unsafe MinerU content lists at the archive boundary', () => {
    const createArchive = entries => zipSync({
        'result/full.md': strToU8('# Paper'),
        ...entries,
    });

    assert.throws(
        () => extractMinerUResultFromZip(createArchive({
            'result/paper_content_list.json': strToU8('{invalid'),
        })),
        /content list JSON/i
    );
    assert.throws(
        () => extractMinerUResultFromZip(createArchive({
            'result/a_content_list.json': strToU8('[]'),
            'result/b_content_list.json': strToU8('[]'),
        })),
        /multiple content_list/i
    );
    assert.throws(
        () => extractMinerUResultFromZip(createArchive({
            'result/paper_content_list.json': strToU8('[{"type":"text"}]'),
        }), { maxContentListBytes: 10 }),
        /size limit/i
    );
    assert.throws(
        () => extractMinerUResultFromZip(createArchive({
            'result/paper_content_list.json': strToU8(JSON.stringify([
                { type: 'text', text: 'one', page_idx: 0, bbox: [0, 0, 10, 10] },
                { type: 'text', text: 'two', page_idx: 0, bbox: [0, 10, 10, 20] },
            ])),
        }), { maxContentBlocks: 1 }),
        /block limit/i
    );

    for (const block of [
        { type: 'text', text: 'bad page', page_idx: -1, bbox: [0, 0, 10, 10] },
        { type: 'text', text: 'bad bbox', page_idx: 0, bbox: [0, 0, 1001, 10] },
        { type: 'text', text: 'empty bbox', page_idx: 0, bbox: [10, 0, 10, 10] },
    ]) {
        assert.throws(
            () => extractMinerUResultFromZip(createArchive({
                'result/paper_content_list.json': strToU8(JSON.stringify([block])),
            })),
            /Unable to extract MinerU result: Invalid MinerU content block/i
        );
    }
});
