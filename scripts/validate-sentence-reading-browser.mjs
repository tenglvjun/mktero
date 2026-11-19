// MKTERO_PLAYWRIGHT_PATH=../mktero-web/node_modules/playwright/index.mjs node scripts/validate-sentence-reading-browser.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { visibleMarkdownTextForRanges } from '../src/markdown/markdown-visible-text.js';
import { assembleAlignedBlock, createAlignmentPlan } from '../src/markdown/translation-alignment.js';
import {
    collectMarkdownTranslationBlocks, createDocumentTranslationViews, mapSourceRangeToComparison,
} from '../src/markdown/markdown-translation-blocks.js';

const scopeProbe = process.env.MKTERO_SCOPE_PROBE === '1';
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
const positioningSource = [
    ...Array.from({ length: 12 }, (_, index) => `Positioning introduction ${index + 1} keeps a separate synthetic observation.`),
    longSentences.join(' '),
    ...Array.from({ length: 12 }, (_, index) => `Positioning closing entry ${index + 1} keeps a separate synthetic observation.`),
].join('\n\n');
const positioningBlocks = collectMarkdownTranslationBlocks(positioningSource);
const positioningTranslations = positioningBlocks.map((block, index) => index === 12
    ? align(block, longSentences, longChinese)
    : { id: block.id, markdown: `几何验证段落${index + 1}，为选区保留真实的正文滚动空间。` });
const positioningViews = createDocumentTranslationViews(positioningSource, positioningBlocks, positioningTranslations);
const positioningDocument = { source: positioningSource, translations: positioningTranslations, views: positioningViews };

const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./sentence-reading-browser/reader.mjs', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'reader', target: 'firefox115',
});
const css = await readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8');
const screenshotPaths = {
    compare: process.env.MKTERO_COMPARE_SCREENSHOT || '/tmp/mktero-unified-compare-zh.png',
    translated: process.env.MKTERO_TRANSLATED_SCREENSHOT || '/tmp/mktero-unified-translated-zh.png',
};
const MAX_DESKTOP_WIDTH = 420;
const MAX_SOURCE_HEIGHT = 180;
const POPUP = '.mktero-translation-source-popup';
const SOURCE_TEXT = '.mktero-translation-source-preview:visible .mktero-translation-source-text';
const ANNOTATION_TEXT = `${POPUP} .mktero-translation-annotation-text:visible`;
const SOURCE_MARK = '.cm-mktero-translation-pair-selected-text';
const ANNOTATE = '[data-action="annotate-source"]:visible';
const OLD_ALIGNMENT_ACTIONS = '[data-action="enable-alignment"], [data-action="cancel-alignment"]';
const TOOLBAR_ACTIONS = ['preview-source', 'copy-translation'];
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

function expectActionsVisible(layout, panel, label, { unavailable = false } = {}) {
    assert.ok(layout, `${label}: the selection popup must remain open`);
    assert.equal(layout.obsoleteSourceUI, 0, `${label}: removed More controls and panels must not exist, even hidden`);
    assert.ok(['collapsed', 'preview'].includes(panel), `${label}: only collapsed and preview states are supported`);
    const previewActions = ['locate-source', ...(!unavailable ? ['annotate-source'] : [])];
    const expected = [...TOOLBAR_ACTIONS, ...(panel === 'preview' ? previewActions : [])];
    assert.equal(layout.panel, panel);
    assert.deepEqual(layout.actions.map(action => action.name), expected, `${label}: only the active panel may offer actions`);
    for (const { name, visible } of layout.actions) assert.ok(visible, `${label}: ${name} is obscured`);
    assert.ok(['up', 'down'].includes(layout.expansion), `${label}: popup must declare its expansion direction`);
    if (panel === 'collapsed') return;
    const action = layout.actions.at(-1);
    if (!unavailable) {
        const locate = layout.actions.find(item => item.name === 'locate-source');
        assert.ok(Math.abs(locate.box.y - action.box.y) <= 1,
            `${label}: Locate and Save must share one action row; ${JSON.stringify({ locate: locate.box, save: action.box, popup: layout.box, reading: layout.reading })}`);
        assert.ok(action.box.left >= locate.box.right - 1, `${label}: Save must sit beside Locate`);
    }
    assert.ok(action.box.top >= layout.visibleTextBox.bottom - 1, `${label}: ${action.name} must stay below the visible scrollport`);
    if (layout.expansion === 'up') {
        assert.ok(layout.toolbar.top >= action.box.bottom - 1, `${label}: upward expansion must keep the toolbar below the panel actions`);
    }
    else assert.ok(layout.toolbar.bottom <= layout.visibleTextBox.top + 1, `${label}: downward expansion must keep the toolbar above the visible scrollport`);
}

function expectStableToolbar(before, after, label) {
    assert.equal(after.id, before.id, `${label}: panel changes must keep the existing popup`);
    assert.equal(after.expansion, before.expansion, `${label}: panel changes must keep the expansion direction`);
    const changes = [];
    const expectGeometry = (previous, current, fields, target) => {
        for (const field of fields) {
            const delta = current[field] - previous[field];
            if (Math.abs(delta) > 1) changes.push(
                `${target}.${field} moved from ${previous[field]} to ${current[field]} (delta ${delta}px, max 1px)`
            );
        }
    };
    expectGeometry(before.toolbar, after.toolbar, ['x', 'y', 'height'], 'toolbar');
    for (const name of TOOLBAR_ACTIONS) {
        const previous = before.actions.find(action => action.name === name);
        const current = after.actions.find(action => action.name === name);
        assert.ok(previous && current, `${label}: ${name} must remain in the toolbar`);
        expectGeometry(previous.box, current.box, ['x', 'y', 'width', 'height'], name);
    }
    assert.deepEqual(changes, [], `${label}: ${changes.join('; ')}`);
}

