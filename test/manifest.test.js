import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(
    new URL('../manifest.json', import.meta.url),
    'utf8'
));
const packageMetadata = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8'
));
const packageLock = JSON.parse(await readFile(
    new URL('../package-lock.json', import.meta.url),
    'utf8'
));

test('allows installation on the tested Zotero 9 minor version', () => {
    assert.equal(manifest.applications.zotero.strict_max_version, '9.0.*');
});

test('provides the update URL required by Zotero 9', () => {
    const updateURL = manifest.applications.zotero.update_url;
    assert.doesNotThrow(() => new URL(updateURL));
    assert.equal(
        updateURL,
        'https://github.com/tenglvjun/mktero/releases/latest/download/updates.json'
    );
});

test('declares the scalable Mktero logo for extension surfaces', () => {
    assert.deepEqual(manifest.icons, {
        48: 'ui/icons/mktero.svg',
        96: 'ui/icons/mktero.svg',
    });
});

test('keeps the installable package version metadata consistent', () => {
    assert.equal(manifest.version, '0.2.3');
    assert.equal(packageMetadata.version, manifest.version);
    assert.equal(packageLock.version, manifest.version);
    assert.equal(packageLock.packages[''].version, manifest.version);
});
