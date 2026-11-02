import { zipSync } from 'fflate';
import { sha256Hex } from './sha256.js';
import { isValidSourceMapEntry } from './markdown-source-map.js';
import { collectFigureImageNodes, normalizeFigureAssetPath } from '../figures/figure-model.js';
import { throwIfFigureAborted } from '../figures/figure-async.js';
import { inspectLLMCacheEntries, LLMCacheError, LLM_CACHE_LIMITS } from '../mineru/llm-cache-bundle.js';
import { adaptLLMCacheAssets } from '../mineru/llm-cache-assets.js';
import { createLLMCacheIdentity, hashCanonicalLLMEntries, LLM_CACHE_PROVIDER } from '../mineru/llm-cache-profile.js';
import { extractMinerUResultFromZip } from '../mineru/zip-markdown.js';

/** Coordinates an explicit local import; no remote clients enter this boundary. */
export class MinerUCacheImportService {
    constructor({ zotero, source, index, cache, resultStore, readFile,
        countPages, isCacheEnabled, prepareResult, recoverFigures = async result => result,
        openPDF = null, decodeImage = null,
        inspect = inspectLLMCacheEntries, adaptAssets = adaptLLMCacheAssets,
        now = Date.now, hash = sha256Hex } = {}) {
        for (const [name, value] of Object.entries({ readFile, countPages, isCacheEnabled, prepareResult })) {
            if (typeof value !== 'function') throw new TypeError(`An import ${name} adapter is required`);
        }
        if (!zotero || !source?.capture || !source?.verify || !index?.publish
            || !cache?.put || !cache?.get || !resultStore?.put || !resultStore?.get) {
            throw new TypeError('Local import storage and source adapters are required');
        }
        Object.assign(this, { zotero, source, index, cache, resultStore, readFile,
            countPages, isCacheEnabled, prepareResult, recoverFigures, openPDF,
            decodeImage, inspect, adaptAssets, now, hash });
        this.active = new Set();
    }

    probe(attachment, options) {
        return this.source.probeCandidate(attachment, options);
    }

    async importLocal(itemID, { signal, onProgress = () => {} } = {}) {
        if (this.active.has(itemID)) throw new LLMCacheError('LLM_CACHE_BUSY', 'The PDF already has an active import');
        this.active.add(itemID);
        try {
            throwIfFigureAborted(signal);
            if (!this.isCacheEnabled()) throw new LLMCacheError('LLM_CACHE_DISABLED', 'Enable local caching before importing');
            const attachment = await this.zotero.Items.getAsync(itemID);
            const expected = identityOf(attachment);
            const filePath = await attachment.getFilePathAsync();
            if (!filePath) throw new LLMCacheError('LLM_CACHE_UNAVAILABLE', 'The local PDF is unavailable');
            const fileData = await this.readFile(filePath);
            throwIfFigureAborted(signal);
            if (!fileData?.byteLength || fileData.byteLength > LLM_CACHE_LIMITS.maxPDFBytes) {
                throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'The local PDF exceeds the import limit');
            }
            const sourceHash = await this.hash(fileData);
            onProgress(5, { operation: 'import-llm-cache' });
            const snapshot = await this.source.capture(attachment, { signal });
            const totalPages = await this.countPages(fileData, { signal });
            if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
                throw new LLMCacheError('LLM_CACHE_INVALID_STRUCTURE', 'The PDF page count is unavailable');
            }
            const input = this.inspect(snapshot.entries, {
                attachment, pdfPageCount: totalPages, sourceRoot: snapshot.sourceRoot,
            });
            throwIfFigureAborted(signal);
            onProgress(10, { operation: 'import-llm-cache' });
            const adapted = await this.adaptAssets(input, {
                fileData, openPDF: this.openPDF, decodeImage: this.decodeImage, signal,
            });
            const snapshotHash = await hashCanonicalLLMEntries(adapted.entries, { signal });
            const identity = await createLLMCacheIdentity({ fileData, sourceHash, snapshotHash });
            throwIfFigureAborted(signal);
            // The package contains only normalized local input, never provenance paths or the PDF.
            const archive = zipSync(Object.fromEntries(adapted.entries.map(entry => [entry.path, entry.data])), { level: 0 });
            if (archive.byteLength > LLM_CACHE_LIMITS.maxTotalBytes) {
                throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'The normalized import exceeds its archive limit');
            }
            const raw = { ...extractMinerUResultFromZip(archive), totalPages, extractedPages: totalPages };
            const context = { fileData, signal, onProgress: progress => onProgress(progress, { operation: 'import-llm-cache' }) };
            const prepared = await this.prepareResult(raw, context);
            throwIfFigureAborted(signal);
            const result = await this.recoverFigures(prepared, context);
            validateImportedDocument(result, totalPages);
            validateImportedFigureCoverage(adapted, result);
            throwIfFigureAborted(signal);
            await this.source.verify(snapshot, { signal });
            await this.resultStore.put(identity.rawKey, { archive, provider: LLM_CACHE_PROVIDER,
                totalPages, extractedPages: totalPages }, { signal });
            await this.cache.put(identity.cacheKey, result, { signal });
            const [stored, derived] = await Promise.all([
                this.resultStore.get(identity.rawKey, { signal }), this.cache.get(identity.cacheKey),
            ]);
            throwIfFigureAborted(signal);
            if (!stored || !derived) throw new LLMCacheError('LLM_CACHE_STORAGE_FAILED', 'The imported result could not be read back');
            validateImportedDocument(derived, totalPages);
            validateImportedFigureCoverage(adapted, derived);
            await this.source.verify(snapshot, { signal });
            const current = await this.zotero.Items.getAsync(itemID);
            if (JSON.stringify(identityOf(current)) !== JSON.stringify(expected)
                || await current.getFilePathAsync() !== filePath
                || await this.hash(await this.readFile(filePath)) !== sourceHash) {
                throw new LLMCacheError('LLM_CACHE_CHANGED', 'The PDF changed while importing');
            }
            throwIfFigureAborted(signal);
            if (!this.isCacheEnabled()) throw new LLMCacheError('LLM_CACHE_DISABLED', 'Local caching was disabled while importing');
            // The explicit menu command binds this source; keep the existing index format.
            await this.index.publish({
                libraryID: expected.libraryID, attachmentKey: expected.key,
                sourceHash, snapshotHash, rawKey: identity.rawKey,
                adapterVersion: identity.adapterVersion, importedAt: this.now(),
                sourceFormat: input.sourceFormat, binding: 'user-confirmed',
            }, { signal });
            onProgress(100, { operation: 'import-llm-cache' });
            return { ...result, ...identity, itemID, kind: 'markdown',
                title: attachment.getDisplayTitle?.() || attachment.attachmentFilename || 'PDF',
                totalPages, extractedPages: totalPages, cacheHit: true,
                warnings: [...new Set([...(result.warnings || []), ...(adapted.warnings || [])])],
            };
        }
        catch (error) {
            if (signal?.aborted || error?.name === 'AbortError'
                || typeof error?.code === 'string' && error.code.startsWith('LLM_CACHE_')) {
                throw error;
            }
            const failure = new LLMCacheError('LLM_CACHE_IMPORT_FAILED', 'The local cache import failed');
            failure.cause = error;
            throw failure;
        }
        finally {
            this.active.delete(itemID);
        }
    }
}

