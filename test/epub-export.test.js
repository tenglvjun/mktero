import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { createEpub } from '../src/epub/epub-export.js';

const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const PNG_BYTES = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
]);

function xhtmlFiles(archive) {
    const entries = unzipSync(archive);
    return Object.fromEntries(Object.entries(entries)
        .filter(([path]) => path.endsWith('.xhtml'))
        .map(([path, bytes]) => [
            path,
            new JSDOM(new TextDecoder().decode(bytes), {
                contentType: 'application/xhtml+xml',
            }).window.document,
        ]));
}

test('creates linked XHTML chapters with MathML, HTML tables, and packaged images', async () => {
    const markdown = [
        '# Chapter One',
        '',
        'The result is $E = mc^2$ and citation [1]. A note follows $^{1}$.',
        '',
        '<!-- mktero-note: footnote -->',
        '> $^{1}$ A chapter-end note.',
        '',
        '![Plot](images/figure.png)',
        '',
        '| Key | Value |',
        '| --- | --- |',
        '| Mode | Stable |',
        '',
        'Jump to [details](#details).',
        '',
        '## Details',
        '',
        'Details remain in this chapter.',
        '',
        '# References',
        '',
        '[1] Alpha A. A reference paper. 2020.',
    ].join('\n');
    const archive = await createEpub({
        title: 'A Test Book',
        markdown,
        assets: [{
            path: 'images/figure.png',
            mimeType: 'image/png',
            data: PNG_BYTES,
        }],
    });
    const files = xhtmlFiles(archive);
    const first = files['OEBPS/text/chapter-01.xhtml'];
    const references = files['OEBPS/text/chapter-02.xhtml'];
    assert.ok(first);
    assert.ok(references);

    assert.ok(first.getElementsByTagNameNS(MATHML_NAMESPACE, 'math').length > 0);
    assert.equal(first.querySelectorAll('table').length, 1);
    assert.equal(first.querySelector('img')?.getAttribute('src'), '../images/image-0001.png');
    assert.ok(first.querySelector('a[href="chapter-01.xhtml#details"]'));
    assert.ok(first.querySelector('a[href="chapter-01.xhtml#footnote-1"]'));
    assert.ok(first.querySelector('#footnote-1'));
    assert.equal(first.querySelector('.chapter-notes h2')?.textContent, 'Chapter notes');
    assert.ok(first.querySelector('a[href="chapter-02.xhtml#mktero-reference-number-1"]'));
    assert.ok(references.querySelector('#references'));
    assert.ok(references.querySelector('#mktero-reference-number-1'));
    assert.ok([...first.querySelectorAll('link[rel="stylesheet"]')]
        .every(link => link.getAttribute('type') === 'text/css'));
    assert.doesNotMatch(first.documentElement.textContent, /return to (?:正文|text)/iu);

    const archiveFiles = unzipSync(archive);
    assert.ok(archiveFiles['OEBPS/images/image-0001.png']);
    assert.deepEqual(archiveFiles['OEBPS/images/image-0001.png'], PNG_BYTES);
});

test('keeps citation links to Chinese reference headings', async () => {
    const markdown = [
        '# Main text',
        '',
        'This supports citation [1].',
        '',
        '# 参考文献',
        '',
        '[1] 中文参考文献。',
    ].join('\n');
    const archive = await createEpub({ title: 'Chinese References', markdown });
    const files = xhtmlFiles(archive);
    const main = files['OEBPS/text/chapter-01.xhtml'];
    const references = files['OEBPS/text/chapter-02.xhtml'];
    const citation = main.querySelector('a[href="chapter-02.xhtml#mktero-reference-number-1"]');

    assert.ok(citation);
    assert.equal(references.querySelector('h1')?.id, '参考文献');
    assert.ok(references.querySelector('#mktero-reference-number-1'));
});

