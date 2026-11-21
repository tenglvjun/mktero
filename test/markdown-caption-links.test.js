import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
    renderMarkdownHTML,
    renderTableCaptionContent,
} from '../src/markdown/markdown-html.js';
import { escapeImageDescription } from '../src/markdown/markdown-figures.js';
import { renderInlineSpans } from '../src/mineru/document/text.js';

function renderFigure(description, { target = 'mktero', escapeAlt = true, inDocument = false } = {}) {
    const source = `Figure 1. ${description}`;
    const image = `![${escapeAlt ? escapeImageDescription(source) : source}](images/f1.png)`;
    const html = renderMarkdownHTML(inDocument ? `Before.\n\n${image}\n\nAfter.` : image, {
        target,
        resolveImageURL: () => 'blob:f1',
    });
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    const caption = document.querySelector('figcaption');
    assert.ok(caption, html);
    return { html, document, caption };
}

for (const target of ['mktero', 'zotero-note', 'epub']) {
    test(`${target} renders explicit caption links with query parameters and fragments`, () => {
        const { caption } = renderFigure(
            'See [data](https://example.org/data?a=1&b=2), '
                + '[method](http://example.org/method), and [results](#results).',
            { target }
        );
        assert.deepEqual([...caption.querySelectorAll('a')].map(link => [
            link.textContent,
            link.getAttribute('href'),
            link.getAttribute('rel'),
        ]), [
            ['data', 'https://example.org/data?a=1&b=2', 'noreferrer'],
            ['method', 'http://example.org/method', 'noreferrer'],
            ['results', '#results', 'noreferrer'],
        ]);
        assert.equal(caption.textContent, 'Figure 1. See data, method, and results.');
    });

    test(`${target} rejects unsafe caption destinations while retaining their labels`, () => {
        const destinations = [
            'javascript:alert(1)',
            'JaVaScRiPt:alert(1)',
            'java&#x73;cript:alert(1)',
            'data:text/html,%3Cscript%3Ealert(1)%3C/script%3E',
            'file:///tmp/private.pdf',
            'mailto:user@example.org',
            'ftp://example.org/data',
            '//example.org/tracker',
            'https://user:password@example.org/data',
            'https://',
        ];
        const { caption } = renderFigure(destinations.map((url, index) => (
            `[unsafe_${index}](${url})`
        )).join('; '), { target });
        assert.equal(caption.querySelectorAll('a').length, 0);
        assert.equal(caption.textContent, `Figure 1. ${destinations.map((_, index) => (
            `unsafe_${index}`
        )).join('; ')}`);
    });

    test(`${target} renders math beside links and within literal link labels`, () => {
        const { caption } = renderFigure(
            String.raw`$x_1$ and [data $R^2$](https://example.org/data) with \(p < 0.05\).`,
            { target }
        );
        const link = caption.querySelector('a');
        assert.equal(link?.getAttribute('href'), 'https://example.org/data');
        assert.equal(caption.querySelectorAll('a').length, 1);
        if (target === 'zotero-note') {
            assert.equal(caption.querySelectorAll('.math').length, 3);
            assert.equal(link.querySelector('.math')?.textContent, '$R^2$');
        }
        else {
            assert.equal(caption.querySelectorAll('.math-inline').length, 3);
            assert.equal(link.querySelector('annotation')?.textContent, 'R^2');
            assert.equal(caption.querySelectorAll('msub').length, 1);
        }
    });

    test(`${target} applies its own policy to Zotero and EPUB chapter links`, () => {
        const { caption } = renderFigure(
            '[PDF](zotero://open-pdf/library/items/ABCD1234?page=2) and '
                + '[section](chapter-0002.xhtml#results) and '
                + '[invalid chapter](chapter-2.xhtml#results).',
            { target }
        );
        assert.deepEqual([...caption.querySelectorAll('a')].map(link => link.getAttribute('href')),
            target === 'epub'
                ? ['chapter-0002.xhtml#results']
                : ['zotero://open-pdf/library/items/ABCD1234?page=2']);
        assert.equal(caption.textContent, 'Figure 1. PDF and section and invalid chapter.');
    });
}

