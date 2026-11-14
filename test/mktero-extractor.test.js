import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MkteroDocumentExtractor,
    MkteroSignInRequiredError,
} from '../src/extractors/mktero-extractor.js';
import {
    MINERU_PARSER_PROFILE_ID, MINERU_PREVIOUS_PARSER_PROFILE_IDS,
    MINERU_PIPELINE_PREVIOUS_PARSER_PROFILE_IDS,
} from '../src/mineru/parser-profile.js';
import { hostedCacheProfileFor } from '../src/mktero/conversion-target.js';
import { LEGACY_FIGURE_PROFILES } from '../src/figures/legacy-figure-profiles.js';

function createPDFItem(overrides = {}) {
    return {
        id: 42,
        parentItem: { getDisplayTitle: () => 'Parent Paper' },
        attachmentFilename: 'paper.pdf',
        isPDFAttachment: () => true,
        getDisplayTitle: () => 'Attachment Title',
        getFilePathAsync: async () => '/tmp/paper.pdf',
        ...overrides,
    };
}

function createExtractor(overrides = {}) {
    return new MkteroDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert() {
                return {
                    result: { markdown: '# Hosted result' },
                    origin: 'network',
                    warnings: [],
                };
            },
        },
        getApiBase: () => 'http://127.0.0.1:8080',
        getAccessToken: () => 'access-token',
        readFile: async () => new Uint8Array([1, 2, 3]),
        ...overrides,
    });
}

test('converts through the hosted service and tags the MinerU profile', async () => {
    const calls = [];
    const fileData = new Uint8Array([1, 2, 3]);
    const extractor = createExtractor({
        conversion: {
            async convert(options) {
                calls.push(options);
                return {
                    result: { markdown: '# Hosted result' },
                    origin: 'network',
                    warnings: [],
                };
            },
        },
        readFile: async path => {
            assert.equal(path, '/tmp/paper.pdf');
            return fileData;
        },
        createCacheKey: async (value, options) => {
            assert.equal(value, fileData);
            assert.equal(options.parserProfile, MINERU_PARSER_PROFILE_ID);
            return 'a'.repeat(64);
        },
        createSourceHash: async () => 'e'.repeat(64),
        isCacheEnabled: () => true,
    });
    const controller = new AbortController();

    const result = await extractor.extract(42, { signal: controller.signal });

    assert.equal(result.provider, 'mktero');
    assert.equal(result.parserProfile, MINERU_PARSER_PROFILE_ID);
    assert.equal(result.title, 'Parent Paper');
    assert.equal(result.markdown, '# Hosted result');
    assert.equal(result.cacheHit, false);
    assert.equal(result.sourceHash, 'e'.repeat(64));
    assert.equal(calls[0].apiBase, 'http://127.0.0.1:8080');
    assert.equal(calls[0].getAccessToken(), 'access-token');
    assert.equal(calls[0].fileName, 'paper.pdf');
    assert.equal(calls[0].fileData, fileData);
});

test('runs the shared figure pipeline on the hosted result', async () => {
    const prepared = [];
    const extractor = createExtractor({
        prepareResult: async (raw, context) => {
            prepared.push(['prepare', raw.markdown, context.signal]);
            return { ...raw, markdown: `${raw.markdown} prepared` };
        },
        recoverFigures: async (result, context) => {
            prepared.push(['figures', result.markdown, context.signal]);
            return { ...result, markdown: `${result.markdown} figures` };
        },
    });
    const controller = new AbortController();

    const result = await extractor.extract(42, { signal: controller.signal });

    assert.equal(result.markdown, '# Hosted result prepared figures');
    assert.deepEqual(prepared.map(entry => entry[0]), ['prepare', 'figures']);
    assert.ok(prepared.every(entry => entry[2] === controller.signal));
});

test('surfaces a signed-out user as a configuration error', async () => {
    const extractor = createExtractor({
        conversion: {
            async convert() {
                const error = new Error('Sign in to Mktero before converting');
                error.code = 'MKTERO_SIGN_IN_REQUIRED';
                throw error;
            },
        },
    });

    await assert.rejects(
        extractor.extract(42, {}),
        error => error instanceof MkteroSignInRequiredError
            && error.code === 'MKTERO_SIGN_IN_REQUIRED'
    );
});

