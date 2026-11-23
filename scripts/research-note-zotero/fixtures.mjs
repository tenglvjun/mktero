import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMarkdownCacheKey } from '../../src/cache/markdown-cache.js';
import { MISTRAL_PARSER_PROFILE_ID } from '../../src/mistral/parser-profile.js';
import {
    fixturePrefs as sentenceFixturePrefs,
    prepareFixtures as prepareSentenceFixtures,
} from '../sentence-reading-zotero/fixtures.mjs';

export const fixturePrefs = {
    ...sentenceFixturePrefs,
    'extensions.mktero.readerNotesVisible': true,
    'extensions.mktero.readerNotesWidth': 300,
    'extensions.mktero.readerOutlineVisible': true,
    'extensions.mktero.readerOutlineSegment': 'annotations',
};

export async function prepareFixtures(run, profile) {
    // Reuse the existing synthetic PDFs and Mistral Markdown cache. Their
    // translations are local mock output; this harness reads the original view.
    const prepared = await prepareSentenceFixtures(run, profile, { secondPageForUnaligned: true });
    assert.equal(prepared.length, 2);
    const pdfs = await Promise.all(prepared.map(async (fixture, index) => {
        const pdf = await readFile(fixture.pdfPath);
        assert.ok(pdf.subarray(0, 8).toString('ascii').startsWith('%PDF-1.4'));
        assert.ok(pdf.includes(Buffer.from(fixture.markdown, 'ascii')));
        return {
            label: index === 0 ? 'A' : 'B',
            pdfPath: fixture.pdfPath,
            cacheKey: await createMarkdownCacheKey(pdf, { parserProfile: MISTRAL_PARSER_PROFILE_ID }),
            pageIndex: index,
            markdown: fixture.markdown,
            quote: fixture.sentences[0],
            followupQuote: fixture.sentences[1],
        };
    }));
    assert.notEqual(pdfs[0].quote, pdfs[1].quote);
    const fixtures = {
        pdfs,
        note: {
            title: 'Research note isolation fixture: evidence from two PDFs survives a normal application restart',
            seed: 'Synthetic standalone note seed; preserve this paragraph across restart.',
        },
    };
    await writeFile(path.join(run, 'fixture-plan.json'), JSON.stringify(fixtures, null, 2));
    return fixtures;
}
