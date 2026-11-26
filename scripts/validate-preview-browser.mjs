// Build the browser preview and check it in several engines. Playwright is not
// a dependency of this repository: point MKTERO_PLAYWRIGHT_PATH at an installed
// `playwright` module (its index.mjs). Real Safari runs through
// /usr/bin/safaridriver, which needs `safaridriver --enable` and Safari's
// "Allow Remote Automation" setting.
//
//   MKTERO_PLAYWRIGHT_PATH=/path/to/playwright/index.mjs \
//   MKTERO_PREVIEW_BROWSERS=chromium,chrome,firefox,webkit,safari \
//   node scripts/validate-preview-browser.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPreview, previewOutput } from './build-preview.mjs';
import { EMBED_CSP, EMBED_SANDBOX, READY_MESSAGE } from '../preview/embed.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(projectRoot, 'build/preview-validation');
const requested = (process.env.MKTERO_PREVIEW_BROWSERS || 'chromium,firefox,webkit')
    .split(',').map(value => value.trim()).filter(Boolean);
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
};

const build = await buildPreview();
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// /__embed.html frames /__sandboxed/ the way the website does: a sandboxed
// iframe, and the preview served with the website's CSP. The preview's module
// requests then carry `Origin: null`, so they need CORS.
const SANDBOXED = '/__sandboxed';
const EMBED_PAGE = `<!doctype html><meta charset="utf-8"><title>embed</title><body style="margin:0">
<iframe id="preview" sandbox="${EMBED_SANDBOX}" allow="clipboard-write" referrerpolicy="no-referrer"
    width="1280" height="800" src="${SANDBOXED}/index.html?lang=en&frame=desktop&theme=light&diagnostics=1"></iframe>
<script>
window.readyMessages = [];
addEventListener('message', event => {
    if (event.source !== document.getElementById('preview').contentWindow) return;
    if (event.data?.type === ${JSON.stringify(READY_MESSAGE)}) window.readyMessages.push(event.origin);
});
</script>`;

