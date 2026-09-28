import test from 'node:test';
import assert from 'node:assert/strict';
import {
    findPublisherCopyrightRanges,
    isPublisherCopyrightGap,
    isPublisherCopyrightParagraph,
} from '../src/markdown/publisher-copyright.js';

const ACM_CLUSTER = [
    'Permission to make digital or hard copies of part or all of this work for personal or classroom use is granted without fee provided that copies are not made or distributed for profit or commercial advantage and that copies bear this notice and the full citation on the first page. Copyrights for third-party components of this work must be honored. For all other uses, contact the owner/author(s).',
    "UIST '23, October 29-November 1, 2023, San Francisco, CA, USA",
    '© 2023 Copyright held by the owner/author(s).',
    'ACM ISBN 979-8-4007-0132-0/23/10.',
    'https://doi.org/10.1145/3586183.3606763',
].join('\n\n');

test('covers an ACM first-page copyright cluster and nothing around it', () => {
    const markdown = `## ABSTRACT\n\nBelievable proxies over the next two\n\n${ACM_CLUSTER}\n\ndays, make new acquaintances.`;
    const ranges = findPublisherCopyrightRanges(markdown);
    assert.equal(ranges.length, 1);
    assert.equal(markdown.slice(ranges[0].from, ranges[0].to), ACM_CLUSTER);
    assert.equal(isPublisherCopyrightGap(`\n\n${ACM_CLUSTER}\n\n`), true);
});

test('accepts a venue line with a curly apostrophe and an en dash', () => {
    const venue = 'UIST ’23, October 29–November 1, 2023, San Francisco, CA, USA';
    const markdown = [
        'Permission to make digital or hard copies of this work.',
        venue,
        '© 2023 Copyright held by the owner/author(s).',
    ].join('\n\n');
    const ranges = findPublisherCopyrightRanges(markdown);
    assert.equal(ranges.length, 1);
    assert.equal(markdown.slice(ranges[0].from, ranges[0].to).includes(venue), true);
});

test('does not hide a venue line, a DOI, or an ACM reference by themselves', () => {
    const reference = 'Joon Sung Park, Joseph C. O\'Brien, Carrie J. Cai, Meredith Ringel Morris, Percy Liang, and Michael S. Bernstein. 2023. Generative Agents: Interactive Simulacra of Human Behavior. In The 36th Annual ACM Symposium on User Interface Software and Technology (UIST \'23), October 29-November 1, 2023, San Francisco, CA, USA. ACM, New York, NY, USA, 22 pages. https://doi.org/10.1145/3586183.3606763';
    const header = 'UIST \'23, October 29-November 1, 2023, San Francisco, CA, USA J.S. Park, J.C. O\'Brien, C.J. Cai, M.R. Morris, P. Liang, M.S. Bernstein';
    const markdown = [
        reference,
        'https://doi.org/10.1145/3586183.3606763',
        header,
    ].join('\n\n');
    assert.deepEqual(findPublisherCopyrightRanges(markdown), []);
    assert.equal(isPublisherCopyrightParagraph(reference), false);
    assert.equal(isPublisherCopyrightParagraph(header), false);
    assert.equal(isPublisherCopyrightGap(`\n\n${reference}\n\n`), false);
});

test('recognizes an IEEE authorized-use notice as a copyright anchor', () => {
    const notice = 'Authorized licensed use limited to: Stanford University. Restrictions apply.';
    assert.equal(isPublisherCopyrightParagraph(notice), true);
    assert.equal(findPublisherCopyrightRanges(`Body.\n\n${notice}\n\nMore body.`).length, 1);
});

test('does not treat a permission phrase inside a sentence as a copyright block', () => {
    const prose = 'The authors discuss permission to make digital or hard copies only as an example.';
    assert.equal(isPublisherCopyrightParagraph(prose), false);
    assert.deepEqual(findPublisherCopyrightRanges(prose), []);
});
