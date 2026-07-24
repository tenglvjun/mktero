import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreferencesController, formatCacheStats } from '../src/ui/preferences.js';

test('formats cache statistics for the preferences pane', () => {
    assert.equal(formatCacheStats({ entries: 0, sizeBytes: 0 }), 'No cached documents');
    assert.equal(
        formatCacheStats({ entries: 2, sizeBytes: 1536 }),
        '2 cached documents, 1.5 KB'
    );
});

test('loads cache usage and clears it from the preferences pane', async () => {
    const status = { textContent: '' };
    const button = {
        disabled: false,
        addEventListener(_type, listener) {
            this.listener = listener;
        },
    };
    const document = {
        getElementById(id) {
            return id === 'mktero-cache-status' ? status : button;
        },
    };
    let stats = { entries: 2, sizeBytes: 1536 };
    let clearCalls = 0;
    const cache = {
        getStats: async () => stats,
        clear: async () => {
            clearCalls++;
            stats = { entries: 0, sizeBytes: 0 };
        },
    };
    const controller = createPreferencesController({
        document,
        zotero: { logError: assert.fail },
        cache,
    });

    await controller.init();
    assert.equal(status.textContent, '2 cached documents, 1.5 KB');

    await button.listener();
    assert.equal(clearCalls, 1);
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, 'No cached documents');
});
