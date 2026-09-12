import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = path.join(root, 'build/figure-validation');
const playwrightPath = process.env.MKTERO_PLAYWRIGHT_PATH;
if (!playwrightPath) throw new Error('Set MKTERO_PLAYWRIGHT_PATH to an installed Playwright module.');
const { chromium, firefox } = await import(pathToFileURL(playwrightPath).href);
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'scripts/figure-region-zotero-harness.mjs')],
    outfile: path.join(output, 'harness.js'), bundle: true, format: 'iife',
    globalName: 'MkteroFigureValidation', target: ['firefox115'], logLevel: 'silent' });
const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}#root{height:100vh}</style></head><body><div id="root"></div><script src="/build/figure-validation/harness.js"></script></body></html>');
            return;
        }
        const file = path.resolve(root, '.' + pathname);
        if (!file.startsWith(root + path.sep)) throw new Error('Invalid fixture path');
        const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css',
            '.json': 'application/json', '.pdf': 'application/pdf', '.wasm': 'application/wasm' }[path.extname(file)];
        if (mime) response.setHeader('Content-Type', mime);
        response.end(await readFile(file));
    }
    catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
    for (const [name, browserType] of Object.entries({ chromium, firefox })) {
        const browser = await browserType.launch({ headless: true,
            executablePath: process.env[`MKTERO_${name.toUpperCase()}_PATH`] || undefined });
        try {
            const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
            page.on('pageerror', error => console.error(name, error.message));
            await page.goto(url);
            const report = await page.evaluate(async () => MkteroFigureValidation.runFigureValidation({
                fixtureRoot: '/test/fixtures/figures', resourceRoot: '/build/package',
            }));
            await writeFile(path.join(output, `${name}-report.json`), JSON.stringify(report, null, 2));
            console.log(name, JSON.stringify(report.cases.filter(value => !value.passed)));
            assert.equal(report.passed, true, `${name} pixel validation failed`);
            await page.evaluate(async () => {
                const shadow = document.querySelector('#root').attachShadow({ mode: 'open' });
                const style = document.createElement('style');
                style.textContent = await (await fetch('/ui/markdown.css')).text();
                const host = document.createElement('div');
                host.className = 'markdown-editor-host'; host.style.height = '100vh';
                shadow.append(style, host);
                window.figureHost = host;
            });
            for (const width of [300, 520, 760, 1200]) {
                await page.setViewportSize({ width, height: 900 });
                for (const view of ['original', 'translation', 'comparison']) {
                    const identity = await page.evaluate(view => MkteroFigureValidation.showValidationDocument(
                        window.figureHost, { view }), view);
                    assert.equal(identity.figures, 1);
                    const contentImage = page.locator('img:not([aria-hidden="true"])').first();
                    await contentImage.waitFor({ state: 'visible' });
                    await page.waitForFunction(() => [...window.figureHost.querySelectorAll('img:not([aria-hidden="true"])')]
                        .every(image => image.complete && image.naturalWidth > 0));
                    const measured = await page.evaluate(() => {
                        const image = window.figureHost.querySelector('img:not([aria-hidden="true"])');
                        const box = image.getBoundingClientRect();
                        return { images: window.figureHost.querySelectorAll('img:not([aria-hidden="true"])').length,
                            ratio: box.width / box.height, naturalRatio: image.naturalWidth / image.naturalHeight,
                            x: box.x, right: box.right, width: innerWidth,
                            captions: window.figureHost.querySelectorAll('figcaption').length };
                    });
                    assert.equal(measured.images, 1);
                    assert.ok(Math.abs(measured.ratio - measured.naturalRatio) < 0.01);
                    assert.ok(measured.x >= -1 && measured.right <= measured.width + 1);
                    assert.equal(measured.captions, 1);
                    await page.screenshot({ path: path.join(output, `${name}-${width}-${view}.png`), fullPage: true });
                }
            }
            await page.evaluate(() => MkteroFigureValidation.disposeFigureValidation());
            console.log(`${name}: ${report.cases.length} pixel cases and 12 reader layouts passed.`);
        }
        finally { await browser.close(); }
    }
}
finally { await new Promise(resolve => server.close(resolve)); }
