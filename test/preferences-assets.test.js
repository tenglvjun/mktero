import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ships MinerU token, cache preferences, and localized Markdown UI assets', async () => {
    const [
        prefs,
        pane,
        script,
        bootstrap,
        markdownView,
        tabPresenter,
        buildScript,
    ] = await Promise.all([
        readFile(new URL('../prefs.js', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/preferences.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/markdown-window.js', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/markdown-tab-presenter.js', import.meta.url), 'utf8'),
        readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8'),
    ]);

    assert.match(prefs, /pref\("extensions\.mktero\.mineruApiKey", ""\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.cacheEnabled", true\)/);
    assert.doesNotMatch(prefs, /extensions\.mktero\.language/);
    assert.doesNotMatch(pane, /id="mktero-language"/);
    assert.doesNotMatch(pane, /preference="extensions\.mktero\.language"/);
    assert.match(pane, /preference="extensions\.mktero\.mineruApiKey"/);
    assert.match(pane, /preference="extensions\.mktero\.cacheEnabled"/);
    assert.match(pane, /id="mktero-clear-cache"/);
    assert.doesNotMatch(pane, /onload=/);
    assert.match(script, /registerPreferencesPaneLoader/);
    const visiblePreferenceText = pane.replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(visiblePreferenceText, /mineru/i);
    assert.match(script, /createZoteroMarkdownCache/);
    assert.doesNotMatch(script, /setMkteroLanguagePreference/);
    assert.match(bootstrap, /new MinerUClient/);
    assert.doesNotMatch(bootstrap, /observeMkteroLanguagePreference/);
    assert.match(markdownView, /createInlineMarkdownEditor/);
    assert.doesNotMatch(markdownView, /'mktero-show-source'/);
    assert.doesNotMatch(markdownView, /'mktero-reparse'/);
    assert.match(markdownView, /__MKTERO_MARKDOWN_STYLES__/);
    assert.doesNotMatch(markdownView, /STYLESHEET_CACHE_KEY/);
    assert.match(markdownView, /error\.markdownStylesUnavailable/);
    assert.match(tabPresenter, /TAB_ICON = 'markdown'/);
    assert.match(buildScript, /ui\/preferences\.js/);
    assert.match(buildScript, /ui\/icons\/markdown\.svg/);
    assert.match(buildScript, /__MKTERO_MARKDOWN_STYLES__/);
    assert.doesNotMatch(buildScript, /copyText\('ui\/markdown\.css'/);
});

test('ships responsive settings cards and a cache switch', async () => {
    const [pane, styles] = await Promise.all([
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.css', import.meta.url), 'utf8'),
    ]);

    assert.match(pane, /class="mktero-settings-card"/);
    assert.equal((pane.match(/class="mktero-switch-input"/g) || []).length, 1);
    assert.equal((pane.match(/class="mktero-switch" aria-hidden="true"/g) || []).length, 1);
    assert.equal((pane.match(/role="switch"/g) || []).length, 1);
    assert.match(styles, /\.mktero-settings-card\s*\{[\s\S]*border-radius:/);
    assert.match(styles, /\.mktero-switch-input:checked\s*\+\s*\.mktero-switch/);
    assert.match(styles, /\.mktero-switch::before/);
    assert.match(styles, /@media\s*\(max-width:/);
});

test('presents every preference group as one cohesive settings card', async () => {
    const [pane, styles] = await Promise.all([
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.css', import.meta.url), 'utf8'),
    ]);

    assert.equal((pane.match(/class="mktero-settings-card"/g) || []).length, 2);
    assert.equal((pane.match(/class="mktero-preferences-section"/g) || []).length, 2);
    assert.match(
        pane,
        /id="mktero-mineru-api-key"[\s\S]*aria-describedby="mktero-token-help mktero-token-storage-note"/
    );
    assert.match(
        pane,
        /id="mktero-cache-enabled"[\s\S]*class="mktero-switch-input"[\s\S]*role="switch"/
    );
    assert.match(
        pane,
        /id="mktero-cache-status"[\s\S]*role="status"[\s\S]*aria-live="polite"/
    );
    assert.match(styles, /#mktero-preferences-pane\s*\{[\s\S]*max-width:/);
    assert.match(styles, /\.mktero-preferences-section\s*\+\s*\.mktero-preferences-section/);
    assert.match(styles, /\.mktero-card-note/);
});
