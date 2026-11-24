// MKTERO_PLAYWRIGHT_PATH=../mktero-web/node_modules/playwright/index.mjs node scripts/validate-sentence-reading-browser.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { visibleMarkdownTextForRanges } from '../src/markdown/markdown-visible-text.js';
import { assembleAlignedBlock, createAlignmentPlan } from '../src/markdown/translation-alignment.js';
import {
    collectMarkdownTranslationBlocks, createDocumentTranslationViews, mapSourceRangeToComparison,
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

const longLegacySource = longSentences.join(' ');
const longLegacyBlocks = collectMarkdownTranslationBlocks(longLegacySource);
const longLegacyTranslations = [{ id: longLegacyBlocks[0].id, markdown: longParagraph }];
const longLegacyDocument = {
    source: longLegacySource,
    views: createDocumentTranslationViews(longLegacySource, longLegacyBlocks, longLegacyTranslations),
    translations: longLegacyTranslations,
};

const groupedSentences = ['Known result.', 'Chen et al. Smith repeated the trial.', 'Final observation.'];
const groupedChinese = ['已确认的结果。', '句组对应的译文证据。', '最终观察结果。'];
const groupedSource = groupedSentences.join(' ');
const groupedBlocks = collectMarkdownTranslationBlocks(groupedSource);
const groupedTranslations = [align(groupedBlocks[0], groupedSentences, groupedChinese)];
const groupedViews = createDocumentTranslationViews(groupedSource, groupedBlocks, groupedTranslations, { targetLanguage: 'zh-CN' });
const groupedDocument = { source: groupedSource, translations: groupedTranslations, views: groupedViews };

const scoreFormula = String.raw`\mathrm{NS}_t^a = \frac{\phi_t(s_t^a) - \phi_t(s_t^{\mathrm{min}})}{\phi_t(s_t^{\mathrm{sota}}) - \phi_t(s_t^{\mathrm{min}})},\tag{1}`;
const scoreSource = ['The score is defined by', `$$\n${scoreFormula}\n$$`,
    'where $s_t^{\\mathrm{min}}$ is the minimum.'].join('\n\n');
const scoreBlocks = collectMarkdownTranslationBlocks(scoreSource);
const scoreTranslations = scoreBlocks.filter(block => block.translatable).map((block, index) => ({
    id: block.id,
    markdown: index === 0 ? '评分定义如下' : `其中 ${block.protectedFragments[0].placeholder} 是最低分。`,
}));
const scoreDocument = { source: scoreSource, translations: scoreTranslations,
    views: createDocumentTranslationViews(scoreSource, scoreBlocks, scoreTranslations) };

const disjointViews = {
    ...views,
    blockRanges: views.blockRanges.map(range => {
        if (range.id !== aligned.id) return range;
        const [first, middle, last] = range.alignmentUnits;
        return {
            ...range,
            alignmentUnits: [{
                ...middle,
                sourceRanges: [...first.sourceRanges, ...last.sourceRanges],
                comparisonSourceRanges: [...first.comparisonSourceRanges, ...last.comparisonSourceRanges],
            }],
        };
    }),
};
const disjointDocument = { source, translations, views: disjointViews };
const capParagraphs = Array.from({ length: 9 }, (_, index) => `Canonical source block ${index + 1}.`);
const capChinese = capParagraphs.map((_, index) => `编号${index + 1}的译文。`);
const capSource = capParagraphs.join('\n\n');
const capBlocks = collectMarkdownTranslationBlocks(capSource);
const capTranslations = capBlocks.map((block, index) => align(block, [capParagraphs[index]], [capChinese[index]]));
const capViews = createDocumentTranslationViews(capSource, capBlocks, capTranslations);
const capDocument = { source: capSource, translations: capTranslations, views: capViews };

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

// A real, tall document: the selected translation is a separate CodeMirror
// line, many screens below its source. No mocked viewport or scroll geometry.
const virtualSentences = Array.from({ length: 100 }, (_, index) => (
    `Synthetic sample ${String(index + 1).padStart(3, '0')} records the cache warmup sequence, `
        + 'keeps every deliberately delayed reading in its original order, and gives the offline '
        + 'reviewer enough evidence to verify the complete simulated run.'
));
const virtualChinese = virtualSentences.map((_, index) => `虚拟化编号${String(index + 1).padStart(3, '0')}的译文读数已记录。`);
const virtualSource = [
    ...Array.from({ length: 18 }, (_, index) => `Offline introduction ${index + 1} preserves a separate synthetic observation.`),
    virtualSentences.join(' '),
    ...Array.from({ length: 12 }, (_, index) => `Offline closing entry ${index + 1} preserves the final synthetic observation.`),
].join('\n\n');
const virtualBlocks = collectMarkdownTranslationBlocks(virtualSource);
const virtualBlock = virtualBlocks[18];
const virtualTranslations = virtualBlocks.map((block, index) => index === 18
    ? align(block, virtualSentences, virtualChinese)
    : { id: block.id, markdown: `离线回归说明段落${index + 1}，保留独立的模拟观察记录。` });
const virtualViews = createDocumentTranslationViews(virtualSource, virtualBlocks, virtualTranslations);
const virtualDocument = { source: virtualSource, translations: virtualTranslations, views: virtualViews };
const virtualRange = virtualViews.blockRanges.find(range => range.id === virtualBlock.id);
assert.equal(virtualRange.alignmentUnits.length, 100, 'Virtualization must keep verified sentence IDs');

// Real paragraphs on both sides let the same short translated selection sit
// near the top, in the middle, or at the bottom without changing viewport or popup styles.
const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./sentence-reading-browser/reader.mjs', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'reader', target: 'firefox115',
});
const css = await readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8');
const screenshotPaths = {
    compare: process.env.MKTERO_COMPARE_SCREENSHOT || '/tmp/mktero-unified-compare-zh.png',
    translated: process.env.MKTERO_TRANSLATED_SCREENSHOT || '/tmp/mktero-unified-translated-zh.png',
};
const POPUP = '.mktero-translation-source-popup';
const SOURCE_MARK = '.cm-mktero-translation-pair-selected-text';
const settle = page => page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}));

