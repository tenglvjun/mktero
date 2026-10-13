import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationShortcutLabels } from '../src/ui/reader-shortcuts.js';

test('names the macOS history chord on macOS', () => {
    assert.deepEqual(
        navigationShortcutLabels({ isMac: true }),
        { back: '⌘[', forward: '⌘]' }
    );
});

test('names the Alt chord elsewhere, and by default', () => {
    for (const options of [{}, { isMac: false }, undefined]) {
        assert.deepEqual(
            navigationShortcutLabels(options),
            { back: 'Alt+←', forward: 'Alt+→' }
        );
    }
});
