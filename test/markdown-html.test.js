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

    const html = renderMarkdownHTML(markdown);
    assert.match(html, /<span class="page-marker" data-page="2">Page 2<\/span>/);
    assert.match(html, /<h1>Intro<\/h1>/);
    assert.match(html, /<p>A <strong>bold<\/strong> and <em>useful<\/em> paragraph\.<\/p>/);
    assert.match(html, /<ul>[\s\S]*<li>First<\/li>[\s\S]*<li>Second<\/li>[\s\S]*<\/ul>/);
    assert.match(html, /<table>[\s\S]*<th>Name<\/th>[\s\S]*<td>1<\/td>[\s\S]*<\/table>/);
    assert.match(html, /<div class="math"><code>x\^2 \+ y\^2 = z\^2<\/code><\/div>/);
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
        '<p># literal * text</p>\n'
    );
});

test('renders code blocks whose content contains a shorter fence', () => {
    assert.equal(
        renderMarkdownHTML('````\nbefore\n```\nafter\n````'),
        '<pre><code>before\n```\nafter\n</code></pre>\n'
    );
});

test('preserves query parameters in safe links', () => {
    assert.equal(
        renderMarkdownHTML('[search](https://example.com/?a=1&b=2)'),
        '<p><a href="https://example.com/?a=1&amp;b=2" rel="noreferrer">search</a></p>\n'
    );
});

test('renders language fences and resolved MinerU images', () => {
    const html = renderMarkdownHTML([
        '```js',
        'const answer = 42;',
        '```',
        '',
        '![Figure 1](images/figure.png)',
    ].join('\n'), {
        resolveImageURL: path => path === 'images/figure.png'
            ? 'blob:mktero-figure'
            : null,
    });

    assert.match(html, /<code class="language-js">const answer = 42;/);
    assert.match(html, /<img src="blob:mktero-figure" alt="Figure 1">/);
});

test('does not load unresolved or external Markdown images', () => {
    const html = renderMarkdownHTML('![Remote](https://example.com/tracker.png)');

    assert.equal(html.includes('<img'), false);
    assert.match(html, /class="missing-image">Remote<\/span>/);
});

test('keeps the safe inline tags emitted by Zotero structured extraction', () => {
    const html = renderMarkdownHTML('H<sub>2</sub>O<br>next');

    assert.equal(html, '<p>H<sub>2</sub>O<br>next</p>\n');
});
