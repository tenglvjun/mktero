import { toUint8Array } from '../mineru/binary.js';
import { MINERU_PARSER_PROFILE_ID } from '../mineru/parser-profile.js';
import {
    isValidSourceLocation,
    isValidSourceMapEntry,
} from '../core/markdown-source-map.js';
import {
    MAX_CHROME_RANGES_BYTES,
    normalizeChromeRanges,
} from '../markdown/chrome-ranges.js';
import { sha256Hex } from '../core/sha256.js';
import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { serializeFigureMap, parseFigureMapJSON } from '../figures/figure-map-serialization.js';
import { throwIfFigureAborted } from '../figures/figure-async.js';

const CACHE_SCHEMA_VERSION = 1;
const METADATA_FILE = 'entry.json';
const MARKDOWN_FILE = 'document.md';
const TRANSLATION_SCHEMA_VERSION = 1;
const MAX_TRANSLATION_VARIANTS = 32;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_SOURCE_MAP_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_SOURCE_LOCATIONS = 100_000;
export const DEFAULT_MAX_TRANSLATION_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MINERU_PARSER_PROFILE = MINERU_PARSER_PROFILE_ID;

export function createZoteroMarkdownCache({ zotero, ioUtils, pathUtils }) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) throw new Error('The Zotero profile directory is unavailable');
    return new MarkdownCache({
        rootPath: pathUtils.join(profilePath, 'mktero-cache', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export async function createMarkdownCacheKey(fileData, {
    crypto = globalThis.crypto,
    parserProfile = DEFAULT_MINERU_PARSER_PROFILE,
} = {}) {
    if (typeof parserProfile !== 'string' || !parserProfile) {
        throw new TypeError('A parser profile is required');
    }
    const sourceHash = await sha256Hex(fileData, { crypto });
    const descriptor = new TextEncoder().encode([
        `cache-schema:${CACHE_SCHEMA_VERSION}`,
        `parser-profile:${parserProfile}`,
        `source-sha256:${sourceHash}`,
    ].join('\n'));
    return sha256Hex(descriptor, { crypto });
}

export async function createMinerUCacheKey(fileData, options = {}) {
    return createMarkdownCacheKey(fileData, {
        ...options,
        parserProfile: options.parserProfile || DEFAULT_MINERU_PARSER_PROFILE,
    });
}

export { sha256Hex };

export class MarkdownCache {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
        maxBytes = DEFAULT_MAX_BYTES,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        maxSourceMapBytes = DEFAULT_MAX_SOURCE_MAP_BYTES,
        maxSourceLocations = DEFAULT_MAX_SOURCE_LOCATIONS,
        maxTranslationBytes = DEFAULT_MAX_TRANSLATION_BYTES,
        maxChromeRangesBytes = MAX_CHROME_RANGES_BYTES,
        maxFigureMapBytes = FIGURE_LIMITS.maxMapBytes,
        hash = sha256Hex,
    }) {
        if (!rootPath) throw new TypeError('A cache root path is required');
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.maxAgeMs = maxAgeMs;
        this.maxSourceMapBytes = maxSourceMapBytes;
        this.maxSourceLocations = maxSourceLocations;
        this.maxTranslationBytes = maxTranslationBytes;
        this.maxChromeRangesBytes = maxChromeRangesBytes;
        this.maxFigureMapBytes = maxFigureMapBytes;
        this.hash = hash;
        this.operationTail = Promise.resolve();
    }

    async get(cacheKey) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.#get(cacheKey));
    }

    async #get(cacheKey) {
        const entryPath = this.#entryPath(cacheKey);
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        if (!(await this.io.exists(metadataPath))) return null;

        try {
            let metadata = JSON.parse(await this.io.readUTF8(metadataPath));
            validateMetadata(
                metadata,
                cacheKey,
                this.maxSourceMapBytes,
                this.maxChromeRangesBytes
            );
            metadata = await this.#repairInvalidTranslationMetadata(
                entryPath,
                metadataPath,
                metadata
            );
            if (this.#isExpired(metadata)) {
                await this.io.remove(entryPath, { recursive: true, ignoreAbsent: true });
                return null;
            }
            const markdownFile = metadata.markdownFile || MARKDOWN_FILE;
            const [markdown, assets, sourceMapJSON, chromeRangesJSON] = await Promise.all([
                this.io.readUTF8(this.path.join(entryPath, markdownFile)),
                Promise.all(metadata.assets.map(async asset => {
                    const data = await this.io.read(
                        this.path.join(entryPath, 'assets', asset.file)
                    );
                    if (data.length !== asset.size) {
                        throw new Error('Cached image size does not match its metadata');
                    }
                    return {
                        path: asset.path,
                        mimeType: asset.mimeType,
                        data,
                    };
                })),
                metadata.sourceMapFile
                    ? this.#readSourceMapJSON(entryPath, metadata)
                    : null,
                metadata.chromeRangesFile
                    ? this.#readChromeRangesJSON(entryPath, metadata)
                    : null,
            ]);
            if (new TextEncoder().encode(markdown).length !== metadata.markdownBytes) {
                throw new Error('Cached Markdown size does not match its metadata');
            }
            let sourceMap;
            if (sourceMapJSON !== null) {
                if (new TextEncoder().encode(sourceMapJSON).length
                    !== metadata.sourceMapBytes) {
                    throw new Error('Cached source map size does not match its metadata');
                }
                sourceMap = JSON.parse(sourceMapJSON);
                validateSourceMap(
                    sourceMap,
                    markdown.length,
                    this.maxSourceLocations
                );
            }
            let chromeRanges;
            if (chromeRangesJSON !== null) {
                try {
                    if (new TextEncoder().encode(chromeRangesJSON).length
                        === metadata.chromeRangesBytes) {
                        const normalized = normalizeChromeRanges(
                            JSON.parse(chromeRangesJSON),
                            markdown.length
                        );
                        if (normalized.length) chromeRanges = normalized;
                    }
                }
                catch {}
            }
            metadata.lastAccessedAt = this.now();
            const figureMap = await this.#readFigureMap(entryPath, metadata, {
                markdown, assets, assetBasePath: metadata.assetBasePath,
            });
            await this.#writeMetadata(metadataPath, metadata).catch(() => {});

            return {
                markdown,
                assets,
                assetBasePath: metadata.assetBasePath,
                extractedPages: metadata.extractedPages,
                totalPages: metadata.totalPages,
                ...(sourceMap ? { sourceMap } : {}),
                ...(chromeRanges ? { chromeRanges } : {}),
                ...(figureMap ? { figureMap } : {}),
                ...(metadata.userEdited ? { userEdited: true } : {}),
            };
        }
        catch {
            await this.io.remove(entryPath, { recursive: true, ignoreAbsent: true })
                .catch(() => {});
            return null;
        }
    }

    async put(cacheKey, result, { allowEmptyMarkdown = false, signal } = {}) {
        throwIfFigureAborted(signal);
        validateCacheKey(cacheKey);
        if (typeof result?.markdown !== 'string'
            || (!allowEmptyMarkdown && !result.markdown.trim())) {
            throw new TypeError('Cached Markdown must be a non-empty string');
        }

        return this.#withOperation(() => this.#put(cacheKey, result, signal));
    }

    getTranslation(cacheKey, translationKey) {
        validateCacheKey(cacheKey);
        validateCacheKey(translationKey);
        return this.#withOperation(() => this.#getTranslation(
            cacheKey,
            translationKey
        ));
    }

    async #getTranslation(cacheKey, translationKey) {
        const entryPath = this.#entryPath(cacheKey);
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        if (!(await this.io.exists(metadataPath))) return null;
        let metadata;
        try {
            metadata = JSON.parse(await this.io.readUTF8(metadataPath));
            validateMetadata(
                metadata,
                cacheKey,
                this.maxSourceMapBytes,
                this.maxChromeRangesBytes
            );
            metadata = await this.#repairInvalidTranslationMetadata(
                entryPath,
                metadataPath,
                metadata
            );
        }
        catch {
            return null;
        }
        const descriptor = (metadata.translations || []).find(candidate => (
            candidate.translationKey === translationKey
        ));
        if (!descriptor) return null;
        try {
            const record = await this.#readTranslationRecord(
                entryPath,
                descriptor
            );
            return translationValue(record);
        }
        catch {
            await this.#removeTranslationReference(
                entryPath,
                metadataPath,
                metadata,
                translationKey
            ).catch(() => {});
            return null;
        }
    }

    getTranslationByLanguage(cacheKey, targetLanguage) {
        validateCacheKey(cacheKey);
        validateTargetLanguage(targetLanguage);
        return this.#withOperation(() => this.#getTranslationByLanguage(
            cacheKey,
            targetLanguage
        ));
    }

    async #getTranslationByLanguage(cacheKey, targetLanguage) {
        const entryPath = this.#entryPath(cacheKey);
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        if (!(await this.io.exists(metadataPath))) return null;
        let metadata;
        try {
            metadata = JSON.parse(await this.io.readUTF8(metadataPath));
            validateMetadata(
                metadata,
                cacheKey,
                this.maxSourceMapBytes,
                this.maxChromeRangesBytes
            );
            metadata = await this.#repairInvalidTranslationMetadata(
                entryPath,
                metadataPath,
                metadata
            );
        }
        catch {
            return null;
        }
        const descriptors = metadata.translations || [];
        let descriptor = null;
        for (let index = descriptors.length - 1; index >= 0; index--) {
            if (descriptors[index].targetLanguage === targetLanguage) {
                descriptor = descriptors[index];
                break;
            }
        }
        if (!descriptor) return null;
        try {
            const record = await this.#readTranslationRecord(
                entryPath,
                descriptor
            );
            return translationValue(record);
        }
        catch {
            await this.#removeTranslationReference(
                entryPath,
                metadataPath,
                metadata,
                descriptor.translationKey
            ).catch(() => {});
            return null;
        }
    }

    putTranslation(cacheKey, translationKey, translation) {
        validateCacheKey(cacheKey);
        validateCacheKey(translationKey);
        validateTranslationValue(translation);
        return this.#withOperation(() => this.#putTranslation(
            cacheKey,
            translationKey,
            translation
        ));
    }

    deleteTranslation(cacheKey) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.#deleteTranslation(cacheKey));
    }

    async #deleteTranslation(cacheKey) {
        const entryPath = this.#entryPath(cacheKey);
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        const metadata = await this.#readMetadata(
            entryPath,
            metadataPath,
            cacheKey
        );
        const translations = metadata?.translations || [];
        if (!translations.length) return false;
        const nextMetadata = withoutTranslationReferences(metadata);
        await this.#writeMetadata(metadataPath, nextMetadata);
        await Promise.all(translations.map(descriptor => this.io.remove(
            this.path.join(entryPath, descriptor.translationFile),
            { ignoreAbsent: true }
        ).catch(() => {})));
        return true;
    }

    async #putTranslation(cacheKey, translationKey, translation) {
        const entryPath = this.#entryPath(cacheKey);
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        const metadata = await this.#readMetadata(
            entryPath,
            metadataPath,
            cacheKey
        );
        if (!metadata) throw new Error('The Markdown cache entry is unavailable');
        const generation = createGenerationID(this.now());
        const translationFile = `translation-${generation}.json`;
        const translationPath = this.path.join(entryPath, translationFile);
        const temporaryPath = `${translationPath}.tmp`;
        const record = {
            schemaVersion: TRANSLATION_SCHEMA_VERSION,
            translationKey,
            ...translationValue(translation),
        };
        const serialized = JSON.stringify(record);
        const translationBytes = new TextEncoder().encode(serialized).length;
        if (translationBytes > this.maxTranslationBytes) {
            throw new Error('Cached translation exceeds the size limit');
        }
        try {
            await this.io.writeUTF8(translationPath, serialized, {
                tmpPath: temporaryPath,
            });
            const previousTranslations = metadata.translations || [];
            const retainedTranslations = previousTranslations
                .filter(descriptor => descriptor.translationKey !== translationKey)
                .slice(-(MAX_TRANSLATION_VARIANTS - 1));
            const translations = [
                ...retainedTranslations,
                {
                    translationFile,
                    translationKey,
                    translationBytes,
                    targetLanguage: translation.targetLanguage,
                },
            ];
            const nextMetadata = {
                ...metadata,
                translations,
                sizeBytes: cachedDocumentSize(metadata)
                    + translations.reduce((total, descriptor) => (
                        total + descriptor.translationBytes
                    ), 0),
                lastAccessedAt: this.now(),
            };
            await this.#writeMetadata(metadataPath, nextMetadata);
            const retainedFiles = new Set(retainedTranslations.map(
                descriptor => descriptor.translationFile
            ));
            await Promise.all(previousTranslations
                .filter(descriptor => !retainedFiles.has(
                    descriptor.translationFile
                ))
                .map(descriptor => this.io.remove(
                    this.path.join(entryPath, descriptor.translationFile),
                    { ignoreAbsent: true }
                ).catch(() => {})));
        }
        catch (error) {
            await Promise.all([translationPath, temporaryPath].map(filePath => (
                this.io.remove(filePath, { ignoreAbsent: true }).catch(() => {})
            )));
            throw error;
        }
        await this.#scan({ removeInvalid: true, enforceLimits: true });
    }

    async #put(cacheKey, result, signal) {
        throwIfFigureAborted(signal);
        const serializedFigureMap = await serializeFigureMap(result.figureMap, result, {
            hash: this.hash, maxBytes: this.maxFigureMapBytes,
        });
        throwIfFigureAborted(signal);
        const entryPath = this.#entryPath(cacheKey);
        const assetsPath = this.path.join(entryPath, 'assets');
        await this.#ensureRoot();
        await this.io.makeDirectory(entryPath, { ignoreExisting: true });
        await this.io.makeDirectory(assetsPath, { ignoreExisting: true });

        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        const previousMetadata = await this.#readMetadata(
            entryPath,
            metadataPath,
            cacheKey
        );
        const generation = createGenerationID(this.now());
        const markdownFile = `document-${generation}.md`;
        const sourceMapFile = `source-map-${generation}.json`;
        const chromeRangesFile = `chrome-ranges-${generation}.json`;
        const figureMapFile = `figure-map-${generation}.json`;
        const writtenPaths = [];
        const temporaryPaths = [];
        const assets = [];
        try {
            for (const [index, asset] of (result.assets || []).entries()) {
                throwIfFigureAborted(signal);
                const file = `${generation}-${String(index).padStart(4, '0')}.bin`;
                const data = toUint8Array(asset.data, 'Cached image');
                const filePath = this.path.join(assetsPath, file);
                const temporaryPath = `${filePath}.tmp`;
                temporaryPaths.push(temporaryPath);
                await this.io.write(filePath, data, { tmpPath: temporaryPath });
                writtenPaths.push(filePath);
                assets.push({
                    file,
                    path: String(asset.path),
                    mimeType: String(asset.mimeType),
                    size: data.length,
                });
            }

            const markdownPath = this.path.join(entryPath, markdownFile);
            const temporaryMarkdownPath = `${markdownPath}.tmp`;
            temporaryPaths.push(temporaryMarkdownPath);
            await this.io.writeUTF8(markdownPath, result.markdown, {
                tmpPath: temporaryMarkdownPath,
            });
            writtenPaths.push(markdownPath);
            const timestamp = this.now();
            const markdownBytes = new TextEncoder().encode(result.markdown).length;
            let sourceMapBytes = 0;
            if (Array.isArray(result.sourceMap)) {
                validateSourceMap(
                    result.sourceMap,
                    result.markdown.length,
                    this.maxSourceLocations
                );
                const sourceMapJSON = JSON.stringify(result.sourceMap);
                sourceMapBytes = new TextEncoder().encode(sourceMapJSON).length;
                if (sourceMapBytes > this.maxSourceMapBytes) {
                    throw new Error('Cached source map exceeds the source map size limit');
                }
                const sourceMapPath = this.path.join(entryPath, sourceMapFile);
                const temporarySourceMapPath = `${sourceMapPath}.tmp`;
                temporaryPaths.push(temporarySourceMapPath);
                await this.io.writeUTF8(sourceMapPath, sourceMapJSON, {
                    tmpPath: temporarySourceMapPath,
                });
                writtenPaths.push(sourceMapPath);
            }
            let chromeRangesBytes = 0;
            let storedChromeRanges = false;
            if (Array.isArray(result.chromeRanges)) {
                const chromeRanges = normalizeChromeRanges(
                    result.chromeRanges,
                    result.markdown.length
                );
                if (chromeRanges.length) {
                    const chromeRangesJSON = JSON.stringify(chromeRanges);
                    chromeRangesBytes = new TextEncoder().encode(chromeRangesJSON).length;
                    if (chromeRangesBytes > this.maxChromeRangesBytes) {
                        throw new Error('Cached chrome ranges exceed the size limit');
                    }
                    const chromeRangesPath = this.path.join(entryPath, chromeRangesFile);
                    const temporaryChromeRangesPath = `${chromeRangesPath}.tmp`;
                    temporaryPaths.push(temporaryChromeRangesPath);
                    await this.io.writeUTF8(chromeRangesPath, chromeRangesJSON, {
                        tmpPath: temporaryChromeRangesPath,
                    });
                    writtenPaths.push(chromeRangesPath);
                    storedChromeRanges = true;
                }
            }
            if (serializedFigureMap) {
                const figureMapPath = this.path.join(entryPath, figureMapFile);
                const temporaryPath = `${figureMapPath}.tmp`;
                temporaryPaths.push(temporaryPath);
                await this.io.writeUTF8(figureMapPath, serializedFigureMap.json, { tmpPath: temporaryPath });
                writtenPaths.push(figureMapPath);
            }
            const metadata = {
                schemaVersion: CACHE_SCHEMA_VERSION,
                cacheKey,
                createdAt: timestamp,
                lastAccessedAt: timestamp,
                markdownFile,
                assetBasePath: String(result.assetBasePath || ''),
                extractedPages: result.extractedPages ?? null,
                totalPages: result.totalPages ?? null,
                markdownBytes,
                sizeBytes: markdownBytes + sourceMapBytes + chromeRangesBytes
                    + (serializedFigureMap?.bytes || 0)
                    + assets.reduce((total, asset) => total + asset.size, 0),
                assets,
            };
            if (Array.isArray(result.sourceMap)) {
                metadata.sourceMapFile = sourceMapFile;
                metadata.sourceMapBytes = sourceMapBytes;
            }
            if (storedChromeRanges) {
                metadata.chromeRangesFile = chromeRangesFile;
                metadata.chromeRangesBytes = chromeRangesBytes;
            }
            if (result.userEdited) metadata.userEdited = true;
            if (serializedFigureMap) {
                metadata.figureMapFile = figureMapFile;
                metadata.figureMapBytes = serializedFigureMap.bytes;
            }
            temporaryPaths.push(`${metadataPath}.tmp`);
            throwIfFigureAborted(signal);
            await this.#writeMetadata(metadataPath, metadata);
            await this.#removeReferencedFiles(entryPath, previousMetadata);
        }
        catch (error) {
            await Promise.all([...writtenPaths, ...temporaryPaths].map(filePath => (
                this.io.remove(filePath, { ignoreAbsent: true }).catch(() => {})
            )));
            throw error;
        }
        await this.#scan({ removeInvalid: true, enforceLimits: true });
    }

    prune() {
        return this.#withOperation(() => this.#scan({
            removeInvalid: true,
            enforceLimits: true,
        }));
    }

    async #scan({ removeInvalid, enforceLimits }) {
        const entriesPath = this.path.join(this.rootPath, 'entries');
        if (!(await this.io.exists(entriesPath))) {
            return { entries: 0, sizeBytes: 0 };
        }

        const now = this.now();
        const entries = [];
        for (const entryPath of await this.io.getChildren(entriesPath)) {
            try {
                if ((await this.io.stat(entryPath)).type !== 'directory') continue;
                const metadata = JSON.parse(
                    await this.io.readUTF8(this.path.join(entryPath, METADATA_FILE))
                );
                const cacheKey = this.path.filename(entryPath);
                validateCacheKey(cacheKey);
                validateMetadata(
                    metadata,
                    cacheKey,
                    this.maxSourceMapBytes,
                    this.maxChromeRangesBytes
                );
                const repairedMetadata = await this.#repairInvalidTranslationMetadata(
                    entryPath,
                    this.path.join(entryPath, METADATA_FILE),
                    metadata,
                    { persist: removeInvalid }
                );
                if (this.#isExpired(repairedMetadata, now)) {
                    if (removeInvalid) {
                        await this.io.remove(entryPath, {
                            recursive: true,
                            ignoreAbsent: true,
                        });
                    }
                    continue;
                }
                entries.push({
                    path: entryPath,
                    lastAccessedAt: repairedMetadata.lastAccessedAt,
                    sizeBytes: repairedMetadata.sizeBytes,
                });
            }
            catch {
                if (removeInvalid) {
                    await this.io.remove(entryPath, { recursive: true, ignoreAbsent: true });
                }
            }
        }

        entries.sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
        let sizeBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
        while (enforceLimits
            && (entries.length > this.maxEntries || sizeBytes > this.maxBytes)) {
            const entry = entries.shift();
            await this.io.remove(entry.path, { recursive: true, ignoreAbsent: true });
            sizeBytes -= entry.sizeBytes;
        }
        return { entries: entries.length, sizeBytes };
    }

    getStats() {
        return this.#withOperation(() => this.#scan({
            removeInvalid: false,
            enforceLimits: false,
        }));
    }

    clear() {
        return this.#withOperation(() => this.#clear());
    }

    async #clear() {
        await this.io.remove(this.rootPath, { recursive: true, ignoreAbsent: true });
        await this.#ensureRoot();
    }

    #entryPath(cacheKey) {
        return this.path.join(this.rootPath, 'entries', cacheKey);
    }

    async #ensureRoot() {
        const parentPath = this.path.parent?.(this.rootPath);
        if (parentPath) {
            await this.io.makeDirectory(parentPath, { ignoreExisting: true });
        }
        await this.io.makeDirectory(this.rootPath, { ignoreExisting: true });
        await this.io.makeDirectory(this.path.join(this.rootPath, 'entries'), {
            ignoreExisting: true,
        });
    }

    #writeMetadata(metadataPath, metadata) {
        return this.io.writeUTF8(metadataPath, JSON.stringify(metadata), {
            tmpPath: `${metadataPath}.tmp`,
        });
    }

    async #readFigureMap(entryPath, metadata, document) {
        if (!validFigureMapFile(metadata.figureMapFile)
            || !Number.isSafeInteger(metadata.figureMapBytes)
            || metadata.figureMapBytes < 1 || metadata.figureMapBytes > this.maxFigureMapBytes) return null;
        try {
            const path = this.path.join(entryPath, metadata.figureMapFile);
            const info = await this.io.stat(path);
            if (info.size !== metadata.figureMapBytes || info.type !== 'regular') return null;
            const json = await this.io.readUTF8(path);
            if (new TextEncoder().encode(json).length !== metadata.figureMapBytes) return null;
            return await parseFigureMapJSON(json, document, { hash: this.hash, maxBytes: this.maxFigureMapBytes });
        }
        catch {
            return null;
        }
    }

    async #readSourceMapJSON(entryPath, metadata) {
        const filePath = this.path.join(entryPath, metadata.sourceMapFile);
        const fileInfo = await this.io.stat(filePath);
        if (!Number.isSafeInteger(fileInfo?.size)
            || fileInfo.size !== metadata.sourceMapBytes
            || fileInfo.size > this.maxSourceMapBytes) {
            throw new Error('Cached source map file size is invalid');
        }
        return this.io.readUTF8(filePath);
    }

    async #readChromeRangesJSON(entryPath, metadata) {
        try {
            const filePath = this.path.join(entryPath, metadata.chromeRangesFile);
            const fileInfo = await this.io.stat(filePath);
            if (!Number.isSafeInteger(fileInfo?.size)
                || fileInfo.size !== metadata.chromeRangesBytes
                || fileInfo.size > this.maxChromeRangesBytes) {
                return null;
            }
            return await this.io.readUTF8(filePath);
        }
        catch {
            return null;
        }
    }

    async #readMetadata(entryPath, metadataPath, cacheKey) {
        if (!(await this.io.exists(metadataPath))) return null;
        try {
            const metadata = JSON.parse(await this.io.readUTF8(metadataPath));
            validateMetadata(
                metadata,
                cacheKey,
                this.maxSourceMapBytes,
                this.maxChromeRangesBytes
            );
            return this.#repairInvalidTranslationMetadata(
                entryPath,
                metadataPath,
                metadata
            );
        }
        catch {
            return null;
        }
    }

    async #repairInvalidTranslationMetadata(
        entryPath,
        metadataPath,
        metadata,
        { persist = true } = {}
    ) {
        const storedTranslations = Array.isArray(metadata.translations)
            ? metadata.translations
            : null;
        const candidates = storedTranslations
            ? storedTranslations.slice(0, MAX_TRANSLATION_VARIANTS)
            : legacyTranslationDescriptor(metadata)
                ? [legacyTranslationDescriptor(metadata)]
                : [];
        const legacy = metadata.translations === undefined
            && hasLegacyTranslationMetadata(metadata);
        const translations = [];
        const rejectedFiles = new Set();
        for (let index = MAX_TRANSLATION_VARIANTS;
            index < (storedTranslations?.length || 0);
            index++) {
            const file = storedTranslations[index]?.translationFile;
            if (isSafeTranslationFile(file)) rejectedFiles.add(file);
        }
        const acceptedFiles = new Set();
        const acceptedKeys = new Set();
        for (const candidate of candidates) {
            let descriptor = candidate;
            if (legacy && isValidTranslationDescriptor(candidate, {
                maxBytes: this.maxTranslationBytes,
                requireTargetLanguage: false,
            })) {
                try {
                    const record = await this.#readTranslationRecord(
                        entryPath,
                        candidate
                    );
                    descriptor = {
                        ...candidate,
                        targetLanguage: record.targetLanguage,
                    };
                }
                catch {
                    descriptor = null;
                }
            }
            const valid = isValidTranslationDescriptor(descriptor, {
                maxBytes: this.maxTranslationBytes,
                requireTargetLanguage: true,
            });
            if (!valid
                || acceptedFiles.has(descriptor.translationFile)
                || acceptedKeys.has(descriptor.translationKey)) {
                if (isSafeTranslationFile(candidate?.translationFile)) {
                    rejectedFiles.add(candidate.translationFile);
                }
                continue;
            }
            translations.push({
                translationFile: descriptor.translationFile,
                translationKey: descriptor.translationKey,
                translationBytes: descriptor.translationBytes,
                targetLanguage: descriptor.targetLanguage,
            });
            acceptedFiles.add(descriptor.translationFile);
            acceptedKeys.add(descriptor.translationKey);
        }
        for (const file of acceptedFiles) rejectedFiles.delete(file);
        const nextMetadata = withTranslationReferences(metadata, translations);
        const changed = JSON.stringify(nextMetadata) !== JSON.stringify(metadata);
        if (!persist || !changed) return nextMetadata;
        await this.#writeMetadata(metadataPath, nextMetadata);
        await Promise.all([...rejectedFiles].map(file => this.io.remove(
            this.path.join(entryPath, file),
            { ignoreAbsent: true }
        ).catch(() => {})));
        return nextMetadata;
    }

    async #removeTranslationReference(
        entryPath,
        metadataPath,
        metadata,
        translationKey
    ) {
        const translations = metadata.translations || [];
        const removed = translations.filter(descriptor => (
            descriptor.translationKey === translationKey
        ));
        const nextMetadata = withTranslationReferences(
            metadata,
            translations.filter(descriptor => (
                descriptor.translationKey !== translationKey
            ))
        );
        try {
            await this.#writeMetadata(metadataPath, nextMetadata);
            await Promise.all(removed.map(descriptor => this.io.remove(
                this.path.join(entryPath, descriptor.translationFile), {
                    ignoreAbsent: true,
                }).catch(() => {})));
        }
        catch {}
        return nextMetadata;
    }

    async #readTranslationRecord(entryPath, descriptor) {
        const translationPath = this.path.join(
            entryPath,
            descriptor.translationFile
        );
        const fileInfo = await this.io.stat(translationPath);
        if (!Number.isSafeInteger(fileInfo?.size)
            || fileInfo.size !== descriptor.translationBytes
            || fileInfo.size > this.maxTranslationBytes
            || (fileInfo.type && fileInfo.type !== 'regular')) {
            throw new Error('Cached translation file size is invalid');
        }
        const serialized = await this.io.readUTF8(translationPath);
        if (new TextEncoder().encode(serialized).length !== fileInfo.size) {
            throw new Error('Cached translation size is invalid');
        }
        const record = JSON.parse(serialized);
        validateTranslationRecord(
            record,
            descriptor.translationKey,
            this.maxTranslationBytes
        );
        if (descriptor.targetLanguage
            && record.targetLanguage !== descriptor.targetLanguage) {
            throw new Error('Cached translation language is inconsistent');
        }
        return record;
    }

    async #removeReferencedFiles(entryPath, metadata) {
        if (!metadata) return;
        const files = [
            this.path.join(entryPath, metadata.markdownFile || MARKDOWN_FILE),
            ...(metadata.sourceMapFile
                ? [this.path.join(entryPath, metadata.sourceMapFile)]
                : []),
            ...(validFigureMapFile(metadata.figureMapFile)
                ? [this.path.join(entryPath, metadata.figureMapFile)] : []),
            ...(metadata.chromeRangesFile
                ? [this.path.join(entryPath, metadata.chromeRangesFile)]
                : []),
            ...(metadata.assets || []).map(asset => (
                this.path.join(entryPath, 'assets', asset.file)
            )),
            ...translationFiles(metadata).map(file => (
                this.path.join(entryPath, file)
            )),
        ];
        await Promise.all(files.map(filePath => this.io.remove(filePath, {
            ignoreAbsent: true,
        }).catch(() => {})));
    }

    #isExpired(metadata, timestamp = this.now()) {
        return timestamp - metadata.lastAccessedAt > this.maxAgeMs;
    }

    async #withOperation(operation) {
        const previous = this.operationTail;
        const pending = previous.catch(() => {}).then(operation);
        this.operationTail = pending;
        try {
            return await pending;
        }
        finally {
            if (this.operationTail === pending) {
                this.operationTail = Promise.resolve();
            }
        }
    }
}

