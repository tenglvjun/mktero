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
