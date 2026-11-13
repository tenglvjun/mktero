import { prepareMinerUResult } from '../mineru/document/prepare.js';
import { extractMinerUResultFromZip } from '../mineru/zip-markdown.js';
import {
    MINERU_COMPATIBLE_CACHE_PROFILE_IDS,
    MINERU_PARSER_PROFILE_ID,
    MINERU_PREVIOUS_PARSER_PROFILE_IDS,
} from '../mineru/parser-profile.js';
import { LEGACY_FIGURE_PROFILES } from '../figures/legacy-figure-profiles.js';
import { MkteroSignInRequiredError } from '../account/account-session.js';
import { SharedMkteroConversion } from '../mktero/shared-conversion.js';
import {
    hostedCacheProfileFor,
    hostedProfilesFor,
    hostedRequestProfileFor,
    isTrustworthyOfflineFailure,
    MKTERO_MODEL_PIPELINE,
    MKTERO_MODEL_VLM,
} from '../mktero/conversion-target.js';

export { MkteroSignInRequiredError };

/**
 * Converts a PDF through the hosted Mktero service.
 *
 * The hosted service decides which MinerU model parses a PDF. That model is
 * part of the cache identity: a pipeline result is never readable through the
 * vlm entry, and the vlm identity is exactly the one this build already ships,
 * so switching models back reuses the retained result instead of converting
 * again. The service's short profile string is only used to validate the target
 * and to derive the local identity; it never becomes a local cache key.
 */
export class MkteroDocumentExtractor {
    constructor({
        zotero,
        conversion,
        getApiBase,
        getAccessToken,
        readFile,
        preparePDFIndex = null,
        onPDFRead = null,
        createCacheKey = null,
        createSourceHash = null,
        readRevision = null,
        cache = null,
        isCacheEnabled = () => false,
        prepareResult = prepareMinerUResult,
        recoverFigures = async result => result,
        resultStore = null,
        createResultKey = null,
        extractStoredResult = extractMinerUResultFromZip,
        assertPageLimit = null,
        onConversionSettled = () => {},
        onCacheError = error => zotero.logError?.(error),
        onPDFIndexError = error => zotero.logError?.(error),
        sharedConversion = null,
        getSharedScope = () => '',
        resolveTarget = null,
    }) {
        if (!zotero) throw new TypeError('A Zotero runtime is required');
        if (!conversion?.convert) {
            throw new TypeError('A Mktero conversion client is required');
        }
        if (typeof getApiBase !== 'function') {
            throw new TypeError('A Mktero API base provider is required');
        }
        if (typeof getAccessToken !== 'function') {
            throw new TypeError('A Mktero access token provider is required');
        }
        if (!readFile) throw new TypeError('A file reader is required');
        this.zotero = zotero;
        this.conversion = conversion;
        this.getApiBase = getApiBase;
        this.getAccessToken = getAccessToken;
        this.readFile = readFile;
        this.onPDFRead = onPDFRead;
        this.preparePDFIndex = preparePDFIndex;
        this.createCacheKey = createCacheKey;
        this.createSourceHash = createSourceHash;
        this.readRevision = readRevision;
        this.cache = cache;
        this.isCacheEnabled = isCacheEnabled;
        this.prepareResult = prepareResult;
        this.recoverFigures = recoverFigures;
        this.resultStore = resultStore?.get && resultStore?.put ? resultStore : null;
        this.createResultKey = typeof createResultKey === 'function' ? createResultKey : null;
        this.extractStoredResult = extractStoredResult;
        if (assertPageLimit !== null && typeof assertPageLimit !== 'function') {
            throw new TypeError('A PDF page limit check must be a function');
        }
        this.assertPageLimit = assertPageLimit;
        this.onConversionSettled = onConversionSettled;
        this.onCacheError = onCacheError;
        this.onPDFIndexError = onPDFIndexError;
        this.getSharedScope = getSharedScope;
        // The client owns the route lookup; injecting it keeps this extractor
        // testable without a service that describes targets.
        this.resolveTarget = resolveTarget
            || (typeof conversion?.resolveTarget === 'function'
                ? options => conversion.resolveTarget(options)
                : null);
        this.sharedConversion = sharedConversion || new SharedMkteroConversion({
            conversion,
            getScope: getSharedScope,
            resultStore: this.resultStore,
            extractStoredResult,
            assertPageLimit,
            onCacheError: error => this.#reportCacheError(error),
            onConversionSettled,
        });
    }