function createGenerationID(timestamp) {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
        || Math.random().toString(36).slice(2);
    return `${Number(timestamp).toString(36)}-${random}`;
}

function validateCacheKey(cacheKey) {
    if (!/^[a-f0-9]{64}$/.test(String(cacheKey))) {
        throw new TypeError('A SHA-256 cache key is required');
    }
}

function validateMetadata(
    metadata,
    cacheKey,
    maxSourceMapBytes,
    maxChromeRangesBytes
) {
    if (metadata?.schemaVersion !== CACHE_SCHEMA_VERSION
        || metadata.cacheKey !== cacheKey
        || !Number.isFinite(metadata.markdownBytes)
        || metadata.markdownBytes < 0
        || !Number.isFinite(metadata.sizeBytes)
        || metadata.sizeBytes < metadata.markdownBytes
        || !Number.isFinite(metadata.lastAccessedAt)
        || (metadata.markdownFile !== undefined
            && !/^document-[a-z0-9-]+\.md$/.test(metadata.markdownFile))
        || (metadata.sourceMapFile !== undefined
            && !/^source-map-[a-z0-9-]+\.json$/.test(metadata.sourceMapFile))
        || (metadata.sourceMapFile !== undefined
            && (!Number.isSafeInteger(metadata.sourceMapBytes)
                || metadata.sourceMapBytes < 0
                || metadata.sourceMapBytes > maxSourceMapBytes))
        || (metadata.sourceMapBytes !== undefined
            && metadata.sourceMapFile === undefined)
        || (metadata.chromeRangesFile !== undefined
            && !/^chrome-ranges-[a-z0-9-]+\.json$/.test(metadata.chromeRangesFile))
        || (metadata.chromeRangesFile !== undefined
            && (!Number.isSafeInteger(metadata.chromeRangesBytes)
                || metadata.chromeRangesBytes < 0
                || metadata.chromeRangesBytes > maxChromeRangesBytes))
        || (metadata.chromeRangesBytes !== undefined
            && metadata.chromeRangesFile === undefined)
        || typeof metadata.assetBasePath !== 'string'
        || (metadata.userEdited !== undefined
            && typeof metadata.userEdited !== 'boolean')
        || !Array.isArray(metadata.assets)
        || metadata.assets.length > 1000) {
        throw new Error('Invalid cache metadata');
    }
    for (const asset of metadata.assets) {
        if (!/^(?:\d{4}|[a-z0-9-]+-\d{4})\.bin$/.test(asset?.file)
            || typeof asset.path !== 'string'
            || typeof asset.mimeType !== 'string'
            || !Number.isFinite(asset.size)
            || asset.size < 0) {
            throw new Error('Invalid cached image metadata');
        }
    }
}

