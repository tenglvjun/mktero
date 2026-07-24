import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ships the MinerU API Token default at the Zotero plugin root', async () => {
    const [prefs, pane] = await Promise.all([
        readFile(new URL('../prefs.js', import.meta.url), 'utf8'),
        readFile(new URL('../ui/preferences.xhtml', import.meta.url), 'utf8'),
    ]);

    assert.match(prefs, /pref\("extensions\.mktero\.mineruApiKey", ""\)/);
    assert.match(pane, /preference="extensions\.mktero\.mineruApiKey"/);
});