    async extract(itemID, {
        onProgress, signal, forceRefresh = false, assertScope = () => {}, beforeCreate = () => {},
        sharedScope, retainSharedLease = false,
    } = {}) {
        const opened = await this.#openPDF(itemID, signal);
        this.#preparePDFIndex(itemID, opened.fileData, signal);
        const prepared = await this.#prepareCachedRead(opened, {
            itemID,
            signal,
            forceRefresh,
        });
        prepared.assertScope = assertScope;
        try {
            const resolved = await this.#resolveIdentity(opened, prepared, { signal });
            prepared.cachePublication = this.#claimPublication(prepared, resolved);
            return await this.#extractPrepared(itemID, opened, prepared, resolved, {
                onProgress, signal, forceRefresh, assertScope, beforeCreate, sharedScope,
                retainSharedLease,
            });
        }
        finally { prepared.cachePublication?.release(); }
    }

    async #extractPrepared(itemID, opened, prepared, resolved, {
        onProgress, signal, forceRefresh, assertScope, beforeCreate, sharedScope, retainSharedLease,
    }) {
        const cached = await this.#readAnyCachedResult(opened, prepared, resolved, {
            signal,
            onProgress,
            forceRefresh,
        });
        if (cached) return cached;

        const resultKey = await this.#resultKey(
            opened.fileData, prepared.sourceHash, resolved.local, signal
        );
        const scope = sharedScope ?? this.getSharedScope();
        const assertCurrentScope = () => {
            assertScope();
            if (scope !== this.getSharedScope()) {
                throw Object.assign(new Error('The conversion account or provider changed'), {
                    code: 'MKTERO_QUOTA_ACCOUNT_CHANGED',
                });
            }
        };
        const extractor = this;
        const lease = this.sharedConversion.acquire({
            scope, assertScope: assertCurrentScope, beforeCreate,
            apiBase: this.getApiBase(),
            getAccessToken: this.getAccessToken,
            fileName: opened.item.attachmentFilename || `zotero-${itemID}.pdf`,
            fileData: opened.fileData,
            sourceHash: prepared.sourceHash,
            resultKey, cacheEnabled: prepared.cacheEnabled,
            forceRefresh, onProgress, signal,
            target: resolved.target,
            // A job that moved to another model owns a different raw result,
            // so the published key is derived from the target it reports.
            resolveResultKey(converted) {
                const identity = extractor.#convertedIdentity(converted, resolved);
                const key = extractor.#resultKey(
                    opened.fileData, prepared.sourceHash, identity, signal
                );
                return key;
            },
        });
        try {
            const converted = await lease.result;
            prepared.warnings.push(...(converted.warnings || []));
            // The job snapshot is authoritative: a route that moved between
            // resolve and create returns the target it actually parsed with,
            // and that — not the pre-computed one — owns the cache identity.
            const actual = this.#convertedIdentity(converted, resolved);
            const result = await this.#prepareConverted(converted.result, opened.fileData, {
                signal,
                onProgress,
            });
            assertCurrentScope();
            const cacheKey = await this.#cacheKeyFor(opened.fileData, actual, prepared);
            if (cacheKey && prepared.cacheEnabled && lease.canPublish()) {
                await this.#saveCachedResult(
                    cacheKey, result, signal, prepared.warnings, lease.canPublish
                );
            }
            assertCurrentScope();
            const extracted = hostedResult(
                opened.title, result, prepared, cacheKey, actual, converted.origin === 'cache'
            );
            extracted.resumedTask = converted.origin === 'resumed';
            return extracted;
        }
        catch (error) {
            if (error?.code === 'MKTERO_SIGN_IN_REQUIRED') throw new MkteroSignInRequiredError();
            throw error;
        }
        finally {
            // Bootstrap retains through annotations/run completion. Standalone
            // extraction owns its lease only through this local pipeline.
            if (!retainSharedLease || !signal) lease.release();
        }
    }

    async readCached(itemID, { signal, onProgress } = {}) {
        const opened = await this.#openPDF(itemID, signal);
        const prepared = await this.#prepareCachedRead(opened, {
            itemID,
            signal,
            forceRefresh: false,
        });
        prepared.assertScope = () => {};
        try {
            const resolved = await this.#resolveIdentity(opened, prepared, { signal });
            prepared.cachePublication = this.#claimPublication(prepared, resolved);
            return await this.#readCachedPrepared(opened, prepared, resolved, { signal, onProgress });
        }
        finally { prepared.cachePublication?.release(); }
    }

    async #readCachedPrepared(opened, prepared, resolved, { signal, onProgress }) {
        const cached = await this.#readAnyCachedResult(opened, prepared, resolved, {
            signal,
            onProgress,
            forceRefresh: false,
        });
        if (cached || !prepared.cacheEnabled) return cached;
        // A pipeline change leaves no derived entry, but a stored MinerU result
        // can still be read without a network request.
        for (const local of await this.#candidatesFor(opened, prepared, resolved)) {
            const resultKey = await this.#resultKey(
                opened.fileData, prepared.sourceHash, local, signal
            );
            const stored = await this.#readStoredResult(resultKey, signal);
            if (!stored) continue;
            const result = await this.#prepareConverted(stored.result, opened.fileData, {
                signal,
                onProgress,
            });
            const cacheKey = await this.#cacheKeyFor(opened.fileData, local, prepared);
            await this.#saveCachedResult(
                cacheKey, result, signal, prepared.warnings,
                prepared.cachePublication.canPublish
            );
            onProgress?.(100);
            return hostedResult(
                opened.title, result, prepared, cacheKey, local, false
            );
        }
        return null;
    }

    /**
     * Reads a retained entry for the resolved model. When the service could not
     * be reached, a retained entry for either model is readable: the file on
     * disk states which model produced it, so it stays trustworthy. Nothing is
     * read after an authentication, quota, or integrity failure.
     */
    async #readAnyCachedResult(opened, prepared, resolved, options) {
        for (const local of await this.#candidatesFor(opened, prepared, resolved)) {
            const cached = await this.#cachedExtractResult(opened, {
                ...prepared,
                ...local,
            }, options);
            if (!cached) continue;
            if (local.modelVersion) cached.hostedModel = local.modelVersion;
            return cached;
        }
        return null;
    }

    /**
     * Claims the derived-entry write for the identities this run may produce.
     *
     * Online that is the resolved model only. Offline it is both models,
     * because whichever retained entry is read becomes the current one.
     */
    #claimPublication(prepared, resolved) {
        const models = resolved.offline
            ? offlineProfiles(resolved.local.modelVersion).map(identity => identity.modelVersion)
            : [resolved.local.modelVersion];
        const holds = models.map(model => this.sharedConversion.captureCachePublication({
            sourceHash: prepared.sourceHash,
            byteLength: prepared.byteLength,
            signal: prepared.signal,
            model,
        }));
        if (holds.length === 1) return holds[0];
        return {
            canPublish: () => holds.every(hold => hold.canPublish()),
            release: () => {
                for (const hold of holds) hold.release();
            },
        };
    }

    /**
     * The identities a read may use, in order.
     *
     * Online there is exactly one: the model the service reported. Offline the
     * entry must be readable, so both models are candidates; the file on disk
     * still states which model produced it, which is what keeps that read
     * trustworthy when the service cannot be asked.
     */
    async #candidatesFor(opened, prepared, resolved) {
        const identities = resolved.offline
            ? offlineProfiles(resolved.local.modelVersion)
            : [resolved.local];
        const candidates = [];
        for (const identity of identities) {
            const cacheKey = identity.cacheKey
                || await this.#cacheKeyFor(opened.fileData, identity, prepared);
            candidates.push({ ...identity, cacheKey });
        }
        return candidates;
    }

    /**
     * Asks the service which model this PDF follows now.
     *
     * A route answer is authoritative for the local identity. Nothing here
     * guesses a model: without a route lookup a hosted PDF keeps the shipped
     * vlm identity, which is what an older service always produced. The one
     * deliberate exception is an unreachable service, where a retained entry is
     * readable under either model — authentication, quota, and integrity
     * failures are reported instead of reading an unverified entry.
     */
    async #resolveIdentity(opened, prepared, { signal }) {
        const localProfile = profile => ({
            modelVersion: profile,
            cacheProfile: hostedCacheProfileFor(profile),
            requestProfile: hostedRequestProfileFor(profile),
            cacheKey: null,
        });
        if (typeof this.resolveTarget !== 'function' || !prepared.sourceHash) {
            return { target: null, local: localProfile(MKTERO_MODEL_VLM), offline: false };
        }
        let target = null;
        try {
            target = await this.resolveTarget({
                apiBase: this.getApiBase(),
                getAccessToken: this.getAccessToken,
                sourceHash: prepared.sourceHash,
                expectedSize: opened.fileData.byteLength,
                contentType: 'application/pdf',
                signal,
                assertScope: prepared.assertScope,
            });
        }
        catch (error) {
            throwIfAborted(signal);
            // A service that does not describe targets is reported, never
            // assumed to be an old vlm-only deployment: a 404 can also be a
            // proxy or a missing route. Only an unreachable service may read a
            // retained entry, because the file itself says which model wrote it.
            if (!isTrustworthyOfflineFailure(error)) throw error;
            prepared.warnings.push(OFFLINE_WARNING);
            return { target: null, local: localProfile(MKTERO_MODEL_VLM), offline: true };
        }
        throwIfAborted(signal);
        const local = localProfile(target.modelVersion);
        local.cacheKey = await this.#cacheKeyFor(opened.fileData, local, prepared);
        return { target, local, offline: false };
    }

    /**
     * The identity a converted result actually belongs to.
     *
     * The model always comes from a target the client validated: the job
     * snapshot first, the resolved target second. Both name a model whose
     * profile is a pure function of it, so a profile can never be paired with
     * the wrong model. Only a conversion that sent no target at all falls back,
     * and the service pins such a legacy request to vlm itself — it refuses with
     * an upgrade error rather than return a pipeline result.
     */
    #convertedIdentity(converted, resolved) {
        const target = converted?.target || resolved.target;
        const modelVersion = target?.modelVersion || MKTERO_MODEL_VLM;
        const profiles = hostedProfilesFor(modelVersion);
        return { ...profiles, target: target || null, cacheKey: null };
    }

    async #cacheKeyFor(fileData, identity, prepared) {
        if (!this.createCacheKey) return null;
        try {
            const cacheKey = await this.createCacheKey(fileData, {
                parserProfile: identity.cacheProfile,
            });
            return typeof cacheKey === 'string' && cacheKey ? cacheKey : null;
        }
        catch (error) {
            throwIfAborted(prepared.signal);
            this.#reportCacheError(error);
            prepared.warnings.push('The local Markdown cache is unavailable.');
            return null;
        }
    }

    async #prepareConverted(raw, fileData, { signal, onProgress }) {
        const preparedResult = await this.prepareResult(raw, {
            fileData,
            signal,
            onProgress,
        });
        throwIfAborted(signal);
        const result = await this.recoverFigures(preparedResult, {
            fileData,
            signal,
            onProgress,
        });
        throwIfAborted(signal);
        return result;
    }

    async #resultKey(fileData, sourceHash, identity, signal) {
        if (!this.resultStore || !this.createResultKey) return null;
        try {
            const resultKey = await this.createResultKey(fileData, {
                sourceHash,
                requestProfile: identity.requestProfile,
                modelVersion: identity.modelVersion,
            });
            throwIfAborted(signal);
            return typeof resultKey === 'string' && resultKey ? resultKey : null;
        }
        catch (error) {
            throwIfAborted(signal);
            this.#reportCacheError(error);
            return null;
        }
    }

    // The key names the model through its request profile, so an archive
    // stored for one model is never reachable for the other.
    async #readStoredResult(resultKey, signal) {
        if (!resultKey || !this.resultStore) return null;
        try {
            const stored = await this.resultStore.get(resultKey, { signal });
            throwIfAborted(signal);
            if (!stored) return null;
            return {
                result: {
                    ...this.extractStoredResult(stored.archive),
                    ...(stored.extractedPages != null ? { extractedPages: stored.extractedPages } : {}),
                    ...(stored.totalPages != null ? { totalPages: stored.totalPages } : {}),
                },
                origin: 'cache',
                warnings: [],
            };
        }
        catch (error) {
            throwIfAborted(signal);
            if (error?.name === 'AbortError') throw error;
            this.#reportCacheError(error);
            await this.resultStore.delete?.(resultKey).catch(() => {});
            return null;
        }
    }

    async #openPDF(itemID, signal) {
        throwIfAborted(signal);
        const item = await this.zotero.Items.getAsync(itemID);
        if (!item?.isPDFAttachment?.()) {
            throw new Error('Only PDF attachments can be converted');
        }
        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            throw new Error('The local PDF file is unavailable');
        }
        const fileData = await this.readFile(filePath);
        throwIfAborted(signal);
        await this.onPDFRead?.(item, fileData);
        throwIfAborted(signal);
        const title = item.parentItem?.getDisplayTitle?.()
            || item.getDisplayTitle?.()
            || 'Untitled PDF';
        return { item, fileData, title };
    }

    async #prepareCachedRead({ fileData }, { itemID, signal, forceRefresh }) {
        const warnings = [];
        const cacheEnabled = Boolean(this.isCacheEnabled());
        const sourceHash = await readSourceHash(
            this.createSourceHash,
            fileData,
            error => this.#reportCacheError(error)
        );
        return {
            itemID,
            cacheEnabled,
            warnings,
            sourceHash,
            byteLength: fileData.byteLength,
            // cacheKey and the publication claim depend on the resolved model,
            // so both are filled in after #resolveIdentity. Nothing is read
            // before that.
            cacheKey: null,
            cacheProfile: null,
            requestProfile: null,
            modelVersion: null,
            forceRefresh,
            signal,
            assertScope: () => {},
            cachePublication: null,
        };
    }

    async #cachedExtractResult(opened, prepared, { signal, onProgress, forceRefresh }) {
        if (forceRefresh) return null;
        if (prepared.cacheKey && typeof this.readRevision === 'function') {
            const revision = await this.#readRevision({
                itemID: prepared.itemID,
                cacheKey: prepared.cacheKey,
                cacheProfile: prepared.cacheProfile,
                fileData: opened.fileData,
                signal,
            });
            if (revision?.snapshot) {
                onProgress?.(100);
                const result = await this.prepareResult({
                    ...revision.snapshot,
                    userEdited: true,
                }, {
                    fileData: opened.fileData,
                    signal,
                    onProgress,
                });
                return createResult(
                    opened.title,
                    result,
                    true,
                    prepared.warnings,
                    revision.cacheKey,
                    false,
                    prepared.sourceHash,
                    prepared.cacheProfile
                );
            }
        }
        if (!prepared.cacheKey) return null;
        const cached = await this.#readCachedResult({
            cacheKey: prepared.cacheKey,
            fileData: opened.fileData,
            cacheEnabled: prepared.cacheEnabled,
            signal,
            warnings: prepared.warnings,
            onProgress,
            canCommit: prepared.cachePublication.canPublish,
            cacheProfile: prepared.cacheProfile,
        });
        throwIfAborted(signal);
        if (!cached) return null;
        onProgress?.(100);
        return createResult(
            opened.title,
            cached,
            true,
            prepared.warnings,
            prepared.cacheKey,
            false,
            prepared.sourceHash,
            prepared.cacheProfile
        );
    }

    async #readRevision({ itemID, cacheKey, cacheProfile, fileData, signal }) {
        let revision = await this.readRevision({ itemID, cacheKey, signal });
        throwIfAborted(signal);
        if (revision || !this.createCacheKey || cacheProfile !== MINERU_PARSER_PROFILE_ID) {
            return revision ? { snapshot: revision, cacheKey } : null;
        }
        // Historical profiles all requested VLM. Preserve the user's earlier
        // VLM corrections without treating them as a Pipeline document.
        const visited = new Set([cacheKey]);
        for (const parserProfile of [...MINERU_PREVIOUS_PARSER_PROFILE_IDS, LEGACY_FIGURE_PROFILES.mineru]) {
            const legacyKey = await this.createCacheKey(fileData, {
                parserProfile,
            });
            throwIfAborted(signal);
            if (!legacyKey || visited.has(legacyKey)) continue;
            visited.add(legacyKey);
            revision = await this.readRevision({
                itemID,
                cacheKey: legacyKey,
                signal,
            });
            throwIfAborted(signal);
            if (revision) return { snapshot: revision, cacheKey: legacyKey };
        }
        return null;
    }

    // #readCachedResult uses the same local Markdown cache as MinerU. A disabled
    // cache still returns a user-edited entry so corrections are not discarded.
    async #readCachedResult({
        cacheKey,
        fileData,
        cacheEnabled,
        signal,
        warnings,
        onProgress,
        canCommit,
        cacheProfile,
    }) {
        if (!this.cache?.get) return null;
        const cached = await this.#getCachedResult(cacheKey, warnings);
        throwIfAborted(signal);
        if (cached && (cacheEnabled || cached.userEdited)) {
            return this.#finishCachedResult({
                cached,
                cacheKey,
                storedKey: cacheKey,
                fileData,
                cacheEnabled,
                signal,
                warnings,
                onProgress,
                canCommit,
            });
        }
        if (!cacheEnabled || !this.createCacheKey) return null;
        // Only the vlm identity has shipped before model selection. A pipeline
        // entry is never read through a vlm key, and vice versa.
        if (cacheProfile !== MINERU_PARSER_PROFILE_ID) return null;
        const visited = new Set([cacheKey]);
        for (const parserProfile of MINERU_COMPATIBLE_CACHE_PROFILE_IDS) {
            let legacyKey = null;
            try {
                legacyKey = await this.createCacheKey(fileData, { parserProfile });
            }
            catch (error) {
                this.#reportCacheError(error);
                continue;
            }
            throwIfAborted(signal);
            if (!legacyKey || visited.has(legacyKey)) continue;
            visited.add(legacyKey);
            const legacy = await this.#getCachedResult(legacyKey, warnings);
            throwIfAborted(signal);
            if (!legacy) continue;
            return this.#finishCachedResult({
                cached: legacy,
                cacheKey,
                storedKey: legacyKey,
                fileData,
                cacheEnabled,
                signal,
                warnings,
                onProgress,
                canCommit,
            });
        }
        return null;
    }

    async #getCachedResult(cacheKey, warnings) {
        try {
            return await this.cache.get(cacheKey);
        }
        catch (error) {
            if (error?.name === 'AbortError') throw error;
            this.#reportCacheError(error);
            warnings.push('The local Markdown cache could not be read.');
            return null;
        }
    }

    async #finishCachedResult({
        cached,
        cacheKey,
        storedKey,
        fileData,
        cacheEnabled,
        signal,
        warnings,
        onProgress,
        canCommit,
    }) {
        const recovered = await this.recoverFigures(cached, {
            fileData,
            signal,
            onProgress,
        });
        throwIfAborted(signal);
        if (cacheEnabled && (storedKey !== cacheKey || recovered !== cached)) {
            await this.#saveCachedResult(cacheKey, recovered, signal, warnings, canCommit);
        }
        return recovered;
    }

    async #saveCachedResult(cacheKey, result, signal, warnings, canCommit = () => true) {
        if (!this.cache?.put || !canCommit()) return;
        try {
            await this.cache.put(cacheKey, result, { signal, canCommit });
        }
        catch (error) {
            throwIfAborted(signal);
            this.#reportCacheError(error);
            warnings.push('The Markdown result could not be saved to the local cache.');
        }
    }

    #preparePDFIndex(itemID, fileData, signal) {
        if (typeof this.preparePDFIndex !== 'function') return;
        try {
            Promise.resolve(this.preparePDFIndex(itemID, {
                fileData,
                signal,
            })).catch(error => this.#reportPDFIndexError(error));
        }
        catch (error) {
            this.#reportPDFIndexError(error);
        }
    }

    #reportCacheError(error) {
        try {
            this.onCacheError(error);
        }
        catch {
            // Cache diagnostics must not make PDF conversion fail.
        }
    }

    #reportPDFIndexError(error) {
        try {
            this.onPDFIndexError(error);
        }
        catch {
            // PDF index diagnostics must not make conversion fail.
        }
    }
}

