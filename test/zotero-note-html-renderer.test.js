import test from 'node:test';
import assert from 'node:assert/strict';
import { renderZoteroNoteHTML } from '../src/markdown/zotero-note-html-renderer.js';

test('renders a portable Zotero note without remote or blob image URLs', () => {
    const html = renderZoteroNoteHTML([
        '# Paper',
        '',
        'A **safe** paragraph.',
        '',
        '![Figure](images/figure.png)',
        '',
        '$$x^2 + y^2$$',
    ].join('\n'), {
        resolveImageAttachmentKey: path => path === 'images/figure.png'
            ? 'IMAGE001'
            : null,
    });

    assert.match(html, /<h1>Paper<\/h1>/);
    assert.match(html, /<strong>safe<\/strong>/);
    assert.match(html, /<img[^>]*data-attachment-key="IMAGE001"/);
    assert.doesNotMatch(html, /(?:src|href)="(?:blob:|https?:\/\/)/i);
    assert.match(html, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"[^>]*>/);
    assert.doesNotMatch(html, /<pre class="math">\$\$/);
    assert.doesNotMatch(html, /<script|onerror|<style/i);
});

test('leaves an explicit missing image placeholder in portable notes', () => {
    const html = renderZoteroNoteHTML('![Missing](images/missing.png)', {
        resolveImageAttachmentKey: () => null,
    });

    assert.match(html, /missing-image/);
    assert.match(html, /Missing/);
});

test('keeps malicious Markdown inert in portable notes', () => {
    const html = renderZoteroNoteHTML([
        '<script>alert(1)</script>',
        '',
        '![Remote](https://example.com/tracker.png)',
        '',
        '[Unsafe](javascript:alert(1))',
    ].join('\n'));

    assert.doesNotMatch(html, /<script|onerror|src\s*=\s*["']https?:/i);
    assert.doesNotMatch(html, /href\s*=\s*["']javascript:/i);
});
