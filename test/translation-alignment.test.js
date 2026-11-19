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

test('keeps reliable list boundaries and groups an ambiguous single-letter sentence ending locally', () => {
    const sentences = [
        'Inference with Qwen3.6-27B took 0.660 hours.',
        'The score fell from 0.711 to 0.708.',
        'We report the results in Appendix D. However, the improvement was small.',
    ];
    const block = blockFor(`- ${sentences[0]} ${sentences[1]}\n- ${sentences[2]}`);
    assert.deepEqual(plannedSource(block), sentences);
    assert.deepEqual(createAlignmentPlan(block).units.map(unit => unit.sourceKind), [undefined, undefined, 'sentence-group']);
    const translations = ['推理耗时。', '得分略降。', '结果见附录 D。然而提升很小。'];
    const response = createAlignmentPlan(block).units.map(({ id }, index) => ({ id, translatedMarkdown: translations[index] }));
    const aligned = assembleAlignedBlock(block, response.reverse(), 'zh-CN');
    const verified = verifyAlignedBlock(block, aligned, 'zh-CN');
    assert.deepEqual(verified.sourceRanges.map(([{ from, to }]) => block.markdown.slice(from, to)), sentences);
    assert.deepEqual(verified.restoredRanges.map(({ from, to }) => verified.markdown.slice(from, to)), translations);
    assert.deepEqual(plannedSource(blockFor('We thank D. Smith for the data.')), ['We thank D. Smith for the data.']);
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

test('keeps unsafe containers, hard breaks, and equation continuations on the block fallback', () => {
    for (const source of [
        '> First sentence.\n> Second sentence.',
        'Text with <span>First. Second.</span>.',
        'Text with <!-- hidden --> content.',
    ]) {
        assert.equal(createAlignmentPlan(blockFor(source)), null, source);
    }
    for (const newline of ['\n', '\r\n', '\r']) {
        for (const marker of ['  ', '   ', '\\']) {
            for (const source of [
                `A sentence that${marker}${newline}continues after a hard break.`,
                `First sentence.${marker}${newline}Second sentence.`,
                `Before. **First.${marker}${newline}Second.** After.`,
            ]) assert.equal(createAlignmentPlan(blockFor(source)), null, JSON.stringify(source));
        }
    }
    const blocks = collectMarkdownTranslationBlocks('The equation is given by\n\n$$x = 1$$\n\nwhere this holds. Another sentence.');
    assert.ok(blocks[2].continuesFrom);
    assert.ok(blocks.every(block => createAlignmentPlan(block) === null));
});

test('normalizes prose soft newlines only in request units and rebuilds original UTF-16 ranges', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
        const middle = `A sentence 𠮷 that${newline}continues with $x.y$${newline}on the next line.`;
        const source = `Before 𠮷. ${middle} After.`;
        const block = blockFor(source);
        const original = structuredClone(block);
        const plan = createAlignmentPlan(block);
        assert.ok(plan, JSON.stringify(newline));
        const expected = ['Before 𠮷.', middle, 'After.'];
        assert.deepEqual(plannedSource(block), expected);
        assert.deepEqual(plan.sourceRanges, expected.map(text => [{
            from: source.indexOf(text), to: source.indexOf(text) + text.length,
        }]));
        const math = block.protectedFragments[0].placeholder;
        assert.deepEqual(plan.units.map(unit => unit.sourceMarkdown), [
            'Before 𠮷.', `A sentence 𠮷 that continues with ${math} on the next line.`, 'After.',
        ]);
        assert.ok(plan.units.every(unit => !Object.hasOwn(unit, 'sourceKind')));
        for (const language of ['en-US', 'zh-CN']) {
            const translated = language === 'en-US'
                ? plan.units.map(unit => unit.sourceMarkdown)
                : ['之前𠮷。', `跨行译文𠮷 ${math}。`, '之后。'];
            const aligned = assembleAlignedBlock(block, plan.units.map(({ id }, index) => ({
                id, translatedMarkdown: translated[index],
            })).reverse(), language);
            assert.equal(aligned.markdown, translated.join(language === 'en-US' ? ' ' : ''));
            const stored = structuredClone(aligned);
            stored.alignment.units.reverse();
            const verified = verifyAlignedBlock(block, stored, language);
            assert.ok(verified);
            assert.ok(verifyAlignedBlock(block, stored));
            assert.deepEqual(verified.sourceRanges, plan.sourceRanges);
            assert.deepEqual(verified.units, aligned.alignment.units);
            const restored = validateTranslatedBlock(block, verified.markdown);
            assert.deepEqual(verified.restoredRanges.map(({ from, to }) => restored.slice(from, to)),
                translated.map(text => text.replace(math, '$x.y$')));
            const changed = blockFor(source.replaceAll(newline, ' '));
            changed.id = block.id;
            assert.notEqual(createAlignmentPlan(changed).units[0].id, plan.units[0].id);
            assert.equal(verifyAlignedBlock(changed, aligned, language), null);
            const tampered = structuredClone(aligned);
            tampered.alignment.units[1].sourceRanges[0].to--;
            assert.equal(verifyAlignedBlock(block, tampered, language), null);
        }
        assert.deepEqual(block, original);
        assert.deepEqual(createAlignmentPlan(block), plan);
    }
});