async function expectPreviewControl(page, locale, expanded, label) {
    const button = page.locator(`${POPUP} [data-action="preview-source"]:visible`);
    assert.equal(await button.textContent(), locale === 'zh-CN' ? '查看原文' : 'View original', `${label}: fixed preview label`);
    assert.equal(await button.getAttribute('aria-expanded'), String(expanded), `${label}: preview expansion state`);
    assert.equal(await button.locator('svg[aria-hidden="true"]').count(), 1, `${label}: preview has a decorative state arrow`);
}

async function expectPreviewSave(page, locale, label) {
    assert.equal(await page.locator(ANNOTATE).textContent(), locale === 'zh-CN' ? '保存到注释' : 'Save to Annotations',
        `${label}: preview save must use the selected UI locale`);
    assert.equal(await page.locator(`${POPUP} [data-action="source-more"]`).count(), 0,
        `${label}: both view toolbars must only contain View original and Copy translation`);
}

async function expectAnnotationScope(page, expected, label, { locale, blockCount = 1, scroll = false, geometryPath }) {
    const details = page.locator(`${POPUP} details.mktero-translation-annotation-details`);
    assert.equal(await details.count(), 1, `${label}: complete save scope must use native details`);
    const summary = details.locator('summary.mktero-related-source-scope');
    assert.equal(await summary.textContent(), locale === 'zh-CN'
        ? `保存范围：${blockCount} 个完整原文块`
        : blockCount === 1 ? 'Save scope: one complete original block' : `Save scope: ${blockCount} complete original blocks`,
    `${label}: save scope label must describe the complete original block count in the selected locale`);
    assert.equal(await details.getAttribute('open'), null, `${label}: save scope is collapsed initially`);
    assert.equal(await page.locator(ANNOTATION_TEXT).count(), 0, `${label}: complete source is hidden until explicitly expanded`);
    const selected = await page.evaluate(() => reader.selectionSnapshot());
    const before = await page.evaluate(() => ({ layout: reader.popupLayout(), scrollTop: reader.scrollState().scrollTop }));
    const reading = await page.locator(SOURCE_TEXT).textContent();
    const geometry = [{ stage: 'before-summary', ...before, selection: selected }];
    await page.evaluate(() => {
        reader.startEvidence();
        reader.recordEvidence('before-scope-summary');
    });
    try {
        for (const expanded of [true, false]) {
            await summary.click();
            await settle(page);
            await page.evaluate(expanded => reader.recordEvidence('after-scope-summary', { expanded }), expanded);
            const current = await page.evaluate(() => ({ layout: reader.popupLayout(), selection: reader.selectionSnapshot(), scrollTop: reader.scrollState().scrollTop }));
            const scope = expanded ? await page.evaluate(() => reader.popupLayout({ saveScope: true })) : null;
            geometry.push({ stage: expanded ? 'summary-expanded' : 'summary-collapsed', ...current, scope });
            assert.ok(current.layout, `${label}: native summary must keep the popup open; ${JSON.stringify(current)}`);
            assert.equal(await details.evaluate(node => node.open), expanded, `${label}: native summary ${expanded ? 'expands' : 'collapses'} the save scope`);
            expectStableToolbar(before.layout, current.layout, `${label}: scope ${expanded ? 'expanded' : 'collapsed'}`);
            expectPopupWithinColumn(current.layout, label);
            expectActionsVisible(current.layout, 'preview', label);
            assert.deepEqual(current.selection, selected, `${label}: inspecting save scope preserves the native selection`);
            assert.ok(Math.abs(current.scrollTop - before.scrollTop) <= 1, `${label}: inspecting save scope preserves the reading position`);
            assert.equal(await page.locator(SOURCE_TEXT).textContent(), reading, `${label}: save scope must retain the exact reading excerpt`);
            if (expanded) {
                assert.equal(await page.locator(ANNOTATION_TEXT).textContent(), expected,
                    `${label}: scope shows complete native original text`);
                assert.equal(scope.scrollport, 'details', `${label}: details must own the save scope scroll position`);
                assert.equal(scope.scrollportOverflowY, 'auto', `${label}: details must be the scrollport`);
                assert.equal(scope.textOverflowY, 'visible', `${label}: the annotation body must not nest another scrollport`);
                assert.equal(scope.textMaxHeight, 'none', `${label}: the annotation body must retain its full natural height`);
                expectActionsVisible(scope, 'preview', `${label}: expanded save scope`);
                if (scroll) assert.ok(scope.scrollRange > 0, `${label}: the complete long save scope must scroll internally`);
                assert.equal(scope.scrollTop, 0, `${label}: save scope must start at the beginning`);
                assert.ok(scope.firstLineVisible, `${label}: the complete first scope line must be readable initially; ${JSON.stringify(scope)}`);
                if (scope.scrollRange > 0) {
                    assert.ok(!scope.lastLineVisible, `${label}: overflowing scope must initially hide its last line`);
                    const bottom = await wheelToEdge(page, scope, 1, `${label}: save scope bottom`);
                    geometry.push({ stage: 'scope-bottom', scope: bottom });
                    assert.ok(!bottom.firstLineVisible && bottom.lastLineVisible, `${label}: scope wheel must reveal the complete last line; ${JSON.stringify(bottom)}`);
                    expectActionsVisible(bottom, 'preview', `${label}: scrolled save scope`);
                    expectStableToolbar(before.layout, bottom, `${label}: scrolling save scope keeps the toolbar fixed`);
                    const top = await wheelToEdge(page, bottom, -1, `${label}: save scope top`);
                    geometry.push({ stage: 'scope-top', scope: top });
                    assert.ok(top.firstLineVisible, `${label}: scope wheel must return to its complete first line`);
                    expectActionsVisible(top, 'preview', `${label}: save scope returned to top`);
                    assert.deepEqual(await page.evaluate(() => reader.selectionSnapshot()), selected,
                        `${label}: scrolling save scope preserves the native selection`);
                    assert.ok(Math.abs(await page.evaluate(() => reader.scrollState().scrollTop) - before.scrollTop) <= 1,
                        `${label}: scrolling save scope must not move the document`);
                    await page.mouse.move(before.layout.toolbar.x + 4, before.layout.toolbar.y + 4);
                    await page.waitForTimeout(300);
                }
                else assert.ok(scope.lastLineVisible, `${label}: the complete short scope must be readable without scrolling`);
            }
            else assert.equal(await page.locator(ANNOTATION_TEXT).count(), 0, `${label}: collapsing hides complete save scope`);
        }
        if (geometryPath) {
            await writeFile(geometryPath, `${JSON.stringify({ label, selected, reading, geometry }, null, 2)}\n`);
            console.log(`保存范围单滚动区几何证据：${geometryPath}`);
        }
    }
    catch (error) {
        const evidence = await page.evaluate(() => reader.finishEvidence());
        const failure = await page.evaluate(() => ({ layout: reader.popupLayout(), scope: reader.popupLayout({ saveScope: true }), selection: reader.selectionSnapshot(), scroll: reader.scrollState() }));
        const path = geometryPath || `/tmp/mktero-unified-scope-evidence-${process.env.MKTERO_BROWSER || 'browser'}-${before.layout.view}-${locale}.json`;
        await writeFile(path, `${JSON.stringify({ label, selected, before, reading, geometry, failure, evidence }, null, 2)}\n`);
        console.error(`保存范围失败证据：${path}`);
        throw error;
    }
    finally { await page.evaluate(() => reader.finishEvidence()); }
}

