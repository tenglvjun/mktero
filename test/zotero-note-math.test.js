import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import {
    noteMathPlaceholder,
    replaceNoteMathPlaceholders,
    rewriteNoteHighlightMath,
} from '../src/core/zotero-note-math.js';
import {
    legacyMathEmphasisVisibleTextForRanges,
    noteMathSegmentsForRanges,
    noteMathSegmentsText,
    noteSegmentTextKey,
    visibleMarkdownTextForRanges,
} from '../src/markdown/markdown-visible-text.js';
import { createZoteroNotes } from '../src/platform/zotero-notes.js';

const parseHTML = html => new DOMParser().parseFromString(html, 'text/html');
const parseBody = html => parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
const ANNOTATION = encodeURIComponent(JSON.stringify({
    annotationKey: 'HIGH0001',
    color: '#ffd400',
}));
const CITATION = '<span class="citation" data-citation="%7B%7D">'
    + '(<span class="citation-item">Dey, 2026, p. 3</span>)</span>';
const PASSAGE = String.raw`where $\mu$ is the mean, $\beta_{i}$ the effect for locus $i$, and $g_{i} \in \{0,1,2\}$ the count.`;

function rangeOf(markdown, text) {
    const from = markdown.indexOf(text);
    assert.notEqual(from, -1, `missing ${text}`);
    return { from, to: from + text.length };
}

test('splits a passage into its text and the formulas the reader typesets', () => {
    const markdown = `# Title\n\n${PASSAGE}\n`;
    const ranges = [rangeOf(markdown, PASSAGE)];
    const segments = noteMathSegmentsForRanges(markdown, ranges);

    assert.deepEqual(segments.map(segment => (
        segment.type === 'math' ? `[${segment.tex}]` : segment.text
    )), [
        'where ',
        '[\\mu]',
        ' is the mean, ',
        '[\\beta_{i}]',
        ' the effect for locus ',
        '[i]',
        ', and ',
        '[g_{i} \\in \\{0,1,2\\}]',
        ' the count.',
    ]);
    assert.equal(
        noteSegmentTextKey(noteMathSegmentsText(segments)),
        noteSegmentTextKey(visibleMarkdownTextForRanges(markdown, ranges))
    );
});

test('typesets a figure-caption formula as the reader shows it', () => {
    const markdown = String.raw`![Figure 1. point $\\hat{G}$ and the deviation $P - \\hat{G}$ isolates.](figures/fig.png)`;
    const from = markdown.indexOf('point');
    const to = markdown.indexOf('isolates.') + 'isolates'.length;
    const segments = noteMathSegmentsForRanges(markdown, [{ from, to }]);
    const formulas = segments.filter(segment => segment.type === 'math');

    assert.deepEqual(formulas.map(segment => segment.tex), [
        String.raw`\hat{G}`,
        String.raw`P - \hat{G}`,
    ]);
    assert.deepEqual(formulas.map(segment => segment.source), [
        String.raw`\\hat{G}`,
        String.raw`P - \\hat{G}`,
    ]);
    assert.equal(
        noteSegmentTextKey(noteMathSegmentsText(segments)),
        noteSegmentTextKey(String.raw`point \\hat{G} and the deviation P - \\hat{G} isolates`)
    );
    assert.equal(
        noteSegmentTextKey(segments.readerSavedText),
        noteSegmentTextKey(String.raw`point \hat{G} and the deviation P - \hat{G} isolates`)
    );

    const html = replaceNoteMathPlaceholders(
        `<p><span class="highlight" data-annotation="${ANNOTATION}">`
            + `${noteMathPlaceholder(0)}</span></p>`,
        new Map([[0, segments]]),
        { parseHTML }
    );
    assert.match(html, /<span class="math">\$\\hat\{G\}\$<\/span>/u);
    assert.match(html, /<span class="math">\$P - \\hat\{G\}\$<\/span>/u);
    assert.doesNotMatch(html, />\$hat\{G\}\$</u);
});

test('keeps a display formula as a block segment, ending at its closing $$', () => {
    const formula = '$$\n\\hat{G} = \\mu + \\sum_{i = 1}^{n} \\beta_{i} g_{i} \\tag{2}\n$$';
    const markdown = `Before.\n\n${formula}\n\nAfter.`;
    const segments = noteMathSegmentsForRanges(markdown, [rangeOf(markdown, formula)]);

    assert.deepEqual(segments, [{
        type: 'math',
        tex: '\\hat{G} = \\mu + \\sum_{i = 1}^{n} \\beta_{i} g_{i} \\tag{2}',
        source: '\\hat{G} = \\mu + \\sum_{i = 1}^{n} \\beta_{i} g_{i} \\tag{2}',
        display: true,
    }]);
});