test('keeps complete emphasis and link wrappers across soft newlines in one normalized unit', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
        for (const middle of [
            `**First 𠮷.${newline}Second $x.y$.**`,
            `Read [First.${newline}Second.](https://example.org/a.b).`,
            `**First.${newline}[*Second.${newline}Third.*](https://example.org) Last.**`,
            `Unknown qvx.${newline}continues here.`,
        ]) {
            const block = blockFor(`Before. ${middle} After.`);
            const plan = createAlignmentPlan(block);
            assert.ok(plan, JSON.stringify(middle));
            assert.deepEqual(plannedSource(block), ['Before.', middle, 'After.']);
            assert.deepEqual(plan.units.map(unit => unit.sourceKind), [undefined, 'sentence-group', undefined]);
            assert.equal(plan.units[1].sourceMarkdown, block.requestMarkdown.slice(
                'Before. '.length, -' After.'.length
            ).replace(/\r\n?|\n/gu, ' '));
            for (const language of ['en-US', 'zh-CN']) {
                const translated = plan.units.map(({ sourceMarkdown }, index) => language === 'en-US'
                    ? sourceMarkdown : ['之前。', `（${sourceMarkdown}）`, '之后。'][index]);
                const aligned = assembleAlignedBlock(block, plan.units.map(({ id }, index) => ({
                    id, translatedMarkdown: translated[index],
                })).reverse(), language);
                const verified = verifyAlignedBlock(block, aligned, language);
                assert.ok(verified, JSON.stringify(middle));
                assert.deepEqual(verified.sourceRanges, plan.sourceRanges);
                assert.equal(verified.units[1].sourceKind, 'sentence-group');
                const restoredMiddle = middle.replace(/\r\n?|\n/gu, ' ');
                assert.equal(validateTranslatedBlock(block, verified.markdown), language === 'en-US'
                    ? `Before. ${restoredMiddle} After.` : `之前。（${restoredMiddle}）之后。`);
            }
        }
    }
});

test('normalizes soft continuations without crossing layout sections or standalone image lines', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
        const continuation = `continues on${newline}the next line.`;
        const image = '![Chart](chart.png)';
        const block = blockFor(`Unknown qvx.${newline}${image}${newline}${continuation} Last.`);
        const plan = createAlignmentPlan(block);
        assert.ok(plan, JSON.stringify(newline));
        assert.deepEqual(plannedSource(block), ['Unknown qvx.', continuation, 'Last.']);
        assert.deepEqual(plan.units.map(unit => unit.sourceMarkdown), ['Unknown qvx.', 'continues on the next line.', 'Last.']);
        assert.ok(plan.units.every(unit => !Object.hasOwn(unit, 'sourceKind')));
        for (const language of ['en-US', 'zh-CN']) {
            const aligned = assembleAlignedBlock(block, plan.units.map(({ id, sourceMarkdown }) => ({
                id, translatedMarkdown: sourceMarkdown,
            })), language);
            const verified = verifyAlignedBlock(block, aligned, language);
            assert.ok(verified);
            assert.equal(validateTranslatedBlock(block, verified.markdown), `Unknown qvx.${newline}${image}${newline}continues on the next line.${language === 'en-US' ? ' ' : ''}Last.`);
        }
        if (newline === '\r') continue;
        const list = blockFor([
            '- [x] First', '  continuation. Tail.', '  - Unknown qvx.', '    continues here.', '- End.',
        ].join(newline));
        const listPlan = createAlignmentPlan(list);
        assert.ok(listPlan);
        assert.deepEqual(plannedSource(list), [
            `First${newline}  continuation.`, 'Tail.', `Unknown qvx.${newline}    continues here.`, 'End.',
        ]);
        assert.deepEqual(listPlan.units.map(unit => unit.sourceKind), [undefined, undefined, 'sentence-group', undefined]);
        for (const language of ['en-US', 'zh-CN']) {
            const aligned = assembleAlignedBlock(list, listPlan.units.map(({ id, sourceMarkdown }) => ({
                id, translatedMarkdown: sourceMarkdown,
            })), language);
            assert.ok(verifyAlignedBlock(list, aligned, language));
            assert.equal(validateTranslatedBlock(list, aligned.markdown), aligned.markdown);
            assert.match(aligned.markdown, /- \[x\] First +continuation\./u);
            assert.ok(aligned.markdown.includes(`${newline}  - Unknown qvx.`));
            assert.ok(aligned.markdown.endsWith(`${newline}- End.`));
        }
    }
});