test('reuses a cached conversion without calling the hosted service', async () => {
    let converted = false;
    const extractor = createExtractor({
        conversion: {
            async convert() {
                converted = true;
                return { result: { markdown: 'fresh' }, origin: 'network' };
            },
        },
        createCacheKey: async () => 'a'.repeat(64),
        isCacheEnabled: () => true,
        cache: {
            async get(key) {
                assert.equal(key, 'a'.repeat(64));
                return { markdown: '# Cached' };
            },
            async put() {
                throw new Error('a cache hit must not be written again');
            },
        },
    });

    const result = await extractor.extract(42, {});

    assert.equal(converted, false);
    assert.equal(result.markdown, '# Cached');
    assert.equal(result.cacheHit, true);
    assert.equal(result.cacheKey, 'a'.repeat(64));
});

test('saves a hosted conversion to the local cache', async () => {
    const saved = [];
    const extractor = createExtractor({
        createCacheKey: async () => 'b'.repeat(64),
        isCacheEnabled: () => true,
        cache: {
            async get() {
                return null;
            },
            async put(key, result) {
                saved.push([key, result.markdown]);
            },
        },
        prepareResult: async raw => ({ ...raw, markdown: `${raw.markdown} prepared` }),
        recoverFigures: async result => ({ ...result, markdown: `${result.markdown} figures` }),
    });

    const result = await extractor.extract(42, {});

    assert.equal(result.cacheHit, false);
    assert.deepEqual(saved, [['b'.repeat(64), '# Hosted result prepared figures']]);
});

test('does not read or write the cache when reuse is disabled', async () => {
    let reads = 0;
    let writes = 0;
    const extractor = createExtractor({
        createCacheKey: async () => 'c'.repeat(64),
        isCacheEnabled: () => false,
        cache: {
            async get() {
                reads += 1;
                return { markdown: '# Cached' };
            },
            async put() {
                writes += 1;
            },
        },
    });

    const result = await extractor.extract(42, {});

    assert.equal(result.markdown, '# Hosted result');
    assert.equal(result.cacheHit, false);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
});

test('still opens a user-edited cache entry when reuse is disabled', async () => {
    let converted = false;
    const extractor = createExtractor({
        conversion: {
            async convert() {
                converted = true;
                return { result: { markdown: 'fresh' }, origin: 'network' };
            },
        },
        createCacheKey: async () => 'd'.repeat(64),
        isCacheEnabled: () => false,
        cache: {
            async get() {
                return { markdown: '# Edited locally', userEdited: true };
            },
        },
    });

    const result = await extractor.extract(42, {});

    assert.equal(converted, false);
    assert.equal(result.markdown, '# Edited locally');
    assert.equal(result.cacheHit, true);
});

test('reuses a stored revision without calling the hosted service', async () => {
    let converted = false;
    const extractor = createExtractor({
        conversion: {
            async convert() {
                converted = true;
                return { result: { markdown: 'fresh' }, origin: 'network' };
            },
        },
        createCacheKey: async () => 'a'.repeat(64),
        readRevision: async () => ({ markdown: '# Edited', userEdited: true }),
    });

    const result = await extractor.extract(42, {});

    assert.equal(converted, false);
    assert.equal(result.markdown, '# Edited');
    assert.equal(result.cacheHit, true);
});

test('awaits revision preparation and supplies the open PDF context', async () => {
    let seen;
    const signal = AbortSignal.timeout(60_000);
    const extractor = createExtractor({
        createCacheKey: async () => 'a'.repeat(64),
        readRevision: async () => ({ markdown: '# Edited', userEdited: true }),
        prepareResult: async (result, context) => {
            seen = context;
            await Promise.resolve();
            return { ...result, markdown: '# Prepared' };
        },
    });

    const result = await extractor.extract(42, { signal });

    assert.equal(result.markdown, '# Prepared');
    assert.equal(seen.signal, signal);
    assert.ok(seen.fileData instanceof Uint8Array);
});

test('rejects a non-PDF attachment', async () => {
    const extractor = createExtractor({
        zotero: {
            Items: { getAsync: async () => createPDFItem({ isPDFAttachment: () => false }) },
        },
    });

    await assert.rejects(extractor.extract(42, {}), /Only PDF attachments/);
});

