import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMarkdownCacheKey } from '../../src/cache/markdown-cache.js';
import { MISTRAL_PARSER_PROFILE_ID } from '../../src/mistral/parser-profile.js';

export const fixturePrefs = {
    'extensions.mktero.conversionProvider': 'mistral',
    'extensions.mktero.cacheEnabled': true,
    'extensions.mktero.aiAutoTranslateSelection': false,
    'extensions.mktero.readerOutlineVisible': true,
    'extensions.mktero.readerOutlineSegment': 'annotations',
    'extensions.mktero.readerNotesVisible': false,
};

export const NOTICE_LINES = [
    'Synthetic distribution notice: this demonstration document contains no private research or personal material.',
    'The repeated page margin is separate from the measured passage and belongs to this generated fixture only.',
    'Readers may inspect the two independent page excerpts while this generic notice stays outside the body.',
    'No publisher names or paper content are reproduced here; every word in this notice is synthetic test data.',
];

export function syntheticPDF(pages, { portrait = false, notice = portrait, illustration = false } = {}) {
    assert.ok(pages.length >= 1);
    const objects = [null, null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const kids = [];
    for (const page of pages) {
        const lines = Array.isArray(page) ? page : [page];
        const baseline = portrait ? 600 : 120;
        let stream = illustration
            ? 'q 0.86 0.91 0.95 rg 40 654 320 96 re f 0.15 0.35 0.55 RG 3 w 56 670 m 120 716 l 184 690 l 248 730 l 344 704 l S Q\n'
            : '';
        for (const [index, text] of lines.entries()) {
            assert.match(text, /^[\x20-\x7e]+$/u);
            const escaped = text.replace(/([\\()])/gu, '\\$1');
            stream += `BT /F1 12 Tf 40 ${baseline - index * 18} Td (${escaped}) Tj ET\n`;
        }
        // Deliberately emitted AFTER the body in content-stream order, while
        // physically occupying the top 5% of each portrait page.
        if (notice) for (const [index, line] of NOTICE_LINES.entries()) {
            stream += `BT /F1 5 Tf 40 ${824 - index * 6} Td (${line}) Tj ET\n`;
        }
        const pageID = objects.length + 1;
        kids.push(`${pageID} 0 R`);
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${portrait ? '600 840' : '900 180'}] `
            + `/Contents ${pageID + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    }
    objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
    let pdf = '%PDF-1.4\n';
    const offsets = objects.map((object, i) => {
        const offset = pdf.length;
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
        return offset;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'ascii');
}

export async function prepareFixtures(run, profile) {
    const fixtures = [];
    for (const [label, noun] of [['retain', 'amber lamp'], ['delete', 'violet dial'], ['retry', 'copper gauge']]) {
        const pages = [`The ${noun} records a stable signal at the end of the first page`,
            `and the ${noun} continues its independent measurement on the second page.`];
        const text = pages.join(' ');
        const markdown = text;
        const portrait = label === 'retain';
        const pdf = syntheticPDF(pages, { portrait });
        const pdfPath = path.join(run, `${label}.pdf`);
        const recoveryPath = path.join(run, `${label}-valid.pdf`);
        const initialPDF = label === 'retry' ? Buffer.from('%PDF-1.4\nSynthetic temporarily damaged PDF fixture.\n', 'ascii') : pdf;
        await writeFile(pdfPath, initialPDF);
        if (label === 'retry') await writeFile(recoveryPath, pdf);
        const cacheKey = await createMarkdownCacheKey(initialPDF, { parserProfile: MISTRAL_PARSER_PROFILE_ID });
        const recoveryCacheKey = await createMarkdownCacheKey(pdf, { parserProfile: MISTRAL_PARSER_PROFILE_ID });
        fixtures.push({ label, pages, text, markdown, pdfPath, cacheKey, recoveryCacheKey, recoveryPath,
            geometry: { width: portrait ? 600 : 900, height: portrait ? 840 : 180, baseline: portrait ? 600 : 120 },
            notice: portrait ? NOTICE_LINES : [],
            comment: `Persisted ${label} comment: page one keeps this text after recoloring and restart.`,
            ...(label === 'retain' ? {
                editedComment: 'Edited after PDF synchronization: only the selected primary highlight receives this replacement comment.',
            } : {}) });
    }
    const captionLines = [
        'Figure 1. The synthetic amber signal rises through independent trials.',
        'Each interval keeps its measured order and a separate reference scale.',
        'A second reading confirms the stable baseline and the final comparison.',
        'All observations belong to this generated diagram and remain traceable.',
    ];
    const caption = captionLines.join(' ');
    const text = caption.slice('Figure 1. '.length);
    const before = 'Before the synthetic figure, this paragraph must stay outside the annotation.';
    const after = 'After the synthetic figure, this paragraph must also stay outside the annotation.';
    const asset = { path: 'images/caption-signal.svg', mimeType: 'image/svg+xml',
        filePath: path.join(run, 'caption-signal.svg'), width: 320, height: 96 };
    await writeFile(asset.filePath, '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="96" viewBox="0 0 320 96">'
        + '<rect width="320" height="96" fill="#dbe8f2"/>'
        + '<path d="M16 80 L80 34 L144 60 L208 20 L304 46" fill="none" stroke="#26598c" stroke-width="3"/></svg>');
    const pdf = syntheticPDF([captionLines], { portrait: true, notice: false, illustration: true });
    const pdfPath = path.join(run, 'caption.pdf');
    await writeFile(pdfPath, pdf);
    const cacheKey = await createMarkdownCacheKey(pdf, { parserProfile: MISTRAL_PARSER_PROFILE_ID });
    fixtures.push({ label: 'caption', pages: [text], text, caption, captionLines, before, after,
        markdown: [before, '', `![${caption}](${asset.path})`, '', after].join('\n'),
        pdfPath, cacheKey, recoveryCacheKey: cacheKey, assets: [asset],
        geometry: { width: 600, height: 840, baseline: 600, lineHeight: 18, lineCount: captionLines.length },
        comment: 'Persisted synthetic caption comment created by a native backward drag in the installed product.' });
    const { MarkdownCache } = await import('../../src/cache/markdown-cache.js');
    const { access, readdir, rename, rm, stat } = await import('node:fs/promises');
    const cache = new MarkdownCache({ rootPath: path.join(profile, 'mktero-cache', 'v1'),
        pathUtils: { ...path, parent: path.dirname, filename: path.basename },
        ioUtils: {
            exists: file => access(file).then(() => true, () => false),
            makeDirectory: dir => mkdir(dir, { recursive: true }),
            readUTF8: file => readFile(file, 'utf8'), read: readFile,
            stat: async file => ({ ...(await stat(file)), type: (await stat(file)).isDirectory() ? 'directory' : 'regular' }),
            getChildren: async dir => (await readdir(dir)).map(name => path.join(dir, name)),
            writeUTF8: async (file, value, { tmpPath }) => { await writeFile(tmpPath, value); await rename(tmpPath, file); },
            write: async (file, value, { tmpPath }) => { await writeFile(tmpPath, value); await rename(tmpPath, file); },
            remove: (file, options) => rm(file, { recursive: options?.recursive, force: true }),
        } });
    for (const fixture of fixtures) {
        const assets = await Promise.all((fixture.assets || []).map(async asset => ({
            path: asset.path, mimeType: asset.mimeType, data: await readFile(asset.filePath),
        })));
        for (const key of new Set([fixture.cacheKey, fixture.recoveryCacheKey])) {
            await cache.put(key, { markdown: fixture.markdown, assets, parserProfile: MISTRAL_PARSER_PROFILE_ID });
            const cached = await cache.get(key);
            assert.equal(cached.markdown, fixture.markdown);
            assert.equal(cached.assets.length, assets.length);
            for (const [index, asset] of assets.entries()) {
                assert.deepEqual(Buffer.from(cached.assets[index].data), asset.data);
            }
        }
    }
    await writeFile(path.join(run, 'fixture-plan.json'), JSON.stringify(fixtures, null, 2));
    return fixtures;
}