test('preserves protected multiline text and escaped backslashes while normalizing adjacent prose', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
        const code = `\`a  ${newline}b\\${newline}c\``;
        const middle = `Read ${code} and${newline}continue here.`;
        const block = blockFor(`Before. ${middle} After.`);
        const original = structuredClone(block);
        const plan = createAlignmentPlan(block);
        assert.ok(plan, JSON.stringify(newline));
        assert.deepEqual(plannedSource(block), ['Before.', middle, 'After.']);
        const placeholder = block.protectedFragments[0].placeholder;
        assert.equal(block.protectedFragments[0].markdown, code);
        assert.equal(plan.units[1].sourceMarkdown, `Read ${placeholder} and continue here.`);
        const aligned = assembleAlignedBlock(block, plan.units.map(({ id, sourceMarkdown }) => ({
            id, translatedMarkdown: sourceMarkdown,
        })), 'en-US');
        const verified = verifyAlignedBlock(block, aligned, 'en-US');
        assert.ok(verified);
        const restored = validateTranslatedBlock(block, aligned.markdown);
        assert.equal(restored, `Before. Read ${code} and continue here. After.`);
        assert.equal(restored.slice(verified.restoredRanges[1].from, verified.restoredRanges[1].to),
            `Read ${code} and continue here.`);
        assert.deepEqual(block, original);

        const escaped = blockFor(`Read \\\\${newline}more.`);
        const escapedPlan = createAlignmentPlan(escaped);
        assert.ok(escapedPlan);
        assert.equal(escapedPlan.units[0].sourceMarkdown, 'Read \\\\ more.');
        assert.ok(verifyAlignedBlock(escaped, assembleAlignedBlock(escaped, escapedPlan.units.map(({ id, sourceMarkdown }) => ({
            id, translatedMarkdown: sourceMarkdown,
        })), 'en-US'), 'en-US'));
    }
});

test('keeps abbreviation and citation context across soft newlines within a prose section', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
        const middle = `See Fig.${newline}2, Dr.${newline}Smith and et${newline}al. report results.${newline}[12]`;
        const block = blockFor(`Before. ${middle} After.`);
        const plan = createAlignmentPlan(block);
        assert.ok(plan);
        assert.deepEqual(plannedSource(block), ['Before.', middle, 'After.']);
        assert.ok(plan.units.every(unit => !Object.hasOwn(unit, 'sourceKind')));
        assert.doesNotMatch(plan.units[1].sourceMarkdown, /[\r\n]/u);
        const aligned = assembleAlignedBlock(block, plan.units.map(({ id, sourceMarkdown }) => ({
            id, translatedMarkdown: sourceMarkdown,
        })), 'en-US');
        assert.ok(verifyAlignedBlock(block, aligned, 'en-US'));
        assert.equal(validateTranslatedBlock(block, aligned.markdown), `Before. ${middle.replace(/\r\n?|\n/gu, ' ')} After.`);
    }
});

test('rejects newline-bearing unit responses after planning normalized prose', () => {
    const block = blockFor('Before. A sentence\ncontinues here. After.');
    const plan = createAlignmentPlan(block);
    assert.ok(plan);
    const returned = plan.units.map(({ id, sourceMarkdown }) => ({ id, translatedMarkdown: sourceMarkdown }));
    for (const newline of ['\n', '\r\n', '\r']) {
        for (const replacement of [`Injected.${newline}Next.`, `${newline}Injected.`, `Injected.${newline}`]) {
            const response = returned.map((unit, index) => index === 1 ? { ...unit, translatedMarkdown: replacement } : unit);
            assert.throws(() => assembleAlignedBlock(block, response, 'en-US'), JSON.stringify(replacement));
        }
    }
    const aligned = assembleAlignedBlock(block, returned, 'en-US');
    const tampered = structuredClone(aligned);
    tampered.alignment.units[1].translatedMarkdown = 'Injected.\nNext.';
    assert.equal(verifyAlignedBlock(block, tampered, 'en-US'), null);
});