test('targets unique author-year entries and falls back for ambiguous matches', async () => {
    const markdown = [
        '# Main',
        '',
        'Duran et al. (2013) describe the method; Smith et al. (2020) report a finding.',
        '',
        '# References',
        '',
        'Duran, R., et al. (2013). Protein Paintbox.',
        '',
        'Smith, A., et al. (2020). First study.',
        '',
        'Smith, B., et al. (2020). Second study.',
    ].join('\n');
    const archive = await createEpub({ title: 'Author Year', markdown });
    const files = xhtmlFiles(archive);
    const main = files['OEBPS/text/chapter-01.xhtml'];
    const references = files['OEBPS/text/chapter-02.xhtml'];
    const citations = [...main.querySelectorAll('a')];

    assert.equal(citations.length, 2);
    assert.deepEqual(citations.map(link => link.textContent), [
        'Duran et al. (2013)',
        'Smith et al. (2020)',
    ]);
    assert.equal(
        citations[0].getAttribute('href'),
        'chapter-02.xhtml#mktero-reference-item-0001'
    );
    assert.equal(citations[1].getAttribute('href'), 'chapter-02.xhtml#references');
    assert.ok(references.querySelector('#mktero-reference-item-0001'));
    assert.ok(references.querySelector('#mktero-reference-item-0002'));
    assert.ok(references.querySelector('#mktero-reference-item-0003'));
});

test('keeps reference anchors unique in list entries and avoids heading ID collisions', async () => {
    const markdown = [
        '# Main',
        '',
        '## mktero-reference-number-1',
        '',
        'Citations [1] and [2].',
        '',
        '## References',
        '',
        '1. [1] Alpha A. First work. 2020.',
        '- [2] Beta B. Second work. 2021.',
    ].join('\n');
    const archive = await createEpub({ title: 'List References', markdown });
    const chapter = xhtmlFiles(archive)['OEBPS/text/chapter-01.xhtml'];
    const ids = [...chapter.querySelectorAll('[id]')].map(element => element.id);

    assert.equal(chapter.querySelector('a[href="chapter-01.xhtml#mktero-reference-number-1"]')?.textContent, '1');
    assert.equal(chapter.querySelector('a[href="chapter-01.xhtml#mktero-reference-number-2"]')?.textContent, '2');
    assert.equal(chapter.querySelector('#mktero-reference-number-1-2')?.tagName.toLowerCase(), 'h2');
    assert.ok(chapter.querySelector('li #mktero-reference-number-1'));
    assert.ok(chapter.querySelector('li #mktero-reference-number-2'));
    assert.equal(new Set(ids).size, ids.length);
});

test('falls back to the References heading when a numeric reference ID is duplicated', async () => {
    const markdown = [
        '# Main',
        '',
        'This cites [1].',
        '',
        '# References',
        '',
        '[1] Alpha A. First work. 2020.',
        '[1] Beta B. Duplicate number. 2021.',
    ].join('\n');
    const archive = await createEpub({ title: 'Duplicate Reference', markdown });
    const files = xhtmlFiles(archive);
    const main = files['OEBPS/text/chapter-01.xhtml'];
    const references = files['OEBPS/text/chapter-02.xhtml'];

    assert.ok(main.querySelector('a[href="chapter-02.xhtml#references"]'));
    assert.ok(references.querySelector('#mktero-reference-number-1'));
    assert.ok(references.querySelector('#mktero-reference-number-1-2'));
});

test('preserves author affiliation superscripts and links body superscripts intact', async () => {
    const markdown = [
        'The diagnostic accuracy of wearable digital technology',
        '',
        'Yue Shi $^{1}$, Chi Chiu Wang $^{1,2}$',
        '',
        '## Article information',
        '',
        'Check for updates',
        '',
        '$^{1}$ Department of Obstetrics and Gynaecology',
        '',
        '$^{2}$ Faculty of Medicine',
        '',
        '## Abstract',
        '',
        'The result is supported by prior work $^{1}$.',
        '',
        '## References',
        '',
        '[1] Alpha A. A cited study. 2020.',
    ].join('\n');
    const archive = await createEpub({ title: 'Paper', markdown });
    const chapter = xhtmlFiles(archive)['OEBPS/text/chapter-01.xhtml'];
    const authorLine = [...chapter.querySelectorAll('p')].find(paragraph => (
        paragraph.textContent.startsWith('Yue Shi')
    ));
    const affiliationLines = [...chapter.querySelectorAll('p')].filter(paragraph => (
        paragraph.textContent.includes('Department of Obstetrics')
        || paragraph.textContent.includes('Faculty of Medicine')
    ));
    const linkedMath = chapter.querySelector(
        'a[href="chapter-01.xhtml#mktero-reference-number-1"] math'
    );

    assert.ok(authorLine);
    assert.equal(authorLine.querySelectorAll('math').length, 2);
    assert.equal(authorLine.querySelectorAll('a').length, 0);
    assert.equal(affiliationLines.length, 2);
    assert.ok(affiliationLines.every(paragraph => (
        paragraph.querySelector('math') && !paragraph.querySelector('a')
    )));
    assert.ok(linkedMath);
    assert.equal(linkedMath.querySelector('annotation'), null);
    assert.equal(authorLine.querySelectorAll('annotation').length, 2);
    assert.equal(chapter.querySelectorAll('.katex-error').length, 0);
});

