import test from 'node:test';
import assert from 'node:assert/strict';
import { renderZoteroNoteHTML } from '../src/markdown/zotero-note-html-renderer.js';

test('stores inline LaTeX in Zotero native math nodes', () => {
    const html = renderZoteroNoteHTML(
        'Jia-Le Yu $^{1,2,3\\dagger}$, Chen Zhang $^{4}$'
    );

    assert.match(
        html,
        /Jia-Le Yu <span class="math">\$\^\{1,2,3\\dagger\}\$<\/span>/
    );
    assert.match(
        html,
        /Chen Zhang <span class="math">\$\^\{4\}\$<\/span>/
    );
    assert.doesNotMatch(html, /<math\b|<annotation\b|class="katex"/i);
});

test('stores figure-caption LaTeX in Zotero native math nodes', () => {
    const html = renderZoteroNoteHTML(
        '![Figure 1. Model output $x^2$](images/figure.png)',
        {
            resolveImageAttachmentKey: () => 'IMAGE001',
        }
    );

    assert.match(
        html,
        /Model output <span class="math">\$x\^2\$<\/span>/
    );
    assert.doesNotMatch(html, /<math\b|<annotation\b|class="katex"/i);
});

test('stores raw-table LaTeX in Zotero native math nodes', () => {
    const html = renderZoteroNoteHTML([
        '<table>',
        '<tbody><tr><td>Estimate $x^2$</td></tr></tbody>',
        '</table>',
    ].join(''));

    assert.match(
        html,
        /Estimate <span class="math">\$x\^2\$<\/span>/
    );
    assert.doesNotMatch(html, /<math\b|<annotation\b|class="katex"/i);
});

test('keeps Zotero-native LaTeX source inert and bounded', () => {
    const html = renderZoteroNoteHTML([
        'Unsafe $\\def\\x{boom}$',
        'comparison $a < b \\mathbin{\\&} c$',
        'and oversized $\\rule{1000000em}{1000000em}$.',
    ].join(', '));

    assert.match(
        html,
        /<code class="math-fallback">\\def\\x\{boom\}<\/code>/
    );
    assert.match(
        html,
        /<span class="math">\$a &lt; b \\mathbin\{\\&amp;\} c\$<\/span>/
    );
    assert.match(
        html,
        /<code class="math-fallback">\\rule\{1000000em\}\{1000000em\}<\/code>/
    );
    assert.doesNotMatch(html, /<img\b|<script\b|onerror\s*=/i);
});

test('falls back when Zotero-native LaTeX exceeds the source budget', () => {
    const source = 'x'.repeat(10_001);
    const html = renderZoteroNoteHTML(`Before $${source}$ after`);

    assert.match(html, /<code class="math-fallback">x{100}/);
    assert.doesNotMatch(html, /<span class="math">|<math\b/i);
});

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
    assert.match(
        html,
        /<pre class="math">\$\$x\^2 \+ y\^2\$\$<\/pre>/
    );
    assert.doesNotMatch(html, /<math\b|<annotation\b|class="katex"/i);
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
