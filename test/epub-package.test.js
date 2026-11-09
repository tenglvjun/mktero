import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import {
    buildEpubPackage,
    EPUB_PACKAGE_LIMITS,
} from '../src/epub/epub-package.js';

const XHTML = 'http://www.w3.org/1999/xhtml';
const OPF = 'http://www.idpf.org/2007/opf';
const DC = 'http://purl.org/dc/elements/1.1/';
const PNG = new Uint8Array(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1EAAAAASUVORK5CYII=',
    'base64'
));
const document = (body = '<p>Chapter text.</p>', head = '') => (
    `<?xml version="1.0" encoding="UTF-8"?><html xmlns="${XHTML}" xmlns:epub="http://www.idpf.org/2007/ops">`
    + `<head><title>Chapter</title>${head}</head><body>${body}</body></html>`
);
const chapter = (overrides = {}) => ({
    id: 'chapter-01',
    title: 'Introduction',
    xhtml: document(),
    ...overrides,
});
const options = (overrides = {}) => ({ title: 'Paper', chapters: [chapter()], ...overrides });
const xml = (entries, path) => new JSDOM(strFromU8(entries[path]), {
    contentType: 'application/xml',
}).window.document;
const elements = (root, namespace, tag) => [...root.getElementsByTagNameNS(namespace, tag)];

function resolveEntry(path, href) {
    return new URL(href, `https://epub.invalid/${path}`).pathname.slice(1);
}

test('builds an EPUB 3 with an uncompressed first mimetype member and complete navigation', () => {
    const archive = buildEpubPackage(options({
        language: 'zh-CN',
        chapters: [
            chapter({ xhtml: document('<h1>Introduction</h1><img src="../images/plot.png" alt="Plot" />'
                + '<p>Claim<sup><a href="chapter-02.xhtml#footnote-1">1</a></sup>.</p>') }),
            chapter({ id: 'chapter-02', title: 'Results', xhtml: document(
                '<h1>Results</h1><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>'
                + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0L1 1" /></svg>'
                + '<section id="footnote-1"><h2>Chapter notes</h2><p>Note text.</p></section>'
            ) }),
        ],
        assets: [{ path: 'images/plot.png', mimeType: 'image/png', data: PNG }],
    }));
    assert.ok(archive instanceof Uint8Array);
    const header = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    assert.equal(header.getUint32(0, true), 0x04034b50);
    assert.equal(header.getUint16(8, true), 0, 'mimetype uses ZIP method STORE');
    assert.equal(header.getUint16(26, true), 8);
    assert.equal(header.getUint16(28, true), 0, 'mimetype has no ZIP extra field');
    assert.equal(strFromU8(archive.subarray(30, 38)), 'mimetype');
    assert.equal(strFromU8(archive.subarray(38, 58)), 'application/epub+zip');

    const entries = unzipSync(archive);
    assert.equal(Object.keys(entries)[0], 'mimetype');
    assert.equal(strFromU8(entries.mimetype), 'application/epub+zip');
    assert.deepEqual(entries['OEBPS/images/plot.png'], PNG);
    const container = xml(entries, 'META-INF/container.xml');
    assert.equal(container.querySelector('rootfile').getAttribute('full-path'), 'OEBPS/content.opf');
    const packageXML = xml(entries, 'OEBPS/content.opf');
    assert.equal(packageXML.documentElement.getAttribute('version'), '3.0');
    assert.equal(elements(packageXML, DC, 'language')[0].textContent, 'zh-CN');
    const items = elements(packageXML, OPF, 'item');
    const ids = items.map(item => item.getAttribute('id'));
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(elements(packageXML, OPF, 'itemref').map(item => item.getAttribute('idref')), [
        'chapter-1', 'chapter-2',
    ]);
    assert.equal(items.find(item => item.getAttribute('href') === 'images/plot.png')
        .getAttribute('media-type'), 'image/png');
    assert.equal(items.find(item => item.getAttribute('href') === 'text/chapter-02.xhtml')
        .getAttribute('properties'), 'mathml svg');
    for (const item of items) {
        assert.ok(entries[resolveEntry('OEBPS/content.opf', item.getAttribute('href'))]);
    }
    assert.equal(items.find(item => item.getAttribute('id') === 'nav').getAttribute('properties'), 'nav');
    assert.equal(elements(packageXML, OPF, 'spine')[0].getAttribute('toc'), 'ncx');
    const nav = xml(entries, 'OEBPS/nav.xhtml');
    assert.equal(nav.documentElement.getAttribute('lang'), 'zh-CN');
    assert.equal(nav.querySelector('nav').getAttribute('epub:type'), 'toc');
    assert.deepEqual([...nav.querySelectorAll('nav a')].map(link => link.getAttribute('href')), [
        'text/chapter-01.xhtml', 'text/chapter-02.xhtml',
    ]);
    const ncx = xml(entries, 'OEBPS/toc.ncx');
    assert.deepEqual([...ncx.querySelectorAll('navPoint')].map(point => point.getAttribute('playOrder')), ['1', '2']);
    assert.deepEqual([...ncx.querySelectorAll('content')].map(content => content.getAttribute('src')), [
        'text/chapter-01.xhtml', 'text/chapter-02.xhtml',
    ]);
    for (const [path] of Object.entries(entries).filter(([path]) => path.endsWith('.xhtml'))) {
        const chapterXML = xml(entries, path);
        for (const link of chapterXML.querySelectorAll('link')) {
            assert.equal(link.getAttribute('type'), 'text/css');
            assert.ok(entries[resolveEntry(path, link.getAttribute('href'))], 'stylesheet target exists');
        }
    }
    const firstChapter = xml(entries, 'OEBPS/text/chapter-01.xhtml');
    const noteLink = firstChapter.querySelector('a');
    assert.equal(noteLink.getAttribute('href'), 'chapter-02.xhtml#footnote-1');
    assert.ok(xml(entries, resolveEntry('OEBPS/text/chapter-01.xhtml', noteLink.getAttribute('href')))
        .getElementById('footnote-1'));
});

