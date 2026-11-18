// MKTERO_PLAYWRIGHT_PATH=../mktero-web/node_modules/playwright/index.mjs node scripts/validate-sentence-reading-browser.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { assembleAlignedBlock, createAlignmentPlan } from '../src/markdown/translation-alignment.js';
import {
    collectMarkdownTranslationBlocks, createDocumentTranslationViews,
} from '../src/markdown/markdown-translation-blocks.js';

const playwrightPath = process.env.MKTERO_PLAYWRIGHT_PATH;
if (!playwrightPath) throw new Error('Set MKTERO_PLAYWRIGHT_PATH to an installed Playwright module.');
const playwright = await import(pathToFileURL(playwrightPath).href);
const sentences = ['Memory use fell.', 'Latency decreased.', 'Accuracy held steady.'];
const chinese = ['内存下降了。', '延迟下降了。', '准确率保持稳定。'];
const paragraph = chinese.join('');
const unalignedSource = 'An older result had no timing data. The sample was retained.';
const unalignedChinese = '旧结果没有计时数据。该样本得到保留。';
const longSentences = [
    'During each simulated run, the test harness collected the time spent warming the cache, '
        + 'recorded the number of operations that never left memory, and saved a separate transcript '
        + 'for a reviewer to compare against the expected sequence of events.',
    'For the second batch, the harness delayed each simulated response until the matching clock '
        + 'tick, checked the order in which the readings arrived, and repeated the comparison '
        + 'after every artificial pause so no timing differences could escape the report.',
    'Finally, the independent reviewer checked the synthetic readings against the original '
        + 'transcript, explained why the deliberately unusual samples should remain in the table, '
        + 'and used the closing entry in the log to confirm that every sample was accounted for.',
];
const longChinese = ['模拟运行期间，系统记录缓存预热耗时。', '第二批次核对每次读数的到达顺序。', '最后，审阅者确认已覆盖全部样本。'];
const longParagraph = longChinese.join('');
const source = [unalignedSource, sentences.join(' '), longSentences.join(' ')].join('\n\n');
const blocks = collectMarkdownTranslationBlocks(source);
const [unaligned, aligned, longAligned] = blocks.filter(block => block.translatable);
function align(block, original, translated) {
    const plan = createAlignmentPlan(block);
    assert.deepEqual(plan?.units.map(unit => unit.sourceMarkdown), original);
    return assembleAlignedBlock(block, plan.units.map(({ id }, i) => ({
        id, translatedMarkdown: translated[i],
    })).reverse(), 'zh-CN');
}
const translations = [
    { id: unaligned.id, markdown: unalignedChinese },
    align(aligned, sentences, chinese),
    align(longAligned, longSentences, longChinese),
];
const views = createDocumentTranslationViews(source, blocks, translations);
for (const block of [aligned, longAligned]) {
    const expectedIDs = translations.find(translation => translation.id === block.id).alignment.units.map(unit => unit.id);
    assert.equal(new Set(expectedIDs).size, 3);
    assert.deepEqual(views.blockRanges.find(range => range.id === block.id)?.alignmentUnits?.map(unit => unit.id), expectedIDs,
        'The document view must project the verified IDs');
}

const tableCells = ['Group', 'Result', 'Alpha', 'First result', 'Beta', 'Second result'];
const structures = [
    {
        kind: 'list',
        source: '- Alpha sample\n- Beta sample',
        reordered: '- 乙样本译文\n- 甲样本译文',
        visibleSource: ['Alpha sample', 'Beta sample'],
        translatedUnits: ['甲样本译文', '乙样本译文'],
        reorderedSelection: { text: '乙样本译文' },
        selections: [{ text: '乙样本译文', original: 'Beta sample' }],
    },
    {
        kind: 'table',
        source: '| Group | Result |\n| --- | --- |\n| Alpha | First result |\n| Beta | Second result |',
        reordered: '| 组别 | 结果 |\n| --- | --- |\n| 乙组 | 乙组测量值 |\n| 甲组 | 甲组测量值 |',
        visibleSource: tableCells,
        translatedUnits: ['组别', '结果', '甲组', '测量数值', '乙组', '测量数值'],
        reorderedSelection: { text: '乙组测量值', selector: '.cm-mktero-table tbody tr:first-child td:nth-child(2)' },
        selections: [
            { text: '测量数值', selector: '.cm-mktero-table tbody tr:nth-child(2) td:nth-child(2)', original: 'Second result' },
            { text: '测量数值', selector: '.cm-mktero-table tbody tr:first-child td:nth-child(2)', original: 'First result' },
        ],
    },
].map(fixture => {
    const blocks = collectMarkdownTranslationBlocks(fixture.source);
    assert.equal(blocks.length, 1);
    const [block] = blocks;
    assert.equal(block.type, fixture.kind);
    const prepare = translation => {
        const translations = [translation];
        const views = createDocumentTranslationViews(fixture.source, blocks, translations, { targetLanguage: 'zh-CN' });
        assert.deepEqual(views.blockRanges[0].alignmentUnits?.map(unit => unit.id), translation.alignment?.units.map(unit => unit.id));
        return { source: fixture.source, views, translations };
    };
    return {
        ...fixture,
        id: block.id,
        wholeBlock: prepare({ id: block.id, markdown: fixture.reordered }),
        verified: prepare(align(block, fixture.visibleSource, fixture.translatedUnits)),
    };
});

