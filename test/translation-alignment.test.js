import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assembleAlignedBlock,
    createAlignmentPlan,
    verifyAlignedBlock,
} from '../src/markdown/translation-alignment.js';
import {
    collectMarkdownTranslationBlocks,
    validateTranslatedBlock,
} from '../src/markdown/markdown-translation-blocks.js';

function blockFor(markdown) {
    return collectMarkdownTranslationBlocks(markdown)[0];
}

function plannedSource(block) {
    const plan = createAlignmentPlan(block);
    return plan?.sourceRanges.map(ranges => ranges.map(({ from, to }) => (
        block.markdown.slice(from, to)
    )).join('')) ?? null;
}

test('plans canonical half-open spans around academic abbreviations and opaque Markdown', () => {
    const first = 'Fig. 2 reports 12.34 ms. at $x.y$, e.g. using `a.b` and [Fig. 2](https://example.org/a.b) [12].';
    const second = 'Visit https://example.org/a.b. Then count 7.';
    const block = blockFor(`${first}  ${second} Next step.`);
    assert.deepEqual(plannedSource(block), [first, 'Visit https://example.org/a.b.', 'Then count 7.', 'Next step.']);
    const plan = createAlignmentPlan(block);
    assert.equal(plan.sourceRanges[1][0].from, first.length + 2);
    assert.doesNotMatch(plan.units[0].sourceMarkdown, /x\.y|example\.org|\[12\]/u);
    assert.equal(plan.units[0].sourceMarkdown.match(/MKTEROPROTECTED\d+PLACEHOLDER/gu).length, 4);
});

test('keeps sentence IDs across list items when a sentence ends with a lettered appendix reference', () => {
    const sentences = [
        'Inference with Qwen3.6-27B took 0.660 hours.',
        'The score fell from 0.711 to 0.708.',
        'We report the results in Appendix D.',
        'However, the improvement was small.',
    ];
    const block = blockFor(`- ${sentences[0]} ${sentences[1]}\n- ${sentences[2]} ${sentences[3]}`);
    assert.deepEqual(plannedSource(block), sentences);
    const translations = ['推理耗时。', '得分略降。', '结果见附录 D。', '然而提升很小。'];
    const response = createAlignmentPlan(block).units.map(({ id }, index) => ({ id, translatedMarkdown: translations[index] }));
    const aligned = assembleAlignedBlock(block, response.reverse(), 'zh-CN');
    const verified = verifyAlignedBlock(block, aligned, 'zh-CN');
    assert.deepEqual(verified.sourceRanges.map(([{ from, to }]) => block.markdown.slice(from, to)), sentences);
    assert.deepEqual(verified.restoredRanges.map(({ from, to }) => verified.markdown.slice(from, to)), translations);
    assert.equal(plannedSource(blockFor('We thank D. Smith for the data.')), null);
});

test('attaches Chinese closing punctuation and Markdown closers to the preceding unit', () => {
    const block = blockFor('她说：“第一句！”**第二句。**「第三句？」最后一句。');
    assert.deepEqual(plannedSource(block), ['她说：“第一句！”', '**第二句。**', '「第三句？」', '最后一句。']);
});

test('uses UTF-16 offsets and attaches punctuation outside an inline link', () => {
    const first = 'She opened [the file!](https://example.org/a.b).';
    const second = '下一句有𠮷。';
    const block = blockFor(`${first} ${second}最后一句。`);
    assert.deepEqual(plannedSource(block), [first, second, '最后一句。']);
    const { sourceRanges } = createAlignmentPlan(block);
    assert.deepEqual(sourceRanges[1], [{ from: first.length + 1, to: first.length + 1 + second.length }]);
});

test('plans headings, nested task lists and visible GFM cells without including structural markers', () => {
    assert.deepEqual(plannedSource(blockFor('# Heading. Another. ###')), ['Heading.', 'Another.']);
    assert.deepEqual(plannedSource(blockFor('Heading. Another.\n------')), ['Heading.', 'Another.']);
    const list = blockFor('- [x] First. Second.\n  - Nested. Repeat.\n  - Repeat.\n- End.');
    assert.deepEqual(plannedSource(list), ['First.', 'Second.', 'Nested.', 'Repeat.', 'Repeat.', 'End.']);
    const table = blockFor('| Name | Value |\n| :--- | ---: |\n||Repeat. Repeat.|Invisible.|\n| X\\|Y. | 12.34 |');
    assert.deepEqual(plannedSource(table), ['Name', 'Value', 'Repeat.', 'Repeat.', 'X\\|Y.']);
});

test('does not infer exact sentences across containers, wrappers, or equations', () => {
    for (const source of [
        '**First sentence. Second sentence.** End.',
        'Read [First sentence. Second sentence.](https://example.org).',
        'A sentence that\ncontinues on the next line.',
        '> First sentence.\n> Second sentence.',
        'Text with <span>First. Second.</span>.',
        'Chen et al. Smith published the follow-up. Next.',
        'See Fig. Results follow. Another sentence.',
        'Unknown abbrev. continues. Another sentence.',,
    ]) {
        assert.equal(createAlignmentPlan(blockFor(source)), null, source);
    }
    const blocks = collectMarkdownTranslationBlocks('The equation is given by\n\n$$x = 1$$\n\nwhere this holds. Another sentence.');
    assert.ok(blocks[2].continuesFrom);
    assert.ok(blocks.every(block => createAlignmentPlan(block) === null));
});