for (const escapeAlt of [false, true]) {
    for (const inDocument of [false, true]) {
        test(`renders caption links with escapeAlt=${escapeAlt} and inDocument=${inDocument}`, () => {
            const { caption } = renderFigure(
                String.raw`See [data\[v2\]\_raw](https://example.org/data_v2).`,
                { escapeAlt, inDocument }
            );
            assert.equal(caption.querySelector('a')?.textContent, 'data[v2]_raw');
            assert.equal(caption.querySelector('a')?.getAttribute('href'), 'https://example.org/data_v2');
            assert.equal(caption.textContent, 'Figure 1. See data[v2]_raw.');
        });
    }
}

for (const property of ['linkURL', 'nativeLinkURL']) {
    test(`renders image-alt links produced from ${property} spans`, () => {
        const description = renderInlineSpans([
            { type: 'text', content: 'See' },
            { type: 'text', content: 'data [v2] __init__.py *',
                [property]: 'https://example.org/source_(demo)/data_v2?a=1&b=2' },
            { type: 'text', content: 'with' },
            { type: 'math', content: 'R^2' },
        ]);
        const { caption } = renderFigure(description);
        const link = caption.querySelector('a');
        assert.equal(link?.textContent, 'data [v2] __init__.py *');
        assert.equal(link?.getAttribute('href'), 'https://example.org/source_(demo)/data_v2?a=1&b=2');
        assert.equal(caption.querySelectorAll('.math-inline').length, 1);
        assert.equal(caption.querySelector('a .math-inline'), null);
        assert.equal(caption.querySelector('em, strong'), null);
    });
}

for (const destination of [
    'https://example.org/data_(v2)',
    String.raw`https://example.org/data_\(v2\)`,
    'https://example.org/data_%28v2%29',
    '<https://example.org/data_(v2)>',
]) {
    test(`keeps URL parentheses out of caption math: ${destination}`, () => {
        const { caption } = renderFigure(`[data](${destination}) and $x$.`);
        assert.equal(caption.querySelector('a')?.getAttribute('href'),
            destination.includes('%28')
                ? 'https://example.org/data_%28v2%29'
                : 'https://example.org/data_(v2)');
        assert.equal(caption.querySelectorAll('.math-inline').length, 1);
        assert.equal(caption.querySelector('a .math-inline'), null);
    });
}

test('unescapes label punctuation without enabling emphasis, code or HTML', () => {
    const { caption } = renderFigure(
        String.raw`[\[v2\] (raw) \_data\_ \*\* \! \# \\](https://example.org/data) `
            + '[**literal** _label_ `code` <sub>2</sub>](https://example.org/label).'
    );
    assert.deepEqual([...caption.querySelectorAll('a')].map(link => link.textContent), [
        '[v2] (raw) _data_ ** ! # \\',
        '**literal** _label_ `code` <sub>2</sub>',
    ]);
    assert.equal(caption.querySelector('em, strong, code, sub, sup, br'), null);
    assert.equal(caption.querySelector('.math-inline'), null);
});

test('keeps significance stars, underscores and literal HTML beside caption links', () => {
    const { caption } = renderFigure(
        String.raw`\* $p < 0.05$; \*\* $p < 0.01$; \*\*\* $p < 0.001$; `
            + String.raw`_raw_ and **literal** and \_\_init\_\_.py <sub>2</sub> <br> `
            + '[data](https://example.org/data).'
    );
    const plain = caption.cloneNode(true);
    for (const math of plain.querySelectorAll('.math-inline')) math.replaceWith('MATH');
    assert.equal(plain.textContent,
        'Figure 1. * MATH; ** MATH; *** MATH; _raw_ and **literal** and __init__.py <sub>2</sub> <br> data.');
    assert.equal(caption.querySelector('em, strong, sub, sup, br'), null);
});

test('does not activate bare URLs, autolinks, reference syntax or image syntax in captions', () => {
    const { caption, document } = renderFigure(
        'https://example.org/bare <https://example.org/auto> [ref][key] '
            + '![remote](https://example.org/tracker.png) [safe](https://example.org/safe).'
    );
    assert.deepEqual([...caption.querySelectorAll('a')].map(link => link.textContent), ['safe']);
    assert.equal(document.querySelectorAll('img').length, 1);
    assert.match(caption.textContent, /https:\/\/example.org\/bare <https:\/\/example.org\/auto> \[ref\]\[key\] !\[remote\]/);
});

