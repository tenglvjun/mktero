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

const served = [];
const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = path.resolve(previewOutput, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(previewOutput + path.sep)) throw new Error('Outside preview');
        const body = await readFile(file);
        served.push(pathname);
        response.writeHead(200, {
            'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-store',
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
        && /[\u4e00-\u9fff]/.test(report.zhLocale?.original || '');
    return report;
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

    await step('wheel-scroll', async () => {
        await page.evaluate(() => window.__mkteroPreview.view.editor.scrollToOffset(0));
        await page.waitForTimeout(200);
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
        const notesBefore = await page.locator('.markdown-note-item').count();
        await toolbar.locator('.mktero-annotation-color-button').first().click();
        await page.waitForFunction(count => (
            window.__mkteroPreview.view.host.shadowRoot.querySelectorAll('.markdown-note-item').length > count
        ), notesBefore, { timeout: 3000 });
        return { notesBefore, notesAfter: await page.locator('.markdown-note-item').count() };
    });

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

    await step('note-opens-pdf', async () => {
        await page.locator('.markdown-note-item .markdown-note-open-pdf').first().click();
        await page.waitForFunction(() => window.__mkteroPreview.shell.activeTab === 'pdf'
            && document.querySelector('.pdf-location-flash'), null, { timeout: 3000 });
        await page.locator('.window-tab[data-tab="reader"]').click();
        await page.waitForTimeout(250);
        return { returned: await page.evaluate(() => window.__mkteroPreview.shell.activeTab) };
    });
    return results;
}

async function textRect(page, text) {
    return page.evaluate(async needle => {
        const preview = window.__mkteroPreview;
        preview.view.editor.scrollToOffset(Math.max(0, preview.model.markdown.indexOf(needle) - 260));
        await new Promise(resolve => setTimeout(resolve, 300));
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
            return {
                x0: first.left + 1,
                y0: first.top + first.height / 2,
                x1: last.right - 1,
                y1: last.top + last.height / 2,
            };
        }
        return null;
    }, text);
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
    };
}

function formatSummary(summary) {
    if (summary.skipped) return `- ${summary.browser}: skipped (${summary.skipped})`;
    if (summary.error) return `- ${summary.browser}: error ${summary.error}`;
    const problems = [...summary.failedChecks, ...summary.failedInteractions, ...summary.errors];
    return `- ${summary.browser} ${summary.version || ''}: ${summary.passed ? 'pass' : 'FAIL'}`
        + (problems.length ? `\n    ${problems.join('\n    ')}` : '');
}
