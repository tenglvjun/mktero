import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getMarkdownReaderAlignment,
    getMarkdownReaderAlignmentCss,
    getMarkdownReaderFont,
    getMarkdownReaderFontFamily,
    getMarkdownReaderFontSize,
    getMarkdownReaderLineHeight,
    getMarkdownReaderLineHeightCss,
    getMarkdownReaderWidth,
    getMarkdownReaderWidthCss,
    MARKDOWN_READER_ALIGNMENT_DEFAULT,
    MARKDOWN_READER_ALIGNMENT_PREF,
    MARKDOWN_READER_FONT_DEFAULT,
    MARKDOWN_READER_FONT_PREF,
    MARKDOWN_READER_FONT_SIZE_DEFAULT,
    MARKDOWN_READER_FONT_SIZE_MAX,
    MARKDOWN_READER_FONT_SIZE_MIN,
    MARKDOWN_READER_FONT_SIZE_PREF,
    MARKDOWN_READER_LINE_HEIGHT_DEFAULT,
    MARKDOWN_READER_LINE_HEIGHT_PREF,
    MARKDOWN_READER_WIDTH_DEFAULT,
    MARKDOWN_READER_WIDTH_PREF,
    setMarkdownReaderAlignment,
    setMarkdownReaderFont,
    setMarkdownReaderFontSize,
    setMarkdownReaderLineHeight,
    setMarkdownReaderWidth,
} from '../src/config/reader-preferences.js';

test('normalizes and persists the Markdown reader font size', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ type: 'get', key, global });
                return 40;
            },
            set(key, value, global) {
                calls.push({ type: 'set', key, value, global });
            },
        },
    };

    assert.equal(getMarkdownReaderFontSize(zotero), MARKDOWN_READER_FONT_SIZE_MAX);
    assert.equal(
        setMarkdownReaderFontSize(zotero, 13),
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
        '"STIX Two Text", "Noto Serif SC", ui-serif, "Iowan Old Style", Charter, "Bitstream Charter", Georgia, serif'
    );
});

test('normalizes and persists Markdown reader line height, width, and alignment', () => {
    const stored = new Map();
    const zotero = {
        Prefs: {
            get(key) {
                return stored.get(key);
            },
            set(key, value) {
                stored.set(key, value);
            },
        },
    };

    assert.equal(getMarkdownReaderLineHeight(zotero), MARKDOWN_READER_LINE_HEIGHT_DEFAULT);
    assert.equal(setMarkdownReaderLineHeight(zotero, 'loose'), 'loose');
    assert.equal(stored.get(MARKDOWN_READER_LINE_HEIGHT_PREF), 'loose');
    assert.equal(setMarkdownReaderLineHeight(zotero, 'unsupported'), 'standard');
    assert.equal(getMarkdownReaderLineHeightCss('tight'), '1.55');
    assert.equal(getMarkdownReaderLineHeightCss('invalid'), '1.78');

    assert.equal(getMarkdownReaderWidth(zotero), MARKDOWN_READER_WIDTH_DEFAULT);
    assert.equal(setMarkdownReaderWidth(zotero, 'wide'), 'wide');
    assert.equal(stored.get(MARKDOWN_READER_WIDTH_PREF), 'wide');
    assert.equal(setMarkdownReaderWidth(zotero, 'unsupported'), 'standard');
    assert.equal(getMarkdownReaderWidthCss('narrow'), '45rem');
    assert.equal(getMarkdownReaderWidthCss('invalid'), '60rem');

    assert.equal(getMarkdownReaderAlignment(zotero), MARKDOWN_READER_ALIGNMENT_DEFAULT);
    assert.equal(setMarkdownReaderAlignment(zotero, 'justify'), 'justify');
    assert.equal(stored.get(MARKDOWN_READER_ALIGNMENT_PREF), 'justify');
    assert.equal(setMarkdownReaderAlignment(zotero, 'unsupported'), 'start');
    assert.equal(getMarkdownReaderAlignmentCss('justify'), 'justify');
    assert.equal(getMarkdownReaderAlignmentCss('invalid'), 'start');
});