async function checkScopeProbe(page, { view, locale }) {
    await page.evaluate(options => reader.setDocument(options), { ...positioningDocument, view });
    await page.evaluate(text => reader.scrollToText(text), longParagraph);
    await settle(page);
    await page.waitForTimeout(550);
    const from = longChinese[0].length + 2;
    const to = from + 2;
    await page.evaluate(options => reader.positionText(options), { text: longParagraph, from, to, fraction: 0.5 });
    await settle(page);
    assert.equal(await page.evaluate(options => reader.select(options), { text: longParagraph, from, to }), longParagraph.slice(from, to));
    await settle(page);
    await clickAction(page, 'preview-source');
    assert.equal(await page.locator(SOURCE_TEXT).textContent(), longSentences[1], 'Reading preview must retain only the exact original sentence');
    await expectAnnotationScope(page, longSentences.join(' '), 'minimal long scope summary', {
        locale, scroll: true,
        geometryPath: `/tmp/mktero-unified-scope-probe-${process.env.MKTERO_BROWSER}-${view}-${locale}.json`,
    });
}

async function clickAction(page, action) {
    await page.locator(`${POPUP} [data-action="${action}"]:visible`).click();
    await settle(page);
}

async function checkStablePopup(page, { view, locale }) {
    const measure = () => page.evaluate(() => reader.popupLayout());
    const failures = [];
    try {
        await page.evaluate(options => {
            reader.clear();
            reader.setDocument(options);
        }, { ...positioningDocument, view });
        for (const { label, fraction, expansion } of [
            { label: 'desktop top selection', fraction: 0.15, expansion: 'down' },
            { label: 'desktop middle selection', fraction: 0.5, expansion: 'up' },
            { label: 'desktop bottom selection', fraction: 0.92, expansion: 'up' },
        ]) {
            try {
                const from = longChinese[0].length + 2;
                const to = from + 2;
                await page.evaluate(text => {
                    reader.clear();
                    reader.scrollToText(text);
                }, longParagraph);
                await settle(page);
                // A host navigation holds its destination for 500ms. Position
                // this fixture only after that hold has finished.
                await page.waitForTimeout(550);
                await page.evaluate(options => reader.positionText(options), { text: longParagraph, from, to, fraction });
                await settle(page);
                await settle(page);
                assert.equal(await page.evaluate(options => reader.select(options), { text: longParagraph, from, to }),
                    longParagraph.slice(from, to), `${label}: establish the native selection once before toggling`);
                await settle(page);
                const initial = await measure();
                assert.ok(initial, `${label}: the native selection must open its compact popup`);
                const selected = await page.evaluate(() => reader.selectionSnapshot());
                assert.ok(selected.connected && !selected.collapsed, `${label}: the native selection must remain connected`);
                const scrollTop = await page.evaluate(() => reader.scrollState().scrollTop);
                const selectionCenter = (initial.selectionRect.top + initial.selectionRect.bottom) / 2;
                assert.ok(Math.abs(selectionCenter - (initial.reading.top + initial.reading.height * fraction)) <= 1,
                    `${label}: selection center ${selectionCenter} must equal requested ${initial.reading.top + initial.reading.height * fraction}; ${JSON.stringify({ selection: initial.selectionRect, reading: initial.reading, scrollTop })}`);
                assert.equal(initial.expansion, expansion, `${label}: expansion must use the available side`);
                expectPopupWithinColumn(initial, label);
                expectActionsVisible(initial, 'collapsed', label);
                await expectPreviewControl(page, locale, false, label);
                let previous = initial;
                // All transitions use this one native selection. Never restore
                // or reselect text between clicks to manufacture stable bounds.
                const transitions = [
                    ['preview-source', 'preview'],
                    ['preview-source', 'collapsed'],
                    ['preview-source', 'preview'],
                    ['preview-source', 'collapsed'],
                ];
                for (const [action, panel] of transitions) {
                    await clickAction(page, action);
                    const current = await measure();
                    const transition = `${label}: ${previous.panel} -> ${panel}`;
                    expectActionsVisible(current, panel, transition);
                    expectPopupWithinColumn(current, transition);
                    expectStableToolbar(previous, current, transition);
                    expectStableToolbar(initial, current, `${transition} compared with initial toolbar`);
                    await expectPreviewControl(page, locale, panel === 'preview', transition);
                    assert.deepEqual(await page.evaluate(() => reader.selectionSnapshot()), selected,
                        `${transition}: panel switches must preserve the original native selection`);
                    assert.ok(Math.abs(await page.evaluate(() => reader.scrollState().scrollTop) - scrollTop) <= 1,
                        `${transition}: panel switches must preserve the reading position`);
                    if (panel === 'preview') {
                        assert.deepEqual(await page.locator(SOURCE_TEXT).allTextContents(), [longSentences[1]]);
                        await expectPreviewSave(page, locale, transition);
                        await expectAnnotationScope(page, longSentences.join(' '), transition, { locale });
                        assert.equal(await page.locator(ANNOTATION_TEXT).count(), 0, `${transition}: save scope is collapsed after inspection`);
                    }
                    else {
                        assert.equal(await page.locator(`${SOURCE_TEXT}, ${ANNOTATION_TEXT}, ${ANNOTATE}`).count(), 0,
                            `${transition}: collapsing must hide the preview, save scope and save action`);
                    }
                    previous = current;
                }
                console.log(`${view} ${locale}：${label} ${expansion} 展开，折叠/预览及保存范围开关工具栏与按钮位置差 ≤1px，展开操作可见`);
            }
            catch (error) { failures.push(error); }
        }
    }
    finally {
        await page.evaluate(options => {
            reader.clear();
            reader.setDocument(options);
        }, { source, translations, views, view });
        await settle(page);
    }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
}