test('readCached returns null without converting when nothing is stored', async () => {
    let conversions = 0;
    let indexed = false;
    const extractor = createExtractor({
        conversion: {
            async convert() { conversions += 1; },
        },
        createCacheKey: async () => 'a'.repeat(64),
        readRevision: async () => null,
        isCacheEnabled: () => true,
        cache: { async get() { return null; } },
        preparePDFIndex() { indexed = true; },
    });

    assert.equal(await extractor.readCached(42, {}), null);
    assert.equal(conversions, 0);
    assert.equal(indexed, false);
});

test('readCached returns a corrected revision without converting', async () => {
    let conversions = 0;
    const extractor = createExtractor({
        conversion: {
            async convert() { conversions += 1; },
        },
        createCacheKey: async () => 'a'.repeat(64),
        readRevision: async () => ({ markdown: '# Corrected' }),
        preparePDFIndex() { assert.fail('PDF index must not be prepared'); },
    });

    const result = await extractor.readCached(42, {});

    assert.equal(conversions, 0);
    assert.equal(result.markdown, '# Corrected');
    assert.equal(result.userEdited, true);
    assert.equal(result.cacheHit, true);
    assert.equal(result.provider, 'mktero');
});

test('readCached returns an existing cache entry without a session', async () => {
    let conversions = 0;
    let tokenReads = 0;
    const extractor = createExtractor({
        conversion: {
            async convert() { conversions += 1; },
        },
        getAccessToken() {
            tokenReads += 1;
            return '';
        },
        createCacheKey: async () => 'a'.repeat(64),
        readRevision: async () => null,
        isCacheEnabled: () => true,
        cache: {
            async get() {
                return { markdown: '# Cached while signed out' };
            },
        },
        preparePDFIndex() { assert.fail('PDF index must not be prepared'); },
    });

    const result = await extractor.readCached(42, {});

    assert.equal(conversions, 0);
    assert.equal(tokenReads, 0);
    assert.equal(result.markdown, '# Cached while signed out');
    assert.equal(result.cacheHit, true);
    assert.equal(result.provider, 'mktero');
});

test('finds a correction made under an earlier MinerU profile', async () => {
    const profiles = [];
    const earlier = MINERU_PREVIOUS_PARSER_PROFILE_IDS[0];
    const extractor = createExtractor({
        conversion: { async convert() { assert.fail('No conversion for a correction'); } },
        createCacheKey: async (_data, { parserProfile }) => {
            profiles.push(parserProfile);
            return parserProfile === earlier ? 'b'.repeat(64) : 'a'.repeat(64) + profiles.length;
        },
        readRevision: async ({ cacheKey }) => cacheKey === 'b'.repeat(64) ? { markdown: '# Corrected earlier' } : null,
        preparePDFIndex() {},
    });

    const result = await extractor.readCached(42, {});

    assert.equal(result.markdown, '# Corrected earlier');
    assert.equal(result.cacheKey, 'b'.repeat(64));
    assert.deepEqual(profiles, [MINERU_PARSER_PROFILE_ID, earlier]);
});

const HOSTED_VLM_PROFILE = hostedCacheProfileFor('vlm');
const HOSTED_PIPELINE_PROFILE = hostedCacheProfileFor('pipeline');
const PIPELINE_SHIPPED_PROFILE = MINERU_PIPELINE_PREVIOUS_PARSER_PROFILE_IDS[0];

/** One distinct 64-character cache key per profile, in the order given. */
function profileKeys(profiles) {
    return new Map(profiles.map((profile, index) => [
        profile,
        (index + 1).toString(16).padStart(2, '0').repeat(32),
    ]));
}

// A hosted extractor that reports a fixed model, records every profile it
// derives a key for, and serves revisions from an explicit table. A profile
// missing from the table yields no key, so consulting it would show up as a
// missing entry rather than an accidental hit.
function createHostedModelExtractor({ model, keys, revisions = {} } = {}) {
    const consultedProfiles = [];
    const reads = [];
    let conversions = 0;
    const extractor = createExtractor({
        conversion: {
            async resolveTarget() {
                return {
                    routeId: 'stable-paper-route',
                    modelVersion: model,
                    parserProfileId: `mineru/v4-batch-${model}-1`,
                };
            },
            async convert() {
                conversions += 1;
                return { result: { markdown: `# Parsed with ${model}` }, origin: 'network' };
            },
        },
        createSourceHash: async () => 'e'.repeat(64),
        createCacheKey: async (_data, { parserProfile }) => {
            consultedProfiles.push(parserProfile);
            return keys.get(parserProfile) || null;
        },
        readRevision: async ({ cacheKey }) => {
            reads.push(cacheKey);
            return revisions[cacheKey] || null;
        },
        isCacheEnabled: () => true,
        cache: { async get() { return null; }, async put() {} },
        preparePDFIndex() {},
    });
    return { extractor, consultedProfiles, reads, conversions: () => conversions };
}

