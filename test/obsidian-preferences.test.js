import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getObsidianSubdirectory,
    getObsidianVaultPath,
    setObsidianSubdirectory,
    setObsidianVaultPath,
} from '../src/config/obsidian-preferences.js';

test('stores the Obsidian vault path and falls back to Mktero for a bad folder', () => {
    const values = new Map();
    const zotero = {
        Prefs: {
            get: key => values.get(key),
            set: (key, value) => values.set(key, value),
        },
    };

    assert.equal(getObsidianVaultPath(zotero), '');
    assert.equal(setObsidianVaultPath(zotero, ' /vault '), '/vault');
    assert.equal(getObsidianVaultPath(zotero), '/vault');
    assert.equal(getObsidianSubdirectory(zotero), 'Mktero');
    assert.equal(setObsidianSubdirectory(zotero, 'Papers'), 'Papers');
    assert.equal(getObsidianSubdirectory(zotero), 'Papers');
    values.set(
        'extensions.mktero.obsidianSubdirectory',
        '../outside'
    );
    assert.equal(getObsidianSubdirectory(zotero), 'Mktero');
    assert.equal(setObsidianSubdirectory(zotero, '../outside'), 'Mktero');
});
