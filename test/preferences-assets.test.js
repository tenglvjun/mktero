import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ships MinerU token and cache preferences at the Zotero plugin root', async () => {
    const [prefs, pane, script, markdownPane, buildScript] = await Promise.all([
        readFile(new URL('../prefs.js', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../src/ui/preferences.js', import.meta.url), 'utf8'),
        readFile(new URL('../ui/markdown.xhtml', import.meta.url), 'utf8'),
        readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8'),
    ]);

    assert.match(prefs, /pref\("extensions\.mktero\.mineruApiKey", ""\)/);
    assert.match(prefs, /pref\("extensions\.mktero\.cacheEnabled", true\)/);
    assert.match(pane, /preference="extensions\.mktero\.mineruApiKey"/);
    assert.match(pane, /preference="extensions\.mktero\.cacheEnabled"/);
    assert.match(pane, /id="mktero-clear-cache"/);
    assert.match(pane, /MkteroPreferences\.init\(event\)/);
    assert.match(script, /createZoteroMarkdownCache/);
    assert.match(markdownPane, /id="mktero-reparse"/);
    assert.match(buildScript, /ui\/preferences\.js/);
});
