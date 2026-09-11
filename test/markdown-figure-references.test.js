import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarkdownFigureReferences } from '../src/markdown/markdown-figure-references.js';
import { findAcademicFigureGroups } from '../src/markdown/markdown-figures.js';

test('keeps all marked panels after OCR removal leaves extra blank lines', () => {
    for (const newline of ['\n', '\r\n']) {
        for (const blankLines of [0, 1, 2, 5]) {
            const separator = newline.repeat(blankLines + 1);
            const markdown = [
                'See Figure 1.',
                '<!-- mktero-figure-layout: columns=2 rows=2,2 -->',
                ...['a', 'b', 'c', 'd'].map(name => `![](images/${name}.png)`),
                'Figure 1. Four panels.',
            ].join(separator);
            const groups = findAcademicFigureGroups(markdown);
            assert.equal(groups.length, 1);
            assert.equal(groups[0].images.length, 4);
            assert.deepEqual(groups[0].gridRows, [2, 2]);
            const preview = analyzeMarkdownFigureReferences(markdown).targets[0];
            for (const name of ['a', 'b', 'c', 'd']) {
                assert.ok(preview.figure.source.includes(`images/${name}.png`));
            }
        }
    }
});

test('does not extend marked figures through prose, fences or another figure', () => {
    const marker = '<!-- mktero-figure-layout: columns=2 rows=2 -->';
    for (const barrier of [
        'An independent paragraph.',
        '```markdown\n![](images/code.png)\n```',
        '<!-- mktero-figure-layout: columns=2 rows=2 -->',
        'Figure 2. An independent figure.',
    ]) {
        const source = [marker, '![](images/a.png)', '', '', barrier,
            '![](images/b.png)', 'Figure 1. Results.'].join('\n');
        assert.ok(!findAcademicFigureGroups(source).some(group => (
            group.from === 0 && group.gridColumns === 2
        )));
    }
    const fenced = '```markdown\n' + [marker, '![](images/a.png)', '', '',
        '![](images/b.png)', 'Figure 1. Results.'].join('\n') + '\n```';
    assert.deepEqual(findAcademicFigureGroups(fenced), []);
    const wrongCount = [marker, '![](images/a.png)', '![](images/b.png)',
        '![](images/c.png)', 'Figure 1. Results.'].join('\n');
    assert.ok(!findAcademicFigureGroups(wrongCount).some(group => group.gridColumns));
});

