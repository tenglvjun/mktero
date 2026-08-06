import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getMarkdownReaderFontSize,
    MARKDOWN_READER_FONT_SIZE_DEFAULT,
    MARKDOWN_READER_FONT_SIZE_MAX,
    MARKDOWN_READER_FONT_SIZE_MIN,
    MARKDOWN_READER_FONT_SIZE_PREF,
    setMarkdownReaderFontSize,
} from '../src/config/reader-preferences.js';

test('normalizes and persists the Markdown reader font size', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ type: 'get', key, global });
                return 24;
            },
            set(key, value, global) {
                calls.push({ type: 'set', key, value, global });
            },
        },
    };

    assert.equal(getMarkdownReaderFontSize(zotero), MARKDOWN_READER_FONT_SIZE_MAX);
    assert.equal(
        setMarkdownReaderFontSize(zotero, 15),
        MARKDOWN_READER_FONT_SIZE_MIN
    );
    assert.deepEqual(calls, [
        {
            type: 'get',
            key: MARKDOWN_READER_FONT_SIZE_PREF,
            global: true,
        },
        {
            type: 'set',
            key: MARKDOWN_READER_FONT_SIZE_PREF,
            value: MARKDOWN_READER_FONT_SIZE_MIN,
            global: true,
        },
    ]);
    assert.equal(
        getMarkdownReaderFontSize({ Prefs: { get: () => 'invalid' } }),
        MARKDOWN_READER_FONT_SIZE_DEFAULT
    );
});
