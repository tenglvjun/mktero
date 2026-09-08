import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assembleTranslatedMarkdown,
    collectMarkdownTranslationBlocks,
    collectMarkdownTranslationBatchResponse,
    collectMarkdownTranslationSections,
    collectProtectedTextTranslationResponse,
    collectDocumentTranslations,
    createComparisonMarkdown,
    createDocumentTranslationViews,
    createMarkdownTranslationBatches,
    createMarkdownTranslationRequest,
    createProtectedTextTranslationPayload,
    createTranslationReadingPositionAnchor,
    mapSourceRangeToComparison,
    reconcileTranslatedBlockProtectedFragments,
    resolveTranslationReadingPosition,
    TRANSLATION_PROTECTED_CONTENT_CHANGED,
    validateTranslatedBlock,
} from '../src/markdown/markdown-translation-blocks.js';
import {
    analyzeMarkdownFigureReferences,
} from '../src/markdown/markdown-figure-references.js';
import {
    analyzeMarkdownTableReferences,
} from '../src/markdown/markdown-table-references.js';
import {
    analyzeMarkdownCitations,
} from '../src/markdown/markdown-citations.js';

test('collects translatable top-level Markdown blocks in document order', () => {
    const markdown = [
        '# Paper',
        '',
        'A paragraph with *emphasis* and $x = 1$.',
        '',
        '- First item',
        '- Second item',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| Alpha | 1 |',
    ].join('\n');

    const blocks = collectMarkdownTranslationBlocks(markdown);

    assert.deepEqual(blocks.map(block => ({
        type: block.type,
        markdown: block.markdown,
        translatable: block.translatable,
    })), [{
        type: 'heading',
        markdown: '# Paper',
        translatable: true,
    }, {
        type: 'paragraph',
        markdown: 'A paragraph with *emphasis* and $x = 1$.',
        translatable: true,
    }, {
        type: 'list',
        markdown: '- First item\n- Second item',
        translatable: true,
    }, {
        type: 'table',
        markdown: '| Name | Value |\n| --- | --- |\n| Alpha | 1 |',
        translatable: true,
    }]);
    assert.equal(new Set(blocks.map(block => block.id)).size, blocks.length);
});