const ALL_HOSTED_KEYS = profileKeys([
    HOSTED_PIPELINE_PROFILE,
    PIPELINE_SHIPPED_PROFILE,
    HOSTED_VLM_PROFILE,
    ...MINERU_PREVIOUS_PARSER_PROFILE_IDS,
    LEGACY_FIGURE_PROFILES.mineru,
]);

for (const [operation, run] of [
    ['extract', extractor => extractor.extract(42)],
    ['readCached', extractor => extractor.readCached(42)],
]) {
    test(`${operation} reaches a Pipeline correction stored under the shipped v19 identity`, async () => {
        const shippedKey = ALL_HOSTED_KEYS.get(PIPELINE_SHIPPED_PROFILE);
        const { extractor, consultedProfiles, reads, conversions } = createHostedModelExtractor({
            model: 'pipeline',
            keys: ALL_HOSTED_KEYS,
            revisions: { [shippedKey]: { markdown: '# Corrected before the bump', userEdited: true } },
        });

        const result = await run(extractor);

        assert.equal(result.markdown, '# Corrected before the bump');
        assert.equal(result.cacheHit, true);
        assert.equal(result.cacheKey, shippedKey);
        assert.equal(result.parserProfile, HOSTED_PIPELINE_PROFILE);
        assert.equal(conversions(), 0);
        assert.deepEqual(consultedProfiles, [HOSTED_PIPELINE_PROFILE, PIPELINE_SHIPPED_PROFILE]);
        assert.deepEqual(reads, [ALL_HOSTED_KEYS.get(HOSTED_PIPELINE_PROFILE), shippedKey]);
    });

    // The Pipeline entry of the fixture is never consulted: a VLM document must
    // not be matched against a differently parsed Pipeline document.
    test(`${operation} keeps a Pipeline correction out of the VLM identity and the reverse`, async () => {
        for (const [model, otherProfiles, otherName] of [
            ['vlm', [HOSTED_PIPELINE_PROFILE, PIPELINE_SHIPPED_PROFILE], 'Pipeline'],
            ['pipeline', [
                HOSTED_VLM_PROFILE,
                ...MINERU_PREVIOUS_PARSER_PROFILE_IDS,
                LEGACY_FIGURE_PROFILES.mineru,
            ], 'VLM'],
        ]) {
            const revisions = {};
            for (const profile of otherProfiles) {
                revisions[ALL_HOSTED_KEYS.get(profile)] = { markdown: '# Other model only' };
            }
            const { extractor, consultedProfiles, reads, conversions } = createHostedModelExtractor({
                model,
                keys: ALL_HOSTED_KEYS,
                revisions,
            });

            const result = await run(extractor);

            if (operation === 'readCached') assert.equal(result, null);
            else {
                assert.equal(result.markdown, `# Parsed with ${model}`);
                assert.equal(result.parserProfile, hostedCacheProfileFor(model));
                assert.equal(conversions(), 1);
            }
            assert.equal(consultedProfiles.includes(HOSTED_PIPELINE_PROFILE), model === 'pipeline');
            for (const otherKey of otherProfiles.map(profile => ALL_HOSTED_KEYS.get(profile))) {
                assert.equal(reads.includes(otherKey), false, `${otherName} history was read for ${model}`);
            }
        }
    });

    test(`${operation} prefers the current Pipeline revision over its earlier identities`, async () => {
        const currentKey = ALL_HOSTED_KEYS.get(HOSTED_PIPELINE_PROFILE);
        const { extractor, consultedProfiles, reads } = createHostedModelExtractor({
            model: 'pipeline',
            keys: ALL_HOSTED_KEYS,
            revisions: {
                [currentKey]: { markdown: '# Corrected on the current identity', userEdited: true },
                [ALL_HOSTED_KEYS.get(PIPELINE_SHIPPED_PROFILE)]: { markdown: '# Corrected before the bump' },
            },
        });

        const result = await run(extractor);

        assert.equal(result.markdown, '# Corrected on the current identity');
        assert.equal(result.cacheKey, currentKey);
        assert.deepEqual(consultedProfiles, [HOSTED_PIPELINE_PROFILE]);
        assert.deepEqual(reads, [currentKey]);
    });
}

