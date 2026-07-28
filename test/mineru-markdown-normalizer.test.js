import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';
import { normalizeMinerUMarkdown } from '../src/mineru/markdown-normalizer.js';

test('converts consecutive MinerU OCR bullets into a Markdown list', () => {
    const markdown = [
        '## References',
        '',
        'Smith J. A preceding reference.',
        '',
        '## Benefits',
        '',
        '\\- fast submission',
        '',
        '• thorough review',
        '',
        '\\- rapid publication',
        '',
        'A separate explanation.',
        '',
        '\\- an isolated literal hyphen',
    ].join('\n');

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        [
            '## References',
            '',
            'Smith J. A preceding reference.',
            '',
            '## Benefits',
            '',
            '- fast submission',
            '',
            '- thorough review',
            '',
            '- rapid publication',
            '',
            'A separate explanation.',
            '',
            '\\- an isolated literal hyphen',
        ].join('\n')
    );
});

test('keeps OCR bullet markers anywhere inside references unchanged', () => {
    const markdown = [
        '## References',
        '',
        'Introductory reference note.',
        '',
        '\\- Smith J. First study.',
        '',
        '• Jones P. Second study.',
    ].join('\n');

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('keeps OCR bullet markers under a Setext references heading unchanged', () => {
    const markdown = [
        'References',
        '----------',
        '',
        '\\- Smith J. First study.',
        '',
        '• Jones P. Second study.',
    ].join('\n');

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('does not join OCR bullets separated by more than one blank line', () => {
    const markdown = '\\- first standalone item\n\n\n• second standalone item';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('joins a MinerU paragraph split in the middle of a sentence', () => {
    const markdown = [
        'The common elements framework improves ability to change perspective on',
        '',
        'an event), and context engagement with new situations.',
    ].join('\n');

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        'The common elements framework improves ability to change perspective on '
            + 'an event), and context engagement with new situations.'
    );
});

test('joins a citation year split from its preceding author name', () => {
    const markdown = 'Dental anxiety can stem from previous negative experiences '
        + '(Oosterink et al., 2008; van Houtem et al.,\n\n'
        + '2017; van Houtem et al., 2015). Its extreme form is dental phobia.';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        'Dental anxiety can stem from previous negative experiences '
            + '(Oosterink et al., 2008; van Houtem et al., 2017; '
            + 'van Houtem et al., 2015). Its extreme form is dental phobia.'
    );
});

test('keeps an unrelated year-led paragraph separate after a comma', () => {
    const markdown = 'The historical discussion mentions several authors,\n\n'
        + '2017 was examined separately in the chronological overview.';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('joins a MinerU paragraph split after a semicolon', () => {
    const markdown = 'Concretely, a real loop system assembles five reusable pieces and '
        + 'an external memory. $^{8}$ Scheduled automations discover and triage the work '
        + '(the scheduled trigger made concrete);\n\n'
        + 'isolated worktrees let parallel agents run without colliding; skills encode '
        + 'project knowledge as named, testable routines.';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        'Concretely, a real loop system assembles five reusable pieces and an external '
            + 'memory. $^{8}$ Scheduled automations discover and triage the work '
            + '(the scheduled trigger made concrete); isolated worktrees let parallel '
            + 'agents run without colliding; skills encode project knowledge as named, '
            + 'testable routines.'
    );
});

test('joins a MinerU paragraph split after a closing parenthetical', () => {
    const markdown = 'Exerting effort will induce physiological (e.g., increased heart '
        + 'rate and cortisol) and psychological (e.g., increased anxiety, distress, '
        + 'fatigue, and depressed mood)\n\n'
        + 'load reactions in individuals $[2, 4]$ .';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        'Exerting effort will induce physiological (e.g., increased heart rate and '
            + 'cortisol) and psychological (e.g., increased anxiety, distress, fatigue, '
            + 'and depressed mood) load reactions in individuals $[2, 4]$ .'
    );
});

test('joins every consecutive continuation created from the same paragraph', () => {
    const markdown = 'A sufficiently descriptive paragraph continues with\n\n'
        + 'another fragment that still has no ending\n\n'
        + 'and finally ends here.';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        'A sufficiently descriptive paragraph continues with another fragment '
            + 'that still has no ending and finally ends here.'
    );
});

test('joins prose that follows an inline image in the same MinerU block', () => {
    const markdown = '![Chart](images/chart.png)  \n'
        + 'The analysis produced the same result with the exception\n\n'
        + 'that the final comparison was no longer significant.';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        '![Chart](images/chart.png)  \n'
            + 'The analysis produced the same result with the exception '
            + 'that the final comparison was no longer significant.'
    );
});

test('keeps complete prose paragraphs separate', () => {
    const markdown = 'This is a complete paragraph.\n\n'
        + 'another paragraph may intentionally start with a lowercase word.';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('keeps complete parenthetical and link endings separate', () => {
    const cases = [
        'A sufficiently detailed paragraph closes with a caveat (see Appendix A)\n\n'
            + 'another paragraph intentionally begins with lowercase prose.',
        'A sufficiently detailed paragraph closes with a '
            + '[project link](https://example.org)\n\n'
            + 'eHealth interventions are discussed in a separate paragraph.',
    ];

    for (const markdown of cases) {
        assert.equal(normalizeMinerUMarkdown(markdown), markdown, markdown);
    }
});

test('keeps a complete parallel-example paragraph separate', () => {
    const cases = [
        'Outcomes were classified as physiological (e.g., heart rate) and '
            + 'psychological (e.g., anxiety)\n\n'
            + 'participants were recruited in a separate phase.',
        'The intervention induces relaxation (e.g., lower heart rate) and '
            + 'engagement (e.g., focused attention)\n\n'
            + 'participants were monitored in a separate phase.',
    ];

    for (const markdown of cases) {
        assert.equal(normalizeMinerUMarkdown(markdown), markdown, markdown);
    }
});

test('keeps a semicolon-ended paragraph without a continuing semicolon series separate', () => {
    const markdown = 'The first complete paragraph deliberately closes with a semicolon;\n\n'
        + 'another paragraph intentionally begins with a lowercase word.';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('does not merge entries inside the references section', () => {
    const markdown = '## References\n\n'
        + 'Smith J, Jones P. Journal of Behavioral Medicine 2024\n\n'
        + 'van der Meer A. Another independently published study 2023';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('does not merge a figure or table caption with following prose', () => {
    const cases = [
        'Figure 1. A sufficiently descriptive caption without punctuation\n\n'
            + 'and the article continues with an explanatory paragraph.',
        'Table 2. A sufficiently descriptive caption without punctuation\n\n'
            + 'and the article continues with an explanatory paragraph.',
        'Figure 2A. A sufficiently descriptive caption without punctuation\n\n'
            + 'and the article continues with an explanatory paragraph.',
        'Figure S1A. A sufficiently descriptive caption without punctuation\n\n'
            + 'and the article continues with an explanatory paragraph.',
    ];

    for (const markdown of cases) {
        assert.equal(normalizeMinerUMarkdown(markdown), markdown, markdown);
    }
});

test('moves an adjacent MinerU figure caption into the image description', () => {
    const markdown = '![](images/6071.jpg)  \n'
        + 'Figure 1. PRISMA flowchart of inclusion of studies for the meta-analysis.';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        '![Figure 1. PRISMA flowchart of inclusion of studies for the meta-analysis.]'
            + '(images/6071.jpg)'
    );
});

test('moves an abbreviated figure caption without punctuation after its number', () => {
    const markdown = '![](images/figure.jpg)  \n'
        + 'Fig. 1 Cumulative frequencies of reasons for listening to music after stress.';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        '![Fig. 1 Cumulative frequencies of reasons for listening to music after stress.]'
            + '(images/figure.jpg)'
    );
});

test('moves a blank-line-separated figure caption into the image description', () => {
    const markdown = '![](images/figure.jpg)\n\n'
        + 'Figure S1A: Participant flow through the study.\n\n'
        + 'The article continues here.';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        '![Figure S1A: Participant flow through the study.]'
            + '(images/figure.jpg)\n\nThe article continues here.'
    );
});

test('moves a figure caption above its image into the image description', () => {
    const markdown = 'Figure 2. Symptom reduction over time in the full sample. '
        + 'The gray shaded region indicates bootstrapped SEs. Model details '
        + 'are described in the Results for Aim 2.\n\n'
        + '![](images/figure.jpg)';
    const normalized = normalizeMinerUMarkdown(markdown);

    assert.equal(
        normalized,
        '![Figure 2. Symptom reduction over time in the full sample. '
            + 'The gray shaded region indicates bootstrapped SEs. Model details '
            + 'are described in the Results for Aim 2.]'
            + '(images/figure.jpg)'
    );
    assert.match(
        renderMarkdownHTML(normalized, {
            resolveImageURL: () => 'blob:mktero-figure',
        }),
        /<span class="mktero-figure-label">Figure 2\.<\/span>/
    );
});

test('moves a figure caption immediately above its image', () => {
    const markdown = 'Fig. 1 Participant flow through the study.\n'
        + '![](images/figure.jpg)';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        '![Fig. 1 Participant flow through the study.](images/figure.jpg)'
    );
});

test('does not assign a caption above multiple panels to only the first image', () => {
    const markdown = 'Figure 1. Results for panels A and B.\n'
        + '![](images/panel-a.jpg)\n'
        + '![](images/panel-b.jpg)';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('preserves CRLF when normalizing a caption above its image', () => {
    const markdown = 'Figure 3. Outcome by treatment group.\r\n\r\n'
        + '![](images/figure.jpg)\r\n\r\nNext paragraph.';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        '![Figure 3. Outcome by treatment group.](images/figure.jpg)'
            + '\r\n\r\nNext paragraph.'
    );
});

test('does not move a caption above an image inside fenced code', () => {
    const markdown = '```md\n'
        + 'Figure 1. This is syntax shown inside a code sample.\n'
        + '![](images/example.jpg)\n'
        + '```';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('does not move an indented caption above an image', () => {
    const markdown = '    Figure 1. This is an indented code sample.\n'
        + '![](images/example.jpg)';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('does not move example figure captions inside fenced code', () => {
    const markdown = '```md\n'
        + '![](images/example.jpg)\n'
        + 'Figure 1. This is syntax shown inside a code sample.\n'
        + '```';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('does not move example figure captions inside indented code', () => {
    const markdown = '    ![](images/example.jpg)\n'
        + '    Figure 1. This is syntax shown inside a code sample.';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('does not assign a shared caption to only the last image panel', () => {
    const markdown = '![](images/panel-a.jpg)\n'
        + '![](images/panel-b.jpg)\n'
        + 'Figure 1. Results for panels A and B.';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('keeps narrative figure mentions and existing image descriptions unchanged', () => {
    const cases = [
        '![](images/figure.jpg)\nFigure 1 shows the participant flow.',
        '![Existing description](images/figure.jpg)\n'
            + 'Figure 1. A separately authored caption.',
    ];

    for (const markdown of cases) {
        assert.equal(normalizeMinerUMarkdown(markdown), markdown, markdown);
    }
});

test('escapes Markdown punctuation in normalized image descriptions idempotently', () => {
    const markdown = '![](images/figure.jpg)  \n'
        + 'Figure 2. Accuracy [95% CI] from C:\\data.';
    const expected = '![Figure 2. Accuracy \\[95% CI\\] from C:\\\\data.]'
        + '(images/figure.jpg)';

    assert.equal(normalizeMinerUMarkdown(markdown), expected);
    assert.equal(normalizeMinerUMarkdown(expected), expected);
});

test('preserves CRLF when normalizing an academic image caption', () => {
    const markdown = '![](images/figure.jpg)  \r\n'
        + 'Fig. 3: Outcome by treatment group.\r\n\r\nNext paragraph.';

    assert.equal(
        normalizeMinerUMarkdown(markdown),
        '![Fig. 3: Outcome by treatment group.](images/figure.jpg)'
            + '\r\n\r\nNext paragraph.'
    );
});

test('does not merge prose with Markdown block structures', () => {
    const cases = [
        '# a lowercase heading\n\nparagraph text',
        '- a list item\n\nparagraph text',
        '> a block quote\n\nparagraph text',
        '| heading | value |\n| --- | --- |\n| a | b |\n\nparagraph text',
        '<table><tr><td>value</td></tr></table>\n\nparagraph text',
        '![Figure](images/figure.png)\n\nparagraph text',
        '$$\nx = y\n$$\n\nparagraph text',
        '<!-- zotero-page: 2 -->\n\nparagraph text',
        'URL: https://www.jmir.org/2021/6/e26771\n\ndoi: 10.2196/26771',
        '    code line with enough prose words and no punctuation\n\n'
            + 'continuation begins here',
        'A sufficiently long prose block ends without terminal punctuation\n\n'
            + 'lowercase setext heading\n---',
    ];

    for (const markdown of cases) {
        assert.equal(normalizeMinerUMarkdown(markdown), markdown, markdown);
    }
});

test('does not merge adjacent figure panels after a Markdown image', () => {
    const markdown = 'High Laser Power (30 mW)  \n'
        + 'a  \n'
        + '![](images/panel-a.jpg)\n\n'
        + 'b  \n'
        + '![](images/panel-b.jpg)';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});

test('preserves line endings when no MinerU split is repaired', () => {
    const markdown = 'First paragraph.\r\n\r\nsecond paragraph.';

    assert.equal(normalizeMinerUMarkdown(markdown), markdown);
});