test('treats dotted lexical tokens generically without protecting them from translation', () => {
    const tokens = new Set(['C.1', 'A.1.2', 'A.B.2', 'S.3.a', '1.A', 'Ph.D', 'v1.2.3', '0.125', 'Qwen3.6-27B']);
    for (const head of ['A', 'K', 'Z', 'a', 's', '7', 'v2', 'Ph', '𠮷']) {
        for (const tail of ['1', '27', 'B', 'a', 'D', '𠮷']) {
            tokens.add(`${head}.${tail}`);
            tokens.add(`${head}.${tail}.3`);
            tokens.add(`${head}.${tail}.z`);
        }
    }
    for (const token of tokens) {
        const sentence = `Inspect ${token} for details.`;
        const block = blockFor(`Before. ${sentence} After.`);
        assert.deepEqual(plannedSource(block), ['Before.', sentence, 'After.'], token);
        assert.deepEqual(createAlignmentPlan(block).units.map(unit => unit.sourceKind), [undefined, undefined, undefined], token);
        assert.equal(block.requestMarkdown, block.markdown, token);
        assert.deepEqual(block.protectedFragments, [], token);
        const translated = createAlignmentPlan(block).units.map(({ id }, index) => ({ id, translatedMarkdown: `译文${index}。` }));
        assert.ok(verifyAlignedBlock(block, assembleAlignedBlock(block, translated.reverse(), 'zh-CN'), 'zh-CN'), token);
    }
    for (const token of ['C.1', 'A.1.2', 'A.B.2', 'S.3.a', '1.A', 'v1.2.3', '12.34']) {
        assert.deepEqual(plannedSource(blockFor(`Before. Inspect ${token}. After.`)), ['Before.', `Inspect ${token}.`, 'After.'], token);
    }
});

test('keeps C.1 references in their sentence while allowing their text to change', () => {
    const block = blockFor('Before. We describe method C.1 in detail. After.');
    const plan = createAlignmentPlan(block);
    assert.deepEqual(plannedSource(block), ['Before.', 'We describe method C.1 in detail.', 'After.']);
    assert.equal(plan.units[1].sourceMarkdown, 'We describe method C.1 in detail.');
    const aligned = assembleAlignedBlock(block, plan.units.map(({ id }, index) => ({
        id, translatedMarkdown: ['之前。', '这里介绍方法丙一。', '之后。'][index],
    })), 'zh-CN');
    assert.equal(aligned.markdown, '之前。这里介绍方法丙一。之后。');
});

test('groups uncertain abbreviation boundaries locally and keeps both reliable neighbors', () => {
    for (const middle of [
        'Chen et al. Smith published the follow-up.',
        'See Fig. Results follow.',
        'Unknown qvx. continues here.',
        'Unknown Qv.Zx. Continues here.',
        'Unknown Qv.Zx. continues here.',
        'She said **Qv.Zx.** Continues here.',
        'She said [Qv.Zx.](https://example.org) Continues here.',
        'She said "Uncertain." continues here.',
        'She said **Uncertain.** continues here.',
        'She said [Uncertain.](https://example.org) continues here.',
        'Unknown qvx. [12] continues here.',
        'Unknown qvx. élève continues here.',
        'Unknown qvx. continues; other qvx. continues too.',
    ]) {
        const block = blockFor(`Before. ${middle} After.`);
        assert.deepEqual(plannedSource(block), ['Before.', middle, 'After.'], middle);
        assert.deepEqual(createAlignmentPlan(block).units.map(unit => unit.sourceKind), [undefined, 'sentence-group', undefined], middle);
    }
    const tail = blockFor('Before. Unknown qvx. continues without final punctuation');
    assert.deepEqual(plannedSource(tail), ['Before.', 'Unknown qvx. continues without final punctuation']);
    assert.equal(createAlignmentPlan(tail).units[1].sourceKind, 'sentence-group');
});