async function wheelToEdge(page, layout, direction, label, { capture = false } = {}) {
    const measure = () => page.evaluate(saveScope => reader.popupLayout({ saveScope }), layout.saveScope);
    const { scrollRange, sourceHeight, wheelPoint } = layout;
    const reached = scrollTop => direction > 0 ? scrollTop >= scrollRange - 1 : scrollTop === 0;
    assert.ok(sourceHeight > 0 && layout.wheelPointInSource,
        `${label}: the wheel must target the original text scrollport`);
    if (capture) await page.evaluate(details => reader.recordEvidence('before-wheel', details), { scenario: label, direction, point: wheelPoint });
    await page.mouse.move(wheelPoint.x, wheelPoint.y);
    // Gecko can cap one wheel event at slightly less than one scrollport.
    const maxSteps = 2 * Math.ceil(scrollRange / sourceHeight) + 1;
    for (let step = 0; step < maxSteps; step++) {
        await page.mouse.wheel(0, direction * (scrollRange + sourceHeight));
        await settle(page);
        if (capture) await page.evaluate(details => reader.recordEvidence('after-wheel', details), { scenario: label, direction });
        const current = await measure();
        assert.ok(current, `${label}: scrolling must keep the popup open; ${JSON.stringify(await page.evaluate(() => {
            const { view, scrollTop, viewport } = reader.scrollState();
            return { view, scrollTop, viewport, selection: reader.selectionSnapshot() };
        }))}; before=${JSON.stringify({ selection: layout.selectionRect, reading: layout.reading })}`);
        if (reached(current.scrollTop)) return current;
    }
    await page.waitForFunction(({ direction, scrollRange, saveScope }) => {
        const current = reader.popupLayout({ saveScope });
        return current && (direction > 0 ? current.scrollTop >= scrollRange - 1 : current.scrollTop === 0);
    }, { direction, scrollRange, saveScope: layout.saveScope }).catch(async error => {
        const current = await measure();
        throw new Error(`${label}: scroll offset ${current?.scrollTop} did not reach ${direction > 0 ? scrollRange : 0}`, { cause: error });
    });
    return measure();
}

