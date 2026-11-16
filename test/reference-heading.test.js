import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EPUB_REFERENCE_HEADING_PATTERN,
    MINERU_REFERENCE_HEADING_PATTERN,
    REFERENCE_HEADING_LABEL_PATTERN,
    REFERENCE_HEADING_LINE_PATTERN,
} from '../src/markdown/reference-heading.js';

// Each consumer sees a heading in a different shape and has always accepted a
// slightly different vocabulary, so the shared vocabulary is composed into
// four patterns. These tests pin what each one accepts. The differences
// between them are listed, not smoothed over: widening one site's vocabulary
// must stay a deliberate edit at that site.

test('matches a bare reference label', () => {
    for (const label of [
        'References',
        'Reference',
        'REFERENCES',
        'References:',
        'References：',
        'References.',
        'References and notes',
        'REFERENCES AND NOTES',
        'References and Notes:',
        'Reference list',
        'Bibliography',
        'Works cited',
        'Literature cited',
        '参考文献',
        '参考资料',
        '参考书目',
        '引用文献',
        '6. References',
        '6 References',
        '6) References',
        '6.1.2 References',
        'VI. REFERENCES',
        'IV References',
        'XI. Bibliography',
        '1. 参考文献',
        '10 References',
        '12. Literature Cited',
        'Works  cited',
        'Reference  list',
    ]) {
        assert.equal(
            REFERENCE_HEADING_LABEL_PATTERN.test(label),
            true,
            label
        );
    }
});

test('does not match wording that continues past a reference label', () => {
    for (const label of [
        'References and Further Reading',
        'Reference Lists',
        'Cited works',
        'Ref',
        'Refs',
        '文献参考',
        '参考文献与注释',
        '1. 參考文獻',
        'Bibliographie',
        'Literaturverzeichnis',
        'Methods',
        'Acknowledgements',
        'Appendix',
        '',
        ' ',
        'References  ',
        '  References',
        'References\t',
        '6.References',
    ]) {
        assert.equal(
            REFERENCE_HEADING_LABEL_PATTERN.test(label),
            false,
            label
        );
    }
});

test('captures the ATX heading level of a reference line', () => {
    const level = line => [...line.matchAll(
        new RegExp(REFERENCE_HEADING_LINE_PATTERN)
    )].at(-1)?.[1]?.length ?? null;

    assert.equal(level('## References'), 2);
    assert.equal(level('# References'), 1);
    assert.equal(level('### 6. References'), 3);
    assert.equal(level('## **References**'), 2);
    assert.equal(level('## References ##'), 2);
    // A Setext heading carries no `#` run, so the parser falls back to its
    // deepest level; the line still matches.
    assert.equal(level('References\n----------'), null);
});

test('finds every reference line in a document', () => {
    const count = markdown => [...markdown.matchAll(
        new RegExp(REFERENCE_HEADING_LINE_PATTERN)
    )].length;

    assert.equal(count([
        '# A',
        '',
        '## References',
        '',
        '[1] X',
        '',
        '## Methods',
        '',
        'Y',
    ].join('\n')), 1);
    assert.equal(count('## References\n\n1. A\n\n## References\n\n2. B'), 2);
});

test('keeps the MinerU plain-text vocabulary narrow', () => {
    for (const text of [
        'References',
        'REFERENCES',
        'Reference',
        'Bibliography',
        'Literature cited',
        'Works cited',
        'Reference list',
        '参考文献',
        '6. References',
        'VI References',
        'XI. Bibliography',
        '1. 参考文献',
        '12. Literature Cited',
    ]) {
        assert.equal(
            MINERU_REFERENCE_HEADING_PATTERN.test(text),
            true,
            text
        );
    }
    // The document IR has never accepted these, and still does not.
    for (const text of [
        'References and notes',
        '参考资料',
        '参考书目',
        '引用文献',
        'References:',
        'References.',
        'References  ',
        '  References',
        'Works  cited',
    ]) {
        assert.equal(
            MINERU_REFERENCE_HEADING_PATTERN.test(text),
            false,
            text
        );
    }
});

test('keeps the EPUB plain-text vocabulary narrow', () => {
    for (const text of [
        'References',
        'Bibliography',
        'Works cited',
        'Works  cited',
        'Literature cited',
        'Literature  cited',
        '参考文献',
        '引用文献',
    ]) {
        assert.equal(
            EPUB_REFERENCE_HEADING_PATTERN.test(text),
            true,
            text
        );
    }
    // The EPUB exporter has never accepted these, and still does not.
    for (const text of [
        '参考资料',
        '参考书目',
        'Reference list',
        'References and notes',
        'References and Notes:',
        '6. References',
        'References:',
    ]) {
        assert.equal(
            EPUB_REFERENCE_HEADING_PATTERN.test(text),
            false,
            text
        );
    }
});

test('matches the vocabulary in the order the consumers were written for', () => {
    // A reminder that the four sites are not interchangeable: the translation
    // collector accepts "and notes" and a numbered prefix, the MinerU IR
    // accepts neither, and the EPUB exporter accepts 引用文献 but not
    // 参考资料.
    assert.equal(REFERENCE_HEADING_LABEL_PATTERN.test('References and notes'), true);
    assert.equal(MINERU_REFERENCE_HEADING_PATTERN.test('References and notes'), false);
    assert.equal(EPUB_REFERENCE_HEADING_PATTERN.test('References and notes'), false);

    assert.equal(REFERENCE_HEADING_LABEL_PATTERN.test('6. References'), true);
    assert.equal(MINERU_REFERENCE_HEADING_PATTERN.test('6. References'), true);
    assert.equal(EPUB_REFERENCE_HEADING_PATTERN.test('6. References'), false);

    assert.equal(EPUB_REFERENCE_HEADING_PATTERN.test('引用文献'), true);
    assert.equal(EPUB_REFERENCE_HEADING_PATTERN.test('参考资料'), false);
    assert.equal(REFERENCE_HEADING_LABEL_PATTERN.test('参考资料'), true);
});
