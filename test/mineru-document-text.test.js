import test from 'node:test';
import assert from 'node:assert/strict';
import {
    escapeLineStart,
    escapeMarkdownText,
    isStandaloneAddress,
    normalizeOCRText,
    renderInlineSpans,
    sanitizeTableHTML,
} from '../src/mineru/document/text.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';

// Executable markup or a live link; escaped text such as `&lt;img onerror=…&gt;` is inert.
const UNSAFE_HTML = /<(?:script|iframe|object|embed|style)\b|<[a-z][^>]*\son[a-z]+\s*=|href\s*=\s*["']?\s*javascript:|<!--/iu;

test('repairs OCR Unicode without changing meaning', () => {
    assert.equal(normalizeOCRText('Schl ¨ ogl'), 'Schlögl');
    assert.equal(normalizeOCRText('G ´ abor'), 'Gábor');
    assert.equal(normalizeOCRText('ﬁnite ﬂow ﬀ ﬃ ﬄ'), 'finite flow ff ffi ffl');
    assert.equal(normalizeOCRText('John´s'), 'John´s');
    assert.equal(normalizeOCRText('e\u0301'), 'é');
});

test('escapes Markdown syntax in OCR text', () => {
    assert.equal(escapeMarkdownText('a * b _c_ `d` \\e'), 'a \\* b \\_c\\_ \\`d\\` \\\\e');
    assert.equal(escapeMarkdownText('$5 million'), '\\$5 million');
    assert.equal(escapeMarkdownText('<script>x</script> p<0.05'), '\\<script>x\\</script> p<0.05');
    assert.equal(escapeMarkdownText('[x](javascript:alert(1))'), '[x\\](javascript:alert(1))');
    assert.equal(escapeMarkdownText('![a](b)'), '\\![a\\](b)');
    assert.equal(escapeMarkdownText('see [12] and [3, 4]'), 'see [12] and [3, 4]');
    assert.equal(escapeMarkdownText('&amp; & co'), '&amp;amp; & co');
    assert.equal(escapeMarkdownText('~~a~~ ~5'), '\\~~a\\~~ ~5');
});

test('does not escape legal URL underscores in OCR text', () => {
    assert.equal(
        escapeMarkdownText('https://reverie.herokuapp.com/UIST_Demo/'),
        'https://reverie.herokuapp.com/UIST_Demo/'
    );
    assert.equal(
        escapeMarkdownText('github.com/joonspk-research/generative_agents'),
        'github.com/joonspk-research/generative_agents'
    );
    assert.equal(escapeMarkdownText('ordinary a_b text'), 'ordinary a\\_b text');
});
test('escapes block syntax only at the start of a paragraph', () => {
    assert.equal(escapeLineStart('# 1'), '\\# 1');
    assert.equal(escapeLineStart('> quote'), '\\> quote');
    assert.equal(escapeLineStart('- item'), '\\- item');
    assert.equal(escapeLineStart('+ item'), '\\+ item');
    assert.equal(escapeLineStart('1. First'), '1\\. First');
    assert.equal(escapeLineStart('12) Second'), '12\\) Second');
    assert.equal(escapeLineStart('==='), '\\===');
    assert.equal(escapeLineStart('```js'), '\\```js');
    assert.equal(escapeLineStart('2021. A year'), '2021\\. A year');
    assert.equal(escapeLineStart('Plain text - with dash'), 'Plain text - with dash');
});

test('renders spans with inline math and tight punctuation', () => {
    assert.equal(renderInlineSpans([
        { type: 'text', content: 'applications ' },
        { type: 'math', content: '[3–5]' },
        { type: 'text', content: ' . Early (' },
        { type: 'math', content: 'x\n+ 1' },
        { type: 'text', content: ') costs $5' },
    ]), 'applications $[3–5]$. Early ($x + 1$) costs \\$5');
    assert.equal(renderInlineSpans([{ type: 'text', content: '中文' }, { type: 'text', content: '文本' }]), '中文文本');
    assert.equal(renderInlineSpans([{ type: 'math', content: '  ' }, { type: 'text', content: 'a' }]), 'a');
});

test('recognizes standalone web addresses', () => {
    assert.equal(isStandaloneAddress('www.example.org/path'), true);
    assert.equal(isStandaloneAddress('github.com/microsoft/nni/'), true);
    assert.equal(isStandaloneAddress('example.org'), false);
    assert.equal(isStandaloneAddress('see www.example.org'), false);
});

test('cleans MinerU table HTML for one Markdown block', () => {
    assert.equal(
        sanitizeTableHTML('<table><tr><td><eq>a &lt; b</eq></td></tr>\n\n<tr><td>x</td></tr></table>'),
        '<table><tr><td> $a < b$ </td></tr>  <tr><td>x</td></tr></table>'
    );
    assert.equal(sanitizeTableHTML('<div>not a table</div>'), '');
    assert.equal(sanitizeTableHTML('<table><tr><td>open'), '');
});

test('escaped adversarial OCR text renders as inert text', () => {
    const lines = [
        '<script>alert(1)</script>',
        '<!-- mktero-figure-layout: columns=2 -->',
        '[x](javascript:alert(1))',
        '$$ \\begin{x} $$',
        '`code` and ```fence```',
        '<img src=x onerror=alert(1)>',
    ];
    for (const line of lines) {
        const markdown = escapeLineStart(escapeMarkdownText(line));
        const html = renderMarkdownHTML(markdown);
        assert.doesNotMatch(html, UNSAFE_HTML, line);
        assert.doesNotMatch(html, /<a\s|<code>|class="math/iu, line);
    }
    const table = renderMarkdownHTML(sanitizeTableHTML('<table><tr><td onclick="x()"><img src=x onerror=alert(1)></td></tr></table>'));
    assert.doesNotMatch(table, UNSAFE_HTML);
});

test('moves sentence punctuation out of inline math and turns abbreviation math into text', () => {
    const line = content => renderInlineSpans([
        { type: 'text', content: 'see' }, { type: 'math', content }, { type: 'text', content: 'next' },
    ]);
    assert.equal(line('x,'), 'see $x$, next');
    assert.equal(line(', y'), 'see, $y$ next');
    assert.equal(line('0.5.'), 'see $0.5$. next');
    assert.equal(line('a \\;'), 'see $a \\;$ next');
    assert.equal(line('\\ldots.'), 'see $\\ldots$. next');
    assert.equal(line('\\mathrm { e . g . }'), 'see e.g. next');
    assert.equal(line('\\mathrm{i.e.}'), 'see i.e. next');
    assert.equal(line('\\text{etc.}'), 'see etc. next');
});

test('escapes a dollar in math once and keeps TeX escapes whole', async () => {
    const { escapeMathDollars } = await import('../src/mineru/document/text.js');
    assert.equal(escapeMathDollars('a$b'), 'a\\$b');
    assert.equal(escapeMathDollars('\\$5'), '\\$5');
    assert.equal(escapeMathDollars('x\\\\$y'), 'x\\\\\\$y');
    assert.equal(sanitizeTableHTML('<table><tr><td><eq>\\$x$</eq></td></tr></table>'),
        '<table><tr><td> $\\$x\\$$ </td></tr></table>');
});
