import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('aborts translation on tab close, reparse, and extension shutdown', async () => {
    const bootstrap = await readFile(
        new URL('../src/bootstrap.js', import.meta.url),
        'utf8'
    );
    const shutdown = sourceBlock(
        bootstrap,
        'globalThis.shutdown = function shutdown()',
        'globalThis.uninstall'
    );
    const openItem = sourceBlock(
        bootstrap,
        'async function openItemAsMarkdown',
        'async function openSavedMarkdownNote'
    );

    assert.ok(shutdown.includes('abortAllTranslations()'));
    assert.ok(
        shutdown.indexOf('abortAllTranslations()')
            < shutdown.indexOf('runtime.presenter?.dispose()')
    );
    assert.ok(openItem.includes('abortTranslation(itemID);'));
    assert.ok(openItem.includes('if (forceRefresh) abortTranslation(itemID);'));
    assert.ok(bootstrap.includes(
        'onClose: () => abortTranslation(noteID)'
    ));
});

test('keeps translations outside snapshot persistence and source Markdown', async () => {
    const [bootstrap, editor, overlay] = await Promise.all([
        readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8'),
        readFile(
            new URL('../src/editor/inline-markdown-editor.js', import.meta.url),
            'utf8'
        ),
        readFile(
            new URL('../src/editor/translation-overlay.js', import.meta.url),
            'utf8'
        ),
    ]);
    const snapshot = sourceBlock(
        bootstrap,
        'async function saveSnapshotForModel',
        'async function runAnnotationAction'
    );

    assert.ok(snapshot.includes('markdown: model.markdown'));
    assert.equal(snapshot.includes('translation'), false);
    assert.ok(editor.includes('EditorView.editable.of(false)'));
    assert.ok(editor.includes('EditorState.readOnly.of(true)'));
    assert.ok(editor.includes('setTranslationOverlay.of'));
    assert.ok(overlay.includes('Decoration.widget'));
    assert.equal(overlay.includes('changes:'), false);
});

function sourceBlock(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, 'start marker must exist');
    assert.ok(end > start, 'end marker must exist');
    return source.slice(start, end);
}
