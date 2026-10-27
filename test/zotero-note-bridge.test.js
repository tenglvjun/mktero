import test from 'node:test';
import assert from 'node:assert/strict';
import {
    annotationJSONForNote,
    NOTE_SELECTION_NOT_LOCATED,
    noteBridgeError,
    selectionPartsToNoteAnnotations,
    summarizeNoteHTML,
} from '../src/core/zotero-note-bridge.js';

const LOCATED_PART = Object.freeze({
    text: 'Selected passage',
    pageLabel: '5',
    sortIndex: '00004|000001|00000',
    position: Object.freeze({
        pageIndex: 4,
        rects: Object.freeze([Object.freeze([10, 20, 30, 40])]),
    }),
});

function locatedPart(overrides = {}) {
    return {
        text: LOCATED_PART.text,
        pageLabel: LOCATED_PART.pageLabel,
        sortIndex: LOCATED_PART.sortIndex,
        position: {
            pageIndex: 4,
            rects: [[10, 20, 30, 40]],
        },
        ...overrides,
    };
}

function codeError(code) {
    return error => {
        assert.equal(error.code, code);
        assert.equal(error instanceof Error, true);
        return true;
    };
}

test('maps located parts to highlight JSON with a cloned PDF position', () => {
    assert.equal(NOTE_SELECTION_NOT_LOCATED, 'MKTERO_NOTE_SELECTION_NOT_LOCATED');
    const firstPosition = {
        pageIndex: 4,
        rects: [[10, 20, 30, 40], [50, 60, 70, 80]],
    };
    const secondPosition = {
        pageIndex: 5,
        rects: [[1, 2, 3, 4]],
    };
    const annotations = selectionPartsToNoteAnnotations([
        {
            text: 'First passage',
            pageLabel: '5',
            sortIndex: '00004|000001|00000',
            position: firstPosition,
            color: '#ff6666',
        },
        {
            text: 'Second passage',
            pageLabel: '6',
            sortIndex: '00005|000001|00000',
            position: secondPosition,
        },
    ], 42);

    assert.deepEqual(annotations, [
        {
            type: 'highlight',
            attachmentItemID: 42,
            text: 'First passage',
            comment: '',
            color: '#ffd400',
            pageLabel: '5',
            sortIndex: '00004|000001|00000',
            position: {
                pageIndex: 4,
                rects: [[10, 20, 30, 40], [50, 60, 70, 80]],
            },
        },
        {
            type: 'highlight',
            attachmentItemID: 42,
            text: 'Second passage',
            comment: '',
            color: '#ffd400',
            pageLabel: '6',
            sortIndex: '00005|000001|00000',
            position: {
                pageIndex: 5,
                rects: [[1, 2, 3, 4]],
            },
        },
    ]);
    annotations[0].position.rects[0][0] = 99;
    annotations[0].position.rects.push([0, 0, 1, 1]);
    annotations[0].position.pageIndex = 0;
    assert.equal(firstPosition.rects[0][0], 10);
    assert.equal(firstPosition.rects.length, 2);
    assert.equal(firstPosition.pageIndex, 4);
    assert.notEqual(annotations[0].position, firstPosition);
    assert.notEqual(annotations[0].position.rects[1], firstPosition.rects[1]);
});

test('refuses a selection that has no parts or no PDF position', () => {
    for (const parts of [[], null, undefined, {}]) {
        assert.throws(
            () => selectionPartsToNoteAnnotations(parts, 42),
            codeError(NOTE_SELECTION_NOT_LOCATED)
        );
    }
    assert.throws(
        () => selectionPartsToNoteAnnotations([{ text: 'orphan' }], 42),
        codeError(NOTE_SELECTION_NOT_LOCATED)
    );
    assert.throws(
        () => selectionPartsToNoteAnnotations([
            { text: 'orphan', position: null },
        ], 42),
        codeError(NOTE_SELECTION_NOT_LOCATED)
    );
});

test('refuses a selection whose attachment id is not positive', () => {
    for (const attachmentItemID of [0, -1, -42, 1.5, Number.NaN]) {
        assert.throws(
            () => selectionPartsToNoteAnnotations(
                [locatedPart()],
                attachmentItemID
            ),
            /A PDF attachment is required/
        );
    }
});

test('adds the attachment id and the annotation key for a saved note annotation', () => {
    const json = {
        type: 'highlight',
        text: 'quoted passage',
        comment: 'A comment',
        color: '#ff6666',
        pageLabel: '4',
        sortIndex: '00003|000001|00000',
        position: { pageIndex: 3, rects: [[1, 2, 3, 4]] },
        key: 'JSONKEY',
        id: 'JSONID',
    };
    const result = annotationJSONForNote(json, {
        attachmentItemID: 42,
        key: 'ITEMKEY',
    });

    assert.notEqual(result, json);
    assert.equal(json.id, 'JSONID');
    assert.equal(result.attachmentItemID, 42);
    assert.equal(result.id, 'ITEMKEY');
    assert.equal(result.key, 'JSONKEY');
    assert.equal(result.text, 'quoted passage');
    assert.equal(result.comment, 'A comment');
    assert.deepEqual(result.position, json.position);

    const fallback = annotationJSONForNote(
        { text: 'from json', key: 'FALLBACK', id: 'other' },
        { attachmentItemID: 7 }
    );
    assert.equal(fallback.id, 'FALLBACK');
    assert.equal(fallback.attachmentItemID, 7);
    assert.throws(
        () => annotationJSONForNote(null, { attachmentItemID: 1, key: 'A' }),
        /Annotation data is unavailable/
    );
});