const served = [];
const server = createServer(async (request, response) => {
    try {
        let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/__embed.html') {
            response.writeHead(200, {
                'Content-Type': MIME['.html'],
                'Cache-Control': 'no-store',
                'Content-Security-Policy': "frame-src 'self'",
            });
            response.end(EMBED_PAGE);
            return;
        }
        const sandboxed = pathname.startsWith(`${SANDBOXED}/`);
        if (sandboxed) pathname = pathname.slice(SANDBOXED.length);
        const file = path.resolve(previewOutput, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(previewOutput + path.sep)) throw new Error('Outside preview');
        const body = await readFile(file);
        served.push(pathname);
        response.writeHead(200, {
            'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            ...(sandboxed ? {
                'Content-Security-Policy': EMBED_CSP,
                'Access-Control-Allow-Origin': '*',
            } : {}),
        });
        response.end(body);
    }
    catch {
        response.writeHead(404);
        response.end();
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

const reports = [];
try {
    const playwright = requested.some(name => name !== 'safari') ? await loadPlaywright() : null;
    for (const name of requested) {
        served.length = 0;
        let report;
        try {
            report = name === 'safari'
                ? await runSafari(name)
                : await runPlaywright(name, playwright);
        }
        catch (error) {
            report = { browser: name, passed: false, error: error.message };
        }
        report.grammarChunks = served
            .filter(file => /\/chunks\/(?!chunk-)[a-z-]+-[A-Z0-9]+\.js$/.test(file))
            .map(file => file.replace(/^\/chunks\/|-[A-Z0-9]+\.js$/g, ''));
        reports.push(report);
        await writeFile(path.join(output, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
    }
}
finally {
    server.close();
}

await writeFile(path.join(output, 'summary.json'), `${JSON.stringify({ build, reports: reports.map(summarize) }, null, 2)}\n`);
console.log(`preview startup ${(build.startupBytes / 1024).toFixed(0)} KiB`);
for (const report of reports) console.log(formatSummary(summarize(report)));
if (reports.some(report => !report.skipped && !report.passed)) process.exitCode = 1;

async function loadPlaywright() {
    const modulePath = process.env.MKTERO_PLAYWRIGHT_PATH;
    if (!modulePath) throw new Error('Set MKTERO_PLAYWRIGHT_PATH to an installed Playwright module.');
    return import(pathToFileURL(modulePath).href);
}

async function runPlaywright(name, playwright) {
    const engine = name === 'chrome' ? 'chromium' : name;
    const browserType = playwright[engine];
    if (!browserType) throw new Error(`Unknown browser ${name}`);
    const browser = await browserType.launch({
        headless: true,
        ...(name === 'chrome' ? { channel: 'chrome' } : {}),
    });
    const report = { browser: name, version: browser.version(), screenshots: [] };
    const external = [];
    const pageErrors = [];
    try {
        const open = async ({ lang = 'en', viewport = { width: 1280, height: 800 }, colorScheme = 'light', tab = 'reader' } = {}) => {
            const context = await browser.newContext({
                viewport,
                deviceScaleFactor: 2,
                colorScheme,
                ...(engine === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}),
            });
            await context.route('**/*', route => {
                const url = route.request().url();
                // WebKit routes the reader's own blob: figure URLs through here.
                if (url.startsWith(baseURL) || /^(?:blob|data):/.test(url)) return route.continue();
                external.push(url);
                return route.abort();
            });
            const page = await context.newPage();
            page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`));
            page.on('console', message => {
                if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
            });
            await page.goto(`${baseURL}/index.html?lang=${lang}&tab=${tab}`);
            await page.waitForFunction(() => window.__mkteroPreview?.selfTest
                || document.querySelector('.preview-fatal'), null, { timeout: 30_000 });
            const fatal = await page.evaluate(() => document.querySelector('.preview-fatal')?.textContent);
            if (fatal) throw new Error(fatal);
            await page.waitForTimeout(500);
            return { context, page };
        };
        const screenshot = async (page, label) => {
            const file = `${name}-${label}.png`;
            await page.screenshot({ path: path.join(output, file) });
            report.screenshots.push(file);
        };

        const main = await open();
        await screenshot(main.page, 'reader-en-1280');
        report.selfTest = await main.page.evaluate(() => window.__mkteroPreview.selfTest());
        report.interactions = await runInteractions(main.page);
        await screenshot(main.page, 'after-interactions');
        for (const tab of ['library', 'pdf']) {
            await main.page.evaluate(value => window.__mkteroPreview.shell.activate(value), tab);
            await main.page.waitForTimeout(250);
            await screenshot(main.page, `${tab}-en-1280`);
        }
        await main.context.close();

        const embed = await open({ lang: 'zh', viewport: { width: 1100, height: 664 } });
        report.zhLocale = await embed.page.evaluate(() => ({
            lang: document.documentElement.lang,
            original: window.__mkteroPreview.view.t('ai.translationView.original'),
        }));
        await screenshot(embed.page, 'reader-zh-1100');
        await embed.context.close();

        const dark = await open({ colorScheme: 'dark' });
        await screenshot(dark.page, 'reader-dark-1280');
        await dark.context.close();

        report.sandboxedEmbed = await runSandboxedEmbed(browser, external, pageErrors);
    }
    finally {
        await browser.close();
    }
    report.externalRequests = external;
    report.pageErrors = pageErrors;
    report.passed = Boolean(report.selfTest?.passed)
        && report.interactions.every(entry => entry.passed)
        && external.length === 0
        && pageErrors.length === 0
        && /[\u4e00-\u9fff]/.test(report.zhLocale?.original || '')
        && Boolean(report.sandboxedEmbed?.passed);
    return report;
}

// The preview inside the website's sandbox: it must start, pass its own
// checks, tell the parent it is ready, and have no storage.
async function runSandboxedEmbed(browser, external, pageErrors) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(baseURL) || /^(?:blob|data):/.test(url)) return route.continue();
        external.push(url);
        return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(`sandboxed pageerror: ${error.message}`));
    page.on('console', message => {
        if (message.type() === 'error') pageErrors.push(`sandboxed console: ${message.text()}`);
    });
    const result = { passed: false };
    try {
        await page.goto(`${baseURL}/__embed.html`);
        await page.waitForFunction(() => window.readyMessages.length > 0, null, { timeout: 30_000 });
        result.readyOrigin = await page.evaluate(() => window.readyMessages[0]);
        const frame = page.frames().find(candidate => candidate.url().includes(`${SANDBOXED}/index.html`));
        if (!frame) throw new Error('sandboxed frame not found');
        await frame.waitForFunction(() => /^(?:PASS|FAIL) /.test(document.title), null, { timeout: 90_000 });
        result.title = await frame.evaluate(() => document.title);
        result.storage = await frame.evaluate(() => {
            try {
                return typeof window.localStorage.length;
            }
            catch (error) {
                return error.name;
            }
        });
        // The diagnostics report overlays the sidebar. Dismiss it before
        // exercising the same pointer interactions as the public preview.
        await frame.locator('.preview-diagnostics').evaluate(panel => { panel.hidden = true; });
        const clickOptions = { timeout: 3000 };
        await frame.getByRole('tab', { name: 'Annotations', exact: true }).click(clickOptions);
        await frame.getByRole('radio', { name: 'Translation: Simplified Chinese', exact: true }).click(clickOptions);
        await frame.getByRole('menuitemradio', { name: 'Simplified Chinese', exact: true }).click(clickOptions);
        const links = frame.locator('.markdown-note-link');
        const annotatedSentences = await links.evaluateAll(nodes => nodes.filter(node => (
            !node.disabled && node.querySelector('.markdown-note-projection')
        )).length);
        if (await links.count() !== 4 || annotatedSentences !== 4) {
            throw new Error('All four sample annotations must link to translated sentences');
        }
        await frame.locator('.markdown-note-link[data-annotation-id="PREVIEW4"] .markdown-note-quote')
            .click(clickOptions);
        await frame.waitForFunction(() => {
            const shadow = window.__mkteroPreview.view.host.shadowRoot;
            const port = shadow.querySelector('.cm-scroller').getBoundingClientRect();
            const highlights = shadow.querySelectorAll('.cm-mktero-pdf-annotation[data-annotation-id="PREVIEW4"]');
            return [...highlights].some(node => {
                const rect = node.getBoundingClientRect();
                return node.textContent.includes('它在混合三栏以上') && rect.bottom > port.top && rect.top < port.bottom;
            });
        }, null, { timeout: 3000 });
        result.translatedAnnotations = annotatedSentences;
        result.passed = result.title.startsWith('PASS ') && result.storage === 'SecurityError';
    }
    catch (error) {
        result.error = error.message;
    }
    finally {
        await context.close();
    }
    return result;
}

// Real pointer, wheel and keyboard input, which the in-page self-test cannot
// produce.
async function runInteractions(page) {
    const results = [];
    const step = async (name, run) => {
        try {
            results.push({ name, passed: true, detail: await run() });
        }
        catch (error) {
            results.push({ name, passed: false, error: error.message.split('\n')[0] });
        }
    };
    const scrollerTop = () => page.evaluate(() => (
        window.__mkteroPreview.view.host.shadowRoot.querySelector('.cm-scroller').scrollTop
    ));
    // The self-test's last step saves and restores a correction, and the
    // reader restores its reading position after that asynchronously. A jump
    // made before that restore lands is undone, so jump until it holds.
    const scrollToTop = async () => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            await page.evaluate(() => window.__mkteroPreview.view.editor.scrollToOffset(0));
            await page.waitForTimeout(300);
            if (await scrollerTop() < 50) {
                await page.waitForTimeout(300);
                if (await scrollerTop() < 50) return;
            }
        }
        throw new Error(`The reader did not stay at the top (scrollTop ${await scrollerTop()})`);
    };

    await step('font-picker-pointer-selection', async () => {
        const initial = await page.evaluate(() => {
            const { view, model } = window.__mkteroPreview;
            const state = {
                font: view.readerFont,
                translationView: model.translationView,
                translationFonts: [...view.translationReaderFonts],
                lineHeight: view.readerLineHeight,
                width: view.readerWidth,
                alignment: view.readerAlignment,
            };
            model.onSetTranslationView('original');
            return state;
        });
        const selected = [];
        try {
            for (const mode of ['original', 'translated']) {
                await page.evaluate(value => (
                    window.__mkteroPreview.model.onSetTranslationView(value)
                ), mode);
                const typography = page.locator('.markdown-typography-toggle');
                if (await typography.getAttribute('aria-expanded') !== 'true') {
                    await typography.click();
                }
                const fonts = mode === 'original'
                    ? ['georgia', 'cambria', 'times-new-roman', 'system-serif']
                    : ['songti-sc', 'noto-serif-sc'];
                for (const font of fonts) {
                    await page.locator('#mktero-reader-font-family').click();
                    // A native press must keep the list open until click. Calling
                    // option.click() in page.evaluate bypasses that sequence.
                    await page.locator(`[data-reader-font="${font}"]`).click({ timeout: 3000 });
                    const result = await page.evaluate(() => {
                        const { view } = window.__mkteroPreview;
                        const root = view.host.shadowRoot;
                        return {
                            selected: root.querySelector('[data-reader-font][aria-selected="true"]')
                                ?.getAttribute('data-reader-font'),
                            fontFamily: getComputedStyle(root.querySelector('.cm-content')).fontFamily,
                            open: view.readerFontOptionsOpen,
                            typographyOpen: view.typographyOpen,
                            lineHeight: view.readerLineHeight,
                            width: view.readerWidth,
                            alignment: view.readerAlignment,
                        };
                    });
                    if (result.selected !== font || result.open || !result.typographyOpen
                        || result.lineHeight !== initial.lineHeight || result.width !== initial.width
                        || result.alignment !== initial.alignment) {
                        throw new Error(`Font selection changed the wrong control: ${JSON.stringify(result)}`);
                    }
                    selected.push({ mode, font, fontFamily: result.fontFamily });
                }
            }
            if (new Set(selected.slice(0, 4).map(entry => entry.fontFamily)).size !== 4) {
                throw new Error(`Body font did not follow the picker: ${JSON.stringify(selected)}`);
            }
            return selected;
        }
        finally {
            await page.evaluate(state => {
                const { view, model } = window.__mkteroPreview;
                view.translationReaderFonts = new Map(state.translationFonts);
                view.setReaderFont(state.font);
                model.onSetTranslationView(state.translationView);
                view.setTypographyOpen(false);
            }, initial);
        }
    });

    await step('wheel-scroll', async () => {
        await scrollToTop();
        const box = await page.locator('.cm-content').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + 200);
        const before = await scrollerTop();
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(400);
        const after = await scrollerTop();
        if (!(after > before + 200)) throw new Error(`scrollTop ${before} -> ${after}`);
        return { before, after };
    });

    await step('select-translate-highlight', async () => {
        // Line-start text, clear of the source-peek card in the top-right corner.
        const rect = await textRect(page, 'Rule-based methods');
        if (!rect) throw new Error('Selection text is not in the DOM');
        await page.mouse.move(rect.x0, rect.y0);
        await page.mouse.down();
        await page.mouse.move(rect.x1, rect.y1, { steps: 8 });
        await page.mouse.up();
        const toolbar = page.locator('.mktero-markdown-selection-actions');
        await toolbar.waitFor({ state: 'visible', timeout: 3000 });
        await toolbar.locator('[data-action="translate-selection"]').click();
        const result = toolbar.locator('.mktero-selection-translation-result');
        await result.waitFor({ state: 'visible', timeout: 4000 });
        await page.waitForFunction(() => {
            const node = window.__mkteroPreview.view.host.shadowRoot
                .querySelector('.mktero-selection-translation-result');
            return node?.textContent.includes('快且可预测');
        }, null, { timeout: 4000 });
        const noteIDsBefore = await page.locator('.markdown-note-link')
            .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-annotation-id')));
        const notesBefore = noteIDsBefore.length;
        const readingTop = await scrollerTop();
        await toolbar.locator('.mktero-annotation-color-button').first().click();
        await page.waitForFunction(count => (
            window.__mkteroPreview.view.host.shadowRoot.querySelectorAll('.markdown-note-item').length > count
        ), notesBefore, { timeout: 3000 });
        const selection = await page.evaluate(async ({ previousIDs, text }) => {
            await new Promise(resolve => {
                let frames = 0;
                const settle = () => {
                    if (++frames === 6) resolve();
                    else requestAnimationFrame(settle);
                };
                requestAnimationFrame(settle);
            });
            const shadow = window.__mkteroPreview.view.host.shadowRoot;
            const links = [...shadow.querySelectorAll('.markdown-note-link')];
            const created = links.filter(node => !previousIDs.includes(node.getAttribute('data-annotation-id')));
            return {
                created: created.map(node => node.getAttribute('data-annotation-id')),
                active: [...shadow.querySelectorAll('.markdown-note-link.is-active')]
                    .map(node => node.getAttribute('data-annotation-id')),
                readingTop: shadow.querySelector('.cm-scroller').scrollTop,
                saved: window.__mkteroPreview.model.annotationOverlay.matched
                    .filter(annotation => created.some(node => node.getAttribute('data-annotation-id') === annotation.id))
                    .map(annotation => ({ text: annotation.text, ranges: annotation.ranges })),
                expectedRange: {
                    from: window.__mkteroPreview.model.markdown.indexOf(text),
                    to: window.__mkteroPreview.model.markdown.indexOf(text) + text.length,
                },
            };
        }, { previousIDs: noteIDsBefore, text: 'Rule-based methods' });
        if (selection.saved.length !== 1 || selection.saved[0].text !== 'Rule-based methods'
            || JSON.stringify(selection.saved[0].ranges) !== JSON.stringify([selection.expectedRange])) {
            throw new Error(`Saved the wrong source selection: ${JSON.stringify(selection)}`);
        }
        if (selection.created.length !== 1 || selection.active.length !== 1
            || selection.active[0] !== selection.created[0]) {
            throw new Error(`Saved annotation must stay selected: ${JSON.stringify(selection)}`);
        }
        if (Math.abs(selection.readingTop - readingTop) > 2) {
            throw new Error(`Saving moved the article from ${readingTop} to ${selection.readingTop}`);
        }
        return { notesBefore, notesAfter: await page.locator('.markdown-note-item').count(), selection };
    });

    for (const { name, text, backward } of [
        { name: 'reverse-body-highlight', text: 'Learned layout models', backward: true },
        { name: 'forward-caption-highlight', text: 'Paragraph-order error by page layout.', backward: false },
        { name: 'reverse-caption-highlight', text: 'methods widens as layouts become less regular.', backward: true },
    ]) {
        await step(name, async () => {
            await page.keyboard.press('Escape');
            const before = await page.evaluate(() => window.__mkteroPreview.model.annotationOverlay.matched
                .map(annotation => annotation.id));
            const rect = await textRect(page, text, { center: true });
            if (!rect) throw new Error(`Selection text is not in the DOM: ${text}`);
            if (!rect.inset) throw new Error(`Selection text is too close to the reading viewport edge: ${text}`);
            await page.mouse.move(backward ? rect.x1 : rect.x0, backward ? rect.y1 : rect.y0);
            await page.mouse.down();
            await page.mouse.move(backward ? rect.x0 : rect.x1, backward ? rect.y0 : rect.y1, { steps: 8 });
            await page.mouse.up();
            const toolbar = page.locator('.mktero-markdown-selection-actions');
            await toolbar.waitFor({ state: 'visible', timeout: 3000 });
            await page.evaluate(() => new Promise(resolve => {
                let frames = 0;
                const settle = () => {
                    if (++frames === 6) resolve();
                    else requestAnimationFrame(settle);
                };
                requestAnimationFrame(settle);
            }));
            const selected = await page.evaluate(() => document.getSelection()?.toString());
            if (selected !== text) throw new Error(`Wrong native selection: ${JSON.stringify(selected)}`);
            await toolbar.locator('.mktero-annotation-color-button').first().click();
            await page.waitForFunction(previous => window.__mkteroPreview.model.annotationOverlay.matched
                .some(annotation => !previous.includes(annotation.id)), before, { timeout: 3000 });
            const saved = await page.evaluate(({ previous, text }) => {
                const model = window.__mkteroPreview.model;
                return {
                    annotations: model.annotationOverlay.matched.filter(annotation => !previous.includes(annotation.id))
                        .map(annotation => ({ text: annotation.text, ranges: annotation.ranges })),
                    expectedRange: { from: model.markdown.indexOf(text), to: model.markdown.indexOf(text) + text.length },
                };
            }, { previous: before, text });
            if (saved.annotations.length !== 1 || saved.annotations[0].text !== text
                || JSON.stringify(saved.annotations[0].ranges) !== JSON.stringify([saved.expectedRange])) {
                throw new Error(`Highlight differs from its source selection: ${JSON.stringify(saved)}`);
            }
            return { text, backward, ranges: saved.annotations[0].ranges };
        });
    }

    await step('typed-search', async () => {
        await page.keyboard.press('Escape');
        await page.locator('.markdown-document-search-toggle').click();
        const input = page.locator('.markdown-document-search-input');
        await input.waitFor({ state: 'visible', timeout: 2000 });
        await input.fill('');
        await page.keyboard.type('baseline');
        await page.waitForFunction(() => /[1-9]/.test(window.__mkteroPreview.view.host.shadowRoot
            .querySelector('.markdown-document-search-count')?.textContent || ''), null, { timeout: 3000 });
        const count = await page.locator('.markdown-document-search-count').textContent();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        return { count };
    });

    await step('outline-click', async () => {
        // The preview opens on the annotations segment of the left column.
        await page.locator('.markdown-outline-segment[data-outline-segment="headings"]').click();
        await page.locator('.markdown-outline-link', { hasText: 'Experiments' }).first().click();
        await page.waitForTimeout(500);
        const visible = await page.evaluate(() => {
            const shadow = window.__mkteroPreview.view.host.shadowRoot;
            const scroller = shadow.querySelector('.cm-scroller').getBoundingClientRect();
            return [...shadow.querySelectorAll('.cm-content .cm-line, .cm-content h2, .cm-content [class*="heading"]')]
                .some(node => node.textContent.includes('3. Experiments')
                    && node.getBoundingClientRect().top >= scroller.top - 4
                    && node.getBoundingClientRect().top < scroller.bottom);
        });
        if (!visible) throw new Error('Heading not in view after outline click');
        return { visible };
    });

    await step('annotation-single-click', async () => {
        await page.locator('.markdown-outline-segment[data-outline-segment="annotations"]').click();
        const visited = [];
        const sourceRanges = [];
        for (const id of ['PREVIEW4', 'PREVIEW1', 'PREVIEW3']) {
            await page.locator(`.markdown-note-link[data-annotation-id="${id}"] .markdown-note-quote`).click();
            await page.waitForFunction(annotationID => {
                const shadow = window.__mkteroPreview.view.host.shadowRoot;
                const port = shadow.querySelector('.cm-scroller').getBoundingClientRect();
                return [...shadow.querySelectorAll('.cm-mktero-pdf-annotation')]
                    .filter(node => node.getAttribute('data-annotation-id') === annotationID)
                    .some(node => {
                        const rect = node.getBoundingClientRect();
                        return rect.bottom > port.top && rect.top < port.bottom;
                    });
            }, id, { timeout: 3000 });
            // Wait for native scroll and CodeMirror layout notifications before
            // checking: the immediate click state used to pass and then revert.
            await page.evaluate(() => new Promise(resolve => {
                let frames = 0;
                const settle = () => {
                    if (++frames === 6) resolve();
                    else requestAnimationFrame(settle);
                };
                requestAnimationFrame(settle);
            }));
            const active = await page.evaluate(() => {
                const shadow = window.__mkteroPreview.view.host.shadowRoot;
                return [...shadow.querySelectorAll('.markdown-note-link.is-active')]
                    .map(node => ({
                        id: node.getAttribute('data-annotation-id'),
                        current: node.getAttribute('aria-current'),
                    }));
            });
            if (active.length !== 1 || active[0].id !== id || active[0].current !== 'location') {
                throw new Error(`Clicked ${id} once; active annotations: ${JSON.stringify(active)}`);
            }
            const source = await page.evaluate(annotationID => {
                const preview = window.__mkteroPreview;
                const annotation = preview.model.annotationOverlay.matched.find(entry => entry.id === annotationID);
                return { offset: preview.view.activeNavigationOffset, ranges: annotation.ranges, text: annotation.text };
            }, id);
            if (source.offset !== source.ranges[0].from) {
                throw new Error(`Clicked ${id} at the wrong source offset: ${JSON.stringify(source)}`);
            }
            sourceRanges.push({ id, ...source });
            visited.push(id);
        }
        return { visited, sourceRanges };
    });

    await step('note-opens-pdf', async () => {
        await page.locator('.markdown-outline-segment[data-outline-segment="annotations"]').click();
        await page.locator('.markdown-note-item .markdown-note-open-pdf').first().click();
        await page.waitForFunction(() => window.__mkteroPreview.shell.activeTab === 'pdf'
            && document.querySelector('.pdf-location-flash'), null, { timeout: 3000 });
        await page.locator('.window-tab[data-tab="reader"]').click();
        await page.waitForTimeout(250);
        return { returned: await page.evaluate(() => window.__mkteroPreview.shell.activeTab) };
    });
    return results;
}

async function textRect(page, text, { center = false, navigate = true } = {}) {
    const rect = await page.evaluate(async ({ needle, center, navigate }) => {
        const preview = window.__mkteroPreview;
        const offset = preview.model.markdown.indexOf(needle);
        if (navigate) {
            preview.view.editor.scrollToOffset(Math.max(0, offset - (center ? 0 : 260)), {
                align: center ? 'center' : 'start',
            });
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        const shadow = preview.view.host.shadowRoot;
        const walker = document.createTreeWalker(shadow.querySelector('.cm-content'), NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const index = node.data.indexOf(needle);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + needle.length);
            const rects = [...range.getClientRects()];
            const first = rects[0];
            const last = rects.at(-1);
            const port = shadow.querySelector('.cm-scroller').getBoundingClientRect();
            return {
                x0: first.left + 0.25,
                y0: first.top + first.height / 2,
                x1: last.right - 0.25,
                y1: last.top + last.height / 2,
                inset: first.top > port.top + 48 && last.bottom < port.bottom - 48,
                scrollDelta: (first.top + last.bottom - port.top - port.bottom) / 2,
                portX: port.left + port.width / 2,
                portY: port.top + port.height / 2,
            };
        }
        return null;
    }, { needle: text, center, navigate });
    if (center && rect && !rect.inset) {
        // A caption shares a measured block with its image. Centering that
        // block can leave the caption at the bottom edge, where a drag starts
        // native autoscroll. Wheel the actual caption into a safe visible area.
        await page.mouse.move(rect.portX, rect.portY);
        await page.mouse.wheel(0, rect.scrollDelta);
        await page.waitForFunction(() => new Promise(resolve => requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve(true));
        })));
        return textRect(page, text, { navigate: false });
    }
    return rect;
}

async function runSafari(name) {
    const port = await freePort();
    const driver = spawn('/usr/bin/safaridriver', ['--port', String(port)], { stdio: 'ignore' });
    try {
        await waitForPort(port);
        const created = await webdriver(port, 'POST', '/session', {
            capabilities: { alwaysMatch: { browserName: 'safari' } },
        });
        if (!created.value?.sessionId) {
            return { browser: name, skipped: true, reason: created.value?.message || 'safaridriver session failed' };
        }
        const session = created.value.sessionId;
        const call = (method, route, body) => webdriver(port, method, `/session/${session}${route}`, body);
        const report = { browser: name, version: created.value.capabilities?.browserVersion, screenshots: [] };
        try {
            await call('POST', '/timeouts', { script: 180_000, pageLoad: 60_000 });
            await call('POST', '/window/rect', { width: 1280, height: 860 });
            const visit = async query => {
                await call('POST', '/url', { url: `${baseURL}/index.html?${query}` });
                const ready = await call('POST', '/execute/async', {
                    script: `const done = arguments[arguments.length - 1];
                        const wait = () => {
                            const fatal = document.querySelector('.preview-fatal');
                            if (fatal) return done(fatal.textContent);
                            if (window.__mkteroPreview?.selfTest) return setTimeout(() => done(true), 500);
                            setTimeout(wait, 100);
                        };
                        wait();`,
                    args: [],
                });
                if (ready.value !== true) throw new Error(`Preview did not start: ${JSON.stringify(ready.value)}`);
            };
            const screenshot = async label => {
                const shot = await call('GET', '/screenshot');
                const file = `${name}-${label}.png`;
                await writeFile(path.join(output, file), Buffer.from(shot.value, 'base64'));
                report.screenshots.push(file);
            };
            await visit('lang=en');
            await screenshot('reader-en');
            const selfTest = await call('POST', '/execute/async', {
                script: `const done = arguments[arguments.length - 1];
                    window.__mkteroPreview.selfTest().then(done, error => done({ passed: false, error: String(error) }));`,
                args: [],
            });
            report.selfTest = selfTest.value;
            await screenshot('after-self-test');
            await visit('lang=zh');
            const zh = await call('POST', '/execute/sync', {
                script: 'return window.__mkteroPreview.view.t("ai.translationView.original");',
                args: [],
            });
            report.zhLocale = { original: zh.value };
            await screenshot('reader-zh');
            report.passed = Boolean(report.selfTest?.passed) && /[\u4e00-\u9fff]/.test(zh.value || '');
            return report;
        }
        finally {
            await call('DELETE', '');
        }
    }
    finally {
        driver.kill();
    }
}

async function webdriver(port, method, route, body) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.json();
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function waitForPort(port, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        try {
            await webdriver(port, 'GET', '/status');
            return;
        }
        catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    }
}

function summarize(report) {
    return {
        browser: report.browser,
        version: report.version,
        passed: report.skipped ? null : Boolean(report.passed),
        skipped: report.skipped ? report.reason : undefined,
        error: report.error,
        failedChecks: (report.selfTest?.results || []).filter(entry => !entry.passed)
            .map(entry => `${entry.name}: ${entry.error}`),
        failedInteractions: (report.interactions || []).filter(entry => !entry.passed)
            .map(entry => `${entry.name}: ${entry.error}`),
        errors: [...(report.selfTest?.errors || []).map(entry => `${entry.kind}: ${entry.message}`),
            ...(report.pageErrors || [])].slice(0, 12),
        externalRequests: report.externalRequests,
        grammarChunks: report.grammarChunks,
        sandboxedEmbed: report.sandboxedEmbed,
    };
}

function formatSummary(summary) {
    if (summary.skipped) return `- ${summary.browser}: skipped (${summary.skipped})`;
    if (summary.error) return `- ${summary.browser}: error ${summary.error}`;
    const problems = [...summary.failedChecks, ...summary.failedInteractions, ...summary.errors];
    const embed = summary.sandboxedEmbed;
    if (embed && !embed.passed) {
        problems.push(`sandboxed embed: ${embed.error || `${embed.title}, storage ${embed.storage}`}`);
    }
    return `- ${summary.browser} ${summary.version || ''}: ${summary.passed ? 'pass' : 'FAIL'}`
        + (problems.length ? `\n    ${problems.join('\n    ')}` : '');
}