test('splits translation sections at top-level H1 headings only', () => {
    const markdown = [
        'Introductory paragraph.',
        '',
        '# First chapter',
        '',
        'First chapter paragraph.',
        '',
        '## Nested heading',
        '',
        'Nested paragraph.',
        '',
        '> # Quoted heading',
        '>',
        '> Quoted content.',
        '',
        '```md',
        '# Fenced heading',
        '```',
        '',
        '# Second chapter',
        '',
        'Second chapter paragraph.',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const sections = collectMarkdownTranslationSections(markdown, blocks);

    assert.deepEqual(sections.map(section => section.blocks.map(block => (
        block.markdown
    ))), [
        ['Introductory paragraph.'],
        [
            '# First chapter',
            'First chapter paragraph.',
            '## Nested heading',
            'Nested paragraph.',
            '> # Quoted heading\n>\n> Quoted content.',
            '```md\n# Fenced heading\n```',
        ],
        ['# Second chapter', 'Second chapter paragraph.'],
    ]);
    assert.deepEqual(
        sections.map(section => section.translatableBlocks.length),
        [1, 5, 2]
    );
    assert.equal(
        sections[1].requestMarkdown,
        createMarkdownTranslationRequest('', sections[1].blocks)
    );
});

test('keeps a document without H1 headings in one translation section', () => {
    const markdown = '## Details\n\nA paragraph.';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const sections = collectMarkdownTranslationSections(markdown, blocks);

    assert.equal(sections.length, 1);
    assert.deepEqual(sections[0].blocks, blocks);
});

test('creates bounded translation batches inside one H1 section', () => {
    const markdown = [
        '# Article',
        '',
        'First paragraph.',
        '',
        `Second ${'word '.repeat(20)}paragraph.`,
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const [section] = collectMarkdownTranslationSections(markdown, blocks);

    const batches = createMarkdownTranslationBatches(section, {
        maxBlocks: 8,
        maxSourceTokens: 15,
    });

    assert.deepEqual(batches.map(batch => batch.blocks.map(block => (
        block.markdown
    ))), [
        ['# Article', 'First paragraph.'],
        [`Second ${'word '.repeat(20)}paragraph.`],
    ]);
});

test('matches batch responses by block ID instead of response order', () => {
    const blocks = collectMarkdownTranslationBlocks('# Paper\n\nParagraph.');
    const response = JSON.stringify([...blocks].reverse().map(block => ({
        id: block.id,
        translatedMarkdown: block.type === 'heading' ? '# 论文' : '译文。',
    })));

    const result = collectMarkdownTranslationBatchResponse(blocks, response);

    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.translations.map(value => value.id), [
        blocks[0].id,
        blocks[1].id,
    ]);
});

test('rejects unknown block IDs in a translation batch response', () => {
    const blocks = collectMarkdownTranslationBlocks('# Paper');

    assert.throws(() => collectMarkdownTranslationBatchResponse(
        blocks,
        JSON.stringify([{
            id: blocks[0].id,
            translatedMarkdown: '# 论文',
        }, {
            id: 'unknown-block',
            translatedMarkdown: 'Injected text',
        }])
    ), /unknown Markdown block ID/i);
});

test('protects numeric citation markers from translation', () => {
    const [block] = collectMarkdownTranslationBlocks(
        'Prior work [1, 3-5] supports this result.'
    );

    assert.doesNotMatch(block.requestMarkdown, /\[1, 3-5\]/);
    assert.equal(block.protectedFragments[0].markdown, '[1, 3-5]');
    assert.equal(validateTranslatedBlock(
        block,
        block.requestMarkdown.replace(
            'Prior work',
            '既有研究'
        ).replace('supports this result', '支持这一结果')
    ), '既有研究 [1, 3-5] 支持这一结果.');
});

test('protects interactive author-year citations from translation', () => {
    const markdown = [
        '# Results',
        '',
        'Smith et al. (2020) reported the outcome.',
        '',
        '## References',
        '',
        'Smith, A., Jones, B., & Lee, C. (2020). Follow-up study.',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const block = blocks.find(candidate => (
        candidate.markdown.includes('reported the outcome')
    ));

    assert.doesNotMatch(block.requestMarkdown, /Smith et al\./);
    assert.deepEqual(
        block.protectedFragments.map(fragment => fragment.markdown),
        ['Smith et al. (2020)']
    );
    assert.equal(validateTranslatedBlock(
        block,
        block.requestMarkdown.replace(
            'reported the outcome',
            '报告了这一结果'
        )
    ), 'Smith et al. (2020) 报告了这一结果.');
    const translated = assembleTranslatedMarkdown(
        markdown,
        blocks,
        blocks.filter(candidate => candidate.translatable).map(candidate => ({
            id: candidate.id,
            markdown: candidate.requestMarkdown
                .replace('Results', '结果')
                .replace('reported the outcome', '报告了这一结果'),
        }))
    );
    const analysis = analyzeMarkdownCitations(translated);
    assert.deepEqual(analysis.citations.map(citation => (
        translated.slice(citation.from, citation.to)
    )), ['Smith et al. (2020)']);
});

test('preserves interactive figure references and target labels', () => {
    const markdown = [
        '# Results',
        '',
        'The ablation appears in Fig. 2.',
        '',
        '![](images/panel-a.png)',
        '',
        '![](images/panel-b.png)  ',
        'Figure 2. Ablation results.',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const referenceBlock = blocks.find(block => (
        block.markdown.includes('The ablation')
    ));
    const captionBlock = blocks.find(block => (
        block.markdown.includes('Figure 2. Ablation')
    ));

    assert.doesNotMatch(referenceBlock.requestMarkdown, /Fig\. 2/);
    assert.doesNotMatch(captionBlock.requestMarkdown, /Figure 2\./);

    const translated = assembleTranslatedMarkdown(
        markdown,
        blocks,
        blocks.filter(block => block.translatable).map(block => ({
            id: block.id,
            markdown: block.requestMarkdown
                .replace('Results', '结果')
                .replace('The ablation appears in', '消融结果见')
                .replace('Ablation results', '消融结果'),
        }))
    );
    const analysis = analyzeMarkdownFigureReferences(translated);

    assert.deepEqual(analysis.references.map(reference => (
        translated.slice(reference.from, reference.to)
    )), ['Fig. 2']);
    assert.deepEqual(
        analysis.targets.map(target => target.label),
        ['Figure 2.']
    );
});

test('preserves interactive table references and target labels', () => {
    const markdown = [
        '# Results',
        '',
        'Performance is reported in Table 1.',
        '',
        'Table 1. Model performance',
        '',
        '| Model | Accuracy |',
        '| --- | ---: |',
        '| Baseline | 0.72 |',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const referenceBlock = blocks.find(block => (
        block.markdown.includes('reported in Table')
    ));
    const captionBlock = blocks.find(block => (
        block.markdown.includes('Table 1. Model')
    ));

    assert.doesNotMatch(referenceBlock.requestMarkdown, /Table 1/);
    assert.doesNotMatch(captionBlock.requestMarkdown, /Table 1\./);

    const translated = assembleTranslatedMarkdown(
        markdown,
        blocks,
        blocks.filter(block => block.translatable).map(block => ({
            id: block.id,
            markdown: block.requestMarkdown
                .replace('Results', '结果')
                .replace('Performance is reported in', '性能见')
                .replace('Model performance', '模型性能')
                .replace('Model', '模型')
                .replace('Accuracy', '准确率')
                .replace('Baseline', '基线'),
        }))
    );
    const analysis = analyzeMarkdownTableReferences(translated);

    assert.deepEqual(analysis.references.map(reference => (
        translated.slice(reference.from, reference.to)
    )), ['Table 1']);
    assert.deepEqual(
        analysis.targets.map(target => target.label),
        ['Table 1.']
    );
});

test('protects a table caption label after matching table cell text', () => {
    const markdown = [
        'The result appears in Table 1.',
        '',
        '| Note |',
        '| --- |',
        '| Table 1 Result summary |',
        '',
        'Table 1 Result summary',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const tableBlock = blocks.find(block => block.type === 'table');
    const captionBlock = blocks.find(block => (
        block.markdown === 'Table 1 Result summary'
    ));

    assert.match(tableBlock.requestMarkdown, /Table 1/);
    assert.doesNotMatch(captionBlock.requestMarkdown, /Table 1/);
});

test('translates embedded figure descriptions without changing the image', () => {
    const markdown = [
        'The design appears in Fig. 1.',
        '',
        '![Figure 1. Model results.](images/f1.png)',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const imageBlock = blocks.find(block => (
        block.markdown.includes('Model results')
    ));

    assert.equal(imageBlock.translatable, true);
    assert.match(imageBlock.requestMarkdown, /Model results/);
    assert.doesNotMatch(imageBlock.requestMarkdown, /Figure 1|f1\.png/);
    const translatedImage = imageBlock.requestMarkdown.replace(
        'Model results',
        '模型结果'
    );
    assert.equal(validateTranslatedBlock(imageBlock, translatedImage), [
        '![Figure 1. 模型结果.](images/f1.png)',
    ].join(''));

    const translations = blocks
        .filter(block => block.translatable)
        .map(block => ({
            id: block.id,
            markdown: block === imageBlock
                ? translatedImage
                : block.requestMarkdown.replace(
                    'The design appears in',
                    '该设计见'
                ),
        }));
    const translated = assembleTranslatedMarkdown(
        markdown,
        blocks,
        translations
    );
    const analysis = analyzeMarkdownFigureReferences(translated);

    assert.deepEqual(analysis.references.map(reference => (
        translated.slice(reference.from, reference.to)
    )), ['Fig. 1']);
    assert.deepEqual(analysis.targets.map(target => target.label), [
        'Figure 1.',
    ]);
    const comparison = createComparisonMarkdown(
        markdown,
        blocks,
        translations
    );
    assert.equal(
        comparison.match(/!\[Figure 1\.[^\]]*\]\(images\/f1\.png\)/g)?.length,
        1
    );
    assert.match(comparison, /Figure 1\. 模型结果\./);
});

test('protects a recovered table label inside a miscaptioned image', () => {
    const markdown = [
        'BMI classes are listed in Table 2.',
        '',
        '<table><tr><td>Category</td><td>BMI</td></tr></table>',
        '',
        '![Table 2. BMI classification.](images/histogram.jpg)',
        'Figure 1. BMI histogram.',
    ].join('\n');
    const block = collectMarkdownTranslationBlocks(markdown).find(candidate => (
        candidate.markdown.includes('BMI classification')
    ));

    assert.equal(block.translatable, true);
    assert.doesNotMatch(block.requestMarkdown, /Table 2|Figure 1|histogram\.jpg/);
    assert.match(block.requestMarkdown, /BMI classification/);
    assert.match(block.requestMarkdown, /BMI histogram/);
    assert.equal(validateTranslatedBlock(
        block,
        block.requestMarkdown
            .replace('BMI classification', 'BMI 分类')
            .replace('BMI histogram', 'BMI 直方图')
    ), [
        '![Table 2. BMI 分类.](images/histogram.jpg)',
        'Figure 1. BMI 直方图.',
    ].join('\n'));
});

test('preserves interactive Unicode citation superscripts', () => {
    const markdown = [
        '# Results',
        '',
        'Relaxation methods reduce anxiety²⁻⁴.',
        '',
        '## References',
        '',
        '[2] Beta B. Second paper. 2020.',
        '[3] Gamma G. Third paper. 2021.',
        '[4] Delta D. Fourth paper. 2022.',
    ].join('\n');
    const block = collectMarkdownTranslationBlocks(markdown).find(candidate => (
        candidate.markdown.includes('Relaxation methods')
    ));

    assert.doesNotMatch(block.requestMarkdown, /²⁻⁴/u);
    assert.equal(validateTranslatedBlock(
        block,
        block.requestMarkdown.replace(
            'Relaxation methods reduce anxiety',
            '放松方法可以减轻焦虑'
        )
    ), '放松方法可以减轻焦虑²⁻⁴.');
});

test('does not protect unresolved academic-looking prose', () => {
    const markdown = 'We figure out Table 9 after reviewing Smith (2020).';
    const [block] = collectMarkdownTranslationBlocks(markdown);

    assert.equal(block.requestMarkdown, markdown);
    assert.deepEqual(block.protectedFragments, []);
});

test('keeps reference headings and entries out of translation batches', () => {
    const markdown = [
        '# Paper',
        '',
        'Body paragraph.',
        '',
        '## References',
        '',
        '[1] Author. Article title.',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const batches = collectMarkdownTranslationSections(markdown, blocks)
        .flatMap(createMarkdownTranslationBatches);

    assert.deepEqual(blocks.map(block => block.translatable), [
        true,
        true,
        false,
        false,
    ]);
    assert.doesNotMatch(batches[0].requestPayload, /References|Article title/);
});

test('resumes translation at a new H1 section after references', () => {
    const markdown = [
        '# Paper',
        '',
        'Body paragraph.',
        '',
        '## References',
        '',
        '[1] Author. Article title.',
        '',
        '# Appendix',
        '',
        'Additional analysis.',
    ].join('\n');

    const blocks = collectMarkdownTranslationBlocks(markdown);

    assert.deepEqual(blocks.map(block => block.translatable), [
        true,
        true,
        false,
        false,
        true,
        true,
    ]);
});

test('translates Setext headings while preserving their heading level', () => {
    const markdown = 'Paper title\n===========';
    const [block] = collectMarkdownTranslationBlocks(markdown);

    assert.equal(block.type, 'heading');
    assert.equal(block.translatable, true);
    assert.equal(
        assembleTranslatedMarkdown(markdown, [block], [{
            id: block.id,
            markdown: '论文标题\n========',
        }]),
        '论文标题\n========'
    );
    assert.throws(
        () => assembleTranslatedMarkdown(markdown, [block], [{
            id: block.id,
            markdown: '## 论文标题',
        }]),
        /structure/i
    );
});

test('preserves structural and unsafe blocks instead of sending them for translation', () => {
    const markdown = [
        '![Figure](images/figure.png)',
        '',
        '```js',
        'alert("do not translate");',
        '```',
        '',
        '$$E = mc^2$$',
        '',
        '<script>alert(1)</script>',
        '',
        '[paper]: https://example.com/paper',
    ].join('\n');

    const blocks = collectMarkdownTranslationBlocks(markdown);

    assert.equal(blocks.length, 5);
    assert.deepEqual(blocks.map(block => block.translatable), [
        false,
        false,
        false,
        false,
        false,
    ]);
});

test('translates text around protected Markdown without exposing protected content', () => {
    const markdown = [
        'Read `model.fit()`, keep $E = mc^2$, then see',
        '![Figure](images/figure.png) and <kbd>Enter</kbd>.',
    ].join(' ');
    const [block] = collectMarkdownTranslationBlocks(markdown);

    assert.equal(block.translatable, true);
    assert.doesNotMatch(block.requestMarkdown, /model\.fit|mc\^2|figure\.png|kbd/);
    assert.equal(block.protectedFragments.length, 5);

    const providerOutput = block.requestMarkdown
        .replace('Read', '阅读')
        .replace('keep', '保留')
        .replace('then see', '然后查看')
        .replace('and', '并按下')
        .replaceAll(', ', '，');
    assert.equal(validateTranslatedBlock(block, providerOutput), [
        '阅读 `model.fit()`，保留 $E = mc^2$，然后查看',
        '![Figure](images/figure.png) 并按下 <kbd>Enter</kbd>.',
    ].join(' '));
});

test('protects display math nested inside lists and blockquotes', () => {
    const markdown = [
        '- Explain the equation:',
        '',
        '  $$',
        '  E = mc^2',
        '  $$',
        '',
        '> Compare the result:',
        '>',
        '> \\[',
        '> a + b = c',
        '> \\]',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translatable = blocks.filter(block => block.translatable);

    assert.equal(translatable.length, 2);
    assert.deepEqual(
        translatable.map(block => block.protectedFragments.length),
        [1, 1]
    );
    assert.doesNotMatch(
        translatable.map(block => block.requestMarkdown).join('\n'),
        /mc\^2|a \+ b/
    );

    const translations = translatable.map(block => ({
        id: block.id,
        markdown: block.requestMarkdown
            .replace('Explain the equation', '解释这个公式')
            .replace('Compare the result', '比较结果'),
    }));
    assert.equal(
        assembleTranslatedMarkdown(markdown, blocks, translations),
        markdown
            .replace('Explain the equation', '解释这个公式')
            .replace('Compare the result', '比较结果')
    );
});

test('does not translate blocks containing only protected Markdown', () => {
    const blocks = collectMarkdownTranslationBlocks([
        '`model.fit()`',
        '',
        '![Figure](images/figure.png)',
        '',
        '$E = mc^2$',
        '',
        'https://example.com/paper',
    ].join('\n'));

    assert.deepEqual(blocks.map(block => block.translatable), [
        false,
        false,
        false,
        false,
    ]);
});

test('translates link text without exposing or changing its destination', () => {
    const [block] = collectMarkdownTranslationBlocks(
        'Read [the paper](https://example.com/paper).'
    );
    const translated = block.requestMarkdown
        .replace('Read', '阅读')
        .replace('the paper', '这篇论文');

    assert.doesNotMatch(block.requestMarkdown, /https:\/\//);
    assert.equal(
        validateTranslatedBlock(block, translated),
        '阅读 [这篇论文](https://example.com/paper).'
    );
});

test('rejects missing, duplicated, or fabricated protected placeholders', () => {
    const [block] = collectMarkdownTranslationBlocks(
        'Run `model.fit()` and inspect ![Figure](figure.png).'
    );
    const [first] = block.protectedFragments;

    assert.throws(
        () => validateTranslatedBlock(
            block,
            block.requestMarkdown.replace(first.placeholder, '')
        ),
        /protected/i
    );
    assert.throws(
        () => validateTranslatedBlock(
            block,
            `${block.requestMarkdown} ${first.placeholder}`
        ),
        /protected/i
    );
    assert.throws(
        () => validateTranslatedBlock(
            block,
            `${block.requestMarkdown} MKTEROPROTECTED999PLACEHOLDER`
        ),
        /protected/i
    );
    assert.throws(
        () => validateTranslatedBlock(
            block,
            block.requestMarkdown.replace(
                first.placeholder,
                `**${first.placeholder}**`
            )
        ),
        /protected/i
    );
});

test('rejects reordered protected placeholders', () => {
    const [block] = collectMarkdownTranslationBlocks(
        'Run `first()` before `second()`.'
    );
    const [first, second] = block.protectedFragments;
    const temporary = 'TEMPORARYPROTECTEDPLACEHOLDER';
    const reordered = block.requestMarkdown
        .replace(first.placeholder, temporary)
        .replace(second.placeholder, first.placeholder)
        .replace(temporary, second.placeholder);

    assert.throws(
        () => validateTranslatedBlock(block, reordered),
        /protected/i
    );
});

test('identifies protected content changes with a stable error code', () => {
    const [block] = collectMarkdownTranslationBlocks(
        'Compare $x$ with the baseline.'
    );

    assert.throws(() => validateTranslatedBlock(
        block,
        block.requestMarkdown.replace(block.protectedFragments[0].placeholder, '')
    ), error => error?.code === TRANSLATION_PROTECTED_CONTENT_CHANGED);
});

test('rejects duplicate cached placeholder identities while reconciling', () => {
    const source = 'See [1] and [2].';
    const [block] = collectMarkdownTranslationBlocks(source);
    const [first, second] = block.protectedFragments;
    const translatedMarkdown = block.requestMarkdown.replace(
        second.placeholder,
        first.placeholder
    );

    assert.throws(
        () => reconcileTranslatedBlockProtectedFragments({
            previousBlock: block,
            currentBlock: block,
            translatedMarkdown,
        }),
        error => error?.code === TRANSLATION_PROTECTED_CONTENT_CHANGED
    );
});

test('translates only ordinary text segments around protected content', () => {
    const [block] = collectMarkdownTranslationBlocks(
        'Compare $X_{c}^{\\top}X_{c}$ and $Y_{c}Y_{c}^{\\top}$.'
    );

    const payload = JSON.parse(createProtectedTextTranslationPayload(block));

    assert.deepEqual(payload, [{
        id: 'segment-0',
        sourceText: 'Compare',
    }, {
        id: 'segment-1',
        sourceText: 'and',
    }]);
    assert.doesNotMatch(
        JSON.stringify(payload),
        /MKTEROPROTECTED|X_\{c\}|Y_\{c\}/
    );

    const translation = collectProtectedTextTranslationResponse(
        block,
        JSON.stringify([{
            id: 'segment-1',
            translatedText: '和',
        }, {
            id: 'segment-0',
            translatedText: '比较',
        }])
    );

    assert.equal(translation.id, block.id);
    assert.equal(
        validateTranslatedBlock(block, translation.markdown),
        '比较 $X_{c}^{\\top}X_{c}$ 和 $Y_{c}Y_{c}^{\\top}$.'
    );
});

test('rejects incomplete or ambiguous protected text segment responses', () => {
    const [block] = collectMarkdownTranslationBlocks(
        'Compare $x$ and $y$.'
    );

    assert.throws(() => collectProtectedTextTranslationResponse(
        block,
        JSON.stringify([{
            id: 'segment-0',
            translatedText: '比较',
        }])
    ), /omitted.*segment/i);
    assert.throws(() => collectProtectedTextTranslationResponse(
        block,
        JSON.stringify([{
            id: 'segment-0',
            translatedText: '比较',
        }, {
            id: 'segment-0',
            translatedText: '对比',
        }, {
            id: 'segment-1',
            translatedText: '和',
        }])
    ), /duplicate.*segment/i);
    assert.throws(() => collectProtectedTextTranslationResponse(
        block,
        JSON.stringify([{
            id: 'segment-0',
            translatedText: '比较',
        }, {
            id: 'segment-1',
            translatedText: '和',
        }, {
            id: 'unknown-segment',
            translatedText: '注入内容',
        }])
    ), /unknown.*segment/i);
    assert.throws(() => collectProtectedTextTranslationResponse(
        block,
        JSON.stringify([{
            id: 'segment-0',
            translatedText: '比较',
        }, {
            id: 'segment-1',
            translatedText: '和',
        }, {
            translatedText: '无标识注入内容',
        }])
    ), /segment without an ID/i);
});

test('assembles a complete translated article while preserving document spacing', () => {
    const markdown = '# Paper\n\nOriginal paragraph.\n\n![Figure](figure.png)\n';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translations = [{
        id: blocks[0].id,
        markdown: '# 论文',
    }, {
        id: blocks[1].id,
        markdown: '译文段落。',
    }];

    assert.equal(
        assembleTranslatedMarkdown(markdown, blocks, translations),
        '# 论文\n\n译文段落。\n\n![Figure](figure.png)\n'
    );
});

test('creates and validates one protected full-document translation payload', () => {
    const markdown = [
        '# Paper',
        '',
        'Read `model.fit()` before continuing.',
        '',
        '```js',
        'doNotTranslate();',
        '```',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const request = createMarkdownTranslationRequest(markdown, blocks);

    assert.match(request, /^MKTEROBLOCK\d+STARTMARKER\n\n# Paper/);
    assert.match(request, /Read MKTEROPROTECTED0PLACEHOLDER/);
    assert.match(request, /MKTEROBLOCK\d+ENDMARKER$/);
    assert.doesNotMatch(request, /model\.fit|doNotTranslate/);

    const translated = request
        .replace('# Paper', '# 论文')
        .replace('Read', '运行')
        .replace('before continuing.', '后继续。');
    const translations = collectDocumentTranslations(
        request,
        blocks,
        translated
    );

    assert.equal(
        assembleTranslatedMarkdown(markdown, blocks, translations),
        '# 论文\n\n运行 `model.fit()` 后继续。\n\n```js\ndoNotTranslate();\n```'
    );
});

test('rejects a full-document response that changes protected blocks', () => {
    const markdown = '# Paper\n\n```js\ncode();\n```';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const request = createMarkdownTranslationRequest(markdown, blocks);
    const protectedBlock = request.match(
        /MKTEROPROTECTED\d+PLACEHOLDER/
    )?.[0];

    assert.throws(
        () => collectDocumentTranslations(
            request,
            blocks,
            request.replace(
                protectedBlock,
                'changed'
            )
        ),
        /protected|structure/i
    );
});

test('rejects a full-document response that reorders same-type blocks', () => {
    const markdown = 'First paragraph.\n\nSecond paragraph.';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const request = createMarkdownTranslationRequest(markdown, blocks);
    const wrappedBlocks = request.split(/\n\n(?=MKTEROBLOCK\d+STARTMARKER)/);

    assert.equal(wrappedBlocks.length, 2);
    assert.throws(
        () => collectDocumentTranslations(
            request,
            blocks,
            [wrappedBlocks[1], wrappedBlocks[0]].join('\n\n')
        ),
        /structure|order/i
    );
});

test('separates adjacent protected and translatable top-level blocks', () => {
    const markdown = '```js\ncode();\n```\nTranslate this paragraph.';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const request = createMarkdownTranslationRequest(markdown, blocks);
    const translated = request.replace(
        'Translate this paragraph.',
        '翻译这个段落。'
    );
    const translations = collectDocumentTranslations(
        request,
        blocks,
        translated
    );

    assert.equal(blocks.length, 2);
    assert.match(request, /PLACEHOLDER\n\nMKTEROBLOCK\d+ENDMARKER/);
    assert.match(request, /STARTMARKER\n\nTranslate/);
    assert.equal(
        assembleTranslatedMarkdown(markdown, blocks, translations),
        '```js\ncode();\n```\n翻译这个段落。'
    );
});

test('creates block-level comparison Markdown with source above translation', () => {
    const markdown = '# Paper\n\nOriginal paragraph.\n\n![Figure](figure.png)';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translations = [{
        id: blocks[0].id,
        markdown: '# 论文',
    }, {
        id: blocks[1].id,
        markdown: '译文第一句。译文第二句。',
    }];

    assert.equal(createComparisonMarkdown(markdown, blocks, translations), [
        '# Paper',
        '',
        '# 论文',
        '',
        'Original paragraph.',
        '',
        '译文第一句。译文第二句。',
        '',
        '![Figure](figure.png)',
    ].join('\n'));
});

test('maps stable block IDs across original, translated, and bilingual views', () => {
    const markdown = '# Paper\n\nOriginal paragraph.';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translations = [{
        id: blocks[0].id,
        markdown: '# \u8bba\u6587',
    }, {
        id: blocks[1].id,
        markdown: '\u8bd1\u6587\u6bb5\u843d\u3002',
    }];

    const views = createDocumentTranslationViews(
        markdown,
        blocks,
        translations
    );

    assert.equal(views.translatedMarkdown, '# \u8bba\u6587\n\n\u8bd1\u6587\u6bb5\u843d\u3002');
    assert.equal(views.comparisonMarkdown, [
        '# Paper',
        '',
        '# \u8bba\u6587',
        '',
        'Original paragraph.',
        '',
        '\u8bd1\u6587\u6bb5\u843d\u3002',
    ].join('\n'));
    assert.deepEqual(views.blockRanges, [{
        id: blocks[0].id,
        type: 'heading',
        sourceFrom: 0,
        sourceTo: 7,
        translatedFrom: 0,
        translatedTo: 4,
        comparisonSourceFrom: 0,
        comparisonSourceTo: 7,
        comparisonTranslationFrom: 9,
        comparisonTranslationTo: 13,
    }, {
        id: blocks[1].id,
        type: 'paragraph',
        sourceFrom: 9,
        sourceTo: 28,
        translatedFrom: 6,
        translatedTo: 11,
        comparisonSourceFrom: 15,
        comparisonSourceTo: 34,
        comparisonTranslationFrom: 36,
        comparisonTranslationTo: 41,
    }]);
});

test('maps original content ranges onto the source side of bilingual blocks', () => {
    const markdown = '# Paper\n\nOriginal paragraph.';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const views = createDocumentTranslationViews(markdown, blocks, [{
        id: blocks[0].id,
        markdown: '# \u8bba\u6587',
    }, {
        id: blocks[1].id,
        markdown: '\u8bd1\u6587\u6bb5\u843d\u3002',
    }]);

    assert.deepEqual(mapSourceRangeToComparison(
        { from: 12, to: 20 },
        views.blockRanges
    ), { from: 18, to: 26 });
    assert.equal(mapSourceRangeToComparison(
        { from: 6, to: 12 },
        views.blockRanges
    ), null);
});

test('keeps reading position in the same stable block across reading modes', () => {
    const markdown = '# Paper\n\nOriginal paragraph.';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const views = createDocumentTranslationViews(markdown, blocks, [{
        id: blocks[0].id,
        markdown: '# \u8bba\u6587',
    }, {
        id: blocks[1].id,
        markdown: '\u8fd9\u662f\u4e00\u6bb5\u957f\u5ea6\u4e0d\u540c\u7684\u8bd1\u6587\u3002',
    }]);
    const anchor = createTranslationReadingPositionAnchor(
        18,
        'original',
        views.blockRanges
    );

    assert.equal(anchor.blockID, blocks[1].id);
    assert.equal(
        resolveTranslationReadingPosition(
            anchor,
            'translated',
            views.blockRanges
        ),
        12
    );
    assert.equal(
        resolveTranslationReadingPosition(
            { ...anchor, side: 'translation' },
            'compare',
            views.blockRanges
        ),
        42
    );
});

test('keeps bilingual lists separate and does not repeat protected images', () => {
    const markdown = [
        '- First item',
        '- Second item',
        '',
        '![Figure](figure.png)',
        'Original caption.',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translations = [{
        id: blocks[0].id,
        markdown: '- 第一项\n- 第二项',
    }, {
        id: blocks[1].id,
        markdown: blocks[1].requestMarkdown.replace(
            'Original caption.',
            '译文图注。'
        ),
    }];
    const comparison = createComparisonMarkdown(markdown, blocks, translations);

    assert.match(
        comparison,
        /- Second item\n<!-- mktero-bilingual-list-boundary -->\n\n- 第一项/
    );
    assert.equal(comparison.match(/!\[Figure\]\(figure\.png\)/g)?.length, 1);
    assert.match(comparison, /Original caption\.\n\n译文图注。/);
});

test('does not repeat an image caption when translation falls back to source', () => {
    const markdown = '![Figure](figure.png)\nOriginal caption.';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const comparison = createComparisonMarkdown(markdown, blocks, [{
        id: blocks[0].id,
        markdown: blocks[0].requestMarkdown,
    }]);

    assert.equal(comparison, markdown);
});

test('rejects incomplete or mismatched translation sets', () => {
    const markdown = '# Paper\n\nParagraph.';
    const blocks = collectMarkdownTranslationBlocks(markdown);

    assert.throws(
        () => assembleTranslatedMarkdown(markdown, blocks, []),
        /missing/i
    );
    assert.throws(
        () => assembleTranslatedMarkdown(markdown, blocks, [{
            id: blocks[0].id,
            markdown: 'Not a heading.',
        }, {
            id: blocks[1].id,
            markdown: '段落。',
        }]),
        /structure/i
    );
});

test('marks a chrome-only paragraph as not translatable', () => {
    const markdown = 'Hello\n\n12\n\nWorld';
    const chromeFrom = markdown.indexOf('\n\n12\n\n');
    const chromeTo = chromeFrom + '\n\n12\n\n'.length;
    const blocks = collectMarkdownTranslationBlocks(markdown, {
        chromeRanges: [{ from: chromeFrom, to: chromeTo }],
    });
    const chromeBlock = blocks.find(block => block.markdown.trim() === '12');
    assert.equal(chromeBlock?.translatable, false);
    assert.equal(
        blocks.find(block => block.markdown === 'Hello')?.translatable,
        true
    );
    assert.equal(
        blocks.find(block => block.markdown === 'World')?.translatable,
        true
    );
});
