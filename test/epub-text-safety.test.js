import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import {
    createEpub,
    splitMarkdownChapters,
} from '../src/epub/epub-export.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const EPUB_NAMESPACE = 'http://www.idpf.org/2007/ops';
const ATTACK_HEADING = '<scr<script>ipt>'
    + '<img src="x" onerror="alert()" />'
    + '<script>alert()</script>'
    + '<a href="javascript:alert()" onclick="alert()">fake link</a>';

function parseXHTMLFiles(archive) {
    const entries = unzipSync(archive);
    const documents = new Map();
    for (const [entryPath, bytes] of Object.entries(entries)) {
        if (!entryPath.endsWith('.xhtml')) continue;
        const source = new TextDecoder().decode(bytes);
        const document = new JSDOM(source, {
            contentType: 'application/xhtml+xml',
        }).window.document;
        assert.equal(document.querySelector('parsererror'), null, `${entryPath} must be valid XML`);
        assert.equal(document.documentElement.localName, 'html');
        assert.equal(document.documentElement.namespaceURI, XHTML_NAMESPACE);
        documents.set(entryPath, document);
    }
    return documents;
}

function assertFragmentTargetsExist(documents) {
    for (const [entryPath, document] of documents) {
        for (const anchor of document.querySelectorAll('a[href*="#"]')) {
            const href = anchor.getAttribute('href');
            const hash = href.indexOf('#');
            const targetPath = href.slice(0, hash);
            const fragment = decodeURIComponent(href.slice(hash + 1));
            if (!fragment) continue;
            const documentPath = targetPath
                ? path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), targetPath))
                : entryPath;
            const targetDocument = documents.get(documentPath);
            assert.ok(targetDocument, `${entryPath} link target document exists: ${href}`);
            assert.ok(
                [...targetDocument.querySelectorAll('[id]')]
                    .some(element => element.id === fragment),
                `${entryPath} link target fragment exists: ${href}`
            );
        }
    }
}

test('exports escaped author-year labels and inert hostile chapter titles', async () => {
    const citations = [1, 2, 3].map(count => (
        `[Smith, 2020${'\\'.repeat(count)}]`
    ));
    const markdown = [
        '# Main',
        '',
        `Sources: ${citations.join('; then ')}.`,
        '',
        'A note follows $^{1}$.',
        '',
        '<!-- mktero-note: footnote -->',
        '> $^{1}$ A footnote.',
        '',
        'Jump to [details](#details).',
        '',
        '## <em>Details</em>',
        '',
        'The local fragment target.',
        '',
        `# ${ATTACK_HEADING}`,
        '',
        'This chapter title is untrusted input.',
        '',
        '# References',
        '',
        '[1] Smith J. A reference paper. 2020.',
    ].join('\n');

    const split = splitMarkdownChapters(markdown, 'Fallback');
    assert.deepEqual(split.map(chapter => chapter.title), [
        'Main',
        ATTACK_HEADING,
        'References',
    ]);

    const archive = await createEpub({ title: 'Safety test', markdown });
    const documents = parseXHTMLFiles(archive);
    const main = documents.get('OEBPS/text/chapter-01.xhtml');
    const hostile = documents.get('OEBPS/text/chapter-02.xhtml');
    const references = documents.get('OEBPS/text/chapter-03.xhtml');
    assert.ok(main);
    assert.ok(hostile);
    assert.ok(references);

    const referenceLinks = [...main.querySelectorAll(
        'a[href="chapter-03.xhtml#mktero-reference-number-1"]'
    )];
    assert.equal(referenceLinks.length, citations.length);
    assert.deepEqual(referenceLinks.map(link => link.textContent), citations);
    assert.ok(referenceLinks.every(link => (
        link.getAttribute('href') === 'chapter-03.xhtml#mktero-reference-number-1'
    )));
    assert.equal(references.querySelector('h1')?.id, 'references');

    const footnoteLink = main.querySelector('a[href="chapter-01.xhtml#footnote-1"]');
    assert.ok(footnoteLink);
    assert.ok(footnoteLink.getElementsByTagNameNS(MATHML_NAMESPACE, 'math').length);
    assert.equal(main.querySelector('#footnote-1')?.getAttributeNS(EPUB_NAMESPACE, 'type'), 'footnote');
    assert.ok(main.querySelector('#details'));
    assert.ok(main.querySelector('a[href="chapter-01.xhtml#details"]'));
    assertFragmentTargetsExist(documents);

    assert.equal(hostile.querySelector('h1')?.textContent, ATTACK_HEADING);
    assert.match(hostile.querySelector('h1')?.id, /^[\p{L}\p{N}-]+$/u);
    assert.equal(hostile.querySelectorAll('a').length, 0);
    for (const document of documents.values()) {
        assert.equal(document.querySelectorAll('script, img, iframe, object, embed').length, 0);
        assert.equal(document.querySelectorAll('[onerror], [onclick], [onload]').length, 0);
        assert.equal(document.querySelectorAll('a[href^="javascript:" i]').length, 0);
    }
});

for (const { marker, lead, tex, glyphs } of [
    {
        marker: '$^{\\dagger}$',
        lead: '$^{\\dagger}$',
        tex: '^{\\dagger}',
        glyphs: '†',
    },
    {
        marker: '\\(^{1}\\)',
        lead: '$^{1}$',
        tex: '^{1}',
        glyphs: '1',
    },
    {
        marker: '$^{1,\\dagger}$',
        lead: '$^{\\dagger}$',
        tex: '^{1,\\dagger}',
        glyphs: '1,†',
    },
]) {
    test(`preserves MathML in the linked footnote marker ${marker}`, async () => {
        const markdown = [
            '# Paper',
            '',
            `Result ${marker}.`,
            '',
            '<!-- mktero-note: footnote -->',
            `> ${lead} The footnote.`,
        ].join('\n');
        const documents = parseXHTMLFiles(await createEpub({ title: 'Math footnote', markdown }));
        const chapter = documents.get('OEBPS/text/chapter-01.xhtml');
        const link = chapter.querySelector('a[href="chapter-01.xhtml#footnote-1"]');
        assert.ok(link);
        const math = link.getElementsByTagNameNS(MATHML_NAMESPACE, 'math')[0];
        assert.ok(math);
        assert.equal(math.querySelector('annotation[encoding="application/x-tex"]')?.textContent, tex);
        assert.equal([...math.querySelectorAll('mn, mo')].map(node => node.textContent).join(''), glyphs);
        assertFragmentTargetsExist(documents);
    });
}