test('keeps initialed personal names together without swallowing neighboring sentences', () => {
    for (const name of ['D. Smith', 'J. R. Smith', 'J.R.R. Tolkien', 'Q. 𠮷田']) {
        const sentence = `We thank ${name} for the data.`;
        const block = blockFor(`Before. ${sentence} After.`);
        assert.deepEqual(plannedSource(block), ['Before.', sentence, 'After.'], name);
        assert.deepEqual(createAlignmentPlan(block).units.map(unit => unit.sourceKind), [undefined, 'sentence-group', undefined], name);
    }
    for (const ending of ['Result D.', 'Appendix Z.', 'Variant K.']) {
        const block = blockFor(`Before. ${ending} However, this holds. After.`);
        assert.deepEqual(plannedSource(block), ['Before.', `${ending} However, this holds.`, 'After.']);
        assert.equal(createAlignmentPlan(block).units[1].sourceKind, 'sentence-group');
    }
});

test('merges candidates until all intersecting emphasis and link wrappers are complete', () => {
    for (const middle of [
        '**First sentence. Second sentence.**',
        '*First sentence. Second sentence.*',
        'Read [First sentence. Second sentence.](https://example.org).',
        '**First. *Nested. Last.* End.**',
        '[First. **Nested. Last.** End.](https://example.org/a.b)',
        'Lead *First. **Middle.** Last.*',
        '*First. Next* and **second. Last.**',
        '***First. Second.***',
        '**First. [*Second. Third.*](https://example.org) Last.**',
    ]) {
        const block = blockFor(`Before. ${middle} After.`);
        assert.deepEqual(plannedSource(block), ['Before.', middle, 'After.'], middle);
        assert.deepEqual(createAlignmentPlan(block).units.map(unit => unit.sourceKind), [undefined, 'sentence-group', undefined], middle);
        const aligned = assembleAlignedBlock(block, createAlignmentPlan(block).units.map(({ id, sourceMarkdown }) => ({
            id, translatedMarkdown: sourceMarkdown,
        })).reverse(), 'en-US');
        assert.ok(verifyAlignedBlock(block, aligned, 'en-US'), middle);
    }
    const block = blockFor('Before. **Complete.** [Complete.](https://example.org) After.');
    assert.deepEqual(plannedSource(block), ['Before.', '**Complete.**', '[Complete.](https://example.org)', 'After.']);
    assert.ok(createAlignmentPlan(block).units.every(unit => !Object.hasOwn(unit, 'sourceKind')));
});

test('limits conservative groups to list items, table cells, paragraphs, and standalone image lines', () => {
    for (const [source, expected, kinds] of [
        ['- **First. Second.**\n  - Unknown qvx. continues. Last.\n- End.',
            ['**First. Second.**', 'Unknown qvx. continues.', 'Last.', 'End.'], ['sentence-group', 'sentence-group', undefined, undefined]],
        ['| **First. Second.** | Unknown qvx. continues. Last. |\n| --- | --- |\n| End. | Tail. |',
            ['**First. Second.**', 'Unknown qvx. continues.', 'Last.', 'End.', 'Tail.'], ['sentence-group', 'sentence-group', undefined, undefined, undefined]],
        ['Unknown qvx.\n![Chart](chart.png)\nAfter. Last.',
            ['Unknown qvx.', 'After.', 'Last.'], [undefined, undefined, undefined]],
        ['First.\nSecond.', ['First.', 'Second.'], [undefined, undefined]],
    ]) {
        const block = blockFor(source);
        assert.deepEqual(plannedSource(block), expected, source);
        assert.deepEqual(createAlignmentPlan(block).units.map(unit => unit.sourceKind), kinds, source);
        assert.ok(verifyAlignedBlock(block, assembleAlignedBlock(block, createAlignmentPlan(block).units.map(({ id, sourceMarkdown }) => ({
            id, translatedMarkdown: sourceMarkdown,
        })).reverse(), 'en-US'), 'en-US'), source);
    }
    const blocks = collectMarkdownTranslationBlocks('Unknown qvx.\n\nAfter. Last.');
    assert.deepEqual(blocks.map(plannedSource), [['Unknown qvx.'], ['After.', 'Last.']]);
});

