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
    assert.ok(first.querySelector('a[href="chapter-02.xhtml#references"]'));
    assert.ok(references.querySelector('#references'));
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
    const citation = main.querySelector('a[href="chapter-02.xhtml#参考文献"]');

    assert.ok(citation);
    assert.equal(references.querySelector('h1')?.id, '参考文献');
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