const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./sentence-reading-browser/reader.mjs', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'reader', target: 'firefox115',
});
const css = await readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8');
const screenshotPath = process.env.MKTERO_POPUP_SCREENSHOT;
const MAX_DESKTOP_WIDTH = 440;
const MAX_SOURCE_HEIGHT = 180;
const SOURCE_TEXT = '.mktero-translation-source-text';
const SOURCE_MARK = '.cm-mktero-translation-pair-selected-text';
const ANNOTATE = 'button.mktero-related-source-create';
const OLD_ALIGNMENT_ACTIONS = '[data-action="enable-alignment"], [data-action="cancel-alignment"]';

function expectPopupWithinColumn(layout, label) {
    const { box, reading, hostWidth } = layout;
    assert.ok(hostWidth > reading.width, `${label}: the editor parent must be narrower than its shadow host`);
    assert.ok(box.left >= reading.left - 1 && box.right <= reading.right + 1,
        `${label}: popup x=${box.left}..${box.right} escapes column x=${reading.left}..${reading.right}`);
    assert.ok(box.top >= reading.top - 1 && box.bottom <= reading.bottom + 1,
        `${label}: popup y=${box.top}..${box.bottom} escapes column y=${reading.top}..${reading.bottom}`);
}

function expectActionsVisible(layout, label) {
    assert.deepEqual(layout.actions.map(action => action.name).sort(), ['annotate-source', 'locate-source']);
    for (const { name, visible } of layout.actions) assert.ok(visible, `${label}: ${name} is obscured`);
}