test('escapes book and chapter metadata as XML text and attributes', () => {
    const title = 'A & B <paper> "研究"';
    const chapterTitle = 'Results <script> & analysis';
    const identifier = 'urn:mktero:paper:"A&B"';
    const entries = unzipSync(buildEpubPackage(options({
        title,
        chapters: [chapter({ title: chapterTitle })],
        metadata: {
            identifier,
            modified: '2026-11-07T12:34:56Z',
            creator: ['A & B', '作者 <C>'],
            publisher: 'Mktero',
            description: 'Quoted "text" & symbols.',
            subject: ['Physics', '研究'],
        },
    })));
    const packageXML = xml(entries, 'OEBPS/content.opf');
    assert.equal(elements(packageXML, DC, 'title')[0].textContent, title);
    assert.equal(elements(packageXML, DC, 'identifier')[0].textContent, identifier);
    assert.deepEqual(elements(packageXML, DC, 'creator').map(node => node.textContent), ['A & B', '作者 <C>']);
    assert.deepEqual(elements(packageXML, DC, 'subject').map(node => node.textContent), ['Physics', '研究']);
    assert.equal(packageXML.querySelector('meta').textContent, '2026-11-07T12:34:56Z');
    const nav = xml(entries, 'OEBPS/nav.xhtml');
    assert.equal(nav.querySelector('title').textContent, title);
    assert.equal(nav.querySelector('a').textContent, chapterTitle);
    assert.equal(nav.querySelector('script'), null);
    const ncx = xml(entries, 'OEBPS/toc.ncx');
    assert.equal(ncx.querySelector('meta[name="dtb:uid"]').getAttribute('content'), identifier);
    assert.equal(ncx.querySelector('docTitle text').textContent, title);
    assert.equal(ncx.querySelector('navLabel text').textContent, chapterTitle);
});

test('adds the shared CSS or repairs a stylesheet link with a missing or incorrect type', () => {
    for (const head of [
        '',
        '<link rel="stylesheet" href="../styles/book.css" />',
        '<link href="../styles/book.css" type="application/css" rel="stylesheet" />',
    ]) {
        const entries = unzipSync(buildEpubPackage(options({ chapters: [chapter({ xhtml: document('<p>Body</p>', head) })] })));
        const content = xml(entries, 'OEBPS/text/chapter-01.xhtml');
        const links = [...content.querySelectorAll('link')];
        assert.equal(links.length, 1);
        assert.equal(links[0].getAttribute('href'), '../styles/book.css');
        assert.equal(links[0].getAttribute('type'), 'text/css');
    }
    assert.throws(() => buildEpubPackage(options({ chapters: [chapter({
        xhtml: document('', '<link rel="stylesheet" href="https://example.com/style.css" />'),
    })] })), /stylesheet path/);
});