test('assembles in source order and preserves structure, placeholders, and language-specific gaps', () => {
    const block = blockFor('- First $x.y$. Second.\n- Third.');
    const { units } = createAlignmentPlan(block);
    const placeholder = block.protectedFragments[0].placeholder;
    const returned = [
        { id: units[2].id, translatedMarkdown: '第三句。' },
        { id: units[0].id, translatedMarkdown: ` 第一句 ${placeholder}。补充一句。 `, sourceRanges: [{ from: -1, to: -1 }] },
        { id: units[1].id, translatedMarkdown: '第二句。' },
    ];
    const aligned = assembleAlignedBlock(block, returned, 'zh-CN');
    assert.deepEqual(aligned, {
        id: block.id,
        markdown: `- 第一句 ${placeholder}。补充一句。第二句。\n- 第三句。`,
        alignment: { version: 1, units: [
            { id: units[0].id, translatedMarkdown: `第一句 ${placeholder}。补充一句。`, sourceRanges: [{ from: 2, to: 14 }] },
            { ...returned[2], sourceRanges: [{ from: 15, to: 22 }] },
            { ...returned[0], sourceRanges: [{ from: 25, to: 31 }] },
        ] },
    });
    assert.equal(validateTranslatedBlock(block, aligned.markdown), '- 第一句 $x.y$。补充一句。第二句。\n- 第三句。');
    assert.equal(assembleAlignedBlock(block, returned, 'fr-FR').markdown, `- 第一句 ${placeholder}。补充一句。 第二句。\n- 第三句。`);
});

test('keeps protected image-only lines outside prose units and attaches post-punctuation citations', () => {
    const block = blockFor('![Chart](chart.png)\nValue rose. [12] Then it leveled off.');
    assert.deepEqual(plannedSource(block), ['Value rose. [12]', 'Then it leveled off.']);
    const plan = createAlignmentPlan(block);
    assert.match(plan.units[0].sourceMarkdown, /^Value rose\. MKTEROPROTECTED\d+PLACEHOLDER$/u);
    assert.doesNotMatch(plan.units[1].sourceMarkdown, /MKTEROPROTECTED/u);
});

test('rejects stored alignment when a same-shaped list or table was reordered after assembly', () => {
    for (const block of [
        blockFor('- First\n- Second'),
        blockFor('| Group | Result |\n| --- | --- |\n| First | One |\n| Second | Two |'),
    ]) {
        const { units } = createAlignmentPlan(block);
        const translation = assembleAlignedBlock(block, units.map(({ id }, index) => ({
            id, translatedMarkdown: `Translated ${index + 1}`,
        })).reverse(), 'en-US');
        assert.ok(verifyAlignedBlock(block, translation, 'en-US'));
        const lines = translation.markdown.split('\n');
        const reordered = [...lines.slice(0, -2), lines.at(-1), lines.at(-2)].join('\n');
        assert.equal(validateTranslatedBlock(block, reordered), reordered);
        assert.equal(verifyAlignedBlock(block, { ...translation, markdown: reordered }, 'en-US'), null);
    }
});

test('rejects missing, duplicate, foreign, empty, displaced, and structurally unsafe results', () => {
    const block = blockFor('First $x.y$. Second.');
    const foreign = collectMarkdownTranslationBlocks('Preface.\n\nFirst $x.y$. Second.')[1];
    const [first, second] = createAlignmentPlan(block).units;
    const translatedFirst = { id: first.id, translatedMarkdown: first.sourceMarkdown };
    const translatedSecond = { id: second.id, translatedMarkdown: '第二句。' };
    for (const results of [
        [translatedFirst],
        [translatedFirst, translatedFirst],
        [translatedFirst, { ...translatedSecond, id: createAlignmentPlan(foreign).units[1].id }],
        [translatedFirst, { ...translatedSecond, translatedMarkdown: ' \t' }],
        [{ ...translatedFirst, translatedMarkdown: '第一句。' }, { ...translatedSecond, translatedMarkdown: block.protectedFragments[0].placeholder + '第二句。' }],
        [{ ...translatedFirst, translatedMarkdown: '**' + first.sourceMarkdown }, { ...translatedSecond, translatedMarkdown: '第二句。**' }],
        [translatedFirst, { ...translatedSecond, translatedMarkdown: '第二句。\n- New item.' }],
        [translatedFirst, { ...translatedSecond, translatedMarkdown: '<script>unsafe</script>' }],
    ]) assert.throws(() => assembleAlignedBlock(block, results, 'zh-CN'));

    const table = blockFor('| First. | Second. |\n| --- | --- |');
    const units = createAlignmentPlan(table).units.map(unit => ({ id: unit.id, translatedMarkdown: unit.sourceMarkdown }));
    assert.throws(() => assembleAlignedBlock(table, [{ ...units[0], translatedMarkdown: 'New | cell' }, units[1]], 'zh-CN'));
});
