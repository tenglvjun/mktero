import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getMarkdownReaderFont,
    getMarkdownReaderFontFamily,
    getMarkdownReaderFontSize,
    MARKDOWN_READER_FONT_DEFAULT,
    MARKDOWN_READER_FONT_PREF,
    MARKDOWN_READER_FONT_SIZE_DEFAULT,
    MARKDOWN_READER_FONT_SIZE_MAX,
    MARKDOWN_READER_FONT_SIZE_MIN,
    MARKDOWN_READER_FONT_SIZE_PREF,
    setMarkdownReaderFont,
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

test('normalizes and persists the Markdown reader font family', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ type: 'get', key, global });
                return 'cambria';
            },
            set(key, value, global) {
                calls.push({ type: 'set', key, value, global });
            },
        },
    };

    assert.equal(getMarkdownReaderFont(zotero), 'cambria');
    assert.equal(setMarkdownReaderFont(zotero, 'system-serif'), 'system-serif');
    assert.equal(
        setMarkdownReaderFont(zotero, 'unsupported'),
        MARKDOWN_READER_FONT_DEFAULT
    );
    assert.deepEqual(calls, [
        {
            type: 'get',
            key: MARKDOWN_READER_FONT_PREF,
            global: true,
        },
        {
            type: 'set',
            key: MARKDOWN_READER_FONT_PREF,
            value: 'system-serif',
            global: true,
        },
        {
            type: 'set',
            key: MARKDOWN_READER_FONT_PREF,
            value: MARKDOWN_READER_FONT_DEFAULT,
            global: true,
        },
    ]);
    assert.equal(
        getMarkdownReaderFont({ Prefs: { get: () => 'invalid' } }),
        MARKDOWN_READER_FONT_DEFAULT
    );
    assert.equal(
        getMarkdownReaderFontFamily('times-new-roman'),
        '"Times New Roman", Georgia, Cambria, serif'
    );
    assert.equal(
        getMarkdownReaderFontFamily('invalid'),
        'ui-serif, "Iowan Old Style", Charter, "Bitstream Charter", Georgia, serif'
    );
});