test('styles book captions like the reader, with a muted caption and a darker label', () => {
    const entries = unzipSync(buildEpubPackage(options()));
    const css = strFromU8(entries['OEBPS/styles/book.css']);
    const rule = selector => {
        const match = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'u').exec(css);
        assert.ok(match, `Missing CSS rule: ${selector}`);
        return match[1];
    };
    const caption = rule('figcaption, caption');
    assert.match(caption, /color:\s*#68717b/u);
    assert.match(caption, /font-size:\s*\.82em/u);
    assert.match(caption, /line-height:\s*1\.5/u);
    assert.match(caption, /text-align:\s*center/u);
    const label = rule('\\.mktero-figure-label, \\.mktero-table-label');
    assert.match(label, /color:\s*#20252b/u);
    assert.match(label, /font-weight:\s*650/u);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/u);
});

test('declares each core EPUB image type and accepts binary views without changing their bytes', () => {
    const gif = new Uint8Array([71, 73, 70, 56, 57, 97]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0L1 1" /></svg>');
    const assets = [
        { path: 'images/plot.png', mimeType: 'image/png', data: PNG.buffer.slice(0) },
        { path: 'images/plot.gif', mimeType: 'image/gif', data: new DataView(gif.buffer) },
        { path: 'images/plot.jpg', mimeType: 'image/jpeg', data: jpeg },
        { path: 'images/plot.svg', mimeType: 'image/svg+xml', data: svg },
    ];
    const entries = unzipSync(buildEpubPackage(options({ assets })));
    const items = elements(xml(entries, 'OEBPS/content.opf'), OPF, 'item');
    for (const asset of assets) {
        const item = items.find(item => item.getAttribute('href') === asset.path);
        assert.equal(item.getAttribute('media-type'), asset.mimeType);
    }
    assert.deepEqual(entries['OEBPS/images/plot.png'], PNG);
    assert.deepEqual(entries['OEBPS/images/plot.gif'], gif);
    assert.deepEqual(entries['OEBPS/images/plot.jpg'], jpeg);
    assert.deepEqual(entries['OEBPS/images/plot.svg'], svg);
});

test('uses reproducible ZIP metadata and a stable content-derived publication identifier', () => {
    const assets = [
        { path: 'images/z.png', mimeType: 'image/png', data: PNG },
        { path: 'images/a.svg', mimeType: 'image/svg+xml', data: strToU8('<svg xmlns="http://www.w3.org/2000/svg" />') },
    ];
    const first = buildEpubPackage(options({ assets }));
    assert.deepEqual(buildEpubPackage(options({ assets: [...assets].reverse() })), first);
    const identifier = archive => elements(xml(unzipSync(archive), 'OEBPS/content.opf'), DC, 'identifier')[0].textContent;
    assert.match(identifier(first), /^urn:mktero:epub:[0-9a-f]{16}$/u);
    assert.notEqual(identifier(buildEpubPackage(options({ title: 'Another paper', assets }))), identifier(first));
    assert.notEqual(identifier(buildEpubPackage(options({ chapters: [chapter({ xhtml: document('<p>Changed text.</p>') })], assets }))), identifier(first));
});

test('rejects unsafe chapter IDs, duplicate IDs, paths and unsupported image media', () => {
    for (const id of ['../chapter', 'chapter/one', 'chapter\\one', '#fragment', '1chapter', '', 'x'.repeat(129)]) {
        assert.throws(() => buildEpubPackage(options({ chapters: [chapter({ id })] })), /chapter ID/);
    }
    assert.throws(() => buildEpubPackage(options({ chapters: [chapter(), chapter({ id: 'CHAPTER-01' })] })), /duplicate chapter/);
    for (const path of [
        '../plot.png', '/plot.png', 'C:/plot.png', 'images/../plot.png',
        'images/./plot.png', 'images//plot.png', 'images\\plot.png',
        'images/%2e%2e/plot.png', 'images/plot.png#id', 'images/plot.png?x', 'images/plot\u0000.png',
        `images/${'p'.repeat(252)}.png`, 'images/.../plot.png',
    ]) {
        assert.throws(() => buildEpubPackage(options({ assets: [{ path, mimeType: 'image/png', data: PNG }] })), /image path/);
    }
    assert.throws(() => buildEpubPackage(options({ assets: [
        { path: 'images/plot.png', mimeType: 'image/png', data: PNG },
        { path: 'images/PLOT.PNG', mimeType: 'image/png', data: PNG },
    ] })), /duplicate image/);
    for (const [path, mimeType] of [
        ['image.webp', 'image/webp'], ['image.png', 'image/jpeg'],
        ['image.js', 'text/javascript'], ['image.png', 'image/svg+xml'],
    ]) {
        assert.throws(() => buildEpubPackage(options({ assets: [{ path, mimeType, data: PNG }] })), /MIME type or extension/);
    }
    assert.throws(() => buildEpubPackage(options({ assets: [{ path: 'image.png', mimeType: 'image/png', data: 'data' }] })), /binary data/);
});

test('rejects incomplete XHTML, external entities and invalid XML metadata', () => {
    for (const xhtml of [
        '<p>Only a body fragment</p>',
        document().replace(`xmlns="${XHTML}"`, ''),
        document().replace(`xmlns="${XHTML}"`, `bad:xmlns="${XHTML}"`),
        document().replace('</body>', ''),
        '<!DOCTYPE html SYSTEM "https://example.com/external.dtd">' + document(),
        '<!DOCTYPE html [<!ENTITY secret SYSTEM "file:///private">]>' + document(),
        document('<p>Null\u0000</p>'),
    ]) {
        assert.throws(() => buildEpubPackage(options({ chapters: [chapter({ xhtml })] })), /complete XHTML/);
    }
    for (const title of ['', null, 'Bad\u0000title', '\uD800', 'x'.repeat(4_097)]) {
        assert.throws(() => buildEpubPackage(options({ title })), /title/);
    }
    for (const language of ['', 'en" lang="bad', 'not_a_locale', null, 'en-123456789']) {
        assert.throws(() => buildEpubPackage(options({ language })), /language/);
    }
    for (const modified of ['2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00.000Z', 'invalid']) {
        assert.throws(() => buildEpubPackage(options({ metadata: { modified } })), /timestamp/);
    }
    assert.throws(() => buildEpubPackage(options({ metadata: null })), /metadata/);
    assert.throws(() => buildEpubPackage(options({ metadata: { creator: ['valid', '\uD800'] } })), /creator/);
});

test('checks chapter, text, image and metadata budgets before constructing an oversized archive', () => {
    assert.throws(() => buildEpubPackage(options({ chapters: [] })), /chapter count/);
    assert.throws(() => buildEpubPackage(options({ chapters: Array(EPUB_PACKAGE_LIMITS.maxChapters + 1).fill(chapter()) })), /chapter count/);
    assert.throws(() => buildEpubPackage(options({ chapters: [chapter({
        xhtml: 'x'.repeat(EPUB_PACKAGE_LIMITS.maxXHTMLBytes + 1),
    })] })), /XHTML exceeds/);
    assert.throws(() => buildEpubPackage(options({ assets: Array(EPUB_PACKAGE_LIMITS.maxAssets + 1) })), /image count/);
    for (const data of [new Uint8Array(), new Uint8Array(EPUB_PACKAGE_LIMITS.maxAssetBytes + 1)]) {
        assert.throws(() => buildEpubPackage(options({ assets: [{ path: 'plot.png', mimeType: 'image/png', data }] })), /image exceeds/);
    }
    const data = new Uint8Array(EPUB_PACKAGE_LIMITS.maxAssetBytes);
    const assets = Array.from({ length: EPUB_PACKAGE_LIMITS.maxTotalAssetBytes / data.byteLength + 1 }, (_, index) => ({
        path: `plot-${index}.png`, mimeType: 'image/png', data,
    }));
    assert.throws(() => buildEpubPackage(options({ assets })), /total size limit/);
    assert.throws(() => buildEpubPackage(options({ metadata: {
        creator: Array(101).fill('Author'),
    } })), /metadata count/);
    assert.throws(() => buildEpubPackage(options({ metadata: {
        description: 'x'.repeat(EPUB_PACKAGE_LIMITS.maxMetadataLength + 1),
    } })), /description/);
    assert.throws(() => buildEpubPackage(options({ metadata: {
        description: 'x'.repeat(EPUB_PACKAGE_LIMITS.maxMetadataLength / 2),
        rights: 'x'.repeat(EPUB_PACKAGE_LIMITS.maxMetadataLength / 2),
    } })), /metadata exceeds/);
});

test('counts UTF-8 bytes and all chapters against the XHTML size budget', () => {
    const value = document('<p>' + '中'.repeat(Math.ceil(EPUB_PACKAGE_LIMITS.maxXHTMLBytes / 3)) + '</p>');
    assert.ok(value.length < EPUB_PACKAGE_LIMITS.maxXHTMLBytes, 'character count alone fits the budget');
    assert.throws(() => buildEpubPackage(options({ chapters: [chapter({ xhtml: value })] })), /XHTML exceeds/);
    const half = document('<p>' + 'a'.repeat(EPUB_PACKAGE_LIMITS.maxXHTMLBytes / 2) + '</p>');
    assert.throws(() => buildEpubPackage(options({ chapters: [
        chapter({ xhtml: half }), chapter({ id: 'chapter-02', xhtml: half }),
    ] })), /XHTML exceeds/);
});
