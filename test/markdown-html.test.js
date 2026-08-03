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
    assert.match(html, /class="math math-display"/);
    assert.match(html, /<math[^>]+display="block"/);
    assert.match(html, /<msup>/);
    assert.doesNotMatch(html, /<div class="math"><code>/);
});

test('renders MinerU inline LaTeX footnote markers as MathML', () => {
    const html = renderMarkdownHTML(
        'Serge A. Steenen $^{a,b,*}$, Fabienne Linke $^{b}$'
    );

    assert.match(html, /class="math-inline"/);
    assert.match(html, /<math/);
    assert.match(html, /<msup>/);
    assert.doesNotMatch(html, /\$\^\{/);
});

test('renders display LaTeX fractions as block MathML', () => {
    const html = renderMarkdownHTML('$$\n\\frac{x^2}{y_1}\n$$');

    assert.match(html, /class="math math-display"/);
    assert.match(html, /<math[^>]+display="block"/);
    assert.match(html, /<mfrac>/);
    assert.match(html, /<annotation encoding="application\/x-tex">\\frac/);
});

test('splits display LaTeX from following Markdown without a blank line', () => {
    const html = renderMarkdownHTML([
        '$$',
        'x^2',
        '$$',
        'Next **paragraph**',
        '\\[',
        'y_1',
        '\\]',
        'Last paragraph',
    ].join('\n'));

    assert.equal((html.match(/class="math math-display"/g) || []).length, 2);
    assert.match(html, /<\/div>\n<p>Next <strong>paragraph<\/strong><\/p>/);
    assert.match(html, /<msup>/);
    assert.match(html, /<msub>/);
    assert.match(html, /<p>Last paragraph<\/p>/);
});

test('supports bracket delimiters and leaves code spans literal', () => {
    const html = renderMarkdownHTML([
        'Inline \\(x_1 + x_2\\) and code `$x$`.',
        '',
        '\\[',
        '\\sum_{i=1}^{n} i',
        '\\]',
    ].join('\n'));

    assert.match(html, /class="math-inline"/);
    assert.match(html, /<msub>/);
    assert.match(html, /class="math math-display"/);
    assert.match(html, /<munderover>/);
    assert.match(html, /<code>\$x\$<\/code>/);
});

test('preserves escaped currency dollars as literal text', () => {
    assert.equal(renderMarkdownHTML('Cost: \\$5'), '<p>Cost: $5</p>\n');
});

test('renders whitespace-padded and escaped inline TeX', () => {
    const html = renderMarkdownHTML(
        'Padded $ x + y $; percent $x+\\%$; dollar $\\$USD$; paren \\( y \\)'
    );

    assert.equal((html.match(/class="math-inline"/g) || []).length, 4);
    assert.doesNotMatch(html, /class="katex-error"/);
    assert.match(html, /<annotation encoding="application\/x-tex">\\\$USD<\/annotation>/);
});

test('preserves emphasis and links around inline LaTeX', () => {
    const html = renderMarkdownHTML(
        '**bold $x^2$**, *italic \\(y_1\\)*, and [linked $z$](https://example.com)'
    );

    assert.match(html, /<strong>bold <span class="math-inline">/);
    assert.match(html, /<em>italic <span class="math-inline">/);
    assert.match(html, /<a href="https:\/\/example\.com"[^>]*>linked <span class="math-inline">/);
    assert.equal((html.match(/class="math-inline"/g) || []).length, 3);
});

test('does not let Markdown emphasis split LaTeX expressions', () => {
    const html = renderMarkdownHTML([
        '$a*b*c$',
        '$\\text{a *word* here}$',
        '$[x](y)$',
        '\\(d*e*f\\)',
        '**outer $g*h*i$ text**',
    ].join(' '));

    assert.equal((html.match(/class="math-inline"/g) || []).length, 5);
    assert.doesNotMatch(html, /\$a<em>/);
    assert.doesNotMatch(html, /href="y"/);
    assert.match(html, /<strong>outer <span class="math-inline">/);
    assert.match(html, /application\/x-tex">\\text\{a \*word\* here\}<\/annotation>/);
});

test('renders display LaTeX inside tight list items', () => {
    const html = renderMarkdownHTML([
        '- $$ x^2 $$',
        '  First item text',
        '- \\[ y_1 \\]',
        '  Second item text',
    ].join('\n'));

    assert.equal((html.match(/class="math math-display"/g) || []).length, 2);
    assert.match(html, /<li><div class="math math-display">/);
    assert.match(html, /<msup>/);
    assert.match(html, /<msub>/);
    assert.match(html, /First item text/);
    assert.match(html, /Second item text/);
});

test('splits display LaTeX from following text inside a blockquote', () => {
    const html = renderMarkdownHTML([
        '> $$',
        '> z^2',
        '> $$',
        '> Quoted text',
    ].join('\n'));

    assert.match(html, /<blockquote>[\s\S]*class="math math-display"/);
    assert.match(html, /<blockquote>[\s\S]*<p>Quoted text<\/p>/);
});

test('falls back without invoking KaTeX for an oversized formula', () => {
    const source = 'x'.repeat(10_001);
    const html = renderMarkdownHTML(`$${source}$`);

    assert.match(html, /class="math-fallback"/);
    assert.doesNotMatch(html, /<math/);
});

test('keeps invalid LaTeX visible without failing Markdown rendering', () => {
    const html = renderMarkdownHTML('Bad $\\frac{$ formula');

    assert.match(html, /class="katex-error"/);
    assert.match(html, /\\frac\{/);
});

test('does not let currency text consume a later formula delimiter', () => {
    const html = renderMarkdownHTML('Price $5 and formula $x$; then $y$2 and $z$');

    assert.match(html, /Price \$5 and formula/);
    assert.equal((html.match(/class="math-inline"/g) || []).length, 2);
    assert.match(html, /application\/x-tex">x<\/annotation>/);
    assert.match(html, /application\/x-tex">z<\/annotation>/);
});

test('handles many rejected dollar candidates in linear time', () => {
    const markdown = '$1'.repeat(32_000);
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.doesNotMatch(html, /class="math-inline"/);
});

test('handles many unmatched parenthesis delimiters in linear time', () => {
    const markdown = '\\('.repeat(32_000);
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.doesNotMatch(html, /class="math-inline"/);
});

test('handles many unmatched display delimiters in linear time', () => {
    const markdown = '\\[\n'.repeat(16_000);
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.doesNotMatch(html, /class="math math-display"/);
});

test('does not rescan long ordinary Markdown at every inline boundary', () => {
    const markdown = [
        '**word** '.repeat(6_000),
        '[word](https://example.com) '.repeat(2_500),
    ].join('\n\n');
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.match(html, /<strong>word<\/strong>/);
    assert.match(html, /<a href="https:\/\/example\.com"/);
});

test('handles many valid inline formulas in linear time', () => {
    const markdown = '$x$ '.repeat(16_000);
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.match(html, /class="math-inline"/);
});

test('handles formulas split by Markdown tokens in linear time', () => {
    const markdown = '$a*b*c$ '.repeat(8_000);
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.match(html, /class="math-inline"/);
    assert.doesNotMatch(html, /\$a<em>/);
});

test('handles large block and inline token arrays without argument overflow', () => {
    const inlineMarkdown = `${'**x** '.repeat(60_000)}$y$`;
    const displayMarkdown = '$$ x $$\ntext\n'.repeat(60_000);

    assert.doesNotThrow(() => renderMarkdownHTML(inlineMarkdown));
    assert.doesNotThrow(() => renderMarkdownHTML(displayMarkdown));
});

test('preserves Markdown after an unmatched parenthesis delimiter', () => {
    const html = renderMarkdownHTML(
        'Text \\( unmatched **bold**, [link](https://example.com), and `code`'
    );

    assert.match(html, /Text \( unmatched/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<a href="https:\/\/example\.com"/);
    assert.match(html, /<code>code<\/code>/);
});

test('does not cross asymmetrically padded formula delimiters', () => {
    const html = renderMarkdownHTML('Variable $ x is unknown and formula $y$');

    assert.match(html, /Variable \$ x is unknown and formula/);
    assert.equal((html.match(/class="math-inline"/g) || []).length, 1);
    assert.match(html, /application\/x-tex">y<\/annotation>/);
});

test('does not expand user-defined TeX macros', () => {
    const html = renderMarkdownHTML('$\\def\\a{xxxxxxxxxx}\\a\\a$');

    assert.match(html, /class="math-fallback"/);
    assert.doesNotMatch(html, /<math/);
});

test('falls back after the document-wide MathML output budget is exhausted', () => {
    const formula = Array.from({ length: 800 }, () => 'x').join('+');
    const markdown = Array.from({ length: 60 }, () => `$${formula}$`).join(' ');
    const html = renderMarkdownHTML(markdown);

    assert.match(html, /<math/);
    assert.match(html, /class="math-fallback"/);
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

test('renders a paired MinerU algorithm wrapper without visible HTML tags', () => {
    const html = renderMarkdownHTML([
        '<div class="mineru-algorithm" style="white-space: pre-wrap; font-family:monospace;">',
        'Algorithm 1: Continual learning',
        '',
        'Input: task $T_{i}$',
        '',
        'Training Stage:',
        '    Optimize $C_{i}$;',
        '</div>',
    ].join('\n'));

    assert.match(html, /^<section class="mktero-algorithm">/);
    assert.match(html, /Algorithm 1: Continual learning/);
    assert.match(html, /class="math-inline"/);
    assert.match(html, /<msub>/);
    assert.doesNotMatch(html, /&lt;\/?div|<div/i);
});

test('keeps unmatched and unrelated div tags inert and visible', () => {
    const unmatched = renderMarkdownHTML('Result\n\n</div>');
    const unrelated = renderMarkdownHTML([
        '<div class="other">',
        'Unsafe wrapper',
        '</div>',
    ].join('\n'));

    assert.match(unmatched, /&lt;\/div&gt;/);
    assert.match(unrelated, /&lt;div class=&quot;other&quot;&gt;/);
    assert.match(unrelated, /&lt;\/div&gt;/);
    assert.doesNotMatch(unrelated, /<div class="other">/);
});

test('does not trust HTML nested inside a MinerU algorithm wrapper', () => {
    const html = renderMarkdownHTML([
        '<div class="mineru-algorithm" onclick="alert(1)">',
        '<script>alert(2)</script>',
        '',
        'Safe algorithm text.',
        '</div>',
    ].join('\n'));

    assert.match(html, /^<section class="mktero-algorithm">/);
    assert.match(html, /Safe algorithm text/);
    assert.doesNotMatch(html, /onclick|<script/i);
    assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
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

test('does not create nested links when LaTeX appears in a URL label', () => {
    const bareURL = renderMarkdownHTML('https://example.com/$x$');
    const linkedURL = renderMarkdownHTML(
        '[visit https://example.com/$y$](https://outer.example)'
    );

    assert.equal((bareURL.match(/<a /g) || []).length, 1);
    assert.equal((linkedURL.match(/<a /g) || []).length, 1);
    assert.equal((bareURL.match(/class="math-inline"/g) || []).length, 1);
    assert.equal((linkedURL.match(/class="math-inline"/g) || []).length, 1);
    assert.match(linkedURL, /href="https:\/\/outer\.example"/);
});

test('preserves reference links when formulas split Markdown tokens', () => {
    const html = renderMarkdownHTML([
        '$x$ [Inline reference][paper]',
        '',
        '$$',
        'y^2',
        '$$',
        '[Block reference][paper]',
        '',
        '[paper]: https://example.com/paper',
    ].join('\n'));

    assert.equal((html.match(/href="https:\/\/example\.com\/paper"/g) || []).length, 2);
    assert.equal((html.match(/class="math-inline"/g) || []).length, 1);
    assert.equal((html.match(/class="math math-display"/g) || []).length, 1);
    assert.doesNotMatch(html, /\[Inline reference\]\[paper\]/);
    assert.doesNotMatch(html, /\[Block reference\]\[paper\]/);
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

test('renders a standalone academic image description as a visible figure caption', () => {
    const caption = 'Figure 1. PRISMA flowchart of inclusion of studies.';
    const html = renderMarkdownHTML(
        `![${caption}](images/figure.png)`,
        { resolveImageURL: () => 'blob:mktero-figure' }
    );

    assert.equal(
        html,
        '<figure class="mktero-figure">'
            + `<img src="blob:mktero-figure" alt="${caption}">`
            + '<figcaption>'
            + '<span class="mktero-figure-label">Figure 1.</span>'
            + ' PRISMA flowchart of inclusion of studies.'
            + '</figcaption>'
            + '</figure>\n'
    );
});

test('renders inline LaTeX in an academic image caption', () => {
    const html = renderMarkdownHTML(
        '![Fig. 2. Progress from $M_{0}$ to '
            + '$M_{1},\\\\ldots,M_{N}$.](images/figure.png)',
        { resolveImageURL: () => 'blob:mktero-figure' }
    );

    assert.equal((html.match(/class="math-inline"/g) || []).length, 2);
    assert.match(
        html,
        /<figcaption><span class="mktero-figure-label">Fig\. 2\.<\/span>/
    );
    assert.match(html, /<msub><mi>M<\/mi><mn>0<\/mn><\/msub>/);
    assert.match(
        html,
        /application\/x-tex">M_\{1\},\\ldots,M_\{N\}<\/annotation>/
    );
    assert.match(
        html,
        /alt="Fig\. 2\. Progress from M_\{0\} to M_\{1\},\\ldots,M_\{N\}\."/
    );
});

test('keeps unsafe LaTeX and HTML inert in an academic image caption', () => {
    const html = renderMarkdownHTML(
        '![Fig. 2. Unsafe $\\\\def\\\\x{1}$ '
            + '<SCRIPT>alert(1)</SCRIPT>.](images/figure.png)',
        { resolveImageURL: () => 'blob:mktero-figure' }
    );

    assert.match(html, /<code class="math-fallback">\\def\\x\{1\}<\/code>/);
    assert.match(html, /&lt;SCRIPT&gt;alert\(1\)&lt;\/SCRIPT&gt;/);
    assert.doesNotMatch(html, /<script>/i);
});

test('keeps unsafe caption content inert in a marked vertical figure group', () => {
    const html = renderMarkdownHTML([
        '(A)   ',
        '![](images/panel-a.jpg)   ',
        '(B)',
        '',
        '![Fig. 5 Results for (a) safe and (b) <script>alert(1)</script>.]'
            + '(images/panel-b.jpg)',
    ].join('\n'), {
        resolveImageURL: path => `blob:mktero-${path}`,
    });

    assert.match(html, /mktero-figure-group-vertical/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/i);
});

test('renders consecutive image panels with one shared academic caption', () => {
    const caption = 'Figure 2. Anxiety & depression outcomes.';
    const html = renderMarkdownHTML([
        `${caption}  `,
        '![](images/panel-a.jpg)',
        '',
        '![](images/panel-b.jpg)',
    ].join('\n'), {
        resolveImageURL: path => `blob:mktero-${path}`,
    });

    assert.equal(
        html,
        '<figure class="mktero-figure mktero-figure-group">'
            + '<img src="blob:mktero-images/panel-a.jpg" alt="">'
            + '<img src="blob:mktero-images/panel-b.jpg" alt="">'
            + '<figcaption>'
            + '<span class="mktero-figure-label">Figure 2.</span>'
            + ' Anxiety &amp; depression outcomes.'
            + '</figcaption>'
            + '</figure>\n'
    );
});

test('keeps repeated extracted axis labels with their shared-caption panels', () => {
    const html = renderMarkdownHTML([
        '![](images/ppg.jpg)  ',
        'Time (s)',
        '',
        '![](images/abp.jpg)  ',
        'Time (s)  ',
        'Fig. 1. SBP and DBP estimation from PPG (left) and ABP (right) signals.',
    ].join('\n'), {
        resolveImageURL: path => `blob:mktero-${path}`,
    });

    assert.equal(
        html,
        '<figure class="mktero-figure mktero-figure-group">'
            + '<div class="mktero-figure-panel">'
            + '<img src="blob:mktero-images/ppg.jpg" alt="">'
            + '<div class="mktero-figure-panel-label">Time (s)</div>'
            + '</div>'
            + '<div class="mktero-figure-panel">'
            + '<img src="blob:mktero-images/abp.jpg" alt="">'
            + '<div class="mktero-figure-panel-label">Time (s)</div>'
            + '</div>'
            + '<figcaption>'
            + '<span class="mktero-figure-label">Fig. 1.</span>'
            + ' SBP and DBP estimation from PPG (left) and ABP (right) signals.'
            + '</figcaption>'
            + '</figure>\n'
    );
});

test('does not treat different prose lines between images as panel labels', () => {
    const html = renderMarkdownHTML([
        '![](images/first.jpg)  ',
        'First result needs discussion.',
        '',
        '![](images/second.jpg)  ',
        'Second result needs separate discussion.  ',
        'Fig. 3. Comparison of both results.',
    ].join('\n'), {
        resolveImageURL: path => `blob:mktero-${path}`,
    });

    assert.doesNotMatch(html, /mktero-figure-group/);
    assert.match(html, /First result needs discussion\./);
    assert.match(html, /Second result needs separate discussion\./);
});

test('keeps extracted panel labels inert when grouping figures', () => {
    const html = renderMarkdownHTML([
        '![](images/first.jpg)  ',
        'Time <script>alert(1)</script> (s)',
        '',
        '![](images/second.jpg)  ',
        'Time <script>alert(1)</script> (s)  ',
        'Fig. 4. Unsafe extracted axis labels.',
    ].join('\n'), {
        resolveImageURL: path => `blob:mktero-${path}`,
    });

    assert.match(html, /mktero-figure-group/);
    assert.match(html, /Time &lt;script&gt;alert\(1\)&lt;\/script&gt; \(s\)/);
    assert.doesNotMatch(html, /<script>/i);
});

test('keeps academic-looking descriptions on inline images inline', () => {
    const html = renderMarkdownHTML(
        'See ![Figure 1. Participant flow.](images/figure.png) for details.',
        { resolveImageURL: () => 'blob:mktero-figure' }
    );

    assert.doesNotMatch(html, /<figure/);
    assert.match(
        html,
        /<p>See <img src="blob:mktero-figure" alt="Figure 1\. Participant flow\."> for details\.<\/p>/
    );
});

test('escapes visible academic captions independently from image attributes', () => {
    const html = renderMarkdownHTML(
        '![Figure 2. A & B <script>.](images/figure.png)',
        { resolveImageURL: () => 'blob:mktero-figure' }
    );

    assert.match(html, /alt="Figure 2\. A &amp; B &lt;script&gt;\."/);
    assert.match(
        html,
        /<figcaption><span class="mktero-figure-label">Figure 2\.<\/span> A &amp; B &lt;script&gt;\.<\/figcaption>/
    );
    assert.doesNotMatch(html, /<script>/);
});

test('does not load unresolved or external Markdown images', () => {
    const html = renderMarkdownHTML('![Remote](https://example.com/tracker.png)');

    assert.equal(html.includes('<img'), false);
    assert.match(html, /class="missing-image">Remote<\/span>/);
});

test('keeps LaTeX in image alt text plain and accessible', () => {
    const missing = renderMarkdownHTML('![$x$](missing.png)');
    const resolved = renderMarkdownHTML('![$x$](figure.png)', {
        resolveImageURL: () => 'blob:mktero-figure',
    });

    assert.match(missing, /class="missing-image">x<\/span>/);
    assert.doesNotMatch(missing, /&lt;span/);
    assert.match(resolved, /alt="x"/);
    assert.doesNotMatch(resolved, /alt="[^"]*&lt;/);
});

test('keeps the safe inline tags emitted by Zotero structured extraction', () => {
    const html = renderMarkdownHTML('H<sub>2</sub>O<br>next');

    assert.equal(html, '<p>H<sub>2</sub>O<br>next</p>\n');
});

test('renders compact raw HTML tables emitted by MinerU', () => {
    const html = renderMarkdownHTML(
        '<table><tr><td>Title {1}</td><td>Value</td></tr></table>'
    );

    assert.equal(
        html,
        '<table><tr><td>Title {1}</td><td>Value</td></tr></table>'
    );
    assert.doesNotMatch(html, /&lt;table&gt;/);
});

test('renders a MinerU table caption as the native table caption', () => {
    const html = renderMarkdownHTML([
        'Table 3 Means & standard deviations of desired emotions',
        '',
        '<table><tr><td>Measure</td><td>m</td><td>SD</td></tr></table>',
    ].join('\n'));

    assert.equal(
        html,
        '<table><caption>'
            + '<span class="mktero-table-label">Table 3</span>'
            + ' Means &amp; standard deviations of desired emotions'
            + '</caption><tr><td>Measure</td><td>m</td><td>SD</td></tr></table>'
    );
});

test('renders a MinerU split table heading and description as one captioned table', () => {
    const html = renderMarkdownHTML([
        '## Table 2',
        '',
        'PICO criteria for inclusion and exclusion in systematic review.',
        '',
        '<table><tr><td>Parameters</td><td>Inclusion Criteria</td></tr></table>',
    ].join('\n'));

    assert.equal(
        html,
        '<table><caption>'
            + '<span class="mktero-table-label">Table 2</span>'
            + ' PICO criteria for inclusion and exclusion in systematic review.'
            + '</caption><tr><td>Parameters</td>'
            + '<td>Inclusion Criteria</td></tr></table>'
    );
});

test('renders a split plain-text Roman table label as one captioned table', () => {
    const html = renderMarkdownHTML([
        'TABLE I  ',
        'OVERVIEW OF DOWNSTREAM BCI TASKS AND DATASETS.',
        '',
        '<table><tr><td>BCI Tasks</td><td>Datasets</td></tr></table>',
    ].join('\n'));

    assert.equal(
        html,
        '<table><caption>'
            + '<span class="mktero-table-label">TABLE I</span>'
            + ' OVERVIEW OF DOWNSTREAM BCI TASKS AND DATASETS.'
            + '</caption><tr><td>BCI Tasks</td>'
            + '<td>Datasets</td></tr></table>'
    );
});

test('renders a blank-line-separated plain-text table label and description as one caption', () => {
    const html = renderMarkdownHTML([
        'TABLE V',
        '',
        'COMPARISON OF DIFFERENT ADAPTATION PARADIGMS.',
        '',
        '<table><tr><td>Paradigm</td><td>Performance</td></tr></table>',
    ].join('\n'));

    assert.equal(
        html,
        '<table><caption>'
            + '<span class="mktero-table-label">TABLE V</span>'
            + ' COMPARISON OF DIFFERENT ADAPTATION PARADIGMS.'
            + '</caption><tr><td>Paradigm</td>'
            + '<td>Performance</td></tr></table>'
    );
});

test('does not group a blank-line-separated table label across extra prose', () => {
    const html = renderMarkdownHTML([
        'TABLE V',
        '',
        'Comparison of adaptation paradigms.',
        '',
        'This separate paragraph explains the evaluation.',
        '',
        '<table><tr><td>Paradigm</td></tr></table>',
    ].join('\n'));

    assert.doesNotMatch(html, /<caption>/);
    assert.match(html, /^<p>TABLE V<\/p>/);
    assert.match(html, /<p>This separate paragraph explains the evaluation\.<\/p>/);
});

test('escapes markup in a MinerU split table description', () => {
    const html = renderMarkdownHTML([
        '## Table 2',
        '',
        'Results <img src=x onerror="alert(1)">',
        '',
        '<table><tr><td>Safe</td></tr></table>',
    ].join('\n'));

    assert.match(
        html,
        /<caption><span class="mktero-table-label">Table 2<\/span> Results &lt;img/
    );
    assert.doesNotMatch(html, /<caption>[\s\S]*<img/i);
    assert.doesNotMatch(html, /onerror="alert\(1\)"/);
});

test('renders academic table captions throughout a Markdown document', () => {
    const html = renderMarkdownHTML([
        'Before',
        '',
        'Table 1 First results',
        '',
        '<table><tr><td>One</td></tr></table>',
        '',
        'Between',
        '',
        'Table 2 Second results',
        '',
        '<table><tr><td>Two</td></tr></table>',
        '',
        'After',
    ].join('\n'));

    assert.match(html, /^<p>Before<\/p>/);
    assert.match(html, /<p>Between<\/p>/);
    assert.match(html, /<p>After<\/p>\n$/);
    assert.equal(html.match(/<caption>/g)?.length, 2);
    assert.match(
        html,
        /<caption><span class="mktero-table-label">Table 1<\/span> First results<\/caption>/
    );
    assert.match(
        html,
        /<caption><span class="mktero-table-label">Table 2<\/span> Second results<\/caption>/
    );
    assert.doesNotMatch(html, /<p>Table [12]/);
});

test('preserves reference definitions across a captioned table', () => {
    const html = renderMarkdownHTML([
        'Read [the results][results].',
        '',
        'Table 1 Results',
        '',
        '<table><tr><td>Score</td><td>42</td></tr></table>',
        '',
        '[results]: https://example.com/results',
    ].join('\n'));

    assert.match(
        html,
        /<a href="https:\/\/example\.com\/results" rel="noreferrer">the results<\/a>/
    );
    assert.match(html, /<caption>/);
});

test('renders a caption above a multiline raw HTML table', () => {
    const html = renderMarkdownHTML([
        'Table 3 Multiline results',
        '',
        '<table>',
        '<tr><td>Measure</td><td>Value</td></tr>',
        '<tr><td>Score</td><td>42</td></tr>',
        '</table>',
    ].join('\n'));

    assert.match(
        html,
        /^<table><caption><span class="mktero-table-label">Table 3<\/span> Multiline results<\/caption>/
    );
    assert.match(html, /<tr><td>Score<\/td><td>42<\/td><\/tr>/);
    assert.doesNotMatch(html, /<p>Table 3/);
});

test('renders inline LaTeX inside raw HTML table cells', () => {
    const html = renderMarkdownHTML(
        '<table><tr><td>Key</td><td>C major is $C^{\\#}/D^b$</td></tr></table>'
    );

    assert.match(html, /<td>C major is <span class="math-inline">/);
    assert.match(html, /<math/);
    assert.match(html, /<msup>/);
    assert.doesNotMatch(html, /\$C\^\{/);
});

test('renders parenthesized LaTeX inside raw HTML table headers', () => {
    const html = renderMarkdownHTML(
        '<table><tr><th>\\(x^2\\)</th><td>$y$</td></tr></table>'
    );

    assert.equal((html.match(/class="math-inline"/g) || []).length, 2);
    assert.match(html, /<th><span class="math-inline">[\s\S]*<msup>/);
    assert.match(html, /application\/x-tex">x\^2<\/annotation>/);
});

test('keeps code literal while rendering adjacent raw table math', () => {
    const html = renderMarkdownHTML(
        '<table><tr><td><code>$x$</code></td><td>$y$</td></tr></table>'
    );

    assert.match(html, /<td><code>\$x\$<\/code><\/td>/);
    assert.equal((html.match(/class="math-inline"/g) || []).length, 1);
    assert.match(html, /application\/x-tex">y<\/annotation>/);
});

test('shares the document-wide math budget with raw table formulas', () => {
    const cells = Array.from(
        { length: 1_000 },
        () => '<td>$x$</td>'
    ).join('');
    const html = renderMarkdownHTML(
        `<table><tr>${cells}</tr></table>\n\n$z$`
    );

    assert.equal((html.match(/<math/g) || []).length, 1_000);
    assert.match(
        html,
        /<p><span class="math-inline"><code class="math-fallback">z<\/code><\/span><\/p>/
    );
});

test('sanitizes attributes and unsafe elements inside raw HTML tables', () => {
    const html = renderMarkdownHTML([
        '<table onclick="alert(1)"><tr><td colspan="2">Safe',
        '<img src="https://example.com/tracker.png" onerror="alert(2)">',
        '<script>alert(3)</script></td></tr></table>',
    ].join(''));

    assert.match(html, /^<table><tr><td colspan="2">Safe/);
    assert.doesNotMatch(html, /onclick|<script|<img/i);
    assert.match(html, /&lt;img [\s\S]*&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
});

test('preserves safe table spans, formatting, and existing HTML entities', () => {
    const html = renderMarkdownHTML([
        '<table><tr><th rowspan="2" onclick="alert(1)">',
        '<strong>A &amp; B</strong><br>Line 2</th>',
        '<td colspan="2"><em>Value</em></td></tr></table>',
    ].join(''));

    assert.equal(html, [
        '<table><tr><th rowspan="2">',
        '<strong>A &amp; B</strong><br>Line 2</th>',
        '<td colspan="2"><em>Value</em></td></tr></table>',
    ].join(''));
    assert.doesNotMatch(html, /onclick|&amp;amp;/);
});
