import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collectMarkdownTranslationBlocks,
    collectMarkdownTranslationSections,
    createMarkdownTranslationBatches,
} from '../src/markdown/markdown-translation-blocks.js';

const CONTINUED = [
    'The energy of a body at rest is given by',
    '$$\nE = mc^2\n$$',
    'where $m$ is its mass and $c$ the speed of light.',
    'A new paragraph that ends.',
    '$$\nx = 1\n$$',
    'Then it ends.',
].join('\n\n');

function batches(markdown, options) {
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const [section] = collectMarkdownTranslationSections(markdown, blocks);
    return { blocks, batches: createMarkdownTranslationBatches(section, options) };
}

test('links a sentence continued after a display equation without merging blocks', () => {
    const blocks = collectMarkdownTranslationBlocks(CONTINUED);
    assert.equal(blocks.length, 6);
    assert.equal(blocks[2].continuesFrom, blocks[0].id);
    assert.equal(blocks[1].continuationOf, blocks[0].id);
    // A closed sentence, or a capitalized start, is not a continuation.
    assert.equal(blocks[5].continuesFrom, undefined);
    assert.equal(blocks[4].continuationOf, undefined);
});

test('keeps a continued sentence in one request and names its start', () => {
    const { blocks, batches: output } = batches(CONTINUED, { maxBlocks: 1, maxSourceTokens: 2_000 });
    const first = JSON.parse(output[0].requestPayload);
    assert.deepEqual(first.map(entry => entry.id), [blocks[0].id, blocks[2].id]);
    assert.equal(first[1].continuesFrom, blocks[0].id);
    assert.equal(first[0].continuesFrom, undefined);
    assert.equal(output.length, 3);
});

test('does not name a continued start that another request carries', () => {
    const long = `${'word '.repeat(400)}is given by`;
    const markdown = [long, '$$\nE = mc^2\n$$', 'where $m$ is the mass.'].join('\n\n');
    const { batches: output } = batches(markdown, { maxBlocks: 8, maxSourceTokens: 50 });
    assert.equal(output.length, 2);
    const second = JSON.parse(output[1].requestPayload);
    assert.equal(second.length, 1);
    assert.equal('continuesFrom' in second[0], false);
});

test('does not continue from an image or across a heading', () => {
    const markdown = [
        '![Fig. 1](images/a.png)',
        '$$\nE = mc^2\n$$',
        'where the image shows it.',
        '## Section',
        '$$\nx\n$$',
        'where nothing precedes.',
    ].join('\n\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    assert.equal(blocks.some(block => block.continuesFrom), false);
});
