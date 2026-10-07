import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getObsidianVaultPath,
    setObsidianVaultPath,
} from '../src/config/obsidian-preferences.js';

test('stores the Obsidian vault path without a configurable folder', () => {
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
    assert.equal(setObsidianVaultPath(zotero, '  '), '');
    assert.equal(values.has('extensions.mktero.obsidianSubdirectory'), false);
});