function isSafeTranslationFile(file) {
    return /^translation-[a-z0-9-]+\.json$/.test(String(file || ''));
}

function isValidTranslationDescriptor(descriptor, {
    maxBytes,
    requireTargetLanguage,
}) {
    return isSafeTranslationFile(descriptor?.translationFile)
        && /^[a-f0-9]{64}$/.test(String(descriptor?.translationKey))
        && Number.isSafeInteger(descriptor?.translationBytes)
        && descriptor.translationBytes >= 0
        && descriptor.translationBytes <= maxBytes
        && (!requireTargetLanguage
            || typeof descriptor.targetLanguage === 'string'
                && descriptor.targetLanguage.length > 0
                && descriptor.targetLanguage.length <= 64);
}

function hasLegacyTranslationMetadata(metadata) {
    return [
        metadata.translationFile,
        metadata.translationKey,
        metadata.translationBytes,
    ].some(value => value !== undefined);
}

function legacyTranslationDescriptor(metadata) {
    if (!hasLegacyTranslationMetadata(metadata)) return null;
    return {
        translationFile: metadata.translationFile,
        translationKey: metadata.translationKey,
        translationBytes: metadata.translationBytes,
    };
}

function translationFiles(metadata) {
    const files = Array.isArray(metadata?.translations)
        ? metadata.translations
            .map(descriptor => descriptor?.translationFile)
            .filter(isSafeTranslationFile)
        : [];
    if (isSafeTranslationFile(metadata?.translationFile)) {
        files.push(metadata.translationFile);
    }
    return [...new Set(files)];
}