test('rebuilds group metadata and UTF-16 ranges in source order despite reversed response and cache IDs', () => {
    const block = blockFor('- Before 𠮷. Unknown qvx. continues with $x.y$ and `z` here. After 𠮷.\n- **First. Second.** End.');
    const plan = createAlignmentPlan(block);
    const expectedSource = ['Before 𠮷.', 'Unknown qvx. continues with $x.y$ and `z` here.', 'After 𠮷.', '**First. Second.**', 'End.'];
    assert.deepEqual(plan.sourceRanges, expectedSource.map(text => [{
        from: block.markdown.indexOf(text), to: block.markdown.indexOf(text) + text.length,
    }]));
    assert.deepEqual(plan.units.map(unit => unit.sourceKind), [undefined, 'sentence-group', undefined, 'sentence-group', undefined]);
    const [math, code] = block.protectedFragments.map(fragment => fragment.placeholder);
    const translations = ['之前𠮷。', `不确定。继续 ${math} 和 ${code}。`, '之后𠮷。', '**一。二。**', '结束。'];
    const returned = plan.units.map(({ id }, i) => ({
        id, translatedMarkdown: translations[i], sourceKind: i % 2 ? 'sentence' : 'sentence-group',
        sourceRanges: [{ from: -1, to: -1 }], translatedRanges: [{ from: -1, to: -1 }],
    })).reverse();
    const aligned = assembleAlignedBlock(block, returned, 'zh-CN');
    assert.deepEqual(aligned.alignment.units.map(unit => unit.id), plan.units.map(unit => unit.id));
    assert.deepEqual(aligned.alignment.units.map(unit => unit.sourceKind), plan.units.map(unit => unit.sourceKind));
    assert.deepEqual(aligned.alignment.units.map(unit => unit.sourceRanges), plan.sourceRanges);
    const cache = structuredClone(aligned);
    cache.alignment.units.reverse().forEach(unit => { unit.sourceKind = 'forged'; });
    const verified = verifyAlignedBlock(block, cache, 'zh-CN');
    assert.ok(verified);
    assert.deepEqual(verified.units, aligned.alignment.units);
    assert.deepEqual(verified.sourceRanges.map(([{ from, to }]) => block.markdown.slice(from, to)), expectedSource);
    const restored = validateTranslatedBlock(block, aligned.markdown);
    assert.deepEqual(verified.restoredRanges.map(({ from, to }) => restored.slice(from, to)), translations.map(text => text.replace(math, '$x.y$').replace(code, '`z`')));
    assert.ok(verified.units.filter((_, i) => i % 2 === 0).every(unit => !Object.hasOwn(unit, 'sourceKind')));
    for (const mutate of [
        value => { value.alignment.units[1].sourceRanges[0].from++; },
        value => { value.alignment.units[1].id = plan.units[0].id; },
        value => { value.alignment.units[1].id += '-foreign'; },
        value => { value.markdown = value.markdown.replace('不确定', '篡改'); },
        value => { value.alignment.units[1].translatedMarkdown = value.alignment.units[1].translatedMarkdown.replace(math, code).replace(`和 ${code}`, `和 ${math}`); },
    ]) {
        const damaged = structuredClone(aligned);
        mutate(damaged);
        assert.equal(verifyAlignedBlock(block, damaged, 'zh-CN'), null);
    }
    const changedSource = blockFor(block.markdown.replace('qvx', 'qvy'));
    assert.equal(verifyAlignedBlock(changedSource, aligned, 'zh-CN'), null);
    assert.throws(() => assembleAlignedBlock(block, returned.map(unit => unit.id === plan.units[1].id
        ? { ...unit, translatedMarkdown: `调换 ${code} 和 ${math}。` } : unit), 'zh-CN'));
});

test('keeps wrapper, markup, and block-marker guards when a conservative group is translated', () => {
    const block = blockFor('Before. **First. Second.** After.');
    const units = createAlignmentPlan(block).units.map(({ id, sourceMarkdown }) => ({ id, translatedMarkdown: sourceMarkdown }));
    for (const replacement of [
        '**First. Second.**\nInjected.',
        '**First. Second.** MKTEROBLOCK9STARTMARKER',
        '<span>First. Second.</span>',
        '<!-- hidden -->First. Second.',
        '![New](new.png) First. Second.',
    ]) {
        assert.throws(() => assembleAlignedBlock(block, [units[0], { ...units[1], translatedMarkdown: replacement }, units[2]], 'en-US'), replacement);
    }
    assert.throws(() => assembleAlignedBlock(block, [
        { ...units[0], translatedMarkdown: '**Before.' },
        { ...units[1], translatedMarkdown: 'First. Second.**' },
        units[2],
    ], 'en-US'));
    const foreign = collectMarkdownTranslationBlocks('Preface.\n\nBefore. **First. Second.** After.')[1];
    assert.throws(() => assembleAlignedBlock(block, createAlignmentPlan(foreign).units.map(({ id, sourceMarkdown }) => ({
        id, translatedMarkdown: sourceMarkdown,
    })), 'en-US'));
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