function expectPopupWithinColumn(layout, label) {
    const { box, reading, hostWidth } = layout;
    assert.ok(hostWidth > reading.width, `${label}: the editor parent must be narrower than its shadow host`);
    assert.ok(box.left >= reading.left - 1 && box.right <= reading.right + 1,
        `${label}: popup x=${box.left}..${box.right} escapes column x=${reading.left}..${reading.right}`);
    assert.ok(box.top >= reading.top - 1 && box.bottom <= reading.bottom + 1,
        `${label}: popup y=${box.top}..${box.bottom} escapes column y=${reading.top}..${reading.bottom}`);
}

async function clickAction(page, action) {
    await page.locator(`${POPUP} [data-action="${action}"]:visible`).click();
    await settle(page);
}

async function wheelToEdge(page, layout, direction, label) {
    const measure = () => page.evaluate(() => reader.popupLayout());
    const { scrollRange, sourceHeight, wheelPoint } = layout;
    const reached = scrollTop => direction > 0 ? scrollTop >= scrollRange - 1 : scrollTop === 0;
    assert.ok(sourceHeight > 0 && layout.wheelPointInSource,
        `${label}: the wheel must target the original text scrollport`);
    await page.mouse.move(wheelPoint.x, wheelPoint.y);
    // Gecko can cap one wheel event at slightly less than one scrollport.
    const maxSteps = 2 * Math.ceil(scrollRange / sourceHeight) + 1;
    for (let step = 0; step < maxSteps; step++) {
        await page.mouse.wheel(0, direction * (scrollRange + sourceHeight));
        await settle(page);
        const current = await measure();
        assert.ok(current, `${label}: scrolling must keep the popup open; ${JSON.stringify(await page.evaluate(() => {
            const { view, scrollTop, viewport } = reader.scrollState();
            return { view, scrollTop, viewport, selection: reader.selectionSnapshot() };
        }))}; before=${JSON.stringify({ selection: layout.selectionRect, reading: layout.reading })}`);
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

async function checkNavigation(page, view, { virtual = false, table = false, disjoint = false } = {}) {
    const tableFixture = structures.find(fixture => fixture.kind === 'table');
    const document = virtual ? virtualDocument : table ? tableFixture.verified : disjoint ? disjointDocument : { source, views, translations };
    await page.evaluate(options => reader.setDocument(options), { ...document, view });
    const range = virtual ? virtualRange : table ? document.views.blockRanges[0]
        : document.views.blockRanges.find(range => range.id === aligned.id);
    const text = virtual ? virtualChinese[0] : table ? '测量数值' : paragraph;
    const from = virtual || table ? 1 : paragraph.indexOf('延迟');
    const to = virtual ? 7 : from + 2;
    const offset = view === 'compare' ? range.comparisonTranslationFrom : range.translatedFrom;
    await page.evaluate(offset => reader.scrollToOffset(offset), offset);
    await settle(page);
    const selector = table ? '.cm-mktero-table tbody tr:nth-child(2) td:nth-child(2)' : undefined;
    assert.equal(await page.evaluate(options => reader.select(options), { text, from, to, selector }), text.slice(from, to),
        `${view} ${table ? 'table cell' : 'paragraph'}: the native selection must initially contain the requested text`);
    await settle(page);
    const selected = await page.evaluate(() => reader.selectionSnapshot());
    assert.equal(selected.text, text.slice(from, to),
        `${view} ${table ? 'table cell' : 'paragraph'}: native selection must survive selectionchange and rendering before Locate`);
    assert.ok(selected.connected && !selected.collapsed && selected.anchor !== null && selected.focus !== null);
    if (!table) assert.ok(selected.focus > selected.anchor);
    const before = await page.evaluate(() => reader.scrollState());
    const countersBefore = await page.evaluate(() => reader.counters());
    const canonical = table ? {
        from: document.source.indexOf('Second result'),
        to: document.source.indexOf('Second result') + 'Second result'.length,
    } : {
        from: virtual ? virtualBlock.from : aligned.from + sentences[0].length + 1,
        to: virtual ? virtualBlock.from + virtualSentences[0].length : aligned.from + sentences[0].length + 1 + sentences[1].length,
    };
    const canonicalRanges = disjoint ? range.alignmentUnits[0].sourceRanges : [canonical];
    const firstCanonical = canonicalRanges[0];
    const target = view === 'translated' ? firstCanonical : mapSourceRangeToComparison(firstCanonical, document.views.blockRanges);
    assert.ok(target, 'The source range must have a target in its displayed document');
    if (view === 'compare' && !table) assert.notEqual(target.from, firstCanonical.from, 'Bilingual navigation must exercise comparison offsets');
    await clickAction(page, 'locate-source');
    const locatedView = view === 'translated' ? 'original' : 'compare';
    await page.waitForFunction(expected => reader.currentView() === expected, locatedView);
    await settle(page);
    assert.ok(await page.evaluate(offset => reader.offsetVisible(offset), target.from), 'Locate must bring the correct original range into the reading viewport');
    const located = await page.evaluate(() => reader.scrollState());
    const countersLocated = await page.evaluate(() => reader.counters());
    if (view === 'translated') {
        assert.deepEqual(countersLocated.reveals.slice(countersBefore.reveals.length), [{
            source: firstCanonical, target: firstCanonical, ranges: canonicalRanges,
        }], 'Translation locate must pass exact canonical ranges to the actual setDocument host');
        assert.deepEqual(countersLocated.flashes.slice(countersBefore.flashes.length), [canonicalRanges],
            'The host must flash every canonical range without bridging gaps');
        const flash = await page.evaluate(() => reader.flashState());
        const expectedText = canonicalRanges.map(({ from, to }) => document.source.slice(from, to));
        assert.deepEqual(flash.ranges, canonicalRanges, 'Original flash decorations must retain exact canonical from/to');
        assert.deepEqual(flash.text, expectedText, 'Original flash must select the correct canonical text');
        assert.deepEqual(flash.rendered, expectedText, 'The original paragraph/table must render every exact flash target');
        if (disjoint) {
            assert.ok(canonicalRanges[0].to < canonicalRanges[1].from, 'The fixture must contain a real unhighlighted gap');
            assert.ok(!flash.rendered.join('').includes(sentences[1]), 'Disjoint flashes must exclude the intervening sentence');
        }
    }
    else assert.deepEqual(countersLocated.reveals, countersBefore.reveals, 'Bilingual locate must scroll directly without calling the host reveal');
    if (virtual) {
        assert.ok(before.scrollTop > before.clientHeight, 'The long document must save a nonzero reading position');
        assert.ok(located.scrollHeight > located.clientHeight * 10, 'The revealed source document must span many real viewports');
        // Comparison offsets belong only to the bilingual document. The host
        // replaces Translation with canonical original Markdown on Locate.
        if (view === 'compare') {
            assert.ok(located.viewport.to <= range.comparisonTranslationFrom || located.viewport.from >= range.comparisonTranslationTo,
                `The translation must leave CodeMirror viewport ${JSON.stringify(located.viewport)}`);
        }
        assert.ok(located.gaps > 0, 'CodeMirror must render real virtualization gaps');
        // CodeMirror can retain the native selection line outside view.viewport.
        // Switching from Translation replaces that document, removing it too.
        if (view === 'translated') assert.ok(!located.renderedText.includes(text),
            'The translated document must be replaced, removing the selected line from the rendered DOM');
    }
    await page.locator('[data-action="return-to-translation"]').click();
    await settle(page);
    assert.equal(await page.evaluate(() => reader.currentView()), view, 'Return must restore the prior view');
    assert.deepEqual(await page.evaluate(() => reader.selectionSnapshot()), selected,
        'Return must recreate the native selection with its original document offsets');
    const restored = await page.evaluate(() => reader.scrollState());
    assert.ok(Math.abs(restored.scrollTop - before.scrollTop) <= 1,
        `Return must restore scrollTop ${before.scrollTop}, got ${restored.scrollTop}`);
    assert.equal(restored.scrollLeft, before.scrollLeft, 'Return must restore horizontal scrolling');
    assert.equal(await page.locator('[data-action="return-to-translation"]').count(), 0, 'Return must consume its button');
    const countersAfter = await page.evaluate(() => reader.counters());
    assert.deepEqual(countersAfter.viewChanges.slice(countersBefore.viewChanges.length), view === 'translated' ? ['translated'] : []);
    assert.deepEqual(countersAfter.annotations, countersBefore.annotations, 'Navigation must not create annotations');
    assert.deepEqual(countersAfter.copies, countersBefore.copies, 'Navigation must not copy');
    assert.equal(countersAfter.translation, 0, 'Navigation must not call selection AI');
    console.log(`${view}：${virtual ? '真实长文虚拟化' : table ? '表格单元格选区' : disjoint ? '不相邻句子独立范围' : '段落选区'}定位原文、精确高亮、返回视图、native selection 与 scrollTop 恢复通过`);
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
        const popup = page.locator(POPUP);
        const text = popup.locator('.mktero-translation-source-text');
        const color = popup.locator('[data-color="#5fb236"]');
        const counters = () => page.evaluate(() => reader.counters());
        const setFixture = async data => {
            await page.evaluate(options => {
                reader.clear();
                reader.setDocument(options);
            }, { ...data, view });
            await settle(page);
        };
        const select = async (value, from = 0, to = from + 2, extra = {}) => {
            await page.evaluate(() => reader.clear());
            await settle(page);
            if (!extra.selector) {
                await page.evaluate(text => reader.scrollToText(text), value);
                await settle(page);
            }
            const picked = await page.evaluate(options => reader.select(options), { text: value, from, to, ...extra });
            if (extra.endText) assert.ok(picked.includes(extra.endText.slice(0, extra.endTo)));
            else assert.equal(picked, value.slice(from, to));
            await popup.waitFor({ state: 'visible' });
            await settle(page);
            assert.equal(await popup.locator('input[type="checkbox"]').count(), 0);
            assert.equal(await popup.locator('[data-action*="translate-selection"], [data-action="preview-source"]').count(), 0);
            assert.equal(await page.locator('[role="dialog"]').count(), 1);
        };
        const expectSaved = async (expectedRanges, expectedText, comment = '', skippedBlockCount = 0) => {
            await settle(page);
            const { annotation, selectionContext } = (await counters()).annotations.at(-1);
            assert.deepEqual(annotation.ranges, expectedRanges);
            assert.equal(annotation.text, expectedText);
            assert.equal(annotation.color, comment ? '#ffd400' : '#5fb236');
            assert.equal(annotation.comment, comment);
            assert.deepEqual(selectionContext, {
                side: 'source', rangesAreSource: true, ...(skippedBlockCount ? { skippedBlockCount } : {}),
            });
            assert.equal(await page.locator('[role="dialog"]').count(), 0);
        };

        const list = structures.find(fixture => fixture.kind === 'list');
        await setFixture(list.verified);
        const [start, middle, end] = await page.evaluate(([first, last]) => [
            reader.textPoint({ text: first, offset: 0 }), reader.textPoint({ text: first, offset: 3 }),
            reader.textPoint({ text: last, offset: 3 }),
        ], list.translatedUnits);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        for (const point of [middle, end]) {
            await page.mouse.move(point.x, point.y, { steps: 6 });
            await settle(page);
            await page.waitForTimeout(300);
            assert.ok((await page.evaluate(() => reader.selectionState())).text, 'Native drag selected real text');
            assert.equal(await page.locator('[role="dialog"]').count(), 0, 'A held mouse must not show a popup, even when paused');
        }
        await page.mouse.up();
        await popup.waitFor({ state: 'visible' });
        assert.equal(await text.textContent(), list.visibleSource.join('\n\n'));
        assert.equal(await page.locator('[role="dialog"]').count(), 1);
        await setFixture({ source, views, translations });

        const first = paragraph.indexOf('下降');
        const second = paragraph.indexOf('下降', first + 1);
        const third = paragraph.indexOf(chinese[2]);
        for (const [from, to, backward, expected] of [
            [first, first + 2, false, [sentences[0]]], [second, second + 2, false, [sentences[1]]],
            [second, third, false, [sentences[1]]], [third, third + 1, false, [sentences[2]]],
            [second, third + 1, true, sentences.slice(1)],
        ]) {
            await select(paragraph, from, to, { backward });
            assert.deepEqual(await text.allTextContents(), [expected.join(' ')]);
            assert.deepEqual(await page.locator(SOURCE_MARK).allTextContents(), view === 'compare' ? expected : []);
        }
        assert.equal(await popup.locator('.mktero-translation-source-label').textContent(),
            locale === 'zh-CN' ? '选区对应的原文' : 'Original for this selection');
        const toolbarRows = await popup.locator('.mktero-markdown-selection-toolbar button').evaluateAll(buttons =>
            buttons.map(button => Math.round(button.getBoundingClientRect().y + button.offsetHeight / 2)));
        assert.ok(Math.max(...toolbarRows) - Math.min(...toolbarRows) <= 1, 'Normal-width controls fit one row');
        assert.deepEqual((await counters()).annotations, []);
        const snapshot = await page.evaluate(() => reader.selectionSnapshot());
        await clickAction(page, 'copy-original');
        assert.equal((await counters()).copies.at(-1), sentences.slice(1).join(' '));
        assert.deepEqual(await page.evaluate(() => reader.selectionSnapshot()), snapshot);
        await clickAction(page, 'copy-with-source');
        assert.deepEqual((await counters()).sourcedCopies.at(-1).target.ranges,
            [{ from: source.indexOf(sentences[1]), to: source.indexOf(sentences[2]) + sentences[2].length }]);
        const sentenceRange = [{ from: source.indexOf(sentences[1]), to: source.indexOf(sentences[1]) + sentences[1].length }];
        await select(paragraph, second, second + 2);
        await clickAction(page, 'view-in-pdf');
        assert.equal((await counters()).pdfLocations.at(-1).pageIndex, 1);
        await select(paragraph, second, second + 2);
        await clickAction(page, 'add-to-note');
        const note = (await counters()).notes.at(-1);
        assert.deepEqual(note.annotation.ranges, sentenceRange);
        assert.equal(note.annotation.text, sentences[1]);
        assert.equal(note.target, 'test-note');
        await select(paragraph, second, second + 2);
        await color.press('Space');
        await expectSaved(sentenceRange, sentences[1]);
        assert.equal((await counters()).annotations.length, 1);
        assert.equal((await page.evaluate(() => reader.selectionState())).collapsed, true);

        // Drag from a block-only match into a confirmed sentence. The legacy text stays readable.
        await select(unalignedChinese, 1, 2, { endText: paragraph, endTo: 2 });
        assert.deepEqual(await text.allTextContents(), [unalignedSource, sentences[0]]);
        await clickAction(page, 'add-note');
        const mixedDraft = page.locator('.mktero-annotation-note-editor');
        assert.equal(await mixedDraft.locator('.mktero-annotation-note-quote').textContent(), sentences[0]);
        await mixedDraft.locator('textarea').fill('Matched only');
        await mixedDraft.locator('[type="submit"]').click();
        await expectSaved([{ from: source.indexOf(sentences[0]), to: source.indexOf(sentences[0]) + sentences[0].length }],
            sentences[0], 'Matched only', 1);

        for (const fixture of structures) {
            await setFixture(fixture.wholeBlock);
            const part = fixture.reorderedSelection;
            await select(part.text, 1, 3, { selector: part.selector });
            const all = [{ from: 0, to: fixture.source.length }];
            const whole = visibleMarkdownTextForRanges(fixture.source, all).trim();
            assert.equal(await text.textContent(), whole);
            assert.equal(await popup.locator('[data-color], [data-action="add-note"], [data-action="add-to-note"]').count(), 0);
            const locate = popup.getByRole('button', { name: locale === 'zh-CN' ? '前往原文标注' : 'Annotate in original' });
            assert.ok(await locate.isVisible());
            const before = (await counters()).annotations.length;
            await locate.click();
            await settle(page);
            assert.equal(await page.evaluate(() => reader.currentView()), view === 'translated' ? 'original' : 'compare');
            await page.locator('[data-action="return-to-translation"]').click();
            await settle(page);
            assert.equal((await counters()).annotations.length, before);

            await setFixture(fixture.verified);
            for (const part of fixture.selections) {
                await select(part.text, 1, 3, { selector: part.selector });
                assert.equal(await text.textContent(), part.original);
                assert.equal(await popup.locator('[data-color]').count(), 8);
            }
            if (fixture.kind === 'list') {
                await select(fixture.translatedUnits[0], 1, 2, { endText: fixture.translatedUnits[1], endTo: 3 });
                assert.equal(await text.textContent(), fixture.visibleSource.join('\n\n'));
                if (capture) await page.screenshot({ path: screenshotPaths[view] });
                await clickAction(page, 'add-note');
                const draft = page.locator('.mktero-annotation-note-editor');
                const quote = fixture.visibleSource.join(' ');
                assert.equal(await draft.locator('.mktero-annotation-note-quote').textContent(), quote);
                await draft.locator('textarea').fill('List evidence');
                await draft.locator('[type="submit"]').click();
                await expectSaved(fixture.visibleSource.map(part => ({
                    from: fixture.source.indexOf(part), to: fixture.source.indexOf(part) + part.length,
                })), quote, 'List evidence');
            }
        }

        await setFixture(groupedDocument);
        await select(groupedChinese.join(''), groupedChinese[0].length + 1, groupedChinese[0].length + 3, { backward: true });
        assert.equal(await text.textContent(), groupedSentences[1]);
        assert.equal(await popup.locator('.mktero-translation-source-label').textContent(),
            locale === 'zh-CN' ? '选区对应的原文（含句组）' : 'Original for this selection (includes a sentence group)');

        await setFixture(longLegacyDocument);
        await page.evaluate(() => reader.setNarrow(true));
        await select(longParagraph);
        const layout = await page.evaluate(() => reader.popupLayout());
        expectPopupWithinColumn(layout, 'long original in narrow column');
        assert.ok(layout.firstLineVisible && layout.scrollRange > 0 && layout.horizontalOverflow <= 1);
        const beforeScroll = await page.evaluate(() => reader.selectionSnapshot());
        const last = await wheelToEdge(page, layout, 1, 'read last original line');
        assert.ok(last.lastLineVisible);
        assert.ok(last.actions.filter(action => ['locate-source', 'copy-original'].includes(action.name))
            .every(action => action.visible));
        assert.deepEqual(await page.evaluate(() => reader.selectionSnapshot()), beforeScroll);
        await page.evaluate(() => reader.setNarrow(false));
        await popup.locator('[data-action="locate-source"]').press('Enter');
        await settle(page);
        assert.equal(await popup.count(), 0);
        assert.ok(await page.locator('.cm-content').evaluate(body => body.getRootNode().activeElement === body));
        const caret = await page.evaluate(() => reader.selectionSnapshot());
        const originalStart = longLegacyDocument.views.blockRanges[0][view === 'compare' ? 'comparisonSourceFrom' : 'sourceFrom'];
        assert.equal(caret.collapsed, true);
        assert.equal(caret.anchor, originalStart, 'Keyboard activation places the caret at the original paragraph');

        await setFixture(capDocument);
        await select(capChinese[0], 0, 1, { endText: capChinese[8], endTo: 2 });
        assert.equal(await color.isDisabled(), true);
        assert.equal(await text.textContent(), capParagraphs.join('\n\n'));
        assert.ok(await popup.locator('.mktero-translation-source-unavailable').isVisible());
        await select(capChinese[0], 0, 1, { endText: capChinese[7], endTo: 2 });
        await color.click();
        const eight = capParagraphs.slice(0, 8);
        await expectSaved(eight.map(part => ({ from: capSource.indexOf(part), to: capSource.indexOf(part) + part.length })), eight.join(' '));
        for (const options of [{}, { table: true }, { virtual: true }, { disjoint: true }]) {
            await checkNavigation(page, view, options);
        }
        assert.equal((await counters()).translation, 0);
        await setFixture(scoreDocument);
        await page.evaluate(() => reader.setNarrow(true));
        await select('评分定义如下', 0, 2, { endText: '最低分。', endTo: 4 });
        const checkFormula = async result => {
            const fraction = result.locator('mfrac');
            const scripts = result.locator('.math-inline msubsup');
            assert.ok(await fraction.isVisible());
            assert.ok(await scripts.isVisible());
            const label = result.locator('mtd mtext').filter({ hasText: /^\(1\)$/u });
            assert.equal(await label.count(), 1);
            assert.ok(await label.isVisible());
            assert.equal(await result.locator('annotation:visible, .math-display-equation-number:visible').count(), 0);
            const fits = await result.evaluate(el => el.scrollWidth <= el.clientWidth + 1);
            assert.ok(fits, 'A wide equation must scroll inside its own box');
        };
        await checkFormula(popup.locator('.mktero-translation-source-scroll'));
        await page.evaluate(data => {
            reader.clear();
            reader.setDocument({ ...data, view: 'original' });
        }, scoreDocument);
        await settle(page);
        await page.evaluate(() => {
            reader.select({ text: 'The score is defined by', from: 0, to: 4, endText: 'is the minimum.' });
        });
        await page.locator('.cm-line').filter({ hasText: 'is the minimum.' })
            .dispatchEvent('mouseup', { button: 0 });
        const translation = page.locator('.mktero-annotation-popup [data-translation-status="success"] .mktero-selection-translation-result');
        await translation.waitFor({ state: 'visible' });
        await checkFormula(translation);
        assert.equal((await counters()).translation, 1);
        assert.deepEqual(errors, [], 'Browser page errors');
        assert.equal(requests, 0, 'Reading an original uses no network requests');
        await page.evaluate(() => reader.destroy());
        console.log(`${view} ${locale}: automatic source, shared toolbar, comments, notes, PDF location, copy, scroll and return passed`);
    }
    finally { await context.close(); }
}

const failures = [];
// Optional filters keep one failing case quick to investigate; the default
// remains both browsers × both views × both locales.
const cases = (name, values) => {
    const selected = process.env[name];
    if (!selected) return values;
    assert.ok(values.includes(selected), `${name} must be one of ${values.join(', ')}`);
    return [selected];
};
const browsers = cases('MKTERO_BROWSER', ['firefox', 'chromium']);
const readingViews = cases('MKTERO_VIEW', ['translated', 'compare']);
const locales = cases('MKTERO_LOCALE', ['en-US', 'zh-CN']);
for (const name of browsers) {
    const browser = await playwright[name].launch({ headless: true });
    try {
        console.log(`${name} ${browser.version()} (Node ${process.versions.node})`);
        for (const view of readingViews) {
            for (const locale of locales) {
                const capture = locale === 'zh-CN' && (name === 'chromium' || browsers.length === 1);
                try { await checkView(browser, view, locale, capture); }
                catch (error) { failures.push(new Error(`${name} ${view} ${locale}: ${error.message}`, { cause: error })); }
            }
        }
    }
    finally { await browser.close(); }
}
if (failures.length) throw new AggregateError(failures, 'Browser reader regression failed');
