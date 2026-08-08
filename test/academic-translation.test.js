import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractAcademicTranslationSegments,
    protectAcademicTranslationText,
    restoreAcademicTranslationPlaceholders,
    splitTranslationSegment,
} from '../src/translation/academic-segments.js';
import {
    createTranslationBatches,
    createTranslationRequest,
    parseTranslationOutput,
    translationProfileDescriptor,
} from '../src/translation/translation-protocol.js';

const SERVICE = {
    id: 'service-1',
    name: 'Service',
    apiURL: 'https://api.example.test/v1/chat/completions',
    apiKey: 'secret',
    model: 'academic-model',
    maxRequestsPerSecond: 1,
    maxParagraphsPerRequest: 2,
    maxCharactersPerRequest: 500,
    temperature: 0.2,
};

test('extracts academic prose while excluding references and unsafe blocks', () => {
    const markdown = [
        '# Methods',
        '',
        'We estimate $L(\\theta)$ using inline code and cite [12].',
        '',
        '- The first cohort contained 24 participants.',
        '',
        '> Measurements were acquired at 20 Hz.',
        '',
        '| Input | Output |',
        '| --- | --- |',
        '| English cell | Ignored cell |',
        '',
        '~~~python',
        'print("not prose")',
        '~~~',
        '',
        '## References',
        '',
        '1. Smith et al. This reference must not be translated.',
        '',
        '## Appendix',
        '',
        'Additional English analysis is included here.',
    ].join('\n');

    const segments = extractAcademicTranslationSegments(markdown);
    assert.deepEqual(segments.map(segment => segment.kind), [
        'heading',
        'paragraph',
        'list-item',
        'blockquote',
        'heading',
        'paragraph',
    ]);
    assert.equal(
        segments.some(segment => segment.source.includes('Smith et al.')),
        false
    );
    assert.equal(
        segments.some(segment => segment.source.includes('English cell')),
        false
    );
    assert.equal(
        segments.some(segment => segment.source.includes('print(')),
        false
    );
    assert.deepEqual(segments.at(-1).headingPath, ['Methods', 'Appendix']);
});

test('extracts academic figure captions as dedicated translation segments', () => {
    const markdown = [
        '# Results',
        '',
        '![Fig. 2. Resolution measured at $f_0$.](images/figure-2.png)',
        '',
        'The reconstructed volume is shown above.',
    ].join('\n');

    const segments = extractAcademicTranslationSegments(markdown);
    const captions = segments.filter(segment => (
        segment.kind === 'figure-caption'
    ));

    assert.equal(captions.length, 1);
    assert.equal(captions[0].source, 'Fig. 2. Resolution measured at $f_0$.');
    assert.equal(captions[0].preparedText.includes('$f_0$'), false);
    assert.equal(captions[0].placeholders[0].value, '$f_0$');
    assert.equal(captions[0].anchor, markdown.indexOf('\n\nThe reconstructed'));
    assert.equal(
        segments.some(segment => segment.preparedText.includes('figure-2.png')),
        false
    );
});

test('extracts academic table captions without translating table cells', () => {
    const markdown = [
        '# Results',
        '',
        'Table 1. Measured reconstruction metrics.',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| English cell | 0.92 |',
        '',
        'The table summarizes the main findings.',
    ].join('\n');

    const segments = extractAcademicTranslationSegments(markdown);
    const captions = segments.filter(segment => (
        segment.kind === 'table-caption'
    ));

    assert.equal(captions.length, 1);
    assert.equal(
        captions[0].source,
        'Table 1. Measured reconstruction metrics.'
    );
    assert.equal(
        segments.some(segment => segment.source.includes('English cell')),
        false
    );
    assert.ok(
        segments.some(segment => (
            segment.kind === 'paragraph'
            && segment.source.includes('The table summarizes')
        ))
    );
});

test('keeps prose after unlabeled images extractable for translation', () => {
    const markdown = [
        '# Results',
        '',
        '![](images/figure-3.png)',
        '',
        'The unlabeled panel shows the reconstructed volume.',
    ].join('\n');

    const segments = extractAcademicTranslationSegments(markdown);
    assert.equal(
        segments.some(segment => segment.kind === 'figure-caption'),
        false
    );
    assert.ok(
        segments.some(segment => (
            segment.kind === 'paragraph'
            && segment.source.includes('The unlabeled panel')
        ))
    );
    assert.equal(
        segments.some(segment => segment.source.includes('figure-3.png')),
        false
    );
});

test('skips non-English figure captions without dropping later prose', () => {
    const markdown = [
        '# Results',
        '',
        '![Fig. 4. 重建体积的分辨率测量结果。](images/figure-4.png)',
        '',
        'Later English analysis remains available for translation.',
    ].join('\n');

    const segments = extractAcademicTranslationSegments(markdown);
    assert.equal(
        segments.some(segment => segment.kind === 'figure-caption'),
        false
    );
    assert.ok(
        segments.some(segment => (
            segment.kind === 'paragraph'
            && segment.source.includes('Later English analysis')
        ))
    );
});

