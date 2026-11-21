// Run with an externally installed Playwright module, like the other browser checks:
// MKTERO_PLAYWRIGHT_PATH=/path/to/playwright/index.mjs MKTERO_EPUB_BROWSERS=chrome node scripts/validate-epub-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
        contents: "export { createZoteroEpubRenderers } from './src/platform/zotero-epub-renderers.js'; export { createEpub } from './src/epub/epub-export.js'; export { renderMarkdownHTML } from './src/markdown/markdown-html.js'; export { default as katex } from 'katex'; export { MarkdownTabPresenter } from './src/ui/markdown-tab-presenter.js'; export { createMarkdownTabView } from './src/ui/markdown-window.js';",
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
    // macOS 27 can deny Firefox 157 access to its default app-data directory
    // even with an explicit profile. Keep Core Foundation's home local to
    // this test browser (Playwright #42768), without changing the real HOME.
    const firefoxHome = name === 'firefox' && process.platform === 'darwin'
        ? await mkdtemp(path.join(tmpdir(), 'mktero-epub-firefox-')) : '';
    let browser;
    try {
        if (firefoxHome) {
            // Precreate standard directories so macOS does not add deny-delete
            // ACLs when Firefox asks Core Foundation to create them.
            await Promise.all(['Library/Application Support', 'Downloads'].map(directory => (
                mkdir(path.join(firefoxHome, directory), { recursive: true })
            )));
        }
        browser = await type.launch({
            headless: true,
            executablePath: process.env[`MKTERO_${name.toUpperCase()}_PATH`] || undefined,
            ...(name === 'chrome' ? { channel: 'chrome' } : {}),
            ...(firefoxHome ? { env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } } : {}),
        });
        const page = await browser.newPage();
        const networkRequests = [];
        page.on('request', request => {
            if (!/^(?:data:|blob:|about:)/u.test(request.url())) networkRequests.push(request.url());
        });
        await page.route('**/*', route => route.abort());
        await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"><style>table,caption{font-size:80px;padding:40px}p{margin:60px}body{line-height:3}</style></head><body></body></html>');
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const report = await page.evaluate(async stylesheetText => {
            const { createZoteroEpubRenderers, createEpub, renderMarkdownHTML, katex } = MkteroEpubValidation;
            const renderers = createZoteroEpubRenderers({ getMainWindow: () => window });
            function check(condition, message) {
                if (!condition) throw new Error(message);
            }
            async function inspectPNG(data, formula = false, sample = '') {
                const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }));
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const context = canvas.getContext('2d');
                context.drawImage(bitmap, 0, 0);
                bitmap.close();
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                let dark = 0;
                let ink = 0;
                let left = canvas.width;
                let top = canvas.height;
                let right = 0;
                let bottom = 0;
                for (let index = 0; index < pixels.length; index += 4) {
                    if (pixels[index + 3] < 16) continue;
                    if (pixels[index] < 128 && pixels[index + 1] < 128 && pixels[index + 2] < 128) dark++;
                    // Colored borders and backgrounds also belong inside the
                    // image bounds; checking black glyphs alone misses them.
                    if (pixels[index] >= 245 && pixels[index + 1] >= 245 && pixels[index + 2] >= 245) continue;
                    const x = (index / 4) % canvas.width;
                    const y = Math.floor(index / 4 / canvas.width);
                    ink++;
                    left = Math.min(left, x);
                    top = Math.min(top, y);
                    right = Math.max(right, x);
                    bottom = Math.max(bottom, y);
                }
                const metrics = { width: canvas.width, height: canvas.height, dark, ink, left, top, right, bottom };
                canvas.width = canvas.height = 0;
                check(dark > (formula ? 20 : 100), 'The PNG must contain visible content');
                const margin = formula ? 1 : 10;
                check(left >= margin && top >= margin && right < metrics.width - margin && bottom < metrics.height - margin,
                    'Content was clipped at a PNG edge (' + sample + '): ' + JSON.stringify(metrics));
                return metrics;
            }
            const pngs = [];
            const formulaPNGs = [];
            const tableMetrics = [];
            async function renderWideTable(options, sample = 'epub') {
                const rendered = await renderers.renderWideTable(options);
                tableMetrics.push({ sample, ...await inspectPNG(rendered.data, false, sample) });
                pngs.push(Array.from(rendered.data));
                return rendered;
            }
            const headers = Array.from({ length: 9 }, (_, index) => 'Column' + (index + 1));
            const wideMarkdown = ['| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |',
                '| ' + headers.map((_, index) => index === 0 ? '![Cell image](images/plot.webp)'
                    : index === 1 ? '$\\pmb{x+y}$'
                        : index === 2 ? '$\\fcolorbox{red}{yellow}{\\(x^2+y_1\\)}$'
                            : index === 3 ? '$\\smallint_0^1 x\\,dx$'
                                : index === 4 ? String.raw`$W^{(d)} = W_{\parallel}^{(d)} + W_{\perp}^{(d)}$`
                                    : index === 5 ? String.raw`$W^{(d)} = ^{\perp}W^{(d)} + ^{\parallel}W^{(d)}$`
                                        : 'Value ' + index).join(' | ') + ' |'].join('\n');
            const sourceCanvas = document.createElement('canvas');
            sourceCanvas.width = sourceCanvas.height = 16;
            sourceCanvas.getContext('2d').fillRect(0, 0, 16, 16);
            const webp = await new Promise(resolve => sourceCanvas.toBlob(resolve, 'image/webp'));
            check(webp?.type === 'image/webp', 'Browser must supply a real WebP conversion fixture');
            const formulaMetrics = [];
            const formulaFixtures = [
                { name: 'pmb', source: String.raw`\pmb{x+y}` },
                { name: 'fcolorbox', source: String.raw`\fcolorbox{red}{yellow}{\(x^2+y_1\)}` },
                { name: 'smallint', source: String.raw`\smallint_0^1 x\,dx` },
                {
                    name: 'S25',
                    source: String.raw`| F (\pmb{x}) - \tilde{F} (\pmb{x}) | < \epsilon ,\tag{S25}`,
                },
                {
                    name: 'W-subscripts',
                    source: String.raw`W^{(d)} = W_{\parallel}^{(d)} + W_{\perp}^{(d)}`,
                },
                {
                    name: 'W-prescripts',
                    source: String.raw`W^{(d)} = ^{\perp}W^{(d)} + ^{\parallel}W^{(d)}`,
                },
                { name: 'linebreak', source: String.raw`a\\b`, directKaTeX: true },
            ].map(fixture => {
                // Markdown currently normalizes display \\\\ differently;
                // obtain this linebreak from KaTeX's actual MathML builder.
                const generated = fixture.directKaTeX ? katex.renderToString(fixture.source, {
                    output: 'mathml', displayMode: false, strict: 'ignore',
                    throwOnError: true, trust: false, maxExpand: 1_000, maxSize: 20,
                }) : renderMarkdownHTML(`$$${fixture.source}$$`, { target: 'epub' });
                const template = document.createElement('template');
                template.innerHTML = generated;
                check(!template.content.querySelector('.math-fallback, .katex-error'), fixture.name + ' must generate real MathML');
                const math = template.content.querySelector('math');
                check(math?.querySelector('annotation')?.textContent === fixture.source, fixture.name + ' must retain its source before validation');
                return { ...fixture, html: math.outerHTML };
            });
            const formulaMarkdown = [
                'Lin Shen $^{ID}$, Kun Qian $^{*ID}$.',
                '',
                'The EEG encoder $f_{eeg}$ uses $E_{x}^{i} \\in R^{C \\times S}$ and $M_x \\in R^{1 \\times N}$.',
                '',
                '$$\\frac{x^2}{y_1} + \\sqrt{x}$$',
                '',
                '$$\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}$$',
                '',
                '$$x^2 + y^2 = z^2 \\tag{5}\\tag{5}$$',
                '',
                ...formulaFixtures.filter(fixture => !fixture.directKaTeX).flatMap(fixture => [`$$${fixture.source}$$`, '']),
            ].join('\n');
            async function renderMathToPNG(options, sample = 'epub') {
                const rendered = await renderers.renderMathToPNG(options);
                formulaMetrics.push({ sample, ...await inspectPNG(rendered.data, true, sample) });
                formulaPNGs.push(Array.from(rendered.data));
                check(Number.isFinite(rendered.verticalAlign), 'Formula baseline must be finite');
                return rendered;
            }
            function presentation(element) {
                return {
                    name: element.localName,
                    namespace: element.namespaceURI,
                    attributes: [...element.attributes].filter(attribute => attribute.name !== 'xmlns')
                        .map(attribute => [attribute.name, attribute.value]).sort(),
                    children: [...element.childNodes].filter(node => node.nodeType !== 1 || node.localName !== 'annotation')
                        .map(node => node.nodeType === 1 ? presentation(node) : node.textContent),
                };
            }
            function checkMathPresentation(actual, expected, sample) {
                const restored = actual.cloneNode(true);
                const originalBoxes = [...expected.querySelectorAll('mpadded')];
                const actualBoxes = [...restored.querySelectorAll('mpadded')];
                check(actualBoxes.length === originalBoxes.length, sample + ' changed the number of padded boxes');
                let adapted = 0;
                for (const [index, box] of actualBoxes.entries()) {
                    if (!box.style.padding) continue;
                    const original = originalBoxes[index];
                    const inset = /^(\d+(?:\.\d+)?)pt$/u.exec(original.getAttribute('lspace') || '');
                    const points = Number(inset?.[1]);
                    check(inset && points > 0 && points <= 12 && original.hasAttribute('mathbackground')
                        && original.children.length === 1 && box.children.length === 1
                        && original.getAttribute('width') === '+' + points * 2 + 'pt'
                        && original.getAttribute('height') === '+' + points * 2 + 'pt'
                        && original.getAttribute('voffset') === points + 'pt',
                        sample + ' adapted a box outside the known KaTeX color-box structure');
                    check(JSON.stringify(presentation(box.firstElementChild)) === JSON.stringify(presentation(original.firstElementChild)),
                        sample + ' changed the inner mathematical tree of a color box');
                    const equivalent = original.cloneNode(true);
                    equivalent.style.padding = points + 'pt';
                    check(box.getAttribute('style') === equivalent.getAttribute('style'),
                        sample + ' must preserve the border and add only the controlled padding');
                    check(box.getAttribute('mathbackground') === original.getAttribute('mathbackground'),
                        sample + ' must preserve the color-box background');
                    for (const attribute of ['width', 'height', 'lspace', 'voffset']) {
                        check(!box.hasAttribute(attribute), sample + ' padding must replace ' + attribute);
                        box.setAttribute(attribute, original.getAttribute(attribute));
                    }
                    box.setAttribute('style', original.getAttribute('style'));
                    adapted++;
                }
                check(JSON.stringify(presentation(restored)) === JSON.stringify(presentation(expected)),
                    sample + ' changed the MathML presentation beyond equivalent color-box spacing');
                return adapted;
            }
            function checkFixtureSemantics(actual, fixture, sample) {
                if (fixture.name === 'S25') {
                    const bold = [...actual.querySelectorAll('mstyle[style]')];
                    check(bold.length === 2 && bold.every(node => node.getAttribute('style') === 'text-shadow: 0.02em 0.01em 0.04px' && node.textContent === 'x'),
                        sample + ' must retain both bold x terms');
                    check([...actual.querySelectorAll('mi')].filter(node => node.textContent === 'x').length === 2,
                        sample + ' must retain exactly two x symbols');
                    check(actual.querySelector('semantics > mtable > mtr > mtd:last-child')?.textContent === '(S25)',
                        sample + ' must retain its complete equation number');
                }
                else if (fixture.name === 'W-subscripts' || fixture.name === 'W-prescripts') {
                    const terms = [...actual.querySelector('semantics > mrow').children];
                    const subscripted = fixture.name === 'W-subscripts';
                    const expectedNames = subscripted ? ['msup', 'mo', 'msubsup', 'mo', 'msubsup']
                        : ['msup', 'msup', 'msup', 'msup', 'msup'];
                    const expectedText = subscripted ? ['W(d)', '=', 'W∥(d)', '+', 'W⊥(d)']
                        : ['W(d)', '=⊥', 'W(d)', '+∥', 'W(d)'];
                    check(JSON.stringify(terms.map(node => node.localName)) === JSON.stringify(expectedNames)
                        && JSON.stringify(terms.map(node => node.textContent)) === JSON.stringify(expectedText),
                        sample + ' must retain the complete decomposition tree');
                    check([...actual.querySelectorAll('mi')].filter(node => node.textContent === 'W').length === 3
                        && [...actual.querySelectorAll('mi')].filter(node => node.textContent === 'd').length === 3,
                        sample + ' must retain all three W and d symbols');
                    const terminal = terms.at(-1);
                    const expectedTerminal = subscripted ? ['W', '⊥', '(d)'] : ['W', '(d)'];
                    check(JSON.stringify([...terminal.children].map(node => node.textContent)) === JSON.stringify(expectedTerminal),
                        sample + ' must retain the final W and its scripts');
                    check(JSON.stringify([...terminal.lastElementChild.children].map(node => [node.localName, node.textContent]))
                        === JSON.stringify([['mo', '('], ['mi', 'd'], ['mo', ')']]),
                        sample + ' must retain d and both parentheses of the rightmost superscript');
                    return { name: terminal.localName, text: terminal.textContent, superscript: terminal.lastElementChild.textContent };
                }
                else if (fixture.name === 'linebreak') {
                    check(actual.querySelector('mspace')?.getAttribute('linebreak') === 'newline'
                        && JSON.stringify([...actual.querySelectorAll('mi')].map(node => node.textContent)) === JSON.stringify(['a', 'b']),
                        sample + ' must retain the explicit linebreak and both symbols');
                }
                return null;
            }
            function colorBoxBounds(node) {
                const bounds = element => {
                    const rect = element.getBoundingClientRect();
                    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
                };
                return [...node.querySelectorAll('mpadded[mathbackground]')].map(box => ({
                    box: bounds(box),
                    body: bounds(box.firstElementChild),
                    padding: box.style.padding,
                }));
            }
            function checkColorBoxBounds(boxes, sample) {
                check(boxes.length === 1, sample + ' must measure the actual color box');
                const { box, body } = boxes[0];
                check(Object.values(box).every(Number.isFinite) && Object.values(body).every(Number.isFinite)
                    && box.width > 0 && box.height > 0 && body.width > 0 && body.height > 0,
                    sample + ' color-box dimensions must be visible and finite');
                const tolerance = 0.5;
                check(box.left <= body.left + tolerance && box.top <= body.top + tolerance
                    && box.right + tolerance >= body.right && box.bottom + tolerance >= body.bottom,
                    sample + ' must contain all four edges of its complete body: ' + JSON.stringify(boxes[0]));
            }
            const mathContracts = [];
            const nativeSerialize = XMLSerializer.prototype.serializeToString;
            const serialized = [];
            const serializedBounds = [];
            XMLSerializer.prototype.serializeToString = function serializeToString(node) {
                serializedBounds.push(colorBoxBounds(node));
                const markup = nativeSerialize.call(this, node);
                serialized.push(markup);
                return markup;
            };
            try {
                for (const fixture of formulaFixtures) {
                    const expected = new DOMParser().parseFromString(fixture.html, 'application/xml').documentElement;
                    const colorBoxes = [];
                    const terminalSuperscripts = [];
                    for (const context of ['formula', 'table']) {
                        const before = serialized.length;
                        if (context === 'formula') await renderMathToPNG({ html: fixture.html }, fixture.name);
                        else await renderWideTable({ html: '<table><tr><td>' + fixture.html + '</td></tr></table>' }, fixture.name);
                        check(serialized.length === before + 1, fixture.name + ' must reach actual SVG serialization');
                        const parsed = new DOMParser().parseFromString(serialized.at(-1), 'application/xml');
                        const actual = parsed.querySelector('math');
                        check(actual && !actual.querySelector('annotation, annotation-xml'), fixture.name + ' must remove only duplicate TeX');
                        const sample = fixture.name + ': ' + context;
                        const adapted = checkMathPresentation(actual, expected, sample);
                        if (fixture.name === 'fcolorbox') {
                            const boxes = serializedBounds.at(-1);
                            checkColorBoxBounds(boxes, sample);
                            check((adapted === 1 && boxes[0].padding === '3pt') || (adapted === 0 && !boxes[0].padding),
                                sample + ' live box padding must match its serialized MathML');
                            colorBoxes.push({ context, adapted: adapted === 1, ...boxes[0] });
                        }
                        else {
                            check(adapted === 0, sample + ' must keep its original MathML spacing');
                        }
                        const terminal = checkFixtureSemantics(actual, fixture, sample);
                        if (terminal) terminalSuperscripts.push({ context, ...terminal });
                        check(!document.querySelector('[aria-hidden="true"]'), fixture.name + ': temporary rendering DOM was not removed');
                    }
                    mathContracts.push({ sample: fixture.name, formula: true, table: true,
                        ...(colorBoxes.length ? { colorBoxes } : {}),
                        ...(terminalSuperscripts.length ? { terminalSuperscripts } : {}),
                    });
                }
                const mathWideTable = '<table><caption>Actual KaTeX formulas in a nine-column results table</caption>'
                    + '<thead><tr>' + headers.map(header => '<th>' + header + '</th>').join('') + '</tr></thead><tbody>'
                    + formulaFixtures.map(fixture => '<tr><th>' + fixture.name + '</th>'
                        + Array.from({ length: 7 }, (_, index) => '<td>Measured value ' + (index + 1) + ': 0.123 ± 0.004</td>').join('')
                        + '<td>' + fixture.html + '</td></tr>').join('')
                    + '</tbody></table>';
                const before = serialized.length;
                await renderWideTable({ html: mathWideTable }, 'all-MathML-wide-table');
                check(serialized.length === before + 1, 'The wide table must reach actual SVG serialization');
                const parsed = new DOMParser().parseFromString(serialized.at(-1), 'application/xml');
                const actualFormulas = [...parsed.querySelectorAll('math')];
                check(actualFormulas.length === formulaFixtures.length, 'The wide table must keep every formula');
                check(!parsed.querySelector('annotation, annotation-xml'), 'The wide table must remove duplicate TeX');
                checkColorBoxBounds(serializedBounds.at(-1), 'all-MathML-wide-table');
                for (const [index, fixture] of formulaFixtures.entries()) {
                    const expected = new DOMParser().parseFromString(fixture.html, 'application/xml').documentElement;
                    const sample = fixture.name + ': wide table';
                    const adapted = checkMathPresentation(actualFormulas[index], expected, sample);
                    const terminal = checkFixtureSemantics(actualFormulas[index], fixture, sample);
                    if (terminal) mathContracts[index].terminalSuperscripts.push({ context: 'wide-table', ...terminal });
                    mathContracts[index].wideTable = true;
                    if (fixture.name === 'fcolorbox') {
                        const boxes = serializedBounds.at(-1);
                        check((adapted === 1 && boxes[0].padding === '3pt') || (adapted === 0 && !boxes[0].padding),
                            'The wide table live box padding must match its serialized MathML');
                        mathContracts[index].colorBoxes.push({ context: 'wide-table', adapted: adapted === 1, ...boxes[0] });
                    }
                }
                check(!document.querySelector('[aria-hidden="true"]'), 'The wide table must remove temporary rendering DOM');
            }
            finally {
                XMLSerializer.prototype.serializeToString = nativeSerialize;
            }
            const archive = await createEpub({
                title: 'Actual EPUB renderer validation',
                language: 'en',
                modified: '2026-11-07T00:00:00Z',
                markdown: ['# Paper', '', formulaMarkdown, '', 'A formula $E=mc^2$, citation [1], and footnote $^{1}$.', '',
                    '<!-- mktero-note: footnote -->', '> $^{1}$ A chapter-end note.', '',
                    '![Converted image](images/plot.webp)', '', '| Key | Value |', '| --- | --- |', '| Small | HTML |', '',
                    wideMarkdown, '', 'See [details](#details).', '', '## Details', '', 'Content.', '',
                    '# References', '', '[1] Alpha A. A reference paper. 2020.'].join('\n'),
                assets: [{ path: 'images/plot.webp', mimeType: 'image/webp', data: new Uint8Array(await webp.arrayBuffer()) }],
                renderWideTable,
                renderMathToPNG,
                renderImageToPNG: renderers.renderImageToPNG,
            });
            const extraWide = '<table><caption>Caption with <p>several lines</p></caption><tbody>'
                + Array.from({ length: 5 }, (_, row) => '<tr>' + Array.from({ length: 24 }, (_, col) => '<td>Cell ' + row + '-' + col + '</td>').join('') + '</tr>').join('')
                + '</tbody></table>';
            await renderWideTable({ html: extraWide }, '24-column-table');
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
                if (cell.startsWith('<img')) {
                    check(refused, 'Unknown image resources must be rejected: ' + cell);
                }
                else {
                    check(!refused, 'Unsupported wrappers and attributes must be removed safely: ' + cell);
                }
            }
            const unsafeMathBodies = [
                '<mstyle style="text-shadow:0.02em 0.01em 0.04px;background:url(https://example.invalid/shadow)"><mi>x</mi></mstyle>',
                '<mpadded style="border:0.04em solid red;background:url(https://example.invalid/border)"><mi>x</mi></mpadded>',
                '<mpadded style="border:4.001px solid red"><mi>x</mi></mpadded>',
                '<mpadded mathbackground="yellow" width="+6pt" height="+6pt" lspace="3pt" voffset="3pt" style="border:0.04em solid red;padding:3pt"><mi>x</mi></mpadded>',
                '<mpadded style="padding:3pt"><mi>x</mi></mpadded>',
                '<mi onclick="window.epubUnsafe=true">x</mi>',
                '<mi href="https://example.invalid/formula">x</mi>',
                '<mstyle mathbackground="url(https://example.invalid/background)"><mi>x</mi></mstyle>',
                '<mrow xmlns="http://www.w3.org/2000/svg"><mi>x</mi></mrow>',
                '<mi xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.invalid/xlink">x</mi>',
                '<futuremath><mi>x</mi></futuremath>',
                '<mi future-attribute="value">x</mi>',
                '<mpadded width="10001em"><mi>x</mi></mpadded>',
                '<mo largeop="execute">∫</mo>',
                '<mspace linebreak="execute"/>',
                '<semantics><mi>x</mi><annotation encoding="text/html">different meaning</annotation></semantics>',
                '<semantics><mi>x</mi><annotation-xml encoding="application/x-tex"><mi>y</mi></annotation-xml></semantics>',
                '<semantics><mi>x</mi><annotation encoding="application/x-tex"><mi>y</mi></annotation></semantics>',
            ];
            for (const body of unsafeMathBodies) {
                const html = '<math xmlns="http://www.w3.org/1998/Math/MathML">' + body + '</math>';
                for (const context of ['formula', 'table']) {
                    let refused = false;
                    try {
                        if (context === 'formula') await renderers.renderMathToPNG({ html });
                        else await renderers.renderWideTable({ html: '<table><tr><td>' + html + '</td></tr></table>' });
                    }
                    catch (error) {
                        refused = /EPUB formula|MathML/u.test(error.message);
                    }
                    check(refused, 'Unsafe MathML must fail explicitly in ' + context + ': ' + body);
                    check(!document.querySelector('[aria-hidden="true"]'), 'Rejected MathML must not leave temporary DOM');
                }
            }
            check(!window.epubUnsafe, 'MathML and table event handlers must never execute');
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
            return { archive: Array.from(archive), pngs, formulaPNGs, tableMetrics, formulaMetrics, mathContracts, refusedOversized, readerMenu };
        }, await readFile(path.join(root, 'ui/markdown.css'), 'utf8'));
        const xmlPage = await browser.newPage();
        xmlPage.on('request', request => {
            if (!/^(?:data:|blob:|about:)/u.test(request.url())) networkRequests.push(request.url());
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
            const formula = await renderers.renderMathToPNG({
                html: '<math xmlns="http://www.w3.org/1998/Math/MathML"><msubsup><mi>E</mi><mi>x</mi><mi>i</mi></msubsup></math>',
            });
            if (!(formula.width > 0 && formula.height > 0 && Number.isFinite(formula.verticalAlign))) {
                throw new Error('XML formula layout is invalid');
            }
            const bitmap = await createImageBitmap(new Blob([rendered.data], { type: 'image/png' }));
            const result = { contentType: document.contentType, width: bitmap.width, height: bitmap.height, formulaWidth: formula.width };
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
        assert.equal(chapter.querySelector('math, annotation'), null);
        assert.ok(chapter.querySelectorAll('img.epub-math-image').length >= 9);
        assert.ok(report.formulaMetrics.length >= 9);
        assert.deepEqual(report.mathContracts.map(contract => contract.sample), [
            'pmb', 'fcolorbox', 'smallint', 'S25', 'W-subscripts', 'W-prescripts', 'linebreak',
        ]);
        assert.ok(report.mathContracts.every(contract => contract.formula && contract.table && contract.wideTable));
        for (const sample of ['W-subscripts', 'W-prescripts']) {
            const contract = report.mathContracts.find(contract => contract.sample === sample);
            assert.deepEqual(contract.terminalSuperscripts.map(terminal => terminal.context), ['formula', 'table', 'wide-table']);
            assert.ok(contract.terminalSuperscripts.every(terminal => terminal.superscript === '(d)'
                && terminal.name === (sample === 'W-subscripts' ? 'msubsup' : 'msup')
                && terminal.text === (sample === 'W-subscripts' ? 'W⊥(d)' : 'W(d)')));
            assert.ok(report.formulaMetrics.some(metrics => metrics.sample === sample), sample + ' must have a real formula PNG');
            assert.ok(report.tableMetrics.some(metrics => metrics.sample === sample), sample + ' must have a real table PNG');
        }
        assert.deepEqual(report.mathContracts.find(contract => contract.sample === 'fcolorbox').colorBoxes
            .map(box => box.context), ['formula', 'table', 'wide-table']);
        assert.ok(report.tableMetrics.some(metrics => metrics.sample === 'all-MathML-wide-table'));
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
        for (const [index, bytes] of report.formulaPNGs.entries()) await writeFile(path.join(output, name + '-formula-' + (index + 1) + '.png'), Uint8Array.from(bytes));
        const metrics = { browser: name, version: browser.version(), tables: report.tableMetrics, formulas: report.formulaMetrics, mathContracts: report.mathContracts, refusedOversized: report.refusedOversized, xmlHost, readerMenu: report.readerMenu };
        await writeFile(path.join(output, name + '-report.json'), JSON.stringify(metrics, null, 2) + '\n');
        console.log(name + ' ' + browser.version() + ': actual rasterization and EPUB export passed');
    }
    finally {
        try { await browser?.close(); }
        finally {
            if (firefoxHome) await rm(firefoxHome, { recursive: true, force: true });
        }
    }
}