test('strips TeX annotations from linked range and single-reference superscripts only', async () => {
    const markdown = [
        '# Main text',
        '',
        'Prior evidence supports this $^{[1-4]}$.',
        '',
        'The clinical observation was $^{[6]}$.',
        '',
        'The equation remains $x^2$.',
        '',
        '# References',
        '',
        '[1] First cited work. 1990.',
        '[2] Second cited work. 1991.',
        '[3] Third cited work. 1992.',
        '[4] Fourth cited work. 1993.',
        '[6] Sixth cited work. 1995.',
    ].join('\n');
    const archive = await createEpub({ title: 'Citation Math', markdown });
    const chapter = xhtmlFiles(archive)['OEBPS/text/chapter-01.xhtml'];
    const citations = [...chapter.querySelectorAll(
        'a[href="chapter-02.xhtml#mktero-reference-number-1"], '
        + 'a[href="chapter-02.xhtml#mktero-reference-number-6"]'
    )];
    const linkedMath = citations.map(link => link.querySelector('math'));
    const equation = [...chapter.querySelectorAll('math')].find(math => (
        math.querySelector('annotation')?.textContent === 'x^2'
    ));

    assert.equal(citations.length, 2);
    assert.deepEqual(citations.map(link => link.getAttribute('href')), [
        'chapter-02.xhtml#mktero-reference-number-1',
        'chapter-02.xhtml#mktero-reference-number-6',
    ]);
    assert.ok(linkedMath.every(math => math));
    assert.ok(linkedMath.every(math => math.querySelector('msup')));
    assert.ok(linkedMath.every(math => !math.querySelector('annotation')));
    assert.deepEqual(citations.map(link => link.textContent), ['[1−4]', '[6]']);
    assert.ok(equation);
    assert.equal(equation.closest('a'), null);
    assert.equal(equation.querySelector('annotation')?.textContent, 'x^2');
});

test('links dollar-wrapped numeric citations outside MathML', async () => {
    const markdown = [
        '# Main text',
        '',
        'Citations $[19]$, $[20]$, and combined evidence $[21, 22]$.',
        '',
        'An unmatched marker $[99]$ and the equation $x^2$ stay unlinked.',
        '',
        '# References',
        '',
        '[19] First cited work. 2020.',
        '[20] Second cited work. 2021.',
        '[21] Third cited work. 2022.',
        '[22] Fourth cited work. 2023.',
    ].join('\n');
    const archive = await createEpub({ title: 'Dollar Citations', markdown });
    const chapter = xhtmlFiles(archive)['OEBPS/text/chapter-01.xhtml'];
    const citations = [...chapter.querySelectorAll(
        'a[href^="chapter-02.xhtml#mktero-reference-number-"]'
    )];

    assert.equal(citations.length, 3);
    assert.deepEqual(citations.map(link => link.textContent), [
        '[19]',
        '[20]',
        '[21,22]',
    ]);
    assert.deepEqual(citations.map(link => link.getAttribute('href')), [
        'chapter-02.xhtml#mktero-reference-number-19',
        'chapter-02.xhtml#mktero-reference-number-20',
        'chapter-02.xhtml#mktero-reference-number-21',
    ]);
    assert.ok(citations.every(link => link.querySelector('math')));
    assert.ok(citations.every(link => !link.querySelector('annotation')));
    assert.ok(citations.every(link => !link.querySelector('.katex-error')));

    const unmatched = [...chapter.querySelectorAll('math')].find(math => (
        math.querySelector('annotation')?.textContent === '[99]'
    ));
    const equation = [...chapter.querySelectorAll('math')].find(math => (
        math.querySelector('annotation')?.textContent === 'x^2'
    ));
    assert.ok(unmatched);
    assert.ok(equation);
    assert.equal(unmatched.closest('a'), null);
    assert.equal(equation.closest('a'), null);
    assert.equal(chapter.querySelectorAll('.katex-error').length, 0);
});