test('a Pipeline revision lookup skips an earlier identity that shares its key', async () => {
    const sharedKey = 'a'.repeat(64);
    const reads = [];
    const extractor = createExtractor({
        conversion: {
            async resolveTarget() {
                return {
                    routeId: 'stable-paper-route',
                    modelVersion: 'pipeline',
                    parserProfileId: 'mineru/v4-batch-pipeline-1',
                };
            },
            async convert() { assert.fail('No conversion for a correction'); },
        },
        createSourceHash: async () => 'e'.repeat(64),
        createCacheKey: async () => sharedKey,
        readRevision: async ({ cacheKey }) => {
            reads.push(cacheKey);
            return null;
        },
        isCacheEnabled: () => true,
        cache: { async get() { return null; }, async put() {} },
        preparePDFIndex() {},
    });

    assert.equal(await extractor.readCached(42), null);
    assert.deepEqual(reads, [sharedKey]);
});

test('an aborted Pipeline revision lookup stops before the earlier identity is read', async () => {
    const controller = new AbortController();
    const keys = ALL_HOSTED_KEYS;
    const { extractor, reads, conversions } = createHostedModelExtractor({
        model: 'pipeline',
        keys,
        revisions: {},
    });
    extractor.readRevision = async ({ cacheKey }) => {
        reads.push(cacheKey);
        controller.abort();
        return null;
    };

    await assert.rejects(extractor.extract(42, { signal: controller.signal }), { name: 'AbortError' });

    assert.deepEqual(reads, [keys.get(HOSTED_PIPELINE_PROFILE)]);
    assert.equal(conversions(), 0);
});

function createPageLimitGuard(error = null) {
    const calls = [];
    const guard = async (fileData, options) => {
        calls.push({ fileData, options });
        if (error) throw error;
    };
    guard.calls = calls;
    return guard;
}

function pageLimitError() {
    const error = new Error('The PDF has 201 pages; the conversion service accepts at most 200');
    error.code = 'PDF_PAGE_LIMIT_EXCEEDED';
    return error;
}

test('checks the page limit before uploading to the hosted service', async () => {
    const fileData = new Uint8Array([1, 2, 3]);
    const controller = new AbortController();
    const assertPageLimit = createPageLimitGuard();
    const extractor = createExtractor({
        readFile: async () => fileData,
        assertPageLimit,
    });

    const result = await extractor.extract(42, { signal: controller.signal });

    assert.equal(result.markdown, '# Hosted result');
    assert.equal(assertPageLimit.calls.length, 1);
    assert.equal(assertPageLimit.calls[0].fileData, fileData);
    assert.notEqual(assertPageLimit.calls[0].options.signal, controller.signal);
    assert.equal(assertPageLimit.calls[0].options.signal.aborted, false);
});

test('a PDF over the page limit is not uploaded and no session is read', async () => {
    let converted = false;
    let tokenReads = 0;
    const extractor = createExtractor({
        conversion: {
            async convert() {
                converted = true;
                return { result: { markdown: 'fresh' }, origin: 'network' };
            },
        },
        getAccessToken: () => {
            tokenReads++;
            return 'access-token';
        },
        assertPageLimit: createPageLimitGuard(pageLimitError()),
    });

    await assert.rejects(extractor.extract(42, {}), { code: 'PDF_PAGE_LIMIT_EXCEEDED' });
    assert.equal(converted, false);
    assert.equal(tokenReads, 0);
});

test('cached Markdown, a correction, and a stored result skip the page check', async () => {
    const assertPageLimit = createPageLimitGuard(pageLimitError());
    const noConversion = { async convert() { assert.fail('No hosted conversion was expected'); } };
    const cached = createExtractor({
        conversion: noConversion,
        createCacheKey: async () => 'a'.repeat(64),
        isCacheEnabled: () => true,
        cache: { async get() { return { markdown: '# Cached' }; }, async put() {} },
        assertPageLimit,
    });
    const corrected = createExtractor({
        conversion: noConversion,
        createCacheKey: async () => 'a'.repeat(64),
        readRevision: async () => ({ markdown: '# Edited', userEdited: true }),
        assertPageLimit,
    });
    const stored = createExtractor({
        conversion: noConversion,
        createCacheKey: async () => 'a'.repeat(64),
        createSourceHash: async () => 'e'.repeat(64),
        isCacheEnabled: () => true,
        cache: { async get() { return null; }, async put() {} },
        resultStore: {
            async get() { return { archive: new Uint8Array([9]), totalPages: 250 }; },
            async put() { assert.fail('A stored result is not stored again'); },
        },
        createResultKey: async () => 'r'.repeat(64),
        extractStoredResult: () => ({ markdown: '# Stored' }),
        assertPageLimit,
    });

    assert.equal((await cached.extract(42, {})).markdown, '# Cached');
    assert.equal((await corrected.extract(42, {})).markdown, '# Edited');
    assert.equal((await stored.extract(42, {})).markdown, '# Stored');
    assert.equal(assertPageLimit.calls.length, 0);
});

