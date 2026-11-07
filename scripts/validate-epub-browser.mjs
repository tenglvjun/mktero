// Run with an externally installed Playwright module, like the other browser checks:
// MKTERO_PLAYWRIGHT_PATH=/path/to/playwright/index.mjs MKTERO_EPUB_BROWSERS=chrome node scripts/validate-epub-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'build/epub-validation');
const playwrightPath = process.env.MKTERO_PLAYWRIGHT_PATH;
if (!playwrightPath) throw new Error('Set MKTERO_PLAYWRIGHT_PATH to an installed Playwright module.');
const playwright = await import(pathToFileURL(playwrightPath).href);
const browsers = (process.env.MKTERO_EPUB_BROWSERS || 'chromium,firefox').split(',').map(value => value.trim()).filter(Boolean);
const bundle = await build({
    stdin: {
        contents: "export { createZoteroEpubRenderers } from './src/platform/zotero-epub-renderers.js'; export { createEpub } from './src/epub/epub-export.js'; export { MarkdownTabPresenter } from './src/ui/markdown-tab-presenter.js'; export { createMarkdownTabView } from './src/ui/markdown-window.js';",
        resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'MkteroEpubValidation',
    target: ['firefox115'],
});
await mkdir(output, { recursive: true });
for (const name of browsers) {
    assert.ok(['chromium', 'chrome', 'firefox', 'webkit'].includes(name), 'Unknown browser: ' + name);
    const type = playwright[name === 'chrome' ? 'chromium' : name];
    const browser = await type.launch({
        headless: true,
        executablePath: process.env[`MKTERO_${name.toUpperCase()}_PATH`] || undefined,
        ...(name === 'chrome' ? { channel: 'chrome' } : {}),
    });
    try {
        const page = await browser.newPage();
        const networkRequests = [];
        page.on('request', request => {
            if (/^https?:/u.test(request.url())) networkRequests.push(request.url());
        });
        await page.route('**/*', route => route.abort());
        await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"><style>table,caption{font-size:80px;padding:40px}p{margin:60px}body{line-height:3}</style></head><body></body></html>');
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const report = await page.evaluate(async stylesheetText => {
            const { createZoteroEpubRenderers, createEpub } = MkteroEpubValidation;
            const renderers = createZoteroEpubRenderers({ getMainWindow: () => window });
            function check(condition, message) {
                if (!condition) throw new Error(message);
            }
            async function inspectPNG(data) {
                const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }));
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const context = canvas.getContext('2d');
                context.drawImage(bitmap, 0, 0);
                bitmap.close();
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                let dark = 0;
                let left = canvas.width;
                let top = canvas.height;
                let right = 0;
                let bottom = 0;
                for (let index = 0; index < pixels.length; index += 4) {
                    if (pixels[index] >= 128 || pixels[index + 1] >= 128 || pixels[index + 2] >= 128) continue;
                    const x = (index / 4) % canvas.width;
                    const y = Math.floor(index / 4 / canvas.width);
                    dark++;
                    left = Math.min(left, x);
                    top = Math.min(top, y);
                    right = Math.max(right, x);
                    bottom = Math.max(bottom, y);
                }
                const metrics = { width: canvas.width, height: canvas.height, dark, left, top, right, bottom };
                canvas.width = canvas.height = 0;
                check(dark > 100, 'The table PNG must contain visible table content');
                check(left >= 10 && top >= 10 && right < metrics.width - 10 && bottom < metrics.height - 10,
                    'Table content was clipped at a PNG edge: ' + JSON.stringify(metrics));
                return metrics;
            }
            const pngs = [];
            const tableMetrics = [];
            async function renderWideTable(options) {
                const rendered = await renderers.renderWideTable(options);
                tableMetrics.push(await inspectPNG(rendered.data));
                pngs.push(Array.from(rendered.data));
                return rendered;
            }
            const headers = Array.from({ length: 9 }, (_, index) => 'Column' + (index + 1));
            const wideMarkdown = ['| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |',
                '| ' + headers.map((_, index) => index === 0 ? '![Cell image](images/plot.webp)' : index === 1 ? '$E=mc^2$' : 'Value ' + index).join(' | ') + ' |'].join('\n');
            const sourceCanvas = document.createElement('canvas');
            sourceCanvas.width = sourceCanvas.height = 16;
            sourceCanvas.getContext('2d').fillRect(0, 0, 16, 16);
            const webp = await new Promise(resolve => sourceCanvas.toBlob(resolve, 'image/webp'));
            check(webp?.type === 'image/webp', 'Browser must supply a real WebP conversion fixture');
            const archive = await createEpub({
                title: 'Actual EPUB renderer validation',
                language: 'en',
                modified: '2026-11-07T00:00:00Z',
                markdown: ['# Paper', '', 'A formula $E=mc^2$, citation [1], and footnote $^{1}$.', '',
                    '<!-- mktero-note: footnote -->', '> $^{1}$ A chapter-end note.', '',
                    '![Converted image](images/plot.webp)', '', '| Key | Value |', '| --- | --- |', '| Small | HTML |', '',
                    wideMarkdown, '', 'See [details](#details).', '', '## Details', '', 'Content.', '',
                    '# References', '', '[1] Alpha A. A reference paper. 2020.'].join('\n'),
                assets: [{ path: 'images/plot.webp', mimeType: 'image/webp', data: new Uint8Array(await webp.arrayBuffer()) }],
                renderWideTable,
                renderImageToPNG: renderers.renderImageToPNG,
            });
            const extraWide = '<table><caption>Caption with <p>several lines</p></caption><tbody>'
                + Array.from({ length: 5 }, (_, row) => '<tr>' + Array.from({ length: 24 }, (_, col) => '<td>Cell ' + row + '-' + col + '</td>').join('') + '</tr>').join('')
                + '</tbody></table>';
            await renderWideTable({ html: extraWide });
            // Zotero's XUL host can lack document.body. Keep the real DOM APIs
            // while exercising the documentElement mounting path.
            const bodylessDocument = new Proxy(document, {
                get(target, property) {
                    if (property === 'body') return null;
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
            const bodylessRenderers = createZoteroEpubRenderers({
                getMainWindow: () => ({ document: bodylessDocument }),
            });
            await inspectPNG((await bodylessRenderers.renderWideTable({ html: extraWide })).data);
            let refusedOversized = false;
            try {
                await renderers.renderWideTable({ html: '<table><tbody>' + '<tr><td>Row</td></tr>'.repeat(600) + '</tbody></table>' });
            }
            catch (error) {
                refusedOversized = /size limit/u.test(error.message);
            }
            check(refusedOversized, 'Oversized tables must fail explicitly instead of clipping');
            const unsafeCells = [
                '<img src="https://example.invalid/private.png">',
                '<img src="../images/image-0001.png" srcset="https://example.invalid/private.png 2x">',
                '<p style="background:url(https://example.invalid/private.png)">x</p>',
                '<p onclick="window.epubUnsafe=true">x</p>',
                '<iframe src="https://example.invalid/"></iframe>',
                '<style>@import url(https://example.invalid/private.css);</style>',
                '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private.png"/></svg>',
            ];
            for (const cell of unsafeCells) {
                let refused = false;
                try { await renderers.renderWideTable({ html: '<table><tr><td>' + cell + '</td></tr></table>' }); }
                catch (error) { refused = /unsupported markup|local asset/u.test(error.message); }
                check(refused, 'Unsafe table markup must fail before insertion: ' + cell);
            }
            check(!window.epubUnsafe, 'Table event handlers must never execute');
            check(document.querySelectorAll('[aria-hidden="true"]').length === 0, 'Temporary table hosts must be removed');
            // Drive the same presenter -> view path as Zotero. Passing a
            // callback straight to a hand-built view model misses this seam.
            const containers = [];
            const owner = {
                document,
                Zotero_Tabs: {
                    add() {
                        const container = document.createElement('div');
                        document.body.append(container);
                        containers.push(container);
                        return { id: 'epub-menu-' + containers.length, container };
                    },
                    select() {},
                    rename() {},
                    close() {},
                },
            };
            const presenter = new MkteroEpubValidation.MarkdownTabPresenter({
                zotero: { getMainWindow: () => owner },
                rootURI: 'data:,',
                createView: options => MkteroEpubValidation.createMarkdownTabView({
                    ...options,
                    stylesheetText,
                    editorFactory: ({ document, parent }) => {
                        const node = document.createElement('div');
                        parent.append(node);
                        return { setDocument() {}, refreshRendering() {}, destroy() { node.remove(); } };
                    },
                }),
            });
            let exportCalls = 0;
            let refreshedCalls = 0;
            const otherActions = {
                onSaveSnapshot() {},
                onExportMarkdown() {},
                onExportObsidian() {},
            };
            const firstExport = async ({ ownerWindow }) => {
                check(ownerWindow === window, 'The menu must pass its owner window');
                exportCalls++;
                return { status: 'cancelled' };
            };
            const visibleMenu = presentation => [...presentation.view.host.shadowRoot
                .querySelector('#mktero-export-action-menu').children]
                .filter(button => !button.hidden).map(button => button.id);
            const expectedMenu = ['mktero-save-snapshot', 'mktero-export-markdown',
                'mktero-export-obsidian', 'mktero-export-epub'];
            let readerMenu;
            try {
                const presentation = presenter.open(42, { ...otherActions, onExportEpub: firstExport });
                presenter.update(presentation, { status: 'ready', title: 'Menu verification',
                    progress: 100, markdown: '# Paper', sourceKind: 'markdown' });
                check(JSON.stringify(visibleMenu(presentation)) === JSON.stringify(expectedMenu),
                    'The presenter must expose EPUB as the fourth visible export action');
                const shadow = presentation.view.host.shadowRoot;
                shadow.querySelector('#mktero-export-actions').click();
                shadow.querySelector('#mktero-export-epub').click();
                await new Promise(resolve => setTimeout(resolve, 0));
                check(exportCalls === 1, 'Clicking EPUB must invoke the presenter callback');
                presenter.open(42, { onExportEpub: async () => {
                    refreshedCalls++;
                    return { status: 'cancelled' };
                } });
                shadow.querySelector('#mktero-export-actions').click();
                shadow.querySelector('#mktero-export-epub').click();
                await new Promise(resolve => setTimeout(resolve, 0));
                check(refreshedCalls === 1 && exportCalls === 1, 'Reused tabs must invoke the refreshed callback');
                const late = presenter.open(43, otherActions);
                presenter.update(late, { status: 'ready', progress: 100, markdown: '# Late action', sourceKind: 'markdown' });
                check(visibleMenu(late).length === 3, 'A missing EPUB callback hides only that action');
                presenter.open(43, { onExportEpub: firstExport });
                check(JSON.stringify(visibleMenu(late)) === JSON.stringify(expectedMenu),
                    'Adding the callback must immediately redraw a ready tab');
                readerMenu = { actions: visibleMenu(presentation), exportCalls, refreshedCalls, lateActionVisible: true };
            }
            finally {
                presenter.dispose();
                containers.forEach(container => container.remove());
            }
            return { archive: Array.from(archive), pngs, tableMetrics, refusedOversized, readerMenu };
        }, await readFile(path.join(root, 'ui/markdown.css'), 'utf8'));
        const xmlPage = await browser.newPage();
        xmlPage.on('request', request => {
            if (/^https?:/u.test(request.url())) networkRequests.push(request.url());
        });
        await xmlPage.route('**/*', route => route.abort());
        await xmlPage.goto('data:application/xhtml+xml,' + encodeURIComponent(
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>XML host</title></head><body></body></html>'
        ));
        await xmlPage.evaluate(source => { (0, eval)(source); }, bundle.outputFiles[0].text);
        const xmlHost = await xmlPage.evaluate(async () => {
            const namespace = 'http://www.w3.org/1999/xhtml';
            const canvas = document.createElementNS(namespace, 'canvas');
            canvas.width = canvas.height = 16;
            canvas.getContext('2d').fillRect(0, 0, 16, 16);
            const encoded = canvas.toDataURL('image/png').split(',')[1];
            const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
            const renderers = MkteroEpubValidation.createZoteroEpubRenderers({ getMainWindow: () => window });
            const rendered = await renderers.renderWideTable({
                html: '<table><tr><td>Text<br><img src="../images/cell.png"></td>'
                    + '<td><math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>x</mi><mn>2</mn></msup></math></td></tr></table>',
                assets: [{ path: 'images/cell.png', mimeType: 'image/png', data: bytes }],
            });
            const bitmap = await createImageBitmap(new Blob([rendered.data], { type: 'image/png' }));
            const result = { contentType: document.contentType, width: bitmap.width, height: bitmap.height };
            bitmap.close();
            canvas.width = canvas.height = 0;
            if (document.querySelector('[aria-hidden="true"]')) throw new Error('XML host was not cleaned');
            return result;
        });
        assert.equal(xmlHost.contentType, 'application/xhtml+xml');
        assert.ok(xmlHost.width > 1 && xmlHost.height > 1);
        assert.deepEqual(networkRequests, [], 'EPUB export and unsafe markup checks must not make network requests');
        const archive = Uint8Array.from(report.archive);
        const entries = unzipSync(archive);
        const chapter = new JSDOM(new TextDecoder().decode(entries['OEBPS/text/chapter-01.xhtml']), { contentType: 'application/xhtml+xml' }).window.document;
        assert.equal(chapter.querySelectorAll('table').length, 1, 'Ordinary table remains HTML');
        assert.equal(chapter.querySelectorAll('figure.epub-table-image img').length, 1);
        assert.ok(chapter.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML', 'math').length > 0);
        for (const element of chapter.querySelectorAll('a[href]')) {
            const href = element.getAttribute('href');
            if (!href.startsWith('chapter-')) continue;
            const [file, id] = href.split('#');
            const target = new JSDOM(new TextDecoder().decode(entries['OEBPS/text/' + file]), { contentType: 'application/xhtml+xml' }).window.document;
            assert.ok(target.getElementById(decodeURIComponent(id)), 'Missing EPUB link target ' + href);
        }
        assert.ok(entries['OEBPS/images/image-0001.png'], 'WebP is converted to packaged PNG');
        assert.ok(entries['OEBPS/images/table-0001.png'], 'Actual wide table PNG is packaged');
        await writeFile(path.join(output, name + '.epub'), archive);
        for (const [index, bytes] of report.pngs.entries()) await writeFile(path.join(output, name + '-table-' + (index + 1) + '.png'), Uint8Array.from(bytes));
        const metrics = { browser: name, version: browser.version(), tables: report.tableMetrics, refusedOversized: report.refusedOversized, xmlHost, readerMenu: report.readerMenu };
        await writeFile(path.join(output, name + '-report.json'), JSON.stringify(metrics, null, 2) + '\n');
        console.log(name + ' ' + browser.version() + ': actual rasterization and EPUB export passed');
    }
    finally {
        await browser.close();
    }
}
