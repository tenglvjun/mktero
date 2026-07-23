import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(
    new URL('../manifest.json', import.meta.url),
    'utf8'
));

test('allows installation on the tested Zotero 9 minor version', () => {
    assert.equal(manifest.applications.zotero.strict_max_version, '9.0.*');
});

test('provides the update URL required by Zotero 9', () => {
    const updateURL = manifest.applications.zotero.update_url;
    assert.doesNotThrow(() => new URL(updateURL));
    assert.match(updateURL, /^https:\/\//);
});