function validFigureMapFile(value) {
    return typeof value === 'string' && /^figure-map-[a-z0-9-]+\.json$/u.test(value);
}

function cachedDocumentSize(metadata) {
    return metadata.markdownBytes
        + (metadata.sourceMapBytes || 0)
        + (metadata.chromeRangesBytes || 0)
        + (Number.isSafeInteger(metadata.figureMapBytes) && metadata.figureMapBytes > 0
            && validFigureMapFile(metadata.figureMapFile) ? metadata.figureMapBytes : 0)
        + metadata.assets.reduce((total, asset) => total + asset.size, 0);
}

function withTranslationReferences(metadata, translations) {
    const value = { ...metadata };
    delete value.translationFile;
    delete value.translationKey;
    delete value.translationBytes;
    if (translations.length) value.translations = translations;
    else delete value.translations;
    value.sizeBytes = cachedDocumentSize(value)
        + translations.reduce((total, descriptor) => (
            total + descriptor.translationBytes
        ), 0);
    return value;
}

function withoutTranslationReferences(metadata) {
    return withTranslationReferences(metadata, []);
}

function validateTranslationRecord(record, translationKey, maxBytes) {
    if (record?.schemaVersion !== TRANSLATION_SCHEMA_VERSION
        || record.translationKey !== translationKey
        || new TextEncoder().encode(JSON.stringify(record)).length > maxBytes) {
        throw new Error('Invalid cached translation metadata');
    }
    validateTranslationValue(record);
}