test('treats footnote marks, citations, code, and unsafe TeX as text', () => {
    const markdown = 'Smith $^{*}$ cites $[12]$, writes `$x$`, and $\\def\\a{b}$ with $y$.';
    const segments = noteMathSegmentsForRanges(markdown, [{
        from: 0,
        to: markdown.length,
    }]);
    const formulas = segments.filter(segment => segment.type === 'math');

    assert.deepEqual(formulas.map(segment => segment.tex), ['y']);
    assert.match(noteMathSegmentsText(segments), /\\def\\a\{b\}/u);
    assert.equal(
        noteMathSegmentsForRanges('Plain text without formulas.', [{ from: 0, to: 10 }]),
        null
    );
    assert.equal(noteMathSegmentsForRanges(markdown, []), null);
    assert.equal(noteMathSegmentsForRanges(markdown, [{ from: 5, to: 2 }]), null);
});

test('replaces a serialized placeholder highlight with text and formulas', () => {
    const html = `<p><span class="highlight" data-annotation="${ANNOTATION}">`
        + `\u201C${noteMathPlaceholder(0)}\u201D</span> ${CITATION}</p>`;
    const segments = [
        { type: 'text', text: 'where ' },
        { type: 'math', tex: '\\mu', display: false },
        { type: 'text', text: ' is the mean' },
    ];

    const output = replaceNoteMathPlaceholders(html, new Map([[0, segments]]), { parseHTML });
    const document = parseBody(output);
    const highlights = [...document.querySelectorAll('span.highlight')];

    assert.deepEqual(highlights.map(span => span.textContent), [
        '\u201Cwhere ',
        ' is the mean\u201D',
    ]);
    assert.ok(highlights.every(span => (
        span.getAttribute('data-annotation') === ANNOTATION
    )));
    assert.equal(document.querySelector('span.math').textContent, '$\\mu$');
    assert.ok(document.querySelector('span.citation'));
    assert.doesNotMatch(output, /MKTERONOTEMATH/u);
});

test('splits the paragraph around a display formula in a highlight', () => {
    const html = `<p><span class="highlight" data-annotation="${ANNOTATION}">`
        + `${noteMathPlaceholder(0)}</span> ${CITATION}</p>`;
    const segments = [
        { type: 'text', text: 'The estimate ' },
        { type: 'math', tex: '\\hat{G} = \\mu \\tag{2}', display: true },
        { type: 'text', text: ' follows.' },
    ];

    const output = replaceNoteMathPlaceholders(html, new Map([[0, segments]]), { parseHTML });
    const body = parseBody(output).body;

    assert.deepEqual([...body.children].map(node => node.localName), ['p', 'pre', 'p']);
    assert.equal(body.querySelector('pre.math').textContent, '$$\\hat{G} = \\mu \\tag{2}$$');
    assert.equal(body.children[0].textContent, 'The estimate');
    assert.match(body.children[2].textContent, /^follows\./u);
    assert.ok(body.children[2].querySelector('span.citation'));
});

test('escapes formula and text markup instead of parsing it', () => {
    const html = `<p><span class="highlight" data-annotation="${ANNOTATION}">`
        + `${noteMathPlaceholder(0)}</span></p>`;
    const segments = [
        { type: 'text', text: '<img src=x onerror=alert(1)> ' },
        { type: 'math', tex: 'x</span><script>alert(1)</script>', display: false },
    ];

    const output = replaceNoteMathPlaceholders(html, new Map([[0, segments]]), { parseHTML });

    assert.doesNotMatch(output, /<img|<script/iu);
    assert.match(output, /&lt;img/u);
    assert.match(output, /&lt;\/span&gt;&lt;script&gt;/u);
});

test('gives up on placeholders it cannot place, so Zotero inserts the text', () => {
    const segments = [{ type: 'math', tex: 'x', display: false }];
    const missing = `<p><span class="highlight" data-annotation="${ANNOTATION}">plain</span></p>`;
    const wrapped = `<p><span class="highlight" data-annotation="${ANNOTATION}">`
        + `a ${noteMathPlaceholder(0)} b</span></p>`;

    assert.equal(
        replaceNoteMathPlaceholders(missing, new Map([[0, segments]]), { parseHTML }),
        null
    );
    assert.equal(
        replaceNoteMathPlaceholders(wrapped, new Map([[0, segments]]), { parseHTML }),
        null
    );
    assert.equal(
        replaceNoteMathPlaceholders(missing, new Map([[0, segments]]), {}),
        null
    );
});