test('packages author markers, inline and display formulas as reusable images with citation links', async () => {
    const requests = [];
    const archive = await createEpub({
        title: 'Echoes of the Brain',
        markdown: [
            '# Echoes of the Brain',
            '',
            'Lin Shen $^{ID}$, Kun Qian $^{*ID}$.',
            '',
            '## Article information',
            '',
            'Funding information.',
            '',
            '## Abstract',
            '',
            'The EEG encoder $f_{eeg}$ uses $E_{x}^{i} \\in R^{C \\times S}$.',
            '',
            'Prior work $^{[1]}$ and $[1]$ supports this.',
            '',
            '$$\\frac{x^2}{y_1}$$',
            '',
            '| Encoder | Value |',
            '| --- | --- |',
            '| EEG | $f_{eeg}$ |',
            '',
            '# Details',
            '',
            'The same encoder is $f_{eeg}$.',
            '',
            '# References',
            '',
            '[1] Alpha A. A cited study. 2020.',
        ].join('\n'),
        async renderMathToPNG(options) {
            assert.doesNotMatch(options.html, /<annotation\b/u);
            requests.push(options);
            return { mimeType: 'image/png', data: PNG_BYTES, width: 3, height: 1.5, verticalAlign: -0.25 };
        },
    });
    const entries = unzipSync(archive);
    const files = xhtmlFiles(archive);
    const main = files['OEBPS/text/chapter-01.xhtml'];
    const details = files['OEBPS/text/chapter-02.xhtml'];
    const author = [...main.querySelectorAll('p')].find(p => p.textContent.startsWith('Lin Shen'));
    assert.equal(author.querySelectorAll('img.epub-math-image').length, 2);
    assert.equal(author.querySelector('a'), null);
    assert.deepEqual([...author.querySelectorAll('img')].map(img => img.getAttribute('alt')), ['ID', '∗ID']);
    assert.equal(main.querySelectorAll('a[href="chapter-03.xhtml#mktero-reference-number-1"] img').length, 2);
    assert.ok(main.querySelector('.math-display img'));
    assert.equal(main.querySelector('table img').getAttribute('src'), details.querySelector('img').getAttribute('src'));
    assert.equal(requests.length, 7);
    assert.equal(Object.keys(entries).filter(path => /images\/math-\d+\.png$/u.test(path)).length, 7);
    for (const doc of Object.values(files)) {
        assert.equal(doc.querySelector('math, annotation, .katex-error'), null);
        assert.doesNotMatch(doc.body.textContent, /\^\{|\\times|\\in/u);
        for (const image of doc.querySelectorAll('img.epub-math-image')) {
            assert.equal(image.getAttribute('style'), 'width:3.0000em;vertical-align:-0.2500em');
            const resource = 'OEBPS/' + image.getAttribute('src').slice(3);
            assert.deepEqual(entries[resource], PNG_BYTES);
        }
    }
    assert.doesNotMatch(new TextDecoder().decode(entries['OEBPS/content.opf']), /properties="mathml"/u);
});

test('keeps math-image footnote markers linked and renders chapter-end note formulas', async () => {
    const archive = await createEpub({
        title: 'Notes',
        markdown: [
            '# Notes', '', 'The note follows $^{1}$.', '',
            '<!-- mktero-note: footnote -->', '> $^{1}$ The formula is $x^2$.',
        ].join('\n'),
        renderMathToPNG: async () => ({
            mimeType: 'image/png', data: PNG_BYTES, width: 1, height: 1, verticalAlign: -0.2,
        }),
    });
    const chapter = xhtmlFiles(archive)['OEBPS/text/chapter-01.xhtml'];
    assert.ok(chapter.querySelector('a[href="chapter-01.xhtml#footnote-1"] img'));
    assert.ok(chapter.querySelector('#footnote-1 img'));
    assert.equal(chapter.querySelector('math, annotation'), null);
});

test('rejects invalid formula images and non-finite layout metrics', async t => {
    const valid = { mimeType: 'image/png', data: PNG_BYTES, width: 1, height: 1, verticalAlign: -0.2 };
    for (const [name, patch] of Object.entries({
        'missing result': null,
        'non-PNG bytes': { data: new Uint8Array([1, 2, 3]) },
        'wrong MIME type': { mimeType: 'image/svg+xml' },
        'infinite width': { width: Infinity },
        'zero height': { height: 0 },
        'non-finite baseline': { verticalAlign: NaN },
    })) {
        await t.test(name, async () => {
            await assert.rejects(createEpub({
                title: 'Invalid formula',
                markdown: 'A formula $x^2$.',
                renderMathToPNG: async () => patch ? { ...valid, ...patch } : null,
            }), /formula renderer did not return a valid PNG/u);
        });
    }
});

test('allocates unique heading IDs around duplicate slugs and footnote IDs', async () => {
    const markdown = [
        '# Foo',
        '',
        '## Foo-2',
        '',
        '## Foo',
        '',
        '## Footnote 1',
        '',
        'A note follows $^{1}$.',
        '',
        '<!-- mktero-note: footnote -->',
        '> $^{1}$ A chapter-end note.',
        '',
        'Jump to [Foo-2](#foo-2).',
    ].join('\n');
    const archive = await createEpub({ title: 'Anchor Test', markdown });
    const chapter = xhtmlFiles(archive)['OEBPS/text/chapter-01.xhtml'];
    const headingIDs = [...chapter.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .slice(0, 4)
        .map(heading => heading.id);
    const allIDs = [...chapter.querySelectorAll('[id]')].map(element => element.id);

    assert.deepEqual(headingIDs, ['foo', 'foo-2', 'foo-3', 'footnote-1-2']);
    assert.equal(new Set(allIDs).size, allIDs.length);
    assert.ok(chapter.querySelector('a[href="chapter-01.xhtml#foo-2"]'));
    assert.ok(chapter.querySelector('a[href="chapter-01.xhtml#footnote-1"]'));
    assert.equal(chapter.querySelector('#footnote-1')?.getAttribute('epub:type'), 'footnote');
});

test('replaces only wide tables with PNG and keeps HTML tables intact', async () => {
    const wideHeaders = Array.from({ length: 9 }, (_, index) => `Column${index + 1}`);
    const wideRow = Array.from({ length: 9 }, (_, index) => `Value${index + 1}`);
    const markdown = [
        '# Tables',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| Narrow | Kept in HTML |',
        '',
        `| ${wideHeaders.join(' | ')} |`,
        `| ${wideHeaders.map(() => '---').join(' | ')} |`,
        `| ${wideRow.join(' | ')} |`,
    ].join('\n');
    const calls = [];
    const archive = await createEpub({
        title: 'Table Test',
        markdown,
        renderWideTable: async options => {
            calls.push(options);
            return { mimeType: 'image/png', data: PNG_BYTES };
        },
    });
    const files = xhtmlFiles(archive);
    const chapter = files['OEBPS/text/chapter-01.xhtml'];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].columns, 9);
    assert.equal(chapter.querySelectorAll('table').length, 1);
    assert.equal(chapter.querySelectorAll('figure.epub-table-image img').length, 1);
    assert.equal(
        chapter.querySelector('figure.epub-table-image img')?.getAttribute('src'),
        '../images/table-0001.png'
    );
    assert.ok(unzipSync(archive)['OEBPS/images/table-0001.png']);
});

test('converts unsupported image resources through the injected PNG renderer', async () => {
    const source = Uint8Array.from([1, 2, 3, 4]);
    let request;
    const archive = await createEpub({
        title: 'Converted Image',
        markdown: '# Image\n\n![Plot](images/plot.webp)',
        assets: [{ path: 'images/plot.webp', mimeType: 'image/webp', data: source }],
        renderImageToPNG: async options => {
            request = options;
            return { mimeType: 'image/png', data: PNG_BYTES };
        },
    });
    assert.equal(request.mimeType, 'image/webp');
    assert.deepEqual(request.data, source);
    const files = xhtmlFiles(archive);
    assert.equal(
        files['OEBPS/text/chapter-01.xhtml'].querySelector('img')?.getAttribute('src'),
        '../images/image-0001.png'
    );
    assert.ok(unzipSync(archive)['OEBPS/images/image-0001.png']);
});
