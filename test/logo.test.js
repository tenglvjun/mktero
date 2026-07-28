import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const logo = await readFile(
    new URL('../ui/icons/mktero.svg', import.meta.url),
    'utf8'
);

test('keeps the Mktero logo colors consistent across Zotero surfaces', () => {
    assert.match(logo, /fill="#F4F7FC"/);
    assert.match(logo, /stroke="#4072E5"/);
    assert.doesNotMatch(logo, /prefers-color-scheme/);
    assert.doesNotMatch(logo, /<style>/);
});