test('rewrites the highlights of a saved note that match their annotation', () => {
    const other = encodeURIComponent(JSON.stringify({ annotationKey: 'OTHER001' }));
    const note = '<div data-citation-items="%5B%5D" data-schema-version="9">'
        + '<h1>Annotations</h1>\n'
        + `<p><span class="highlight" data-annotation="${ANNOTATION}">`
        + '\u201Cwhere \\mu is the mean\u201D</span> '
        + `${CITATION}</p>\n`
        + `<p><span class="highlight" data-annotation="${other}">\u201CUntouched\u201D</span></p>`
        + '</div>';
    const segments = [
        { type: 'text', text: 'where ' },
        { type: 'math', tex: '\\mu', source: '\\mu', display: false },
        { type: 'text', text: ' is the mean' },
    ];

    const output = rewriteNoteHighlightMath(
        note,
        key => (key === 'HIGH0001' ? segments : null),
        { parseHTML }
    );
    const document = parseBody(output);

    assert.ok(document.querySelector('div[data-citation-items][data-schema-version="9"]'));
    assert.equal(document.querySelector('span.math').textContent, '$\\mu$');
    assert.equal(
        document.querySelectorAll('span.highlight')[2].textContent,
        '\u201CUntouched\u201D'
    );
    assert.equal(
        rewriteNoteHighlightMath(
            note.replace('the mean', 'an average'),
            () => segments,
            { parseHTML }
        ),
        null
    );
});

test('rewrites a saved highlight whose formula subscripts were hidden', () => {
    const note = '<div data-citation-items="%5B%5D" data-schema-version="9">'
        + `<p><span class="highlight" data-annotation="${ANNOTATION}">`
        + '\u201Cset point \\hat{G}t = w(t)\\hat{G}{\\mathrm{genomic}}\u201D</span></p>'
        + '</div>';
    const segments = [
        { type: 'text', text: 'set point ' },
        {
            type: 'math',
            tex: String.raw`\hat{G}_t = w(t)\hat{G}_{\mathrm{genomic}}`,
            source: String.raw`\hat{G}_t = w(t)\hat{G}_{\mathrm{genomic}}`,
            display: false,
        },
    ];

    segments.legacySavedText = 'set point \\hat{G}t = w(t)\\hat{G}{\\mathrm{genomic}}';
    const output = rewriteNoteHighlightMath(note, () => segments, { parseHTML });
    const document = parseBody(output);

    assert.equal(
        document.querySelector('span.math').textContent,
        String.raw`$\hat{G}_t = w(t)\hat{G}_{\mathrm{genomic}}$`
    );
    assert.match(document.body.textContent, /\u201Cset point /u);
});

function noteEditorHarness({ zoteroOverrides = {}, instanceOverrides = {} } = {}) {
    const posted = [];
    const inserted = [];
    const serialized = [];
    const instance = {
        _initPromise: Promise.resolve(),
        focus() {},
        async insertAnnotations(annotations) {
            inserted.push(annotations);
        },
        async _ensureNoteCreated() {
            posted.push('ensure');
        },
        _postMessage(message) {
            posted.push(message);
        },
        ...instanceOverrides,
    };
    const editor = {
        setAttribute() {},
        classList: { add() {} },
        getCurrentInstance: () => instance,
        focus() {},
        remove() {},
    };
    const note = {
        id: 8,
        libraryID: 7,
        parentID: 9,
        isNote: () => true,
        isEditable: () => true,
    };
    const items = new Map([
        [8, note],
        [9, { id: 9, libraryID: 7, isRegularItem: () => true }],
        [42, { id: 42, libraryID: 7, parentID: 9, isPDFAttachment: () => true }],
    ]);
    const zotero = {
        Items: { get: id => items.get(id) || null, async loadDataTypes() {} },
        Libraries: { get: () => ({ editable: true }) },
        EditorInstanceUtilities: {
            serializeAnnotations(annotations) {
                serialized.push(annotations);
                return {
                    html: annotations.map(annotation => (
                        `<p><span class="highlight" data-annotation="${ANNOTATION}">`
                        + `\u201C${annotation.text}\u201D</span> ${CITATION}</p>`
                    )).join(''),
                    citationItems: [],
                };
            },
        },
        logError() {},
        ...zoteroOverrides,
    };
    const window = {
        document: { createXULElement: () => editor },
        customElements: { get: () => function NoteEditor() {} },
    };
    const notes = createZoteroNotes(zotero, {
        getMainWindow: () => window,
        parseHTML,
        delay: () => Promise.resolve(),
    });
    return { notes, posted, inserted, serialized };
}

