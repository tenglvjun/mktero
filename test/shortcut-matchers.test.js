import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isNextAssetShortcut,
    isNextHeadingShortcut,
    isNextNoteShortcut,
    isPreviousAssetShortcut,
    isPreviousHeadingShortcut,
    isPreviousNoteShortcut,
    isShortcutsPanelShortcut,
} from '../src/ui/shortcut-matchers.js';

function keyEvent(overrides = {}) {
    return {
        key: '',
        code: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        ...overrides,
    };
}

test("'?' with plain modifiers opens the shortcuts panel", () => {
    assert.ok(isShortcutsPanelShortcut(keyEvent({ key: '?', shiftKey: true })));
    assert.ok(isShortcutsPanelShortcut(keyEvent({ key: '?' })));
});

test("'?' with Ctrl/Meta/Alt does not open the panel", () => {
    assert.ok(!isShortcutsPanelShortcut(keyEvent({ key: '?', ctrlKey: true })));
    assert.ok(!isShortcutsPanelShortcut(keyEvent({ key: '?', metaKey: true })));
    assert.ok(!isShortcutsPanelShortcut(keyEvent({ key: '?', altKey: true })));
});

test("'?' while composing is ignored", () => {
    assert.ok(!isShortcutsPanelShortcut(keyEvent({
        key: '?',
        isComposing: true,
    })));
});

test('n and p match headings by character', () => {
    assert.ok(isNextHeadingShortcut(keyEvent({ key: 'n' })));
    assert.ok(isPreviousHeadingShortcut(keyEvent({ key: 'p' })));
});

test('n and p match headings by physical key position', () => {
    // A non-US layout can report a different character for the same key.
    assert.ok(isNextHeadingShortcut(keyEvent({ key: 'ń', code: 'KeyN' })));
    assert.ok(isPreviousHeadingShortcut(keyEvent({ key: 'ρ', code: 'KeyP' })));
});

test('single-letter keys reject every modifier plane', () => {
    for (const overrides of [
        { key: 'n', ctrlKey: true },
        { key: 'n', metaKey: true },
        { key: 'n', altKey: true },
        { key: 'n', shiftKey: true },
        { key: 'p', ctrlKey: true },
        { key: 'p', shiftKey: true },
    ]) {
        assert.ok(!isNextHeadingShortcut(keyEvent(overrides)), JSON.stringify(overrides));
        assert.ok(!isPreviousHeadingShortcut(keyEvent(overrides)), JSON.stringify(overrides));
    }
});

test('Shift+N and Shift+P select figure jumps', () => {
    assert.ok(isNextAssetShortcut(keyEvent({ key: 'N', shiftKey: true })));
    assert.ok(isPreviousAssetShortcut(keyEvent({ key: 'P', shiftKey: true })));
    assert.ok(!isNextAssetShortcut(keyEvent({ key: 'N' })));
    assert.ok(!isNextAssetShortcut(keyEvent({
        key: 'N',
        shiftKey: true,
        ctrlKey: true,
    })));
});

test('Alt+N and Alt+P select note jumps', () => {
    assert.ok(isNextNoteShortcut(keyEvent({ key: 'n', altKey: true })));
    assert.ok(isPreviousNoteShortcut(keyEvent({ key: 'p', altKey: true })));
    assert.ok(!isNextNoteShortcut(keyEvent({ key: 'n' })));
    // AltGr reports Ctrl+Alt on Windows; keep it clear.
    assert.ok(!isNextNoteShortcut(keyEvent({
        key: 'n',
        altKey: true,
        ctrlKey: true,
    })));
    assert.ok(!isNextNoteShortcut(keyEvent({
        key: 'n',
        altKey: true,
        metaKey: true,
    })));
    assert.ok(!isNextNoteShortcut(keyEvent({
        key: 'n',
        altKey: true,
        shiftKey: true,
    })));
});

test('composing input disables every landmark key', () => {
    for (const overrides of [
        { key: 'n', isComposing: true },
        { key: 'N', shiftKey: true, isComposing: true },
        { key: 'n', altKey: true, isComposing: true },
    ]) {
        assert.ok(!isNextHeadingShortcut(keyEvent(overrides)));
        assert.ok(!isNextAssetShortcut(keyEvent(overrides)));
        assert.ok(!isNextNoteShortcut(keyEvent(overrides)));
    }
});