test('uses the first note line as the title and the second as the preview', () => {
    assert.deepEqual(
        summarizeNoteHTML('<h1>Heading</h1><p>Body <b>text</b></p>'),
        { title: 'Heading', preview: 'Body text' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<div>Heading<br/>Body</div>'),
        { title: 'Heading', preview: 'Body' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<P>Heading</P><DIV>Body</DIV>'),
        { title: 'Heading', preview: 'Body' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<p> </p><p>Heading</p><p>   </p><p>Body</p>'),
        { title: 'Heading', preview: 'Body' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<p>HTML title</p><p>HTML preview</p>', {
            title: '  Zotero title  ',
        }),
        { title: 'Zotero title', preview: 'HTML preview' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<p>HTML title</p><p>HTML preview</p>', {
            title: '   ',
        }),
        { title: 'HTML title', preview: 'HTML preview' }
    );
    assert.deepEqual(summarizeNoteHTML(''), { title: '', preview: '' });
    assert.deepEqual(
        summarizeNoteHTML('<p>Only a title</p>'),
        { title: 'Only a title', preview: '' }
    );
});

test('strips tags and script or style content without returning markup', () => {
    const summary = summarizeNoteHTML([
        '<style>p { color: red; }</style>',
        '<script type="text/javascript">alert(1)</script>',
        '<SCRIPT>secret()</SCRIPT>',
        '<p>Title <em>with</em> <a href="http://example.test">link</a></p>',
        '<p>Preview <strong>text</strong></p>',
    ].join(''));

    assert.deepEqual(summary, {
        title: 'Title with link',
        preview: 'Preview text',
    });
    const plain = `${summary.title}\n${summary.preview}`;
    assert.equal(plain.includes('<'), false);
    assert.equal(plain.includes('>'), false);
    assert.equal(plain.includes('alert'), false);
    assert.equal(plain.includes('secret'), false);
    assert.equal(plain.includes('color'), false);
    assert.equal(plain.includes('href'), false);
    assert.deepEqual(
        summarizeNoteHTML('<script>alert(1)</script><style>.x{}</style>'),
        { title: '', preview: '' }
    );
    // Removing `<script>` from `<s<script>cript>` must not leave `<script`.
    // A browser reads `<s<script>` as one tag and the rest as text.
    const nested = summarizeNoteHTML('<s<script>cript>alert(1)</script><p>Kept</p>');
    const nestedPlain = `${nested.title}\n${nested.preview}`;
    assert.equal(nestedPlain.includes('<'), false);
    assert.equal(
        summarizeNoteHTML('<s<script>cript>').title.includes('<'),
        false
    );
});

test('reads note markup the way an HTML tokenizer does', () => {
    assert.deepEqual(
        summarizeNoteHTML('<p>a < b</p><p>c</p>'),
        { title: 'a < b', preview: 'c' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<p data-x="a>b" title=\'c>d\'>Text</p><p>Next</p>'),
        { title: 'Text', preview: 'Next' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<!-- <script>x</script> --><p>Shown</p>'),
        { title: 'Shown', preview: '' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<p>Kept</p><span class="cut'),
        { title: 'Kept', preview: '' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<SCRIPT>if (a < b) x()</SCRIPT ><p>After</p>'),
        { title: 'After', preview: '' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<style>p{}</styled><p>Hidden</p></style><p>Shown</p>'),
        { title: 'Shown', preview: '' }
    );
});

test('decodes note entities and ignores invalid code points', () => {
    assert.deepEqual(
        summarizeNoteHTML('<p>Fish &amp; chips &lt; &#39; &#x4e2d;</p><p>&quot;next&quot;</p>'),
        { title: "Fish & chips < ' 中", preview: '"next"' }
    );
    assert.deepEqual(
        summarizeNoteHTML('<p>A&#x110000;B&#xD800;C</p><p>D&#1114112;E&#99999999999999999999;F</p>'),
        { title: 'A&#x110000;B&#xD800;C', preview: 'D&#1114112;E&#99999999999999999999;F' }
    );
    const summary = summarizeNoteHTML('<p>&#x110000;</p><p>&#xD800;</p>');
    assert.equal(summary.title.includes('\uFFFD'), false);
    assert.doesNotMatch(summary.title, /[\uD800-\uDFFF]/);
    assert.doesNotMatch(summary.preview, /[\uD800-\uDFFF]/);
});

test('truncates long note titles and previews with an ellipsis', () => {
    const exactTitle = 'a'.repeat(120);
    const exactPreview = 'b'.repeat(200);
    assert.deepEqual(
        summarizeNoteHTML(`<p>${exactTitle}</p><p>${exactPreview}</p>`),
        { title: exactTitle, preview: exactPreview }
    );

    const summary = summarizeNoteHTML(
        `<p>${'c'.repeat(121)}</p><p>${'d'.repeat(201)}</p>`,
        { title: `  ${'Z'.repeat(130)}  ` }
    );
    assert.equal(summary.title, `${'Z'.repeat(119)}…`);
    assert.equal(summary.preview, `${'d'.repeat(199)}…`);
    assert.equal(summary.title.length, 120);
    assert.equal(summary.preview.length, 200);
    assert.equal(summary.title.endsWith('…'), true);
    assert.equal(summary.preview.endsWith('…'), true);
    assert.equal(summary.title.includes('...'), false);
    assert.equal(summary.title.includes('<'), false);
    assert.equal(summary.preview.includes('<'), false);
});

test('noteBridgeError stamps the refusal code on the error', () => {
    const error = noteBridgeError(
        'MKTERO_NOTE_EDITOR_UNAVAILABLE',
        'The note editor cannot be shown'
    );
    assert.equal(error instanceof Error, true);
    assert.equal(error.code, 'MKTERO_NOTE_EDITOR_UNAVAILABLE');
    assert.equal(error.message, 'The note editor cannot be shown');
});
