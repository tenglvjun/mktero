import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractReferenceIdentifiers,
} from '../src/markdown/markdown-reference-identifiers.js';

test('extracts normalized DOI, arXiv, explicit PMID, and PDF URL', () => {
    assert.deepEqual(
        extractReferenceIdentifiers(
            'Doe. Paper title. doi:10.1000/ABC. PMID: 12345678. '
            + 'https://arxiv.org/abs/2401.00001v2 '
            + 'https://example.org/papers/paper.pdf#page=2'
        ),
        {
            doi: '10.1000/abc',
            arxivID: '2401.00001',
            pmid: '12345678',
            pdfURL: 'https://example.org/papers/paper.pdf',
        }
    );
});

test('recognizes Medline IDs and DOI line wrapping from PDF references', () => {
    assert.deepEqual(
        extractReferenceIdentifiers(
            '[doi: 10.1016/\n j.ogc.2014.10.003] [Medline: 25681845]'
        ),
        {
            doi: '10.1016/j.ogc.2014.10.003',
            arxivID: '',
            pmid: '25681845',
            pdfURL: '',
        }
    );
});

test('does not infer PMID from ordinary citation numbers', () => {
    assert.equal(
        extractReferenceIdentifiers(
            'The sample size was [1, 2] in 2020 and pages 123-129.'
        ).pmid,
        ''
    );
});

test('rejects non-PDF and unsafe URL candidates', () => {
    assert.equal(
        extractReferenceIdentifiers(
            'javascript:alert(1) https://example.org/article.html '
            + 'https://example.org/file.pdf?download=1'
        ).pdfURL,
        'https://example.org/file.pdf?download=1'
    );
    assert.equal(
        extractReferenceIdentifiers(
            'https://example.org/download?format=pdf#page=2'
        ).pdfURL,
        'https://example.org/download?format=pdf'
    );
});

test('does not confuse a Markdown link destination with a PDF reference URL', () => {
    assert.equal(
        extractReferenceIdentifiers('[https://e.org/report.pdf](https://e.org/report.pdf)').pdfURL,
        'https://e.org/report.pdf'
    );
});

test('does not truncate an oversized PDF URL into a different target', () => {
    const url = `https://e.org/${'x'.repeat(2_040)}.pdfzzz`;
    assert.equal(extractReferenceIdentifiers(url).pdfURL, '');
});
test('bounds input and returns stable empty fields', () => {
    assert.deepEqual(extractReferenceIdentifiers('x'.repeat(20_000)), {
        doi: '',
        arxivID: '',
        pmid: '',
        pdfURL: '',
    });
});
