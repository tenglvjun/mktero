// MKTERO_PLAYWRIGHT_PATH=../mktero-web/node_modules/playwright/index.mjs node scripts/validate-reference-hover-browser.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const playwrightPath = process.env.MKTERO_PLAYWRIGHT_PATH;
if (!playwrightPath) throw new Error('Set MKTERO_PLAYWRIGHT_PATH to an installed Playwright module.');
const playwright = await import(pathToFileURL(playwrightPath).href);
const css = await readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8');
const markdown = [
    'Select the sentence around Figure 1 and Table 1 with references [1] and [2].',
    '',
    '![Figure 1. Measured results](images/result.png)',
    '',
    'Table 1. Results',
    '',
    '| Model | Score |',
    '| --- | --- |',
    '| First [1] | 10 |',
    '',
    '## References',
    '',
    '[1] First author. First paper. 2024.',
    '[2] Second author. Second paper. 2025.',
    '',
    ...Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}. Extra text to exercise reader scrolling.`),
].join('\n');
const bundle = await build({
    stdin: {
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
        contents: `
            import { createInlineMarkdownEditor } from './src/editor/inline-markdown-editor.js';
            import { EditorView } from '@codemirror/view';
            const host = document.querySelector('#host');
            const root = host.attachShadow({mode: 'open'});
            let editor;
            window.mountReader = () => {
                editor?.destroy();
                const style = document.createElement('style');
                style.textContent = ${JSON.stringify(css)};
                const parent = document.createElement('div');
                parent.className = 'markdown-editor-host';
                parent.style.cssText = 'height: 560px; width: 900px;';
                root.replaceChildren(style, parent);
                editor = createInlineMarkdownEditor({
                    parent, initialMarkdown: ${JSON.stringify(markdown)},
                    resolveImageURL: () => 'data:image/svg+xml,' + encodeURIComponent(
                        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="lightblue"/></svg>'),
                });
                window.reader = {editor, parent,
                    view: EditorView.findFromDOM(parent.querySelector('.cm-editor'))};
            };
            window.mountReader();
        `,
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', target: 'firefox115',
});

const popup = '.mktero-citation-popup, .mktero-figure-preview-popup, .mktero-table-preview-popup';
const types = [
    ['figure', '.cm-mktero-figure-reference', '.mktero-figure-preview-popup'],
    ['table', '.cm-mktero-table-reference', '.mktero-table-preview-popup'],
    ['citation', '.cm-line .cm-mktero-citation', '.mktero-citation-popup'],
];
const requested = (process.env.MKTERO_HOVER_BROWSERS || 'chromium,firefox,webkit')
    .split(',').map(name => name.trim()).filter(Boolean);
for (const name of requested) {
    const browser = await playwright[name].launch({ headless: true });
    const context = await browser.newContext({
        offline: true, serviceWorkers: 'block', viewport: { width: 1100, height: 700 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.setContent('<!doctype html><body style="margin:20px"><div id="host"></div>');
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        // Control the reader's timers, while still exercising native hit testing,
        // Shadow DOM focus, mouse selection, and scrolling in each engine.
        await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
        await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
        const hover = async locator => {
            const box = await locator.boundingBox();
            assert.ok(box);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        };
        const reset = async () => {
            await page.mouse.move(1000, 650);
            await page.evaluate(() => {
                window.getSelection()?.removeAllRanges();
                window.mountReader();
            });
            await page.clock.runFor(100);
        };
        for (const [kind, reference, preview] of types) {
            await reset();
            const target = page.locator(reference).first();
            await hover(target);
            await page.clock.runFor(449);
            assert.equal(await page.locator(preview).count(), 0, `${kind}: early popup`);
            await page.clock.runFor(1);
            assert.equal(await page.locator(preview).count(), 1, `${kind}: missing preview`);
            await page.keyboard.press('Escape');
            await page.clock.runFor(500);
            assert.equal(await page.locator(preview).count(), 0, `${kind}: Escape reopened`);

            await reset();
            await hover(page.locator(reference).first());
            await page.mouse.move(1000, 650);
            await page.clock.runFor(600);
            assert.equal(await page.locator(preview).count(), 0, `${kind}: passing over opened preview`);

            await reset();
            // Start on the reference itself and pause over another reference
            // longer than the open delay while still holding the mouse button.
            const start = await page.locator(reference).first().boundingBox();
            assert.ok(start);
            const end = await page.locator('.cm-line .cm-mktero-citation').last().boundingBox();
            assert.ok(end);
            await page.mouse.move(start.x + 2, start.y + start.height / 2);
            await page.mouse.down();
            await page.mouse.move(end.x + end.width - 2, end.y + end.height / 2, { steps: 15 });
            await page.clock.runFor(600);
            assert.equal(await page.locator(popup).count(), 0, `${kind}: popup during drag`);
            await page.mouse.up();
            const selected = await page.evaluate(() => {
                const root = window.reader.parent.getRootNode();
                return (root.getSelection?.() || window.getSelection()).toString();
            });
            assert.ok(selected.length > 0, `${kind}: drag failed to select text`);
            await hover(page.locator('.cm-mktero-figure-reference').first());
            await page.clock.runFor(600);
            assert.equal(await page.locator(popup).count(), 0, `${kind}: popup replaced selection`);
        }
        await reset();
        await hover(page.locator('.cm-line .cm-mktero-citation').first());
        await page.clock.runFor(200);
        await page.mouse.wheel(0, 100);
        await page.clock.runFor(600);
        assert.equal(await page.locator(popup).count(), 0, 'wheel opened a queued preview');

        await reset();
        const citation = page.locator('.cm-line .cm-mktero-citation').first();
        await citation.focus();
        assert.equal(await page.locator('.mktero-citation-popup').count(), 1, 'keyboard focus waited');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Escape');
        await page.clock.runFor(500);
        assert.equal(await page.locator('.mktero-citation-popup').count(), 0, 'keyboard Escape reopened');
        assert.equal(await citation.evaluate(element => element.getRootNode().activeElement === element), true,
            'Escape did not restore keyboard focus');
        assert.deepEqual(errors, [], `${name}: browser errors`);
        console.log(`${name} ${browser.version()}: hover timing, passing over, native drag, selection, scrolling, and keyboard pass`);
    }
    finally {
        await context.close();
        await browser.close();
    }
}
