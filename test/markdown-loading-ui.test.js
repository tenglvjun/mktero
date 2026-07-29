import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ships an accessible, visible loading UI for MinerU conversion', async () => {
    const [styles, script] = await Promise.all([
        readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/markdown-window.js', import.meta.url), 'utf8'),
    ]);

    assert.match(script, /id: 'mktero-loading'/);
    assert.match(script, /role: 'status'/);
    assert.match(script, /id: 'mktero-loading-progress'/);
    assert.match(script, /id: 'mktero-loading-progress-label'/);
    assert.match(script, /attachShadow/);
    assert.match(styles, /@keyframes mktero-spin/);
    assert.match(styles, /\.loading-state--inline/);
    assert.match(styles, /\.mktero-tab-view/);
    assert.match(script, /createLoadingPresentation\(model, this\.t\)/);
    assert.match(script, /loading-state--inline/);
    assert.doesNotMatch(script, /MinerU|loading-eyebrow/);
    assert.doesNotMatch(styles, /\.loading-eyebrow/);
});

test('styles a read-only Markdown workspace without editing controls', async () => {
    const styles = await readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8');

    assert.doesNotMatch(styles, /\.app-header\s*\{/);
    assert.doesNotMatch(styles, /\.editor-toolbar\s*\{/);
    assert.doesNotMatch(styles, /\.save-button\s*\{/);
    assert.match(styles, /\.markdown-side-panel-edge\s*\{[^}]*width: 7px;/s);
    assert.match(styles, /\.markdown-side-panel-resizer\s*\{[^}]*inset: 0;/s);
    assert.match(styles, /\.markdown-editor-host\s*\{[^}]*min-height: 0;/s);
    assert.doesNotMatch(styles, /\.mode-switch/);
});

test('allows text selection in the inline rendered Markdown editor', async () => {
    const styles = await readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8');

    assert.match(styles, /\.cm-content\s*\{[^}]*-moz-user-select: text;/s);
    assert.match(styles, /\.cm-content\s*\{[^}]*user-select: text;/s);
    assert.match(
        styles,
        /\.cm-content ::selection\s*\{[^}]*color: HighlightText;[^}]*background-color: Highlight;/s
    );
});