function createResult(
    title,
    parsedResult,
    cacheHit,
    warnings = [],
    cacheKey = null,
    resumedTask = false,
    sourceHash = null,
    parserProfile = MINERU_PARSER_PROFILE_ID
) {
    const extracted = {
        kind: 'markdown',
        provider: 'mktero',
        parserProfile,
        title,
        markdown: parsedResult.markdown,
        assets: parsedResult.assets || [],
        assetBasePath: parsedResult.assetBasePath || '',
        extractedPages: parsedResult.extractedPages,
        totalPages: parsedResult.totalPages,
        sourceMap: parsedResult.sourceMap,
        ...(parsedResult.figureMap ? { figureMap: parsedResult.figureMap } : {}),
        warnings,
        cacheHit,
        resumedTask,
    };
    if (cacheKey) extracted.cacheKey = cacheKey;
    if (sourceHash) extracted.sourceHash = sourceHash;
    if (parsedResult.userEdited) extracted.userEdited = true;
    if (Array.isArray(parsedResult.chromeRanges)) {
        extracted.chromeRanges = parsedResult.chromeRanges;
    }
    if (typeof parsedResult.documentStructure === 'string') {
        extracted.documentStructure = parsedResult.documentStructure;
    }
    return extracted;
}

// A hosted result carries the model identity it was actually parsed under, so
// bootstrap can record readiness for that identity and nothing else.
function hostedResult(title, result, prepared, cacheKey, identity, cacheHit) {
    const extracted = createResult(
        title, result, cacheHit, prepared.warnings, cacheKey, false,
        prepared.sourceHash, identity.cacheProfile
    );
    extracted.hostedModel = identity.modelVersion;
    if (identity.target?.routeId) extracted.hostedRouteId = identity.target.routeId;
    return extracted;
}

const OFFLINE_WARNING = 'The Mktero conversion service is unreachable; this paper was read from a retained local copy.';

/** Both model identities, the resolved one first. */
function offlineProfiles(preferred) {
    const order = preferred === MKTERO_MODEL_PIPELINE
        ? [MKTERO_MODEL_PIPELINE, MKTERO_MODEL_VLM]
        : [MKTERO_MODEL_VLM, MKTERO_MODEL_PIPELINE];
    return order.map(modelVersion => ({
        modelVersion,
        cacheProfile: hostedCacheProfileFor(modelVersion),
        requestProfile: hostedRequestProfileFor(modelVersion),
        cacheKey: null,
    }));
}

async function readSourceHash(createSourceHash, fileData, onError) {
    if (typeof createSourceHash !== 'function') return null;
    try {
        const sourceHash = await createSourceHash(fileData);
        return typeof sourceHash === 'string' && sourceHash ? sourceHash : null;
    }
    catch (error) {
        onError(error);
        return null;
    }
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
