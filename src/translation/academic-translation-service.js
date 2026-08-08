import { createTranslationCacheKey } from '../cache/translation-cache.js';
import {
    extractAcademicTranslationSegments,
    restoreAcademicTranslationPlaceholders,
} from './academic-segments.js';
import { createTranslationBatches } from './translation-protocol.js';

const MAX_TRANSLATION_SEGMENTS = 20_000;
const MAX_BATCH_WORKERS = 4;
const MAX_TRANSLATION_TEXT_CHARACTERS = 32 * 1024 * 1024;

export function createEmptyTranslationState() {
    return {
        visible: true,
        status: 'idle',
        profileKey: null,
        targetLanguage: '',
        serviceName: '',
        completed: 0,
        failed: 0,
        total: 0,
        failureCodes: {},
        segments: [],
        error: '',
        errorCode: null,
    };
}

export class AcademicTranslationService {
    constructor({
        client,
        cache,
        createCacheKey = createTranslationCacheKey,
        extractSegments = extractAcademicTranslationSegments,
        onCacheError = () => {},
    }) {
        if (typeof client?.translateBatch !== 'function') {
            throw new TypeError('A translation client is required');
        }
        if (typeof cache?.get !== 'function'
            || typeof cache?.put !== 'function') {
            throw new TypeError('A translation cache is required');
        }
        this.client = client;
        this.cache = cache;
        this.createCacheKey = createCacheKey;
        this.extractSegments = extractSegments;
        this.onCacheError = onCacheError;
    }

    async translate({
        markdown,
        documentTitle,
        configuration,
        force = false,
        signal,
        onUpdate = () => {},
    }) {
        throwIfAborted(signal);
        const source = String(markdown || '');
        const segments = this.extractSegments(source);
        if (segments.length > MAX_TRANSLATION_SEGMENTS) {
            throw translationError(
                'The document contains too many translation segments',
                'TRANSLATION_DOCUMENT_TOO_LARGE'
            );
        }
        const profileKey = await this.createCacheKey(source, configuration);
        const context = {
            profileKey,
            targetLanguage: configuration.targetLanguage,
            serviceName: configuration.service.name,
        };
        const records = new Map();
        emitState(onUpdate, context, records, segments, 'loading-cache');

        if (force) {
            await this.cache.remove?.(profileKey).catch(error => {
                this.onCacheError(error);
            });
        }
        else {
            const cached = await this.cache.get(profileKey).catch(error => {
                this.onCacheError(error);
                return null;
            });
            mergeCachedRecords(records, cached, segments);
        }

        const pending = segments.filter(segment => (
            records.get(segment.id)?.status !== 'complete'
        ));
        if (!pending.length) {
            return emitState(onUpdate, context, records, segments, 'complete');
        }

        emitState(onUpdate, context, records, segments, 'translating');
        const { batches, chunks } = createTranslationBatches(
            pending,
            configuration.service
        );
        const chunksBySegment = groupChunksBySegment(chunks);
        const chunkTranslations = new Map();
        const settledChunks = new Set();
        const chunkErrors = new Map();
        let nextBatch = 0;
        let fatalError = null;
        let persistTail = Promise.resolve();
        const persist = () => {
            const snapshot = cacheSnapshot(context, records, segments);
            persistTail = persistTail.catch(() => {}).then(() => (
                this.cache.put(profileKey, snapshot).catch(error => {
                    this.onCacheError(error);
                })
            ));
            return persistTail;
        };

        const worker = async () => {
            while (!fatalError) {
                throwIfAborted(signal);
                const batchIndex = nextBatch++;
                if (batchIndex >= batches.length) return;
                const batch = batches[batchIndex];
                try {
                    const result = await this.#translateWithProtocolFallback({
                        configuration,
                        documentTitle,
                        batch,
                        signal,
                    });
                    settleBatch(
                        batch,
                        result,
                        settledChunks,
                        chunkTranslations,
                        chunkErrors
                    );
                }
                catch (error) {
                    if (signal?.aborted) throw error;
                    if (isFatalTranslationError(error)) {
                        fatalError = error;
                        return;
                    }
                    settleFailedBatch(batch, error, settledChunks, chunkErrors);
                }
                finalizeSettledSegments({
                    records,
                    pending,
                    chunksBySegment,
                    chunkTranslations,
                    settledChunks,
                    chunkErrors,
                });
                emitState(onUpdate, context, records, segments, 'translating');
                await persist();
            }
        };

        const workerCount = Math.min(MAX_BATCH_WORKERS, batches.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        await persistTail;
        throwIfAborted(signal);
        if (fatalError) throw fatalError;
        const status = countRecords(records, 'complete') === segments.length
            ? 'complete'
            : 'partial';
        const state = emitState(onUpdate, context, records, segments, status);
        await persist();
        return state;
    }

    async #translateWithProtocolFallback({
        configuration,
        documentTitle,
        batch,
        signal,
    }) {
        try {
            const translations = await this.client.translateBatch({
                service: configuration.service,
                targetLanguage: configuration.targetLanguage,
                systemPrompt: configuration.systemPrompt,
                documentTitle,
                segments: batch,
                signal,
            });
            validateBatchPlaceholders(translations, batch);
            return { translations, errors: new Map() };
        }
        catch (error) {
            if (error?.code !== 'TRANSLATION_PROTOCOL_INVALID'
                || batch.length === 1) {
                throw error;
            }
        }

        const translations = new Map();
        const errors = new Map();
        for (const segment of batch) {
            throwIfAborted(signal);
            try {
                const result = await this.client.translateBatch({
                    service: configuration.service,
                    targetLanguage: configuration.targetLanguage,
                    systemPrompt: configuration.systemPrompt,
                    documentTitle,
                    segments: [segment],
                    signal,
                });
                validateBatchPlaceholders(result, [segment]);
                translations.set(segment.id, result.get(segment.id));
            }
            catch (error) {
                if (signal?.aborted || isFatalTranslationError(error)) {
                    throw error;
                }
                errors.set(
                    segment.id,
                    error?.code || 'TRANSLATION_REQUEST_FAILED'
                );
            }
        }
        return { translations, errors };
    }
}

