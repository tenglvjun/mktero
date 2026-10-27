import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    MARKDOWN_READER_NOTES_VISIBLE_PREF,
    MARKDOWN_READER_NOTES_WIDTH_DEFAULT,
    MARKDOWN_READER_NOTES_WIDTH_MAX,
    MARKDOWN_READER_NOTES_WIDTH_MIN,
    MARKDOWN_READER_NOTES_WIDTH_PREF,
    MARKDOWN_READER_OUTLINE_SEGMENT_DEFAULT,
    MARKDOWN_READER_OUTLINE_SEGMENT_PREF,
    MARKDOWN_READER_OUTLINE_VISIBLE_PREF,
    MARKDOWN_READER_OUTLINE_WIDTH_DEFAULT,
    MARKDOWN_READER_OUTLINE_WIDTH_MAX,
    MARKDOWN_READER_OUTLINE_WIDTH_MIN,
    MARKDOWN_READER_OUTLINE_WIDTH_PREF,
    MARKDOWN_READER_WIDTH_DEFAULT,
    MARKDOWN_READER_WIDTH_OPTIONS,
    MARKDOWN_READER_WIDTH_PREF,
    getMarkdownReaderPanelLayout,
    normalizeMarkdownReaderOutlineSegment,
    normalizeMarkdownReaderPanelLayout,
    setMarkdownReaderAlignment,
    setMarkdownReaderFont,
    setMarkdownReaderFontSize,
    setMarkdownReaderLineHeight,
    setMarkdownReaderPanelLayout,
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

test('lets the reading column grow with the window up to a cap', () => {
    const caps = MARKDOWN_READER_WIDTH_OPTIONS.map(option => (
        Number.parseFloat(option.css)
    ));
    assert.deepEqual(caps, [45, 80, 120]);
    assert.deepEqual(caps, [...caps].sort((a, b) => a - b));
    for (const option of MARKDOWN_READER_WIDTH_OPTIONS) {
        assert.match(option.css, /^\d+rem$/, 'a cap, not a fixed width');
    }
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
    assert.equal(getMarkdownReaderWidthCss('standard'), '80rem');
    assert.equal(getMarkdownReaderWidthCss('wide'), '120rem');
    assert.equal(getMarkdownReaderWidthCss('invalid'), '80rem');

    assert.equal(getMarkdownReaderAlignment(zotero), MARKDOWN_READER_ALIGNMENT_DEFAULT);
    assert.equal(setMarkdownReaderAlignment(zotero, 'justify'), 'justify');
    assert.equal(stored.get(MARKDOWN_READER_ALIGNMENT_PREF), 'justify');
    assert.equal(setMarkdownReaderAlignment(zotero, 'unsupported'), 'start');
    assert.equal(getMarkdownReaderAlignmentCss('justify'), 'justify');
    assert.equal(getMarkdownReaderAlignmentCss('invalid'), 'start');
});

test('normalizes the Markdown reader panel layout', () => {
    assert.equal(MARKDOWN_READER_OUTLINE_WIDTH_DEFAULT, 256);
    assert.equal(MARKDOWN_READER_OUTLINE_WIDTH_MIN, 180);
    assert.equal(MARKDOWN_READER_OUTLINE_WIDTH_MAX, 480);
    assert.equal(MARKDOWN_READER_NOTES_WIDTH_DEFAULT, 300);
    assert.equal(MARKDOWN_READER_NOTES_WIDTH_MIN, 220);
    assert.equal(MARKDOWN_READER_NOTES_WIDTH_MAX, 480);
    assert.equal(MARKDOWN_READER_OUTLINE_SEGMENT_DEFAULT, 'headings');
    assert.deepEqual(normalizeMarkdownReaderPanelLayout(), {
        outline: { visible: true, width: 256 },
        notes: { visible: true, width: 300 },
        outlineSegment: 'headings',
    });
    assert.deepEqual(normalizeMarkdownReaderPanelLayout({
        outline: { visible: 'false', width: 10 },
        notes: { visible: 0, width: 'nope' },
        outlineSegment: 'notes',
    }), {
        outline: { visible: false, width: 180 },
        notes: { visible: false, width: 300 },
        outlineSegment: 'headings',
    });
    assert.deepEqual(normalizeMarkdownReaderPanelLayout({
        outline: { visible: false, width: 179 },
        notes: { visible: 'false', width: 481 },
    }), {
        outline: { visible: false, width: 180 },
        notes: { visible: false, width: 480 },
        outlineSegment: 'headings',
    });
    assert.equal(normalizeMarkdownReaderPanelLayout({
        outline: { width: 180 },
    }).outline.width, 180);
    assert.equal(normalizeMarkdownReaderPanelLayout({
        outline: { width: 480 },
    }).outline.width, 480);
    assert.equal(normalizeMarkdownReaderPanelLayout({
        notes: { width: 220 },
    }).notes.width, 220);
    assert.equal(normalizeMarkdownReaderPanelLayout({
        notes: { width: 219 },
    }).notes.width, 220);
    assert.equal(normalizeMarkdownReaderPanelLayout({
        outline: { width: 200.4 },
        notes: { width: 250.6 },
    }).outline.width, 200);
    assert.equal(normalizeMarkdownReaderPanelLayout({
        notes: { width: 250.5 },
    }).notes.width, 251);
    assert.equal(normalizeMarkdownReaderPanelLayout({
        outline: { width: '256' },
        notes: { width: '' },
    }).outline.width, 256);
    assert.equal(normalizeMarkdownReaderPanelLayout({
        notes: { width: '' },
    }).notes.width, 300);
    for (const hidden of [false, 0, 'false']) {
        const layout = normalizeMarkdownReaderPanelLayout({
            outline: { visible: hidden },
            notes: { visible: hidden },
        });
        assert.equal(layout.outline.visible, false, String(hidden));
        assert.equal(layout.notes.visible, false, String(hidden));
    }
    for (const visible of [true, 1, 'true', '0', '', null, undefined, 'yes']) {
        const layout = normalizeMarkdownReaderPanelLayout({
            outline: { visible },
            notes: { visible },
        });
        assert.equal(layout.outline.visible, true, String(visible));
        assert.equal(layout.notes.visible, true, String(visible));
    }
    assert.equal(normalizeMarkdownReaderOutlineSegment('figures'), 'figures');
    assert.equal(
        normalizeMarkdownReaderOutlineSegment(' annotations '),
        'annotations'
    );
    assert.equal(normalizeMarkdownReaderOutlineSegment('headings'), 'headings');
    for (const invalid of ['Headings', 'notes', '', null, undefined, 1]) {
        assert.equal(
            normalizeMarkdownReaderOutlineSegment(invalid),
            'headings',
            String(invalid)
        );
    }
});