test('keeps a formula subscript the old reader hid, and a subscript it kept', () => {
    const markdown = 'point $\\hat{G} = \\mu +\\sum_{i}\\beta_{i}g_{i}$, where $\\beta_{i}$ are sizes and $g_{i}\\in \\{0,1,2\\}$ counts. according to $\\hat{G}_t = w(t)\\hat{G}_{\\mathrm{genomic}}$, end';
    const ranges = [{ from: 0, to: markdown.length }];
    const segments = noteMathSegmentsForRanges(markdown, ranges);
    const saved = legacyMathEmphasisVisibleTextForRanges(markdown, ranges);

    assert.match(saved, /\\sum_\{i\}/u);
    assert.doesNotMatch(saved, /\\hat\{G\}_t/u);
    assert.notEqual(
        noteSegmentTextKey(noteMathSegmentsText(segments)),
        noteSegmentTextKey(saved)
    );
    segments.legacySavedText = saved;
    assert.match(segments.find(segment => segment.tex?.includes('_t')).tex, /_t/u);
});

test('inserts a highlight with its formulas through the note editor', async () => {
    const harness = noteEditorHarness();
    const handle = await harness.notes.mountEditor({ replaceChildren() {} }, {
        attachmentID: 42,
        noteID: 8,
        focus: false,
    });
    const annotation = {
        type: 'highlight',
        attachmentItemID: 42,
        text: 'where \\mu is the mean',
        position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
    };
    const segments = [
        { type: 'text', text: 'where ' },
        { type: 'math', tex: '\\mu', source: '\\mu', display: false },
        { type: 'text', text: ' is the mean' },
    ];

    await handle.insertAnnotations([annotation], { segmentsFor: () => segments });

    assert.deepEqual(harness.inserted, []);
    assert.equal(harness.serialized[0][0].text, noteMathPlaceholder(0));
    assert.equal(harness.serialized[0][0].position, annotation.position);
    assert.equal(harness.posted[0], 'ensure');
    assert.equal(harness.posted[1].action, 'insertHTML');
    assert.equal(harness.posted[1].pos, null);
    assert.match(harness.posted[1].html, /<span class="math">\$\\mu\$<\/span>/u);
    assert.doesNotMatch(harness.posted[1].html, /MKTERONOTEMATH/u);
});

test('inserts the reader formulas when the saved highlight hid their subscripts', async () => {
    const harness = noteEditorHarness();
    const handle = await harness.notes.mountEditor({ replaceChildren() {} }, {
        attachmentID: 42,
        noteID: 8,
        focus: false,
    });
    const annotation = {
        type: 'highlight',
        text: String.raw`set point \hat{G}t = w(t)\hat{G}{\mathrm{genomic}}`,
    };
    const segments = [
        { type: 'text', text: 'set point ' },
        {
            type: 'math',
            tex: String.raw`\hat{G}_t = w(t)\hat{G}_{\mathrm{genomic}}`,
            source: String.raw`\hat{G}_t = w(t)\hat{G}_{\mathrm{genomic}}`,
            display: false,
        },
    ];

    segments.legacySavedText = annotation.text;
    await handle.insertAnnotations([annotation], { segmentsFor: () => segments });

    assert.deepEqual(harness.inserted, []);
    assert.match(
        harness.posted[1].html,
        /<span class="math">\$\\hat\{G\}_t = w\(t\)\\hat\{G\}_\{\\mathrm\{genomic\}\}\$<\/span>/u
    );
});

test('keeps Zotero\'s insertAnnotations when the formulas cannot be inserted', async () => {
    const annotation = { type: 'highlight', text: 'where \\mu is the mean' };
    const segments = [
        { type: 'text', text: 'where ' },
        { type: 'math', tex: '\\mu', display: false },
        { type: 'text', text: ' is the mean' },
    ];
    const cases = [
        noteEditorHarness({ instanceOverrides: { _postMessage: undefined } }),
        noteEditorHarness({ zoteroOverrides: { EditorInstanceUtilities: {} } }),
        noteEditorHarness({
            zoteroOverrides: {
                EditorInstanceUtilities: {
                    serializeAnnotations() {
                        throw new Error('serializer changed');
                    },
                },
            },
        }),
    ];
    for (const harness of cases) {
        const handle = await harness.notes.mountEditor({ replaceChildren() {} }, {
            attachmentID: 42,
            noteID: 8,
            focus: false,
        });
        await handle.insertAnnotations([annotation], { segmentsFor: () => segments });
        assert.deepEqual(harness.inserted, [[annotation]]);
        assert.equal(harness.posted.some(message => message?.action), false);
    }

    // Segments whose text is not the annotation's are not used.
    const mismatched = noteEditorHarness();
    const handle = await mismatched.notes.mountEditor({ replaceChildren() {} }, {
        attachmentID: 42,
        noteID: 8,
        focus: false,
    });
    await handle.insertAnnotations(
        [{ ...annotation, text: 'something else' }],
        { segmentsFor: () => segments }
    );
    assert.equal(mismatched.inserted.length, 1);
    assert.deepEqual(mismatched.serialized, []);

    // Without segments, the call is Zotero's own.
    const plain = noteEditorHarness();
    const plainHandle = await plain.notes.mountEditor({ replaceChildren() {} }, {
        attachmentID: 42,
        noteID: 8,
        focus: false,
    });
    await plainHandle.insertAnnotations([annotation]);
    assert.deepEqual(plain.inserted, [[annotation]]);
});