function settleBatch(
    batch,
    result,
    settledChunks,
    chunkTranslations,
    chunkErrors
) {
    for (const chunk of batch) {
        settledChunks.add(chunk.id);
        if (result.translations.has(chunk.id)) {
            chunkTranslations.set(chunk.id, result.translations.get(chunk.id));
        }
        else {
            chunkErrors.set(
                chunk.id,
                result.errors.get(chunk.id) || 'TRANSLATION_REQUEST_FAILED'
            );
        }
    }
}

function settleFailedBatch(batch, error, settledChunks, chunkErrors) {
    for (const chunk of batch) {
        settledChunks.add(chunk.id);
        chunkErrors.set(
            chunk.id,
            error?.code || 'TRANSLATION_REQUEST_FAILED'
        );
    }
}

function mergeCachedRecords(records, cached, segments) {
    if (!cached?.segments) return;
    const expected = new Map(segments.map(segment => [segment.id, segment]));
    for (const record of cached.segments) {
        const segment = expected.get(record.id);
        if (!segment
            || record.sourceHash !== segment.sourceHash
            || record.from !== segment.from
            || record.to !== segment.to
            || !['complete', 'failed'].includes(record.status)) {
            continue;
        }
        if (record.status === 'complete' && !String(record.text || '').trim()) {
            continue;
        }
        records.set(record.id, { ...record });
    }
}

function groupChunksBySegment(chunks) {
    const groups = new Map();
    for (const chunk of chunks) {
        const values = groups.get(chunk.segmentID) || [];
        values.push(chunk);
        groups.set(chunk.segmentID, values);
    }
    return groups;
}

function finalizeSettledSegments({
    records,
    pending,
    chunksBySegment,
    chunkTranslations,
    settledChunks,
    chunkErrors,
}) {
    for (const segment of pending) {
        if (records.get(segment.id)?.status === 'complete') continue;
        const chunks = chunksBySegment.get(segment.id) || [];
        if (!chunks.length
            || !chunks.every(chunk => settledChunks.has(chunk.id))) {
            continue;
        }
        const failedChunk = chunks.find(chunk => chunkErrors.has(chunk.id));
        if (failedChunk) {
            records.set(segment.id, {
                ...cacheRecordBase(segment),
                status: 'failed',
                errorCode: chunkErrors.get(failedChunk.id),
            });
            continue;
        }
        try {
            const translated = chunks
                .slice()
                .sort((left, right) => left.partIndex - right.partIndex)
                .map(chunk => chunkTranslations.get(chunk.id))
                .join(' ');
            records.set(segment.id, {
                ...cacheRecordBase(segment),
                status: 'complete',
                text: restoreAcademicTranslationPlaceholders(
                    translated,
                    segment.placeholders
                ),
            });
        }
        catch (error) {
            records.set(segment.id, {
                ...cacheRecordBase(segment),
                status: 'failed',
                errorCode: error?.code || 'TRANSLATION_PLACEHOLDER_INVALID',
            });
        }
    }
}