async function checkCompactPopup(page, { selection, settle, expectReading, capture }) {
    const measure = () => page.evaluate(() => reader.popupLayout());
    async function wheelToEdge(layout, direction, label) {
        const { scrollRange, sourceHeight, wheelPoint } = layout;
        const reached = scrollTop => direction > 0 ? scrollTop >= scrollRange - 1 : scrollTop === 0;
        await page.mouse.move(wheelPoint.x, wheelPoint.y);
        // Gecko can cap one wheel event at slightly less than one scrollport.
        const maxSteps = 2 * Math.ceil(scrollRange / sourceHeight) + 1;
        for (let step = 0; step < maxSteps; step++) {
            await page.mouse.wheel(0, direction * (scrollRange + sourceHeight));
            await settle();
            const current = await measure();
            assert.ok(current, `${label}: scrolling must keep the popup open`);
            if (reached(current.scrollTop)) return current;
        }
        await page.waitForFunction(({ direction, scrollRange }) => {
            const current = reader.popupLayout();
            return current && (direction > 0 ? current.scrollTop >= scrollRange - 1 : current.scrollTop === 0);
        }, { direction, scrollRange }).catch(async error => {
            const current = await measure();
            throw new Error(`${label}: scroll offset ${current?.scrollTop} did not reach ${direction > 0 ? scrollRange : 0}`, { cause: error });
        });
        return measure();
    }

    await selection(paragraph, 0, 2);
    await expectReading(sentences[0]);
    const short = await measure();
    expectPopupWithinColumn(short, 'short selection');
    assert.equal(short.scrollRange, 0, 'A short source should not need scrolling');
    assert.ok(short.firstLineVisible && short.lastLineVisible, 'The short source must be fully visible');
    assert.ok(short.sourceHeight <= short.sourceLineHeight * 2,
        `A short source must not reserve a tall body (got ${short.sourceHeight}px)`);
    expectActionsVisible(short, 'short selection');

    async function checkLong(label) {
        await expectReading(...longSentences);
        const before = await measure();
        expectPopupWithinColumn(before, label);
        assert.ok(before.box.bottom <= before.selectionRect.top || before.box.top >= before.selectionRect.bottom,
            `${label}: popup must not cover a wrapped selection when there is room beside it`);
        assert.ok(before.box.width <= MAX_DESKTOP_WIDTH, `${label}: popup is ${before.box.width}px wide (max ${MAX_DESKTOP_WIDTH}px)`);
        assert.ok(before.sourceHeight <= MAX_SOURCE_HEIGHT,
            `${label}: source scrollport is ${before.sourceHeight}px tall (max ${MAX_SOURCE_HEIGHT}px)`);
        assert.equal(before.popupOverflow, 0, `${label}: the popup, including actions, must not scroll`);
        assert.equal(before.horizontalOverflow, 0, `${label}: source must wrap without horizontal scrolling`);
        assert.ok(before.scrollRange > 0 && before.scrollTop === 0, `${label}: long source must start at the top and overflow`);
        assert.ok(before.firstLineVisible && !before.lastLineVisible, `${label}: source viewport must show the beginning, not the end`);
        expectActionsVisible(before, `${label} before scrolling`);

        const after = await wheelToEdge(before, 1, label);
        assert.ok(!after.firstLineVisible && after.lastLineVisible, `${label}: wheel must reach the entire last line`);
        assert.equal(after.box.y, before.box.y, `${label}: wheel must not move the popup`);
        expectActionsVisible(after, `${label} after scrolling`);
        return before;
    }

    await selection(longParagraph, 0, longParagraph.length);
    const desktop = await checkLong('desktop');
    assert.ok(short.box.width < desktop.box.width && short.box.height < desktop.box.height,
        `Short popup (${short.box.width}x${short.box.height}) must size to its content rather than match long popup (${desktop.box.width}x${desktop.box.height})`);
    await wheelToEdge(desktop, -1, 'desktop return to top');
    if (capture) {
        await page.screenshot({ path: screenshotPath, type: 'png' });
        console.log(`Compact popup screenshot: ${screenshotPath}`);
    }

    // Keep the selection and popup alive so this exercises the resize observer.
    await page.evaluate(() => document.querySelector('#reader').setAttribute('data-narrow', ''));
    await page.waitForFunction(width => {
        const layout = reader.popupLayout();
        return layout && layout.reading.width < width && layout.box.width <= layout.reading.width;
    }, desktop.box.width);
    const narrow = await checkLong('resized while open');
    assert.equal(narrow.id, desktop.id, 'Resizing must reposition the existing popup');
    assert.equal(narrow.hostWidth, desktop.hostWidth, 'The viewport and shadow host must not shrink in the narrow case');
    assert.ok(narrow.box.width < desktop.box.width,
        `Popup must adapt to the narrowed reading column (${desktop.box.width}px to ${narrow.box.width}px)`);
    console.log(`Compact popup: short ${short.box.width.toFixed(1)}x${short.box.height.toFixed(1)}px; desktop ${desktop.box.width.toFixed(1)}px and resized while open ${narrow.box.width.toFixed(1)}px wide; source scrollport ${desktop.sourceHeight}px/${narrow.sourceHeight}px; actions visible at both ends`);
}

