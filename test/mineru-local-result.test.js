import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { extractMinerULocalResultFromZip } from '../src/mineru/local-result.js';

test('reads markdown.md and images without treating middle JSON as figure layout', () => {
    const archive = zipSync({
        'markdown.md': strToU8('# Local paper\n\n![Chart](images/a.png)\n'),
        'middle_json.json': strToU8('{"schema":"docvortex.middle","pdf_info":[]}'),
        'structured_content.json': strToU8('{}'),
        'images/a.png': strToU8('png-bytes'),
    });

    const result = extractMinerULocalResultFromZip(archive);

    assert.equal(result.markdown, '# Local paper\n\n![Chart](images/a.png)\n');
    assert.equal(result.assetBasePath, '');
    assert.deepEqual(result.contentList, []);
    assert.equal(result.detailedLayout, undefined);
    assert.deepEqual(result.assets.map(asset => asset.path), ['images/a.png']);
    assert.equal(result.assets[0].mimeType, 'image/png');
});

test('rejects a local MinerU archive without markdown.md or with an escaping path', () => {
    assert.throws(
        () => extractMinerULocalResultFromZip(zipSync({
            'full.md': strToU8('# Cloud shape'),
        })),
        error => error.code === 'MINERU_LOCAL_INVALID_RESULT'
    );
    assert.throws(
        () => extractMinerULocalResultFromZip(zipSync({
            'markdown.md': strToU8('# Local'),
            '../secret.png': strToU8('nope'),
        })),
        error => error.code === 'MINERU_LOCAL_INVALID_RESULT'
            && !error.message.includes('secret')
    );
});