async function checkCompactPopup(page, { selection, expectReading, capture, locale, view }) {
    const measure = () => page.evaluate(() => reader.popupLayout());

    await selection(paragraph, 0, 2);
    const compact = await measure();
    expectPopupWithinColumn(compact, 'default compact popup');
    expectActionsVisible(compact, 'collapsed', 'default compact popup');
    await clickAction(page, 'preview-source');
    await expectReading(sentences[0]);
    const short = await measure();
    expectPopupWithinColumn(short, 'short selection');
    assert.equal(short.scrollRange, 0, 'A short source should not need scrolling');
    assert.ok(short.firstLineVisible && short.lastLineVisible, 'The short source must be fully visible');
    assert.ok(short.sourceHeight <= short.sourceLineHeight * 2,
        `A short source must not reserve a tall body (got ${short.sourceHeight}px)`);
    expectActionsVisible(short, 'preview', 'short selection');
    assert.ok(compact.box.height < short.box.height, 'The default toolbar must be shorter than the expanded preview');

    async function checkLong(label) {
        await expectReading(...longSentences);
        const before = await measure();
        expectPopupWithinColumn(before, label);
        assert.ok(before.box.bottom <= before.selectionRect.top || before.box.top >= before.selectionRect.bottom,
            `${label}: popup must not cover a wrapped selection when there is room beside it; ${JSON.stringify({ popup: before.box, selection: before.selectionRect, reading: before.reading, expansion: before.expansion })}`);
        assert.ok(before.box.width <= MAX_DESKTOP_WIDTH + 2, `${label}: popup is ${before.box.width}px wide (max ${MAX_DESKTOP_WIDTH}px plus border)`);
        assert.ok(before.sourceHeight <= MAX_SOURCE_HEIGHT,
            `${label}: source scrollport is ${before.sourceHeight}px tall (max ${MAX_SOURCE_HEIGHT}px)`);
        assert.equal(before.popupOverflow, 0, `${label}: the popup, including actions, must not scroll`);
        assert.equal(before.horizontalOverflow, 0, `${label}: source must wrap without horizontal scrolling`);
        assert.ok(before.scrollRange > 0 && before.scrollTop === 0, `${label}: long source must start at the top and overflow`);
        assert.ok(before.firstLineVisible && !before.lastLineVisible, `${label}: source viewport must show the beginning, not the end`);
        expectActionsVisible(before, 'preview', `${label} before scrolling`);
        const readingBefore = await page.evaluate(() => reader.scrollState().scrollTop);
        const after = await wheelToEdge(page, before, 1, label, { capture });
        assert.ok(!after.firstLineVisible && after.lastLineVisible, `${label}: wheel must reach the entire last line`);
        assert.equal(after.box.y, before.box.y, `${label}: wheel must not move the popup`);
        assert.equal(await page.evaluate(() => reader.scrollState().scrollTop), readingBefore, `${label}: internal scrolling must not move the document`);
        expectActionsVisible(after, 'preview', `${label} after scrolling`);
        await wheelToEdge(page, after, -1, `${label} return to top`, { capture });
        return before;
    }

    await selection(longParagraph, 0, longParagraph.length);
    await clickAction(page, 'preview-source');
    const desktop = await checkLong('desktop preview');
    assert.ok(short.box.width < desktop.box.width && short.box.height < desktop.box.height,
        `Short popup (${short.box.width}x${short.box.height}) must size to its content rather than match long popup (${desktop.box.width}x${desktop.box.height})`);
    await expectPreviewSave(page, locale, 'desktop preview');
    await expectAnnotationScope(page, longSentences.join(' '), 'desktop preview', { locale, scroll: true });
    if (capture) {
        await page.screenshot({ path: screenshotPaths[view], type: 'png' });
        console.log(`中文${view === 'compare' ? '双语' : '全译文'}原文操作截图：${screenshotPaths[view]}`);
    }

    // Keep the selection and popup alive so this exercises the resize observer.
    if (capture) await page.evaluate(() => reader.startEvidence());
    await page.evaluate(() => reader.setNarrow(true));
    await page.waitForFunction(() => {
        const layout = reader.popupLayout();
        return layout && Math.abs(layout.reading.width - 320) < 1 && layout.box.width <= layout.reading.width;
    });
    if (capture) await page.evaluate(() => reader.recordEvidence('after-narrow-layout'));
    // Flush CodeMirror's deferred resize measurement before attributing any
    // document movement to the wheel inside the popup.
    await page.evaluate(() => reader.requestMeasure());
    await settle(page);
    await settle(page);
    if (capture) await page.evaluate(() => reader.recordEvidence('after-explicit-measure-and-six-frames'));
    assert.ok(await measure(), 'Resizing and CodeMirror measurement must keep the selection popup open');
    const narrow = await checkLong('320px preview');
    assert.equal(narrow.id, desktop.id, 'Resizing must reposition the existing popup');
    assert.equal(narrow.hostWidth, desktop.hostWidth, 'The viewport and shadow host must not shrink in the narrow case');
    assert.ok(narrow.box.width < desktop.box.width, 'Popup must adapt to the narrowed reading column');
    await expectPreviewSave(page, locale, '320px preview');
    await expectAnnotationScope(page, longSentences.join(' '), '320px preview', { locale, scroll: true });
    await clickAction(page, 'preview-source');
    expectActionsVisible(await measure(), 'collapsed', 'collapsed after expanded panel');
    // A wheel over the reading surface remains an explicit dismissal, unlike
    // CodeMirror's automatic scroll adjustment after resizing the column.
    await page.mouse.move(narrow.reading.left + 4, narrow.reading.top + 16);
    await page.mouse.wheel(0, 120);
    await settle(page);
    assert.equal(await page.locator(POPUP).count(), 0, 'A reader wheel outside the popup must still dismiss it');
    await page.evaluate(() => reader.setNarrow(false));
    await settle(page);
    console.log(`浮框尺寸：紧凑 ${compact.box.height.toFixed(1)}px；短原文 ${short.box.width.toFixed(1)}×${short.box.height.toFixed(1)}px；长原文 ${desktop.box.width.toFixed(1)}px，窄栏 ${narrow.box.width.toFixed(1)}px；内部滚动与上下工具栏可见`);
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
    await clickAction(page, 'preview-source');
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

async function checkCompleteSourceSave(page, { locale, source, label }) {
    const before = await page.evaluate(() => reader.counters());
    const range = { from: 0, to: source.length };
    const nativeText = visibleMarkdownTextForRanges(source, [range]).trim();
    await expectPreviewSave(page, locale, label);
    await expectAnnotationScope(page, nativeText, label, { locale });
    await page.locator(ANNOTATE).click();
    await settle(page);
    const saved = (await page.evaluate(() => reader.counters())).annotations.slice(before.annotations.length);
    assert.equal(saved.length, 1, `${label}: save once`);
    assert.equal(saved[0].annotation.text, nativeText, `${label}: save complete native original text`);
    assert.deepEqual(saved[0].annotation.ranges, [range], `${label}: save the entire canonical original block`);
    assert.deepEqual(saved[0].selectionContext, { side: 'source', rangesAreSource: true });
    assert.deepEqual(await page.evaluate(() => reader.selectionState()), { text: '', collapsed: true });
}

async function checkAnnotationCap(page, { view, locale }) {
    await page.evaluate(options => {
        reader.clear();
        reader.setDocument(options);
        reader.scrollToOffset(0);
    }, { ...capDocument, view });
    await settle(page);
    const before = await page.evaluate(() => reader.counters());
    for (const count of [9, 8]) {
        const selected = await page.evaluate(options => reader.select(options), {
            text: capChinese[0], from: 0, to: capChinese[0].length, endText: capChinese[count - 1],
        });
        assert.ok(selected.startsWith(capChinese[0]) && selected.endsWith(capChinese[count - 1]),
            `The ${count}-block test must use a real native selection spanning all translated blocks`);
        await settle(page);
        const compact = await page.evaluate(() => reader.popupLayout());
        expectActionsVisible(compact, 'collapsed', `${count}-block selection`);
        await clickAction(page, 'preview-source');
        try { await page.locator(SOURCE_TEXT).waitFor({ state: 'visible' }); }
        catch (error) {
            const evidence = await page.evaluate(() => ({
                layout: reader.popupLayout(), selection: reader.selectionSnapshot(),
                calls: reader.counters(), scroll: reader.scrollState(),
                popup: document.querySelector('#reader').shadowRoot.querySelector('.mktero-translation-source-popup')?.outerHTML,
            }));
            await writeFile('/tmp/mktero-translated-cap-evidence.json', `${JSON.stringify({ view, locale, count, evidence }, null, 2)}\n`);
            throw new Error(`${view} ${locale} ${count}-block preview missing; evidence: /tmp/mktero-translated-cap-evidence.json`, { cause: error });
        }
        assert.equal(await page.locator(SOURCE_TEXT).textContent(), capParagraphs.slice(0, count).join('\n\n'),
            'The save cap must retain the entire source reading preview');
        const label = `${view} ${locale} ${count}-block preview`;
        const preview = await page.evaluate(() => reader.popupLayout());
        expectPopupWithinColumn(preview, label);
        expectStableToolbar(compact, preview, label);
        expectActionsVisible(preview, 'preview', label, { unavailable: count > 8 });
        assert.equal(preview.scrollTop, 0, `${label}: a new source preview must start at the beginning`);
        assert.ok(preview.sourceHeight >= preview.sourceLineHeight && preview.firstLineVisible,
            `${label}: the source preview must show a complete first line; ${JSON.stringify({ sourceHeight: preview.sourceHeight, sourceLineHeight: preview.sourceLineHeight, textBox: preview.textBox, firstLineBox: preview.firstLineBox })}`);
        assert.equal(preview.popupOverflow, 0, `${label}: actions must stay outside the scrollport`);
        assert.equal(preview.horizontalOverflow, 0, `${label}: original text must wrap`);
        if (preview.scrollRange > 0) {
            const scrollTop = await page.evaluate(() => reader.scrollState().scrollTop);
            const scrolled = await wheelToEdge(page, preview, 1, label);
            assert.ok(scrolled.lastLineVisible,
                `${label}: the complete last line must be visible at the scroll limit; ${JSON.stringify({ scrollTop: scrolled.scrollTop, scrollRange: scrolled.scrollRange, textBox: scrolled.textBox, lastLineBox: scrolled.lastLineBox })}`);
            expectActionsVisible(scrolled, 'preview', `${label} after scrolling`, { unavailable: count > 8 });
            expectStableToolbar(compact, scrolled, `${label} after scrolling`);
            assert.equal(await page.evaluate(() => reader.scrollState().scrollTop), scrollTop,
                `${label}: internal scrolling must preserve document scrollTop`);
            assert.deepEqual(await page.evaluate(() => reader.selectionState()), { text: selected, collapsed: false },
                `${label}: internal scrolling must retain the entire native selection`);
            // Stop targeting the old scrollport before changing the native selection.
            await page.mouse.move(preview.reading.right + 16, preview.reading.top + 16);
            await page.waitForTimeout(300);
        }
        else assert.ok(preview.lastLineVisible, `${label}: the complete source must fit`);
        if (count > 8) {
            assert.equal(await page.locator(ANNOTATE).count(), 0, 'More than eight original blocks cannot be saved');
            assert.equal(await page.locator(`${POPUP} details.mktero-translation-annotation-details`).count(), 0,
                'An over-cap selection must not expose a save scope');
            assert.match(await page.locator(`${POPUP} .mktero-translation-source-unavailable:visible`).textContent(), /8/u,
                'The unavailable explanation must state the eight-block limit');
            assert.deepEqual((await page.evaluate(() => reader.counters())).annotations, before.annotations,
                'An over-cap selection must create no annotation');
        }
        else {
            await expectPreviewSave(page, locale, 'eight-block save');
            await expectAnnotationScope(page, capParagraphs.slice(0, 8).join('\n\n'), 'eight-block complete source scope', { locale, blockCount: 8 });
            await page.locator(ANNOTATE).click();
            await settle(page);
            const saved = (await page.evaluate(() => reader.counters())).annotations.slice(before.annotations.length);
            assert.equal(saved.length, 1, 'Eight original blocks must produce exactly one annotation');
            assert.deepEqual(saved[0].annotation.ranges, capBlocks.slice(0, 8).map(({ from, to }) => ({ from, to })),
                'The saved ranges must be the eight complete canonical original blocks');
            assert.equal(saved[0].annotation.text, capParagraphs.slice(0, 8).join('\n\n'));
            assert.deepEqual(saved[0].selectionContext, { side: 'source', rangesAreSource: true });
            assert.deepEqual(await page.evaluate(() => reader.selectionState()), { text: '', collapsed: true });
        }
    }
    console.log(`${view} ${locale}：9块保持可读且拒绝保存，8块以canonical整块保存及清空选区通过`);
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
        if (scopeProbe) {
            await checkScopeProbe(page, { view, locale });
            assert.deepEqual(errors, [], 'Browser page errors');
            assert.equal(requests, 0, 'The scope probe must stay offline');
            await page.evaluate(() => reader.destroy());
            return;
        }
        const texts = page.locator(SOURCE_TEXT);
        const marks = page.locator(SOURCE_MARK);
        const row = page.locator('.mktero-translation-legacy-block:visible');
        const selection = async (text, from, to, backward = false, selector) => {
            if (!selector) {
                await page.evaluate(text => reader.scrollToText(text), text);
                await settle(page);
            }
            assert.equal(await page.evaluate(options => reader.select(options), { text, from, to, backward, selector }),
                text.slice(from, to), 'The browser must actually select the requested characters');
            // Native selectionchange is asynchronous; never dispatch editor
            // events or call the runtime hit-test helpers to fake selection.
            await settle(page);
            expectActionsVisible(await page.evaluate(() => reader.popupLayout()), 'collapsed', 'new translated selection');
            assert.equal(await texts.count(), 0, 'Default popup must not expose original text');
            assert.equal(await page.locator(ANNOTATE).count(), 0, 'Default popup must not offer save');
            assert.equal(await page.locator('[data-action="show-source-block"]:visible').count(), 0, 'Legacy access must be inside the preview');
        };
        const expectReading = async (...expected) => {
            assert.deepEqual(await marks.allTextContents(), view === 'compare' ? expected : []);
            assert.deepEqual(await texts.allTextContents(), expected.length ? [expected.join('\n\n')] : []);
        };
        const expectNoRequests = async () => {
            const calls = await page.evaluate(() => reader.counters());
            assert.equal(calls.translation, 0);
            assert.deepEqual(calls.annotations, []);
            assert.equal(requests, 0);
        };
        const expectWholeBlockAction = async (id, label) => {
            await clickAction(page, 'preview-source');
            await row.waitFor({ state: 'visible' });
            assert.equal(await row.getAttribute('data-translation-block-id'), id, label);
            await expectReading();
            assert.deepEqual(await row.locator('button').evaluateAll(buttons => buttons.map(button => button.dataset.action)),
                ['show-source-block'], label);
            assert.equal(await page.locator(`${ANNOTATE}, [data-action="locate-source"]:visible`).count(), 0, label);
            assert.equal(await page.locator(OLD_ALIGNMENT_ACTIONS).count(), 0, label);
            const selected = await page.evaluate(() => reader.selectionSnapshot());
            const popupID = (await page.evaluate(() => reader.popupLayout())).id;
            await row.locator('[data-action="show-source-block"]').click();
            await settle(page);
            // Removing the focused legacy button must not schedule a delayed dismissal.
            await page.waitForTimeout(300);
            assert.equal((await page.evaluate(() => reader.popupLayout()))?.id, popupID,
                `${label}: showing the original block must retain the popup while idle for 300ms`);
            assert.deepEqual(await page.evaluate(() => reader.selectionSnapshot()), selected,
                `${label}: showing the original block must preserve its native selection`);
            assert.equal(await page.locator(OLD_ALIGNMENT_ACTIONS).count(), 0, label);
        };
        const first = paragraph.indexOf('下降');
        await selection(paragraph, first, first + 2);
        assert.deepEqual(await page.locator('.mktero-translation-source-toolbar button').allTextContents(),
            locale === 'zh-CN' ? ['查看原文', '复制译文'] : ['View original', 'Copy translation'],
            'Both compact toolbars must use the selected UI locale and the same two actions');
        await expectPreviewControl(page, locale, false, 'localized compact toolbar');
        const second = paragraph.indexOf('下降', first + 1);
        const third = paragraph.indexOf(chinese[2]);
        for (const [from, to, backward, expected] of [
            [first, first + 2, false, [sentences[0]]],
            [second, second + 2, false, [sentences[1]]],
            [second, third, false, [sentences[1]]],
            [third, third + 1, false, [sentences[2]]],
            [second, third + 1, true, [sentences[1], sentences[2]]],
        ]) {
            await selection(paragraph, from, to, backward);
            await clickAction(page, 'preview-source');
            await expectReading(...expected);
        }
        await page.evaluate(() => reader.clear());
        await settle(page);
        await expectReading();
        assert.equal(await page.locator(POPUP).count(), 0, 'Clearing the native selection must dismiss the popup');

        await selection(unalignedChinese, 0, 2);
        await expectWholeBlockAction(unaligned.id, 'unaligned paragraph');
        await expectReading(unalignedSource);
        await expectNoRequests();
        console.log(`${view} ${locale}：重复词、局部句、ID边界、反向跨句、清空、legacy 显式整段通过`);
        const scenarioFailures = [];
        try { await checkStablePopup(page, { view, locale }); }
        catch (error) { scenarioFailures.push(error); }
        try { await checkCompactPopup(page, { selection, expectReading, capture, locale, view }); }
        catch (error) {
            const evidence = await page.evaluate(() => ({
                layout: reader.popupLayout(), selection: reader.selectionSnapshot(), calls: reader.counters(),
                popup: document.querySelector('#reader').shadowRoot.querySelector('.mktero-translation-source-popup')?.outerHTML,
            }));
            await writeFile(`/tmp/mktero-popup-layout-${view}-${locale}-evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
            scenarioFailures.push(error);
        }
        finally {
            if (capture) {
                const evidence = await page.evaluate(() => reader.finishEvidence());
                await writeFile('/tmp/mktero-selection-browser-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`);
                console.log('原生选区/事件/滚动证据：/tmp/mktero-selection-browser-evidence.json');
            }
        }
        await page.evaluate(options => {
            reader.clear();
            reader.setNarrow(false);
            reader.setDocument(options);
        }, { source, translations, views, view });
        await settle(page);
        await expectNoRequests();

        // Reading shows the matched sentence; saving in either view uses the
        // complete canonical original block through the same preview action.
        await selection(paragraph, second, second + 2);
        await clickAction(page, 'copy-translation');
        assert.deepEqual((await page.evaluate(() => reader.counters())).copies, ['下降'], 'Copy must use the host callback with the selected translation');
        expectActionsVisible(await page.evaluate(() => reader.popupLayout()), 'collapsed', 'after copy');
        await clickAction(page, 'preview-source');
        await expectReading(sentences[1]);
        await expectPreviewSave(page, locale, 'whole paragraph preview save');
        expectActionsVisible(await page.evaluate(() => reader.popupLayout()), 'preview', 'whole paragraph preview actions');
        await expectAnnotationScope(page, sentences.join(' '), 'whole paragraph save scope', { locale });
        await expectReading(sentences[1]);
        await page.locator(ANNOTATE).click();
        await settle(page);
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
            await settle(page);
            await selectPart(fixture.reorderedSelection);
            await expectWholeBlockAction(fixture.id, `reordered ${fixture.kind}`);
            assert.deepEqual((await marks.allTextContents()).map(text => fixture.kind === 'list'
                ? text.replace(/^•?\s*/u, '') : text), view === 'compare' ? fixture.visibleSource : []);
            assert.deepEqual(await texts.allTextContents(), [visibleMarkdownTextForRanges(fixture.source,
                [{ from: 0, to: fixture.source.length }]).trim()],
            'Explicit whole-block preview must show the complete native original text');
            await checkCompleteSourceSave(page, { view, locale, source: fixture.source, label: `legacy ${fixture.kind} save` });

            await page.evaluate(options => reader.setDocument(options), { ...fixture.verified, view });
            await settle(page);
            for (const selected of fixture.selections) {
                await selectPart(selected);
                await clickAction(page, 'preview-source');
                await expectReading(selected.original);
                assert.equal(await row.count(), 0, `Verified ${fixture.kind} selection must use its ID`);
            }
            if (fixture.kind === 'table') await checkCompleteSourceSave(page, {
                view, locale, source: fixture.source, label: 'verified table native original save',
            });
        }
        const savedAnnotations = (await page.evaluate(() => reader.counters())).annotations;
        for (const options of [{}, { table: true }, { virtual: true }, { disjoint: true }]) {
            try { await checkNavigation(page, view, options); }
            catch (error) { scenarioFailures.push(error); }
        }
        try { await checkAnnotationCap(page, { view, locale }); }
        catch (error) { scenarioFailures.push(error); }
        if (scenarioFailures.length) throw new AggregateError(scenarioFailures, scenarioFailures.map(error => error.message).join('\n'));
        const calls = await page.evaluate(() => reader.counters());
        assert.deepEqual(calls.annotations.slice(0, savedAnnotations.length), savedAnnotations);
        assert.equal(calls.annotations.length, savedAnnotations.length + 1, 'The eight-block scenario must save exactly once');
        assert.deepEqual(calls.copies, ['下降']);
        assert.equal(calls.translation, 0);
        await page.evaluate(() => reader.destroy());
        assert.deepEqual(errors, [], 'Browser page errors');
        assert.equal(requests, 0, 'Network attempts while opening or using the offline reader');
        console.log(`${view} ${locale}：换序 list/table 显式整块、可验证 ID、host 复制、完整原文注释预览、两种往返通过；0 网络请求、0 选区 AI`);
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