function validateBatchPlaceholders(translations, segments) {
    for (const segment of segments) {
        const translated = translations.get(segment.id);
        const expected = placeholderTokens(segment.source);
        const actual = placeholderTokens(translated);
        if (expected.length !== actual.length
            || expected.some((token, index) => token !== actual[index])) {
            throw translationError(
                'The translation changed a protected placeholder',
                'TRANSLATION_PROTOCOL_INVALID'
            );
        }
    }
}

function placeholderTokens(value) {
    const tokens = [];
    for (const match of String(value || '').matchAll(/⟦MKTERO_\d+⟧/gu)) {
        tokens.push(match[0]);
    }
    return tokens.sort();
}

function emitState(onUpdate, context, records, segments, status) {
    const translatedSegments = segments.flatMap(segment => {
        const record = records.get(segment.id);
        return record?.status === 'complete' ? [{
            id: segment.id,
            from: segment.from,
            to: segment.to,
            anchor: segment.anchor,
            kind: segment.kind,
            text: record.text,
            status: 'complete',
        }] : [];
    });
    const translationCharacters = translatedSegments.reduce(
        (total, segment) => total + segment.text.length,
        0
    );
    if (translationCharacters > MAX_TRANSLATION_TEXT_CHARACTERS) {
        throw translationError(
            'The translated document exceeds its size limit',
            'TRANSLATION_DOCUMENT_TOO_LARGE'
        );
    }
    const state = {
        visible: true,
        status,
        profileKey: context.profileKey,
        targetLanguage: context.targetLanguage,
        serviceName: context.serviceName,
        completed: countRecords(records, 'complete'),
        failed: countRecords(records, 'failed'),
        total: segments.length,
        failureCodes: countFailureCodes(records),
        segments: translatedSegments,
        error: '',
        errorCode: null,
    };
    onUpdate(state);
    return state;
}
function cacheSnapshot(context, records, segments) {
    const stored = segments
        .map(segment => records.get(segment.id))
        .filter(record => record?.status === 'complete'
            || record?.status === 'failed');
    return {
        status: countRecords(records, 'complete') === segments.length
            ? 'complete'
            : 'partial',
        targetLanguage: context.targetLanguage,
        serviceName: context.serviceName,
        segments: stored,
    };
}

function cacheRecordBase(segment) {
    return {
        id: segment.id,
        sourceHash: segment.sourceHash,
        from: segment.from,
        to: segment.to,
        kind: segment.kind,
    };
}

function countRecords(records, status) {
    let count = 0;
    for (const record of records.values()) {
        if (record.status === status) count++;
    }
    return count;
}

function countFailureCodes(records) {
    const counts = {};
    for (const record of records.values()) {
        if (record.status !== 'failed') continue;
        const code = String(record.errorCode || 'TRANSLATION_REQUEST_FAILED');
        counts[code] = (counts[code] || 0) + 1;
    }
    return counts;
}

function isFatalTranslationError(error) {
    return error?.code === 'TRANSLATION_AUTHENTICATION_FAILED'
        || error?.code === 'TRANSLATION_INSECURE_TRANSPORT'
        || error?.code === 'TRANSLATION_CONFIGURATION_INVALID'
        || error?.code === 'TRANSLATION_SERVICE_REQUIRED';
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = signal.reason instanceof Error
        ? signal.reason
        : new Error('The translation was cancelled');
    if (!error.code) error.code = 'TRANSLATION_ABORTED';
    throw error;
}

function translationError(message, code) {
    const error = new Error(message);
    error.name = 'TranslationServiceError';
    error.code = code;
    return error;
}
