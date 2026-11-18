import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMarkdownCacheKey, MarkdownCache } from '../../src/cache/markdown-cache.js';
import { MarkdownTranslationService } from '../../src/ai/markdown-translation-service.js';
import { getAISettings } from '../../src/config/ai-preferences.js';
import {
    collectMarkdownTranslationBlocks, createDocumentTranslationViews,
} from '../../src/markdown/markdown-translation-blocks.js';
import { MISTRAL_PARSER_PROFILE_ID } from '../../src/mistral/parser-profile.js';

export const fixturePrefs = {
    'extensions.mktero.conversionProvider': 'mistral',
    'extensions.mktero.cacheEnabled': true,
    'extensions.mktero.aiProvider': 'custom',
    'extensions.mktero.aiProtocol': 'openai-chat-completions',
    'extensions.mktero.aiApiBase': 'https://sentence-reading.invalid/v1',
    'extensions.mktero.aiModel': 'synthetic-smoke',
    'extensions.mktero.aiReasoning': 'none',
    'extensions.mktero.aiTargetLanguage': 'zh-CN',
    'extensions.mktero.aiAutoTranslateSelection': false,
};

export async function prepareFixtures(run, profile) {
    const cache = new MarkdownCache({
        rootPath: path.join(profile, 'mktero-cache', 'v1'),
        pathUtils: { ...path, parent: path.dirname, filename: path.basename },
        ioUtils: {
            exists: file => access(file).then(() => true, () => false),
            makeDirectory: dir => mkdir(dir, { recursive: true }),
            readUTF8: file => readFile(file, 'utf8'),
            read: readFile,
            stat: async file => ({ ...(await stat(file)), type: (await stat(file)).isDirectory() ? 'directory' : 'regular' }),
            getChildren: async dir => (await readdir(dir)).map(name => path.join(dir, name)),
            writeUTF8: async (file, value, { tmpPath }) => {
                await writeFile(tmpPath, value);
                await rename(tmpPath, file);
            },
            remove: (file, options) => rm(file, { recursive: options?.recursive, force: true }),
        },
    });
    const getSettings = () => getAISettings({ Prefs: { get: key => fixturePrefs[key] } });
    const { provider, protocol, apiBase, model, reasoning, targetLanguage } = getSettings();
    const fixtures = [];
    for (const kind of ['aligned', 'legacy']) {
        const aligned = kind === 'aligned';
        const sentences = aligned
            ? ['The amber lamp is steady.', 'The violet dial is silent.']
            : ['The copper switch is open.', 'The silver gauge is stable.'];
        const units = aligned
            ? ['\u7425\u73c0\u706f\u4fdd\u6301\u7a33\u5b9a\u3002', '\u7d2b\u8272\u8868\u76d8\u6ca1\u6709\u58f0\u97f3\u3002']
            : ['\u94dc\u8d28\u5f00\u5173\u65ad\u5f00\u3002', '\u94f6\u8272\u4eea\u8868\u4fdd\u6301\u7a33\u5b9a\u3002'];
        const markdown = sentences.join(' ');
        const pdf = syntheticPDF(markdown);
        const pdfPath = path.join(run, `${kind}.pdf`);
        await writeFile(pdfPath, pdf);
        const documentKey = await createMarkdownCacheKey(pdf, { parserProfile: MISTRAL_PARSER_PROFILE_ID });
        await cache.put(documentKey, { markdown, assets: [], parserProfile: MISTRAL_PARSER_PROFILE_ID });
        const promptVersion = aligned ? 'mktero-translation-v8' : 'mktero-translation-v7';
        let mockedRequests = 0;
        const service = new MarkdownTranslationService({
            aiGateway: { async generateText({ messages }) {
                assert.ok(aligned, 'Reading the legacy cache must not call the gateway');
                mockedRequests++;
                const [entry] = JSON.parse(messages.at(-1).content);
                assert.deepEqual(entry.units.map(unit => unit.sourceMarkdown), sentences);
                return { text: JSON.stringify([{ id: entry.id, units: entry.units.map(({ id }, i) => ({
                    id, translatedMarkdown: units[i],
                })) }]), model };
            } },
            getSettings: () => ({ ...getSettings(), apiKey: 'synthetic-mock-only', streaming: false }),
            cache,
        });
        if (aligned) {
            const generated = await service.translateDocument({ documentKey, markdown });
            assert.equal(generated.partial, false);
            assert.equal(mockedRequests, 1);
        }
        else {
            const [block] = collectMarkdownTranslationBlocks(markdown);
            const blocks = [{ id: block.id, markdown: units.join('') }];
            const views = createDocumentTranslationViews(markdown, [block], blocks, { targetLanguage });
            const identity = { provider, protocol, apiBase, model, reasoning, targetLanguage, promptVersion };
            const translationKey = createHash('sha256')
                .update(JSON.stringify({ documentKey, source: markdown, ...identity })).digest('hex');
            await cache.putTranslation(documentKey, translationKey, {
                ...views, blocks, sourceBlocks: [{ id: block.id, markdown }],
                settingsIdentity: JSON.stringify(identity), model, targetLanguage, promptVersion,
            });
        }
        const loaded = await service.getCachedDocumentTranslation({ documentKey, markdown, targetLanguage });
        assert.equal(loaded?.promptVersion, promptVersion, `${kind}: cached translation not readable`);
        assert.equal(loaded.translatedMarkdown, units.join(''));
        assert.equal(loaded.blockRanges[0].alignmentUnits?.length ?? 0, aligned ? 2 : 0);
        fixtures.push({ kind, pdfPath, markdown, sentences, units });
    }
    return fixtures;
}

function syntheticPDF(text) {
    const stream = `BT /F1 12 Tf 40 120 Td (${text}) Tj ET\n`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 180] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = objects.map((object, i) => {
        const offset = pdf.length;
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
        return offset;
    });
    const xref = pdf.length;
    pdf += 'xref\n0 6\n0000000000 65535 f \n';
    for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    return Buffer.from(`${pdf}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'ascii');
}