function validateTranslationValue(value) {
    const failedBlocks = value?.failedBlocks ?? [];
    const partial = value?.partial ?? false;
    if (typeof value?.translatedMarkdown !== 'string'
        || typeof value.comparisonMarkdown !== 'string'
        || !Array.isArray(value.blocks)
        || value.blocks.length > 100_000
        || typeof value.model !== 'string'
        || typeof value.targetLanguage !== 'string'
        || typeof value.promptVersion !== 'string'
        || (value.partial !== undefined && typeof value.partial !== 'boolean')
        || partial !== Boolean(failedBlocks.length)
        || !Array.isArray(failedBlocks)
        || failedBlocks.length > value.blocks.length) {
        throw new Error('Invalid cached document translation');
    }
    for (const block of value.blocks) {
        if (typeof block?.id !== 'string'
            || !block.id
            || typeof block.markdown !== 'string') {
            throw new Error('Invalid cached Markdown block translation');
        }
    }
    const blockIDs = new Set(value.blocks.map(block => block.id));
    if (value.sourceBlocks !== undefined) {
        if (!Array.isArray(value.sourceBlocks)
            || value.sourceBlocks.length !== value.blocks.length) {
            throw new Error('Invalid cached Markdown translation sources');
        }
        const sourceBlockIDs = new Set();
        for (const block of value.sourceBlocks) {
            if (typeof block?.id !== 'string'
                || !blockIDs.has(block.id)
                || sourceBlockIDs.has(block.id)
                || typeof block.markdown !== 'string') {
                throw new Error('Invalid cached Markdown translation source');
            }
            sourceBlockIDs.add(block.id);
        }
    }
    if (value.settingsIdentity !== undefined
        && (typeof value.settingsIdentity !== 'string'
            || !value.settingsIdentity
            || value.settingsIdentity.length > 8_192)) {
        throw new Error('Invalid cached translation settings identity');
    }
    const failedIDs = new Set();
    for (const failure of failedBlocks) {
        if (typeof failure?.id !== 'string'
            || !blockIDs.has(failure.id)
            || failedIDs.has(failure.id)
            || typeof failure.message !== 'string') {
            throw new Error('Invalid cached Markdown block failure');
        }
        failedIDs.add(failure.id);
    }
}