test('reads and writes only the changed Markdown reader panel preferences', () => {
    const stored = new Map([
        [MARKDOWN_READER_OUTLINE_VISIBLE_PREF, true],
        [MARKDOWN_READER_OUTLINE_WIDTH_PREF, 200],
        [MARKDOWN_READER_OUTLINE_SEGMENT_PREF, 'annotations'],
        [MARKDOWN_READER_NOTES_VISIBLE_PREF, 'false'],
        [MARKDOWN_READER_NOTES_WIDTH_PREF, 999],
    ]);
    const reads = [];
    const writes = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                reads.push({ key, global });
                return stored.get(key);
            },
            set(key, value, global) {
                writes.push({ key, value, global });
                stored.set(key, value);
            },
        },
    };

    assert.deepEqual(getMarkdownReaderPanelLayout(zotero), {
        outline: { visible: true, width: 200 },
        notes: { visible: false, width: 480 },
        outlineSegment: 'annotations',
    });
    assert.deepEqual(reads.map(call => call.key), [
        MARKDOWN_READER_OUTLINE_VISIBLE_PREF,
        MARKDOWN_READER_OUTLINE_WIDTH_PREF,
        MARKDOWN_READER_NOTES_VISIBLE_PREF,
        MARKDOWN_READER_NOTES_WIDTH_PREF,
        MARKDOWN_READER_OUTLINE_SEGMENT_PREF,
    ]);
    assert.equal(reads.every(call => call.global === true), true);

    reads.length = 0;
    const unchanged = setMarkdownReaderPanelLayout(zotero, {});
    assert.deepEqual(writes, []);
    assert.equal(unchanged.outline.width, 200);
    assert.equal(unchanged.notes.visible, false);

    const next = setMarkdownReaderPanelLayout(zotero, {
        notes: { width: 100, visible: 'false' },
        outlineSegment: 'nope',
    });
    assert.deepEqual(writes, [
        {
            key: MARKDOWN_READER_NOTES_VISIBLE_PREF,
            value: false,
            global: true,
        },
        {
            key: MARKDOWN_READER_NOTES_WIDTH_PREF,
            value: 220,
            global: true,
        },
        {
            key: MARKDOWN_READER_OUTLINE_SEGMENT_PREF,
            value: 'headings',
            global: true,
        },
    ]);
    assert.deepEqual(next, {
        outline: { visible: true, width: 200 },
        notes: { visible: false, width: 220 },
        outlineSegment: 'headings',
    });
    assert.equal(
        writes.some(call => call.key === MARKDOWN_READER_OUTLINE_VISIBLE_PREF),
        false
    );
    assert.equal(
        writes.some(call => call.key === MARKDOWN_READER_OUTLINE_WIDTH_PREF),
        false
    );

    writes.length = 0;
    const hidden = setMarkdownReaderPanelLayout(zotero, {
        outline: { visible: 0 },
    });
    assert.deepEqual(writes, [{
        key: MARKDOWN_READER_OUTLINE_VISIBLE_PREF,
        value: false,
        global: true,
    }]);
    assert.equal(hidden.outline.visible, false);
    assert.equal(hidden.outline.width, 200);
    assert.deepEqual(
        getMarkdownReaderPanelLayout({ Prefs: { get: () => undefined } }),
        {
            outline: { visible: true, width: 256 },
            notes: { visible: true, width: 300 },
            outlineSegment: 'headings',
        }
    );
});

test('declares the Markdown reader panel layout preferences', () => {
    assert.equal(
        MARKDOWN_READER_OUTLINE_VISIBLE_PREF,
        'extensions.mktero.readerOutlineVisible'
    );
    assert.equal(
        MARKDOWN_READER_OUTLINE_WIDTH_PREF,
        'extensions.mktero.readerOutlineWidth'
    );
    assert.equal(
        MARKDOWN_READER_OUTLINE_SEGMENT_PREF,
        'extensions.mktero.readerOutlineSegment'
    );
    assert.equal(
        MARKDOWN_READER_NOTES_VISIBLE_PREF,
        'extensions.mktero.readerNotesVisible'
    );
    assert.equal(
        MARKDOWN_READER_NOTES_WIDTH_PREF,
        'extensions.mktero.readerNotesWidth'
    );
    const source = readFileSync(new URL('../prefs.js', import.meta.url), 'utf8');
    for (const line of [
        'pref("extensions.mktero.readerOutlineVisible", true);',
        'pref("extensions.mktero.readerOutlineWidth", 256);',
        'pref("extensions.mktero.readerOutlineSegment", "headings");',
        'pref("extensions.mktero.readerNotesVisible", true);',
        'pref("extensions.mktero.readerNotesWidth", 300);',
    ]) {
        assert.equal(source.includes(line), true, line);
    }
});
