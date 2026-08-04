import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SAVED_MARKDOWN_NOTE_KIND,
    SOURCE_MARKDOWN_ATTACHMENT_TITLE,
    SOURCE_MAP_ATTACHMENT_TITLE,
    createSavedMarkdownManifest,
    isSavedMarkdownNote,
    parseSavedMarkdownNote,
    serializeSavedMarkdownNote,
} from '../src/core/saved-markdown-note-format.js';

const manifest = createSavedMarkdownManifest({
    sourcePDFKey: 'PDFKEY1',
    sourceParentKey: 'PARENT01',
    cacheKey: 'a'.repeat(64),
    markdownHash: 'b'.repeat(64),
    parserProfile: 'mineru-v1',
    sourceAttachmentKey: 'SOURCE01',
    sourceMapAttachmentKey: 'MAP00001',
    assets: [{
        path: 'images/figure.png',
        attachmentKey: 'IMAGE001',
        mimeType: 'image/png',
    }],
    snapshotHTMLHash: 'c'.repeat(64),
    createdAt: '2026-08-04T00:00:00.000Z',
});

test('serializes and parses a marked saved Markdown note', () => {
    const html = serializeSavedMarkdownNote({
        bodyHTML: '<h1>Paper</h1><p>Safe content</p>',
        manifest,
    });

    assert.match(html, new RegExp(`data-mktero-kind="${SAVED_MARKDOWN_NOTE_KIND}"`));
    assert.match(html, /data-schema-version="9"/);
    assert.match(html, /data-mktero-source-pdf-key="PDFKEY1"/);
    assert.match(html, /<h1>Paper<\/h1>/);
    assert.equal(isSavedMarkdownNote(html), true);

    const parsed = parseSavedMarkdownNote(html);
    assert.equal(parsed.kind, SAVED_MARKDOWN_NOTE_KIND);
    assert.equal(parsed.manifest.sourcePDFKey, 'PDFKEY1');
    assert.equal(parsed.manifest.sourceAttachmentKey, 'SOURCE01');
    assert.deepEqual(parsed.manifest.assets, manifest.assets);
});

test('does not classify ordinary Zotero note HTML as a Mktero note', () => {
    const html = '<div><h1>Ordinary note</h1><p>Text</p></div>';

    assert.equal(isSavedMarkdownNote(html), false);
    assert.throws(() => parseSavedMarkdownNote(html), /saved Markdown/i);
});

test('rejects unsafe and incomplete saved note metadata', () => {
    const html = serializeSavedMarkdownNote({
        bodyHTML: '<p>Text</p>',
        manifest,
    });
    const unsafe = html.replace('PDFKEY1', 'PDF&quot; onerror=&quot;alert(1)');
    assert.equal(isSavedMarkdownNote(unsafe), false);
    assert.throws(
        () => parseSavedMarkdownNote(unsafe),
        /metadata|saved Markdown/i
    );

    const missingHash = html.replace(
        / data-mktero-markdown-hash="[^"]*"/,
        ''
    );
    assert.throws(() => parseSavedMarkdownNote(missingHash), /hash/i);
});

test('exports stable internal attachment titles', () => {
    assert.equal(SOURCE_MARKDOWN_ATTACHMENT_TITLE, 'Mktero source.md');
    assert.equal(SOURCE_MAP_ATTACHMENT_TITLE, 'Mktero source-map.json');
});
