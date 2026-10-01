import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
    citationKeyFromExtra,
    createObsidianCollisionDirectoryName,
    createObsidianDocumentMetadata,
    createObsidianNote,
    createObsidianVersionFileStem,
    decideObsidianOverwrite,
    normalizeObsidianSubdirectory,
    parseObsidianNote,
    resolveObsidianOutputRoot,
    separateObsidianImageCaptions,
} from '../src/markdown/obsidian-note.js';

const exportedAt = new Date('2026-09-28T02:40:00.000Z');

test('writes Zotero identity into Obsidian frontmatter without inventing a citekey', () => {
    const metadata = createObsidianDocumentMetadata({
        libraryID: 1,
        itemKey: 'ABCD2345',
        attachmentKey: 'PDFKEY12',
        title: 'Attention: "All" You Need',
        creators: [
            {
                creatorType: 'author',
                firstName: 'Ashish',
                lastName: 'Vaswani',
            },
            { creatorType: 'editor', firstName: 'Editor', lastName: 'Only' },
        ],
        date: '2017-06-12',
        doi: '10.48550/arXiv.1706.03762',
        extra: 'Publisher: arXiv',
        tags: ['transformer'],
        provider: 'mineru',
        view: 'original',
        exportedAt,
    });
    const note = createObsidianNote(metadata, '# Attention\n');

    assert.equal(citationKeyFromExtra('Publisher: arXiv'), '');
    assert.match(note, /title: "Attention: \\"All\\" You Need"/);
    assert.match(note, /authors:\n {2}- "Ashish Vaswani"/);
    assert.doesNotMatch(note, /Editor Only/);
    assert.match(note, /year: 2017/);
    assert.match(note, /doi: "10\.48550\/arXiv\.1706\.03762"/);
    assert.doesNotMatch(note, /citekey:/);
    assert.match(note, /zotero: "zotero:\/\/select\/library\/items\/ABCD2345"/);
    assert.match(note, /mktero-item: "ABCD2345"/);
    assert.match(note, /mktero-provider: "mineru"/);
    assert.match(note, /mktero-view: "original"/);
    assert.equal(parseObsidianNote(note).body, '# Attention\n');
});

test('keeps an existing Better BibTeX citation key and a group select URI', () => {
    const metadata = createObsidianDocumentMetadata({
        libraryID: 4,
        libraryType: 'group',
        groupID: 42,
        itemKey: 'ABCD2345',
        attachmentKey: 'PDFKEY12',
        title: 'Paper',
        extra: 'Citation Key: vaswani2017attention',
        provider: 'mistral',
        view: 'zh-CN',
        exportedAt,
    });

    assert.equal(
        metadata.citekey,
        'vaswani2017attention'
    );
    assert.equal(
        metadata.zotero,
        'zotero://select/groups/42/items/ABCD2345'
    );
    assert.equal(metadata.year, 0);
    assert.doesNotMatch(createObsidianNote(metadata, ''), /^year:/m);
});

test('asks before overwriting a hand-edited or unrelated note', () => {
    const identity = { library: '1', item: 'ABCD2345' };

    assert.equal(decideObsidianOverwrite({
        existing: null,
        identity,
        nextBodyHash: 'next',
    }), 'write');
    assert.equal(decideObsidianOverwrite({
        existing: { ...identity, bodyHash: 'previous' },
        identity,
        previousBodyHash: 'previous',
        nextBodyHash: 'next',
    }), 'write');
    assert.equal(decideObsidianOverwrite({
        existing: { ...identity, bodyHash: 'hand-edit' },
        identity,
        previousBodyHash: 'previous',
        nextBodyHash: 'next',
    }), 'confirm');
    assert.equal(decideObsidianOverwrite({
        existing: { library: '1', item: 'OTHERKEY', bodyHash: 'previous' },
        identity,
        previousBodyHash: 'previous',
        nextBodyHash: 'next',
    }), 'confirm');
});

test('rejects a vault subfolder that can escape the vault', () => {
    assert.equal(normalizeObsidianSubdirectory(''), 'Mktero');
    assert.equal(normalizeObsidianSubdirectory('Papers'), 'Papers');
    assert.throws(
        () => normalizeObsidianSubdirectory('../outside'),
        /folder name is invalid/
    );
    assert.throws(
        () => resolveObsidianOutputRoot('/vault', '..', path.posix.join),
        /folder name is invalid/
    );
    assert.deepEqual(
        resolveObsidianOutputRoot('/vault', 'Papers', path.posix.join),
        { subdirectory: 'Papers', outputRoot: '/vault/Papers' }
    );
});

test('moves figure captions out of image alt text so Obsidian can render them', () => {
    const markdown = [
        'Before ![FIG. 1: Ref. \\[13\\] and (linear).](assets/generated/figures/fig.png) after',
        '',
        '```',
        '![not an image](assets/skip.png)',
        '```',
        '',
        '![](assets/images/plain.jpg)',
        '',
    ].join('\n');

    const separated = separateObsidianImageCaptions(markdown);

    assert.match(
        separated,
        /Before !\[\]\(assets\/generated\/figures\/fig\.png\) after\n\nFIG\. 1: Ref\. \[13\] and \(linear\)\./
    );
    assert.match(separated, /```\n!\[not an image\]\(assets\/skip\.png\)\n```/);
    assert.match(separated, /!\[\]\(assets\/images\/plain\.jpg\)/);
    assert.doesNotMatch(separated, /!\[FIG/);
});

test('names each saved translation without changing the original note name', () => {
    assert.equal(createObsidianVersionFileStem('AAAAAAAAA', 'original'), 'AAAAAAAAA');
    assert.equal(
        createObsidianVersionFileStem('AAAAAAAAA', 'zh-CN'),
        'AAAAAAAAA - chinese'
    );
    assert.equal(
        createObsidianVersionFileStem('AAAAAAAAA', 'ja-JP'),
        'AAAAAAAAA - japanese'
    );
    assert.throws(
        () => createObsidianVersionFileStem('AAAAAAAAA', 'compare'),
        /language is invalid/
    );
});

test('suffixes only the colliding paper directory with the Zotero item key', () => {
    assert.equal(
        createObsidianCollisionDirectoryName('Paper', 'ABCD2345', 'document'),
        'Paper ABCD2345'
    );
});