test('protects inline formulas, code, URLs, and citations exactly', () => {
    const marker = String.fromCharCode(96);
    const source = [
        'The loss $L(x)$ uses ' + marker + 'Adam' + marker
            + ', see https://example.test/a?q=1,',
        'and follows prior work [12-14].',
    ].join(' ');
    const protectedText = protectAcademicTranslationText(source);

    assert.equal(protectedText.placeholders.length, 4);
    assert.equal(protectedText.text.includes('$L(x)$'), false);
    const urlPlaceholder = protectedText.placeholders.find(placeholder => (
        /^https?:\/\//u.test(placeholder.value)
    ));
    assert.ok(urlPlaceholder);
    assert.equal(
        new URL(urlPlaceholder.value.replace(/[.,;:!?)]+$/u, '')).hostname,
        'example.test'
    );
    assert.ok(protectedText.text.includes(urlPlaceholder.token));
    assert.equal(protectedText.text.includes(urlPlaceholder.value), false);

    const translated = [
        '译文',
        ...protectedText.placeholders.map(placeholder => placeholder.token),
    ].join(' ');
    const restored = restoreAcademicTranslationPlaceholders(
        translated,
        protectedText.placeholders
    );
    for (const placeholder of protectedText.placeholders) {
        assert.ok(restored.includes(placeholder.value));
    }
    assert.throws(
        () => restoreAcademicTranslationPlaceholders(
            translated + ' ' + protectedText.placeholders[0].token,
            protectedText.placeholders
        ),
        error => error.code === 'TRANSLATION_PLACEHOLDER_INVALID'
    );
});

test('strips nested HTML tags before translation', () => {
    const protectedText = protectAcademicTranslationText(
        'Safe text <scr<script>ipt>alert(1)</script> continues here.'
    );
    assert.equal(protectedText.text.includes('<script'), false);
    assert.equal(protectedText.text.includes('</script>'), false);
    assert.match(protectedText.text, /Safe text/u);
    assert.match(protectedText.text, /continues here/u);
});

test('removes display formulas instead of sending them to the model', () => {
    const source = 'Before formula.\n\n$$E = mc^2$$\n\nAfter formula.';
    const formulaStart = source.indexOf('$$');
    const protectedText = protectAcademicTranslationText(source, {
        displayMathRanges: [{
            from: formulaStart,
            to: formulaStart + '$$E = mc^2$$'.length,
        }],
    });

    assert.equal(protectedText.text.includes('mc^2'), false);
    assert.match(protectedText.text, /Before formula.*After formula/u);
});

test('splits long segments without cutting placeholders', () => {
    const placeholder = '⟦MKTERO_0⟧';
    const segment = {
        id: 'segment-000001',
        kind: 'paragraph',
        headingPath: ['Methods'],
        preparedText: [
            'The first sentence contains enough words for splitting.',
            'The second sentence preserves ' + placeholder + ' exactly.',
            'The final sentence remains intact.',
        ].join(' '),
    };
    const parts = splitTranslationSegment(segment, 70);

    assert.ok(parts.length >= 2);
    assert.equal(parts.filter(part => part.source.includes(placeholder)).length, 1);
    assert.equal(parts.some(part => part.source.endsWith('⟦MKTERO_0')), false);
});

test('batches chunks by paragraph count and character budget', () => {
    const segments = Array.from({ length: 3 }, (_, index) => ({
        id: 'segment-' + String(index + 1).padStart(6, '0'),
        kind: 'paragraph',
        headingPath: [],
        preparedText: 'English segment ' + (index + 1) + '.',
    }));
    const { batches, chunks } = createTranslationBatches(segments, {
        ...SERVICE,
        maxParagraphsPerRequest: 2,
        maxCharactersPerRequest: 500,
    });

    assert.equal(chunks.length, 3);
    assert.deepEqual(batches.map(batch => batch.length), [2, 1]);
});

test('builds the immutable JSON protocol after the editable prompt', () => {
    const body = createTranslationRequest({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate into {{targetLanguage}}.',
        documentTitle: 'Paper title',
        segments: [{
            id: 'segment-000001',
            kind: 'paragraph',
            headingPath: ['Methods'],
            source: 'Source text.',
        }],
    });

    assert.equal(body.model, 'academic-model');
    assert.equal(body.temperature, 0.2);
    assert.match(body.messages[0].content, /Translate into zh-CN/u);
    assert.match(body.messages[0].content, /untrusted data/u);
    assert.equal(JSON.parse(body.messages[1].content).documentTitle, 'Paper title');
});

test('rejects missing, duplicate, and reordered model output', () => {
    const expected = [
        { id: 'segment-000001', source: 'One.' },
        { id: 'segment-000002', source: 'Two.' },
    ];
    const valid = parseTranslationOutput(JSON.stringify({
        translations: [
            { id: 'segment-000001', text: '一。' },
            { id: 'segment-000002', text: '二。' },
        ],
    }), expected);
    assert.deepEqual([...valid], [
        ['segment-000001', '一。'],
        ['segment-000002', '二。'],
    ]);
    for (const translations of [
        [{ id: 'segment-000001', text: '一。' }],
        [
            { id: 'segment-000002', text: '二。' },
            { id: 'segment-000001', text: '一。' },
        ],
        [
            { id: 'segment-000001', text: '一。' },
            { id: 'segment-000001', text: '重复。' },
        ],
    ]) {
        assert.throws(
            () => parseTranslationOutput(
                JSON.stringify({ translations }),
                expected
            ),
            error => error.code === 'TRANSLATION_PROTOCOL_INVALID'
        );
    }
});

test('excludes secrets, service names, and QPS from the cache profile', () => {
    const profile = translationProfileDescriptor({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Academic prompt',
    });

    assert.equal('apiKey' in profile, false);
    assert.equal('name' in profile, false);
    assert.equal('maxRequestsPerSecond' in profile, false);
    assert.equal(profile.model, SERVICE.model);
    assert.equal(profile.segmentationVersion, 3);
    assert.match(profile.protocolPrompt, /untrusted data/u);
});