test('a forced refresh checks the page limit even with cached Markdown', async () => {
    const assertPageLimit = createPageLimitGuard(pageLimitError());
    const extractor = createExtractor({
        conversion: { async convert() { assert.fail('No hosted conversion was expected'); } },
        createCacheKey: async () => 'a'.repeat(64),
        isCacheEnabled: () => true,
        cache: { async get() { return { markdown: '# Cached' }; }, async put() {} },
        assertPageLimit,
    });

    await assert.rejects(extractor.extract(42, { forceRefresh: true }), { code: 'PDF_PAGE_LIMIT_EXCEEDED' });
    assert.equal(assertPageLimit.calls.length, 1);
});

test('readCached never checks the page limit', async () => {
    const assertPageLimit = createPageLimitGuard(pageLimitError());
    const extractor = createExtractor({
        conversion: { async convert() { assert.fail('readCached does not convert'); } },
        assertPageLimit,
    });

    assert.equal(await extractor.readCached(42, {}), null);
    assert.equal(assertPageLimit.calls.length, 0);
});

test('rejects a hosted page limit check that is not a function', () => {
    assert.throws(() => createExtractor({ assertPageLimit: 'yes' }), TypeError);
});

test('a signed-out reader is reported as needing a sign-in, not read offline', async () => {
    const extractor = createExtractor({
        conversion: {
            async convert() { assert.fail('A signed-out reader must not convert'); },
            async resolveTarget({ getAccessToken }) {
                // The real token provider refuses without a stored session.
                await getAccessToken();
            },
        },
        getAccessToken: () => {
            throw new MkteroSignInRequiredError();
        },
        createCacheKey: async () => 'a'.repeat(64),
        createSourceHash: async () => 'e'.repeat(64),
        isCacheEnabled: () => true,
        cache: { async get() { assert.fail('A signed-out reader must not read a retained entry'); } },
    });

    await assert.rejects(
        extractor.readCached(42, {}),
        error => error instanceof MkteroSignInRequiredError
            && error.code === 'MKTERO_SIGN_IN_REQUIRED'
    );
});

test('a resolve transport failure reads a retained entry and says why', async () => {
    const warnings = [];
    const extractor = createExtractor({
        conversion: {
            async convert() { assert.fail('An offline read must not convert'); },
            async resolveTarget() {
                throw Object.assign(new Error('offline'), { code: 'MKTERO_NETWORK_ERROR' });
            },
        },
        createCacheKey: async () => 'a'.repeat(64),
        createSourceHash: async () => 'e'.repeat(64),
        isCacheEnabled: () => true,
        cache: { async get() { return { markdown: '# Retained offline' }; } },
    });

    const result = await extractor.readCached(42, {});
    warnings.push(...result.warnings);

    assert.equal(result.markdown, '# Retained offline');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unreachable/);
});

test('a rejected session is reported even when a retained entry exists', async () => {
    for (const code of ['MKTERO_SIGN_IN_REQUIRED', 'MKTERO_INVALID_TARGET', 'MKTERO_TARGET_MISMATCH']) {
        const extractor = createExtractor({
            conversion: {
                async convert() { assert.fail('A refused session must not convert'); },
                async resolveTarget() { throw Object.assign(new Error('refused'), { code }); },
            },
            createCacheKey: async () => 'a'.repeat(64),
            createSourceHash: async () => 'e'.repeat(64),
            isCacheEnabled: () => true,
            cache: { async get() { return { markdown: '# Unverified' }; } },
        });

        await assert.rejects(extractor.readCached(42, {}), error => error.code === code);
    }
});