test('keeps explicit Markdown link syntax inside math from becoming a caption link', () => {
    const { caption } = renderFigure(
        String.raw`$[x](https://example.org/math)$ and [data](https://example.org/data).`
    );
    assert.equal(caption.querySelectorAll('a').length, 1);
    assert.equal(caption.querySelector('a')?.textContent, 'data');
    assert.equal(caption.querySelector('.math-inline a'), null);
});

test('does not produce nested anchors from explicit links inside a link label', () => {
    const { caption } = renderFigure(
        '[outer [inner](https://inner.example)](https://outer.example).'
    );
    assert.equal(caption.querySelectorAll('a').length, 1);
    assert.equal(caption.querySelector('a')?.getAttribute('href'), 'https://outer.example');
    assert.equal(caption.querySelector('a')?.textContent, 'outer [inner](https://inner.example)');
});

for (const length of [8192, 8193]) {
    test(`uses literal link fallback only beyond the caption link limit: ${length} characters`, () => {
        const suffix = ' [data](https://example.org/data) $x$';
        const description = 'x'.repeat(length - suffix.length) + suffix;
        const html = renderTableCaptionContent({ label: 'Table 1.', description });
        const { document } = parseHTML(html);
        assert.equal(document.querySelectorAll('a').length, length === 8192 ? 1 : 0);
        assert.equal(document.querySelectorAll('.math-inline').length, 1);
        assert.equal(document.querySelector('annotation')?.textContent, 'x');
    });
}

test('preserves image-alt TeX escapes and source positions around caption links', () => {
    const { caption } = renderFigure(
        String.raw`$\alpha_i$ and [fit $\beta_j$](https://example.org/fit) with \(\gamma_k\).`
    );
    assert.deepEqual([...caption.querySelectorAll('annotation')].map(node => node.textContent), [
        '\\alpha_i', '\\beta_j', '\\gamma_k',
    ]);
    assert.equal(caption.querySelector('a annotation')?.textContent, '\\beta_j');
    assert.equal(caption.querySelector('a')?.getAttribute('href'), 'https://example.org/fit');
});

test('does not parse images or links recursively within a caption link label', () => {
    const { caption, document } = renderFigure(
        '[outer ![image [inner](https://inner.example)](https://example.org/tracker.png)]'
            + '(https://outer.example).'
    );
    assert.equal(caption.querySelectorAll('a').length, 1);
    assert.equal(caption.querySelector('a')?.getAttribute('href'), 'https://outer.example');
    assert.equal(caption.querySelector('a')?.textContent,
        'outer ![image [inner](https://inner.example)](https://example.org/tracker.png)');
    assert.equal(document.querySelectorAll('img').length, 1);
});

test('falls back to literal links and bounded math for a long adversarial caption', () => {
    const brackets = '['.repeat(32_000) + ']'.repeat(32_000);
    const description = `${brackets} [data](https://example.org/data) <script>alert(1)</script> $x_1$`;
    const startedAt = performance.now();
    const html = renderTableCaptionContent({ label: 'Table 1.', description });
    const elapsed = performance.now() - startedAt;
    const { document } = parseHTML(html);
    assert.ok(elapsed < 1500, `caption rendering took ${elapsed.toFixed(0)}ms`);
    assert.equal(document.querySelector('a, img, script'), null);
    assert.equal(document.querySelectorAll('.math-inline').length, 1);
    assert.equal(document.querySelector('annotation')?.textContent, 'x_1');
    assert.ok(html.includes(`${brackets} [data](https://example.org/data) &lt;script&gt;alert(1)&lt;/script&gt; `));
});