test('maps a prose figure reference to a uniquely captioned image', () => {
    const markdown = [
        '# Results',
        '',
        'The study flow is summarized in Figure 1.',
        '',
        '![Figure 1. PRISMA flowchart](images/flow.png)',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.deepEqual(result.targets.map(target => ({
        id: target.id,
        label: target.label,
        caption: target.caption,
        source: target.figure.source,
    })), [{
        id: 'figure:1',
        label: 'Figure 1.',
        caption: 'Figure 1. PRISMA flowchart',
        source: '![Figure 1. PRISMA flowchart](images/flow.png)',
    }]);
    assert.deepEqual(result.references.map(reference => ({
        text: markdown.slice(reference.from, reference.to),
        targetId: reference.targetId,
    })), [{
        text: 'Figure 1',
        targetId: 'figure:1',
    }]);
});

test('maps Figure references to captions that use a pipe separator', () => {
    const markdown = [
        'The WikiSkill workspace is shown in (Figure 2).',
        '',
        '![](images/framework.jpg)',
        'Figure 2 | Overview of the WikiSkill framework.',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.deepEqual(result.targets.map(target => ({
        id: target.id,
        label: target.label,
        caption: target.caption,
    })), [{
        id: 'figure:2',
        label: 'Figure 2 |',
        caption: 'Figure 2 | Overview of the WikiSkill framework.',
    }]);
    assert.deepEqual(result.references.map(reference => ({
        text: markdown.slice(reference.from, reference.to),
        targetId: reference.targetId,
    })), [{
        text: 'Figure 2',
        targetId: 'figure:2',
    }]);
});

test('maps a subfigure reference to its uniquely captioned parent figure', () => {
    const markdown = [
        'The first layer appears in (Fig. 1a).',
        '',
        '![Fig. 1. Pipeline architecture](images/pipeline.png)',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.deepEqual(result.references.map(reference => ({
        text: markdown.slice(reference.from, reference.to),
        targetId: reference.targetId,
    })), [{
        text: 'Fig. 1a',
        targetId: 'figure:1',
    }]);
});

test('recovers a figure target after its image receives a table caption', () => {
    const markdown = [
        'The distribution is shown in Figure 1.',
        '',
        '<table><tr><td>Category</td><td>BMI</td></tr></table>',
        '',
        '![Table 2. BMI classification.](images/histogram.jpg)',
        'Figure 1. BMI histogram.',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.deepEqual(result.targets.map(target => ({
        id: target.id,
        caption: target.caption,
        source: target.figure.source,
    })), [{
        id: 'figure:1',
        caption: 'Figure 1. BMI histogram.',
        source: '![Figure 1. BMI histogram.](images/histogram.jpg)',
    }]);
    assert.deepEqual(result.references.map(reference => ({
        text: markdown.slice(reference.from, reference.to),
        targetId: reference.targetId,
    })), [{
        text: 'Figure 1',
        targetId: 'figure:1',
    }]);
});

test('prefers an exact subfigure target over its parent figure', () => {
    const markdown = [
        'Compare Fig. 1a with the complete figure.',
        '',
        '![Fig. 1. Complete result](images/complete.png)',
        '',
        '![Fig. 1a. Detailed result](images/detail.png)',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.deepEqual(result.references.map(reference => reference.targetId), [
        'figure:1a',
    ]);
});

test('does not fall back when an exact subfigure target is ambiguous', () => {
    const markdown = [
        'Compare Fig. 1a with the complete figure.',
        '',
        '![Fig. 1. Complete result](images/complete.png)',
        '',
        '![Fig. 1a. First detail](images/detail-first.png)',
        '',
        '![Fig. 1a. Second detail](images/detail-second.png)',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.deepEqual(result.references, []);
});

test('maps Fig. references to every panel in a shared-caption figure', () => {
    const markdown = [
        'The ablation is shown in Fig. S2.',
        '',
        '![](images/panel-a.png)',
        '',
        '![](images/panel-b.png)  ',
        'FIG. S2: Ablation results by cohort.',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.equal(result.targets.length, 1);
    assert.equal(result.targets[0].id, 'figure:s2');
    assert.equal(result.targets[0].caption, 'FIG. S2: Ablation results by cohort.');
    assert.equal(
        result.targets[0].figure.source.match(/!\[\]/g)?.length,
        2
    );
    assert.deepEqual(result.references.map(reference => (
        markdown.slice(reference.from, reference.to)
    )), ['Fig. S2']);
});

test('maps a reference to one composite image with a trailing panel label', () => {
    const markdown = [
        'Convergence is shown in Figure 3.',
        '',
        '![](images/posterior.jpg)  ',
        '(b) Draws from posterior distribution  ',
        'Figure 3. (a) Trace plots and (b) posterior draws.',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.equal(result.targets.length, 1);
    assert.equal(result.targets[0].id, 'figure:3');
    assert.equal(
        result.targets[0].caption,
        'Figure 3. (a) Trace plots and (b) posterior draws.'
    );
    assert.deepEqual(result.references.map(reference => (
        markdown.slice(reference.from, reference.to)
    )), ['Figure 3']);
});

test('maps localized figure labels and Unicode spacing in translated prose', () => {
    const markdown = [
        '尽管PPG和ABP信号具有相似的形状，如图1所示，',
        '但直接评估SBP和DBP值并非易事；另见Fig.\u00a01。',
        '',
        '![图 1. PPG和ABP信号](images/figure.png)',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.deepEqual(result.targets.map(target => ({
        id: target.id,
        label: target.label,
    })), [{
        id: 'figure:1',
        label: '图 1.',
    }]);
    assert.deepEqual(result.references.map(reference => ({
        text: markdown.slice(reference.from, reference.to),
        targetId: reference.targetId,
    })), [{
        text: '图1',
        targetId: 'figure:1',
    }, {
        text: 'Fig.\u00a01',
        targetId: 'figure:1',
    }]);
});

test('keeps split Figure 1 targets in translated and bilingual paper views', () => {
    const firstPanel = 'images/75036a1c04fe5b273b8dae9f4d121fa16efdc33d04dc66f46b71b575d22daf61.jpg';
    const secondPanel = 'images/0c74f3058b21ed0e804b59e8cfa7f9438e364f637e7546c0f4751085aa522fde.jpg';
    const source = [
        'The right side of Fig. 1 shows an example ABP waveform.',
        '',
        'Although the PPG and ABP signals share a similar shape, as shown in Fig. 1.',
        '',
        `![](${firstPanel})  `,
        'Time (s)',
        '',
        `![](${secondPanel})  `,
        'Time (s)  ',
        'Fig. 1. SBP and DBP estimation from PPG (left) and ABP (right) signals.',
    ].join('\n');
    const translated = [
        'Fig. 1 的右侧展示了一个动脉血压波形示例。',
        '',
        '尽管PPG和ABP信号具有相似的形状，如Fig. 1所示。',
        '',
        `![](${firstPanel})  `,
        '时间（秒）',
        '',
        `![](${secondPanel})  `,
        '时间 (秒)  ',
        'Fig. 1. 基于PPG（左）和ABP（右）信号的SBP与DBP估计。',
    ].join('\n');
    const bilingual = [
        'The right side of Fig. 1 shows an example ABP waveform.',
        '',
        'Fig. 1 的右侧展示了一个动脉血压波形示例。',
        '',
        `![](${firstPanel})  `,
        'Time (s)',
        '',
        '时间（秒）',
        '',
        `![](${secondPanel})  `,
        'Time (s)  ',
        'Fig. 1. SBP and DBP estimation from PPG (left) and ABP (right) signals.',
        '时间 (秒)  ',
        'Fig. 1. 基于PPG（左）和ABP（右）信号的SBP与DBP估计。',
    ].join('\n');

    for (const markdown of [source, translated, bilingual]) {
        const result = analyzeMarkdownFigureReferences(markdown);
        assert.deepEqual(result.targets.map(target => target.id), ['figure:1']);
        assert.ok(result.references.some(reference => (
            markdown.slice(reference.from, reference.to).includes('Fig. 1')
        )));
    }
});

test('ignores figure references in code and links and rejects duplicate labels', () => {
    const markdown = [
        '`Figure 3` is an example token.',
        '',
        '[Figure 3](https://example.com) is already linked.',
        '',
        'The actual result is in Figure 3.',
        '',
        '![Figure 3. First result](images/first.png)',
        '',
        '![Fig. 3: Reused identifier](images/second.png)',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.deepEqual(result.targets, []);
    assert.deepEqual(result.references, []);
});
