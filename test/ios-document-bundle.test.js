import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { IOS_BUNDLES, IOS_RENDERER_TARGETS } from '../scripts/build-ios-renderer.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Builds the document bundle in memory and runs it in a bare context.
 *
 * The app runs this bundle in JavaScriptCore, which has no DOM. Building it here
 * without a browser platform and evaluating it in a context that has no
 * `document` or `window` is what proves that stays true: a stray DOM call would
 * fail on this test rather than at runtime on a phone.
 */
async function loadDocumentBundle() {
    const result = await build({
        entryPoints: [path.join(projectRoot, IOS_BUNDLES.document)],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'neutral',
        target: IOS_RENDERER_TARGETS,
        logLevel: 'error',
        define: {
            __MKTERO_BUILD__: JSON.stringify('release'),
            __MKTERO_VERSION__: JSON.stringify('9.9.9'),
            process: 'undefined',
            Buffer: 'undefined',
        },
    });
    const code = result.outputFiles[0].text;
    // A bare context: no document, no window, no Zotero.
    const sandbox = { JSON, Math, Object, Array, String, Number, Boolean, Map, Set, Error, TypeError, RegExp, Date };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return { api: sandbox.MkteroDocument, code };
}

const text = (bbox, content) => ({
    type: 'text',
    bbox,
    lines: [{ bbox, spans: [{ bbox, type: 'text', content }] }],
});
const title = (bbox, content) => ({
    type: 'title',
    bbox,
    lines: [{ bbox, spans: [{ bbox, type: 'text', content }] }],
});

const HEADER = 'IEEE TRANSACTIONS ON PATTERN ANALYSIS, VOL. 44';

function layoutDocument(pages = 3, { withTitle = false } = {}) {
    return {
        pdf_info: Array.from({ length: pages }, (_, page) => ({
            page_idx: page,
            page_size: [612, 792],
            para_blocks: [
                text([50, 20, 560, 40], HEADER),
                ...(page === 0 && withTitle
                    ? [title([50, 50, 560, 80], 'Attention Is All You Need')]
                    : []),
                text([280, 760, 330, 780], String(page + 1)),
                text(
                    [50, 80, 560, 120],
                    `Body paragraph ${page} of the paper, long enough to read as prose rather than a label.`
                ),
            ],
            discarded_blocks: [],
        })),
        _backend: 'pipeline',
        _version_name: '3.0',
    };
}

test('the bundle exposes one entry point and no DOM dependency', async () => {
    const { api, code } = await loadDocumentBundle();
    assert.ok(api, 'MkteroDocument must be defined');
    assert.deepEqual(Object.keys(api).sort(), ['prepare', 'version']);
    assert.equal(api.version, '9.9.9');
    // A DOM reference would have thrown while the sandbox had no document, but a
    // guarded one would survive: assert the bundle does not carry one at all.
    assert.doesNotMatch(code, /\bdocument\.(createElement|querySelector|body)\b/u);
    assert.doesNotMatch(code, /\bwindow\./u);
});

test('repeated page chrome is dropped and every paragraph survives', async () => {
    const { api } = await loadDocumentBundle();
    const result = api.prepare({
        markdown: '# RAW\n\n' + HEADER + '\n\n1\n\nBody paragraph 0...',
        layout: layoutDocument(3),
        assets: [{ path: 'images/fig1.png' }],
    });

    assert.equal(result.structured, true);
    assert.equal(result.error, undefined);

    const headerCount = result.markdown.split(HEADER).length - 1;
    assert.ok(headerCount <= 1, `the running header repeated ${headerCount} times`);

    for (const page of ['1', '2', '3']) {
        const standalone = result.markdown
            .split('\n')
            .some(line => line.trim() === page);
        assert.equal(standalone, false, `page number ${page} survived`);
    }
    for (let page = 0; page < 3; page++) {
        assert.match(result.markdown, new RegExp(`Body paragraph ${page}`));
    }
});

test('a title block becomes a heading', async () => {
    const { api } = await loadDocumentBundle();
    const result = api.prepare({
        markdown: '(raw)',
        layout: layoutDocument(2, { withTitle: true }),
        assets: [],
    });
    assert.equal(result.structured, true);
    // The writer gives the title `##`: the reader's own title chrome is not a
    // document level-1 heading, so the first section is `##` as well.
    assert.match(result.markdown, /^## Attention Is All You Need$/m);
});

test('the layout may arrive as JSON text', async () => {
    const { api } = await loadDocumentBundle();
    const result = api.prepare({
        markdown: '(raw)',
        layout: JSON.stringify(layoutDocument(2)),
        assets: [],
    });
    assert.equal(result.structured, true);
    assert.match(result.markdown, /Body paragraph 1/);
});

test('a content list is used when there is no layout', async () => {
    const { api } = await loadDocumentBundle();
    // The flat content list projects to `pageIndex`/`bbox`/`type`/`text`, which
    // is what the ingest reads; a `page_idx` entry is dropped as unusable.
    const contentList = [
        {
            type: 'text',
            text: 'A paragraph read from the content list.',
            pageIndex: 0,
            bbox: [0, 0, 1000, 100],
        },
    ];
    const result = api.prepare({
        markdown: '(raw)',
        layout: null,
        contentList: JSON.stringify(contentList),
        assets: [],
    });
    assert.match(result.markdown, /content list/);
});

test('without structure the provider Markdown is returned unchanged', async () => {
    const { api } = await loadDocumentBundle();
    const markdown = '# Paper\n\nAs MinerU wrote it.';
    for (const input of [
        { markdown, layout: null },
        { markdown, layout: null, contentList: null },
        { markdown, layout: '{not json' },
        { markdown, layout: { pdf_info: [] } },
        { markdown, layout: { pdf_info: 'nope' } },
    ]) {
        const result = api.prepare({ ...input, assets: [] });
        assert.equal(result.structured, false, JSON.stringify(input).slice(0, 60));
        assert.equal(result.markdown, markdown, 'the input must not be lost');
    }
});

test('an empty result never replaces the document with a blank page', async () => {
    const { api } = await loadDocumentBundle();
    const markdown = 'The only text this document has.';
    // A layout with pages but nothing readable in them projects to a valid
    // document that writes nothing; returning that would show a blank page.
    const result = api.prepare({
        markdown,
        layout: {
            pdf_info: [{ page_idx: 0, page_size: [612, 792], para_blocks: [], discarded_blocks: [] }],
            _backend: 'pipeline',
            _version_name: '3.0',
        },
        assets: [],
    });
    assert.equal(result.markdown.trim() === '' ? 'blank' : 'kept', 'kept');
    assert.equal(result.markdown, markdown);
});

test('a missing argument set does not throw', async () => {
    const { api } = await loadDocumentBundle();
    for (const input of [undefined, {}, { markdown: null }, { markdown: 42 }]) {
        const result = api.prepare(input);
        assert.equal(typeof result.markdown, 'string');
        assert.equal(result.structured, false);
    }
});