test('keeps HTML and attribute injection inert in link labels and destinations', () => {
    const { caption, document } = renderFigure(
        '[<img src=x onerror="alert(1)"><script>alert(2)</script><sub>3</sub>]'
            + '(https://example.org/safe "\\\" onclick=\\\"alert(3)") '
            + '[encoded](https://example.org/?q=%22%20onclick=%22alert%284%29) '
            + '[quotes](<https://example.org/?q=" onmouseover="alert(5)>) '
            + '$\\href{javascript:alert(6)}{x}$'
    );
    assert.equal(caption.querySelector('img, script, sub, iframe, svg'), null);
    assert.equal(document.querySelectorAll('img').length, 1);
    assert.equal(document.querySelector('[onclick], [onerror], [onmouseover]'), null);
    assert.equal(caption.querySelector('a')?.textContent,
        '<img src=x onerror="alert(1)"><script>alert(2)</script><sub>3</sub>');
    assert.ok([...caption.querySelectorAll('a')].every(link => (
        link.getAttribute('href').startsWith('https://example.org/')
    )));
});

test('renders links and math in a shared caption for multiple image panels', () => {
    const html = renderMarkdownHTML([
        '![](images/a.png)',
        '',
        '![](images/b.png)',
        '',
        'Figure 2. See [data](https://example.org/data) and $R^2$.',
    ].join('\n'), { resolveImageURL: () => 'blob:panel' });
    const { document } = parseHTML(html);
    assert.equal(document.querySelector('figcaption a')?.getAttribute('href'), 'https://example.org/data');
    assert.equal(document.querySelectorAll('figcaption .math-inline').length, 1);
    assert.equal(document.querySelectorAll('img').length, 2);
});

test('renders safe table caption links with the same literal punctuation policy', () => {
    const html = renderTableCaptionContent({
        label: 'Table 1.',
        description: '[**data**](https://example.org/data) _raw_ $R^2$ <sub>2</sub>',
    });
    const { document } = parseHTML(html);
    assert.equal(document.querySelector('a')?.textContent, '**data**');
    assert.equal(document.querySelector('.math-inline annotation')?.textContent, 'R^2');
    assert.equal(document.querySelector('em, strong, sub'), null);
    assert.equal(document.querySelector('.mktero-table-label')?.textContent, 'Table 1.');
});

test('shares the document math budget across linked labels and ordinary caption math', () => {
    const description = '[data $x$](https://example.org/data) '
        + '$x$ '.repeat(999) + '[last $z$](https://example.org/last) $y$';
    const html = renderTableCaptionContent({ label: 'Table 1.', description });
    const { document } = parseHTML(html);
    assert.equal(document.querySelectorAll('a').length, 2);
    assert.equal(document.querySelectorAll('math').length, 1_000);
    assert.equal(document.querySelectorAll('.math-fallback').length, 2);
    assert.equal(document.querySelector('a:last-of-type .math-fallback')?.textContent, 'z');
});

test('keeps unsafe math inert inside caption link labels', () => {
    const html = renderTableCaptionContent({
        label: 'Table 1.',
        description: '[unsafe $\\def\\x{1}$](https://example.org/unsafe)',
    });
    const { document } = parseHTML(html);
    assert.equal(document.querySelectorAll('a').length, 1);
    assert.equal(document.querySelectorAll('math').length, 0);
    assert.equal(document.querySelector('a .math-fallback')?.textContent, '\\def\\x{1}');
});

test('keeps oversized math bounded when a caption link falls back to text', () => {
    const html = renderTableCaptionContent({
        label: 'Table 1.',
        description: `[large $${'x'.repeat(10_001)}$](https://example.org/large)`,
    });
    const { document } = parseHTML(html);
    assert.equal(document.querySelectorAll('a, math').length, 0);
    assert.equal(document.querySelectorAll('.math-fallback').length, 1);
});

test('handles long literal significance markers without recursively parsing emphasis', () => {
    const html = renderTableCaptionContent({
        label: 'Table 1.',
        description: `[${'*'.repeat(3_000)}data${'*'.repeat(3_000)}](https://example.org/data)`,
    });
    const { document } = parseHTML(html);
    assert.equal(document.querySelector('a')?.textContent, `${'*'.repeat(3_000)}data${'*'.repeat(3_000)}`);
    assert.equal(document.querySelector('em, strong'), null);
});
