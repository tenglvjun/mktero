import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationShortcutLabels, readerShortcutGroups } from '../src/ui/reader-shortcuts.js';

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

test('the cheat sheet names the platform history chord', () => {
    const mac = readerShortcutGroups({ isMac: true });
    const other = readerShortcutGroups({ isMac: false });
    const macHistory = mac[0].items.find(
        item => item.labelKey === 'viewer.shortcutsHistory'
    );
    const otherHistory = other[0].items.find(
        item => item.labelKey === 'viewer.shortcutsHistory'
    );
    assert.equal(macHistory.keys, '⌘[ / ⌘]');
    assert.equal(otherHistory.keys, 'Alt+← / Alt+→');
});

test('the cheat sheet groups navigation and landmark jumps', () => {
    const groups = readerShortcutGroups({});
    assert.deepEqual(
        groups.map(group => group.groupKey),
        ['viewer.shortcutsGroupNavigation', 'viewer.shortcutsGroupJump']
    );
    const jump = groups[1];
    assert.deepEqual(
        jump.items.map(item => item.keys),
        ['N / P', 'Shift+N / Shift+P', 'Alt+N / Alt+P']
    );
    for (const group of groups) {
        assert.ok(group.items.length > 0);
        for (const item of group.items) {
            assert.equal(typeof item.keys, 'string');
            assert.equal(typeof item.labelKey, 'string');
        }
    }
});