function translationValue(value) {
    const failedBlocks = value.failedBlocks ?? [];
    const sourceBlocks = Array.isArray(value.sourceBlocks)
        ? value.sourceBlocks
        : null;
    return {
        translatedMarkdown: value.translatedMarkdown,
        // The comparison view is rebuilt from source and translated blocks.
        comparisonMarkdown: sourceBlocks ? '' : value.comparisonMarkdown,
        blocks: value.blocks.map(block => ({
            id: block.id,
            markdown: block.markdown,
        })),
        ...(sourceBlocks ? {
            sourceBlocks: sourceBlocks.map(block => ({
                id: block.id,
                markdown: block.markdown,
            })),
        } : {}),
        ...(typeof value.settingsIdentity === 'string'
            && value.settingsIdentity ? {
                settingsIdentity: value.settingsIdentity,
            } : {}),
        model: value.model,
        targetLanguage: value.targetLanguage,
        promptVersion: value.promptVersion,
        partial: Boolean(value.partial),
        failedBlocks: failedBlocks.map(failure => ({
            id: failure.id,
            message: failure.message,
        })),
    };
}

function validateTargetLanguage(targetLanguage) {
    if (typeof targetLanguage !== 'string'
        || !targetLanguage
        || targetLanguage.length > 64) {
        throw new TypeError('A translation target language is required');
    }
}

function validateSourceMap(sourceMap, markdownLength, maxLocations) {
    if (!Array.isArray(sourceMap) || sourceMap.length > 100_000) {
        throw new Error('Invalid cached source map');
    }
    let locationCount = 0;
    for (const entry of sourceMap) {
        if (typeof entry?.type !== 'string'
            || !Number.isSafeInteger(entry.markdownFrom)
            || !Number.isSafeInteger(entry.markdownTo)
            || entry.markdownFrom < 0
            || entry.markdownTo <= entry.markdownFrom
            || entry.markdownTo > markdownLength
            || !Array.isArray(entry.locations)
            || !entry.locations.length
            || entry.locations.length > 1000) {
            throw new Error('Invalid cached source map entry');
        }
        locationCount += entry.locations.length;
        if (locationCount > maxLocations) {
            throw new Error('Cached source map exceeds the source map location limit');
        }
        for (const location of entry.locations) {
            if (!isValidSourceLocation(location)) {
                throw new Error('Invalid cached source location');
            }
        }
        if (!isValidSourceMapEntry(entry, markdownLength)) {
            throw new Error('Invalid cached source map entry');
        }
    }
}