export function validateImportedDocument(result, totalPages) {
    if (typeof result?.markdown !== 'string' || !result.markdown.trim()
        || !Array.isArray(result.sourceMap) || !result.sourceMap.length
        || result.sourceMap.some(entry => !isValidSourceMapEntry(entry, result.markdown.length)
            || entry.locations.some(location => location.pageIndex >= totalPages))) {
        throw new LLMCacheError('LLM_CACHE_INVALID_DOCUMENT', 'The imported document has no usable source mapping');
    }
    const paths = new Set((result.assets || []).map(asset => normalizeFigureAssetPath(asset.path)));
    for (const image of collectFigureImageNodes(result.markdown)) {
        const path = normalizeFigureAssetPath(image.assetPath, result.assetBasePath || '');
        if (!paths.has(path)) throw new LLMCacheError('LLM_CACHE_MISSING_IMAGE', 'The imported document has a missing image');
    }
}

export function validateImportedFigureCoverage(input, result) {
    const rendered = new Set(collectFigureImageNodes(result.markdown).map(image => (
        normalizeFigureAssetPath(image.assetPath, result.assetBasePath || '')
    )));
    const referenced = new Set(rendered);
    for (const figure of result.figureMap?.figures || []) {
        const target = figure.render?.assetPath;
        if (!target || !rendered.has(normalizeFigureAssetPath(target, result.assetBasePath || ''))) continue;
        for (const panel of figure.panels || []) {
            if (panel.originalAssetPath) referenced.add(normalizeFigureAssetPath(panel.originalAssetPath, input.assetBasePath || ''));
        }
    }
    const required = new Set(input.coverage.filter(record => record.required).map(record => (
        record.path ? normalizeFigureAssetPath(record.path, input.assetBasePath || '') : null
    )));
    for (const path of required) {
        if (!path || !referenced.has(path)) {
            throw new LLMCacheError('LLM_CACHE_MISSING_IMAGE', 'An input figure was lost during document preparation');
        }
    }
}

function identityOf(attachment) {
    if (!Number.isSafeInteger(attachment?.id) || attachment.id < 1 || attachment.deleted
        || !attachment.isPDFAttachment?.() || !Number.isSafeInteger(attachment.libraryID)
        || typeof attachment.key !== 'string' || !attachment.key) {
        throw new LLMCacheError('LLM_CACHE_INVALID_ATTACHMENT', 'A current PDF attachment is required');
    }
    return { id: attachment.id, key: attachment.key, libraryID: attachment.libraryID };
}