test('saves a created note again with the formulas in its highlights', async () => {
    const saved = [];
    let noteHTML = '<div data-citation-items="%5B%5D" data-schema-version="9">'
        + `<p><span class="highlight" data-annotation="${ANNOTATION}">`
        + '\u201Cwhere \\mu is the mean\u201D</span></p></div>';
    const created = {
        id: 77,
        getNote: () => noteHTML,
        setNote(html) {
            noteHTML = html;
        },
        async saveTx() {
            saved.push(noteHTML);
        },
    };
    const attachment = {
        id: 42,
        libraryID: 7,
        parentID: 9,
        isPDFAttachment: () => true,
        getAnnotations: () => [{ annotationType: 'highlight', key: 'HIGH0001' }],
    };
    const zotero = {
        Items: {
            get: id => ({
                42: attachment,
                9: { id: 9, libraryID: 7, isRegularItem: () => true },
            })[id] || null,
            async loadDataTypes() {},
        },
        EditorInstance: {
            async createNoteFromAnnotations() {
                return created;
            },
        },
        logError() {},
    };
    const notes = createZoteroNotes(zotero, { parseHTML });
    const segments = [
        { type: 'text', text: 'where ' },
        { type: 'math', tex: '\\mu', source: '\\mu', display: false },
        { type: 'text', text: ' is the mean' },
    ];

    const result = await notes.createFromAnnotations(42, {
        segmentsFor: key => (key === 'HIGH0001' ? segments : null),
    });

    assert.deepEqual(result, { noteID: 77 });
    assert.equal(saved.length, 1);
    assert.match(saved[0], /<span class="math">\$\\mu\$<\/span>/u);
    assert.match(saved[0], /data-schema-version="9"/u);

    // A rewrite that fails keeps the note Zotero created.
    created.setNote = () => {
        throw new Error('read-only');
    };
    noteHTML = noteHTML.replace(/<span class="math">[^<]*<\/span>/u, '\\mu');
    const again = await notes.createFromAnnotations(42, { segmentsFor: () => segments });
    assert.deepEqual(again, { noteID: 77 });
    assert.equal(saved.length, 1);
});

test('puts the note back when saving its formulas fails', async () => {
    const original = '<div data-schema-version="9">'
        + `<p><span class="highlight" data-annotation="${ANNOTATION}">`
        + '\u201Cwhere \\mu is the mean\u201D</span></p></div>';
    let noteHTML = original;
    const created = {
        id: 77,
        getNote: () => noteHTML,
        setNote(html) {
            noteHTML = html;
        },
        async saveTx() {
            throw new Error('database locked');
        },
    };
    const logged = [];
    const zotero = {
        Items: {
            get: id => ({
                42: {
                    id: 42,
                    libraryID: 7,
                    parentID: 9,
                    isPDFAttachment: () => true,
                    getAnnotations: () => [{ annotationType: 'highlight' }],
                },
                9: { id: 9, libraryID: 7, isRegularItem: () => true },
            })[id] || null,
            async loadDataTypes() {},
        },
        EditorInstance: {
            async createNoteFromAnnotations() {
                return created;
            },
        },
        logError: error => logged.push(error.message),
    };
    const notes = createZoteroNotes(zotero, { parseHTML });
    const segments = [
        { type: 'text', text: 'where ' },
        { type: 'math', tex: '\\mu', source: '\\mu', display: false },
        { type: 'text', text: ' is the mean' },
    ];

    const result = await notes.createFromAnnotations(42, { segmentsFor: () => segments });

    assert.deepEqual(result, { noteID: 77 });
    assert.equal(noteHTML, original);
    assert.deepEqual(logged, ['database locked']);
});
