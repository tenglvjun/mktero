import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';

test('renders the Markdown subset used by the PDF converter', () => {
    const markdown = [
        '<!-- zotero-page: 2 -->',
        '',
        '# Intro',
        '',
        'A **bold** and *useful* paragraph.',
        '',
        '- First',
        '- Second',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| x | 1 |',
        '',
        '$$',
        'x^2 + y^2 = z^2',
        '$$',
    ].join('\n');

    assert.equal(renderMarkdownHTML(markdown), [
        '<span class="page-marker" data-page="2">Page 2</span>',
        '<h1>Intro</h1>',
        '<p>A <strong>bold</strong> and <em>useful</em> paragraph.</p>',
        '<ul><li>First</li><li>Second</li></ul>',
        '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>x</td><td>1</td></tr></tbody></table>',
        '<div class="math"><code>x^2 + y^2 = z^2</code></div>',
    ].join('\n'));
});

test('escapes raw HTML and refuses unsafe links', () => {
    const html = renderMarkdownHTML([
        '<script>alert(1)</script>',
        '',
        '[bad](javascript:alert(1))',
        '',
        '[good](https://example.com)',
    ].join('\n'));

    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('href="javascript:'), false);
    assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
    assert.equal(html.includes('href="https://example.com"'), true);
});

test('preserves escaped Markdown punctuation as literal text', () => {
    assert.equal(
        renderMarkdownHTML('\\# literal \\* text'),
        '<p># literal * text</p>'
    );
});

test('renders code blocks whose content contains a shorter fence', () => {
    assert.equal(
        renderMarkdownHTML('````\nbefore\n```\nafter\n````'),
        '<pre><code>before\n```\nafter</code></pre>'
    );
});

test('preserves query parameters in safe links', () => {
    assert.equal(
        renderMarkdownHTML('[search](https://example.com/?a=1&b=2)'),
        '<p><a href="https://example.com/?a=1&amp;b=2" rel="noreferrer">search</a></p>'
    );
});