async function checkView(browser, view, locale, capture) {
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block', viewport: { width: 1200, height: 640 } });
    let requests = 0;
    context.on('request', request => { if (/^https?:/u.test(request.url())) requests++; });
    await context.route('**/*', route => route.abort());
    await context.routeWebSocket('**/*', socket => { requests++; return socket.close(); });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.setContent('<!doctype html><meta charset="utf-8"><style>body { margin: 0; }</style><main id="reader"></main>');
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.evaluate(options => reader.mount(options), { source, translations, views, view, css, locale });
        const texts = page.locator(SOURCE_TEXT);
        const marks = page.locator(SOURCE_MARK);
        const row = page.locator('.mktero-translation-legacy-block');
        const selection = async (text, from, to, backward = false, selector) => {
            assert.equal(await page.evaluate(options => reader.select(options), { text, from, to, backward, selector }),
                text.slice(from, to), 'The browser must actually select the requested characters');
            await settle();
        };
        // Native selectionchange is asynchronous; the editor applies it on the
        // next frame. Do not dispatch editor events or call a hit-test helper.
        const settle = () => page.evaluate(() => new Promise(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }));
        const expectReading = async (...expected) => {
            assert.deepEqual(await marks.allTextContents(), view === 'compare' ? expected : []);
            assert.deepEqual(await texts.allTextContents(), view === 'translated' && expected.length ? [expected.join('\n\n')] : []);
        };
        const expectNoRequests = async () => assert.deepEqual(await page.evaluate(() => reader.counters()), {
            translation: 0, annotations: [],
        });
        const expectWholeBlockAction = async (id, label) => {
            await row.waitFor({ state: 'visible' });
            assert.equal(await row.getAttribute('data-translation-block-id'), id, label);
            await expectReading();
            assert.deepEqual(await row.locator('button').evaluateAll(buttons => buttons.map(button => button.dataset.action)),
                ['show-source-block'], label);
            assert.equal(await page.locator(`${ANNOTATE}, [data-action="locate-source"], .mktero-related-source-locate`).count(), 0, label);
            assert.equal(await page.locator(OLD_ALIGNMENT_ACTIONS).count(), 0, label);
            await row.locator('[data-action="show-source-block"]').click();
            await settle();
            assert.equal(await page.locator(OLD_ALIGNMENT_ACTIONS).count(), 0, label);
        };

        const first = paragraph.indexOf('下降');
        const second = paragraph.indexOf('下降', first + 1);
        const third = paragraph.indexOf(chinese[2]);
        await selection(paragraph, first, first + 2);
        await expectReading(sentences[0]);
        await selection(paragraph, second, second + 2);
        await expectReading(sentences[1]);
        await selection(paragraph, second, third);
        await expectReading(sentences[1]);
        await selection(paragraph, second, third + 1, true);
        await expectReading(sentences[1], sentences[2]);
        await page.evaluate(() => reader.clear());
        await settle();
        await expectReading();

        await selection(unalignedChinese, 0, 2);
        await expectWholeBlockAction(unaligned.id, 'unaligned paragraph');
        await expectReading(unalignedSource);
        await expectNoRequests();
        console.log(`${view} ${locale}: exact repeated word, partial second, sentence end, reverse cross, clear, explicit whole paragraph OK`);
        if (view === 'translated') {
            await checkCompactPopup(page, { selection, settle, expectReading, capture });
            await expectNoRequests();
        }

        // Reading shows only the matched sentence, but saving must target the
        // entire original paragraph at its canonical Markdown offsets.
        await selection(paragraph, second, second + 2);
        await expectReading(sentences[1]);
        await page.locator(ANNOTATE).click();
        await settle();
        const { annotations, translation } = await page.evaluate(() => reader.counters());
        assert.equal(translation, 0);
        assert.equal(annotations.length, 1, 'One click must save exactly one annotation');
        const [{ annotation, selectionContext }] = annotations;
        assert.deepEqual(annotation.ranges, [{ from: aligned.from, to: aligned.to }]);
        assert.equal(annotation.text, sentences.join(' '));
        assert.deepEqual(selectionContext, { side: 'source', rangesAreSource: true });
        assert.equal(await page.locator('[role="dialog"]').count(), 0, 'No follow-up dialog after saving');
        assert.deepEqual(await page.evaluate(() => reader.selectionState()), { text: '', collapsed: true });
        await expectReading();
        assert.equal(await page.locator('.cm-mktero-selection-retained').count(), 0, 'No retained selection after saving');

        for (const fixture of structures) {
            const selectPart = ({ text, selector }) => selection(text, 1, 3, false, selector);
            await page.evaluate(options => reader.setDocument(options), { ...fixture.wholeBlock, view });
            await selectPart(fixture.reorderedSelection);
            await expectWholeBlockAction(fixture.id, `reordered ${fixture.kind}`);
            if (view === 'compare' && fixture.kind === 'list') {
                // CodeMirror may include the rendered bullet at line boundaries.
                assert.deepEqual((await marks.allTextContents()).map(text => text.replace(/^•?\s*/u, '')), fixture.visibleSource);
                assert.equal(await texts.count(), 0);
            }
            else await expectReading(...(view === 'compare' ? fixture.visibleSource : [fixture.source]));

            await page.evaluate(options => reader.setDocument(options), { ...fixture.verified, view });
            for (const selected of fixture.selections) {
                await selectPart(selected);
                await expectReading(selected.original);
                assert.equal(await row.count(), 0, `Verified ${fixture.kind} selection must use its ID`);
            }
        }
        assert.deepEqual(await page.evaluate(() => reader.counters()), { annotations, translation: 0 });
        await page.evaluate(() => reader.destroy());
        assert.deepEqual(errors, [], 'Browser page errors');
        assert.equal(requests, 0, 'Network attempts while opening or using the offline reader');
        console.log(`${view} ${locale}: reordered lists/tables reveal only whole blocks, verified IDs resolve exact excerpts, one canonical annotation, 0 network or selection AI`);
    }
    finally { await context.close(); }
}

const failures = [];
for (const name of ['firefox', 'chromium']) {
    const browser = await playwright[name].launch({ headless: true });
    try {
        console.log(`${name} ${browser.version()} (Node ${process.versions.node})`);
        for (const view of ['translated', 'compare']) {
            for (const locale of ['en-US', 'zh-CN']) {
                const capture = Boolean(screenshotPath) && name === 'chromium' && locale === 'zh-CN';
                try { await checkView(browser, view, locale, capture); }
                catch (error) { failures.push(new Error(`${name} ${view} ${locale}: ${error.message}`, { cause: error })); }
            }
        }
    }
    finally { await browser.close(); }
}
if (failures.length) throw new AggregateError(failures, 'Browser reader regression failed');
