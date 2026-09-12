import { serializeFigureMap, parseFigureMapJSON } from '../figures/figure-map-serialization.js';
import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { sha256Hex } from '../core/sha256.js';

const STORE_SCHEMA_VERSION = 1;
const METADATA_FILE = 'metadata.json';
const MARKDOWN_FILE = 'base.md';
const SOURCE_MAP_FILE = 'source-map.json';
const FIGURE_MAP_FILE = 'figure-map.json';
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CORRECTIONS_FILE_PATTERN = /^corrections-\d+-\d+\.json$/;
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_MAP_BYTES = 20 * 1024 * 1024;
const MAX_CORRECTIONS_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 150 * 1024 * 1024;
const MAX_ASSETS = 1_000;

export function createZoteroMarkdownRevisionStore({
    zotero,
    ioUtils,
    pathUtils,
}) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) throw new Error('The Zotero profile directory is unavailable');
    return new ZoteroMarkdownRevisionStore({
        rootPath: pathUtils.join(profilePath, 'mktero-revisions', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export class ZoteroMarkdownRevisionStore {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
        hash = sha256Hex,
    }) {
        if (!rootPath) throw new TypeError('A Markdown revision root is required');
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.hash = hash;
        this.writeSequence = 0;
        this.operationTail = Promise.resolve();
    }

    load(cacheKey) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.#load(cacheKey));
    }

    save(cacheKey, revision) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.#save(cacheKey, revision));
    }

    delete(cacheKey) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.io.remove(
            this.#entryPath(cacheKey),
            { recursive: true, ignoreAbsent: true }
        ));
    }

    async #load(cacheKey) {
        const entryPath = this.#entryPath(cacheKey);
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        if (!(await this.io.exists(metadataPath))) return null;
        const metadata = await this.#readMetadata(metadataPath, cacheKey);
        const [markdown, sourceMapJSON, correctionsJSON, assets] = await Promise.all([
            this.#readSizedUTF8(
                this.path.join(entryPath, MARKDOWN_FILE),
                metadata.markdownBytes,
                MAX_MARKDOWN_BYTES,
                'Markdown revision base'
            ),
            this.#readSizedUTF8(
                this.path.join(entryPath, SOURCE_MAP_FILE),
                metadata.sourceMapBytes,
                MAX_SOURCE_MAP_BYTES,
                'Markdown revision source map'
            ),
            this.#readSizedUTF8(
                this.path.join(entryPath, metadata.correctionsFile),
                metadata.correctionsBytes,
                MAX_CORRECTIONS_BYTES,
                'Markdown revision corrections'
            ),
            Promise.all(metadata.assets.map(async asset => ({
                path: asset.path,
                mimeType: asset.mimeType,
                data: await this.#readSizedBinary(
                    this.path.join(entryPath, 'assets', asset.file),
                    asset.size,
                    'Markdown revision asset'
                ),
            }))),
        ]);
        let sourceMap;
        let correctionData;
        try {
            sourceMap = JSON.parse(sourceMapJSON);
            correctionData = JSON.parse(correctionsJSON);
        }
        catch (error) {
            throw new Error('Invalid Markdown revision data', { cause: error });
        }
        if (!Array.isArray(sourceMap)
            || !Array.isArray(correctionData?.blocks)
            || !Array.isArray(correctionData?.corrections)) {
            throw new Error('Invalid Markdown revision data');
        }
        let figureMap;
        if (validSize(metadata.figureMapBytes, FIGURE_LIMITS.maxMapBytes) && metadata.figureMapBytes > 0) {
            try {
                const json = await this.#readSizedUTF8(this.path.join(entryPath, FIGURE_MAP_FILE),
                    metadata.figureMapBytes, FIGURE_LIMITS.maxMapBytes, 'Figure map');
                if (metadata.figureMapHash !== undefined
                    && (!CACHE_KEY_PATTERN.test(metadata.figureMapHash)
                        || await this.hash(new TextEncoder().encode(json)) !== metadata.figureMapHash)) {
                    throw new Error('Figure map hash is invalid');
                }
                figureMap = await parseFigureMapJSON(json, {
                    markdown, assets, assetBasePath: metadata.assetBasePath,
                }, { hash: this.hash });
            }
            catch {
                // Optional Figure metadata cannot hide the corrected document.
            }
        }
        return {
            schemaVersion: STORE_SCHEMA_VERSION,
            base: {
                itemID: metadata.itemID,
                cacheKey,
                markdown,
                sourceMap,
                ...(figureMap ? { figureMap } : {}),
                assets,
                assetBasePath: metadata.assetBasePath,
                extractedPages: metadata.extractedPages,
                totalPages: metadata.totalPages,
            },
            blocks: correctionData.blocks,
            corrections: correctionData.corrections,
        };
    }

    async #save(cacheKey, revision) {
        validateRevision(revision, cacheKey);
        await this.#ensureRoot();
        const entryPath = this.#entryPath(cacheKey);
        const assetsPath = this.path.join(entryPath, 'assets');
        await this.io.makeDirectory(entryPath, { ignoreExisting: true });
        await this.io.makeDirectory(assetsPath, { ignoreExisting: true });

        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        const previous = await this.#readOptionalMetadata(metadataPath, cacheKey);
        const serialized = serializeRevision(revision);
        if (revision.base.figureMap) {
            const figureMap = await serializeFigureMap(revision.base.figureMap, revision.base, { hash: this.hash });
            serialized.figureMapJSON = figureMap.json;
            serialized.metadata.figureMapBytes = figureMap.bytes;
            serialized.metadata.figureMapHash = await this.hash(new TextEncoder().encode(figureMap.json));
            if (previous?.figureMapBytes && previous.figureMapHash === undefined) {
                const json = await this.#readSizedUTF8(this.path.join(entryPath, FIGURE_MAP_FILE),
                    previous.figureMapBytes, FIGURE_LIMITS.maxMapBytes, 'Figure map');
                previous.figureMapHash = await this.hash(new TextEncoder().encode(json));
            }
        }
        else if (previous) {
            for (const key of ['figureMapBytes', 'figureMapHash']) {
                if (Object.hasOwn(previous, key)) serialized.metadata[key] = previous[key];
            }
        }
        if (previous) validateImmutableBase(previous, serialized.metadata);

        let correctionsFile;
        do {
            correctionsFile = [
            'corrections-',
            Math.max(0, Math.trunc(this.now())),
            '-',
            this.writeSequence++,
            '.json',
            ].join('');
        } while (await this.io.exists(this.path.join(entryPath, correctionsFile)));
        const correctionsPath = this.path.join(entryPath, correctionsFile);
        const metadata = {
            ...serialized.metadata,
            correctionsFile,
            correctionsBytes: serialized.correctionsBytes,
        };
        const created = [];
        try {
            if (!previous) await this.#writeImmutableBase(entryPath, assetsPath, serialized, created);
            created.push(correctionsPath, `${correctionsPath}.tmp`, `${metadataPath}.tmp`);
            await this.io.writeUTF8(correctionsPath, serialized.correctionsJSON, {
                tmpPath: `${correctionsPath}.tmp`,
            });
            await this.io.writeUTF8(metadataPath, JSON.stringify(metadata), {
                tmpPath: `${metadataPath}.tmp`,
            });
        }
        catch (error) {
            await Promise.allSettled(created.map(filePath => this.io.remove(filePath, {
                recursive: false,
                ignoreAbsent: true,
            })));
            throw error;
        }
        if (previous?.correctionsFile
            && previous.correctionsFile !== correctionsFile) {
            await this.io.remove(
                this.path.join(entryPath, previous.correctionsFile),
                { ignoreAbsent: true }
            ).catch(() => {});
        }
    }

    async #writeImmutableBase(entryPath, assetsPath, serialized, created) {
        const files = [
            [this.path.join(entryPath, MARKDOWN_FILE), serialized.markdown],
            [this.path.join(entryPath, SOURCE_MAP_FILE), serialized.sourceMapJSON],
        ];
        if (serialized.figureMapJSON) {
            files.push([this.path.join(entryPath, FIGURE_MAP_FILE), serialized.figureMapJSON]);
        }
        for (const asset of serialized.assets) {
            files.push([this.path.join(assetsPath, asset.file), asset.data]);
        }
        for (const [filePath, data] of files) {
            if (await this.io.exists(filePath)) {
                throw new Error('An incomplete Markdown revision base already exists');
            }
            created.push(filePath, `${filePath}.tmp`);
            const write = typeof data === 'string' ? 'writeUTF8' : 'write';
            await this.io[write](filePath, data, { tmpPath: `${filePath}.tmp` });
        }
    }

    async #readOptionalMetadata(metadataPath, cacheKey) {
        if (!(await this.io.exists(metadataPath))) return null;
        return this.#readMetadata(metadataPath, cacheKey);
    }

    async #readMetadata(metadataPath, cacheKey) {
        let metadata;
        try {
            metadata = JSON.parse(await this.io.readUTF8(metadataPath));
        }
        catch (error) {
            throw new Error('Invalid revision metadata', { cause: error });
        }
        validateMetadata(metadata, cacheKey);
        return metadata;
    }

    async #readSizedUTF8(filePath, expectedBytes, maxBytes, label) {
        const info = await this.io.stat(filePath);
        if (!Number.isSafeInteger(info?.size)
            || info.size !== expectedBytes
            || info.size > maxBytes) {
            throw new Error(`${label} size is invalid`);
        }
        return this.io.readUTF8(filePath);
    }

    async #readSizedBinary(filePath, expectedBytes, label) {
        const info = await this.io.stat(filePath);
        if (!Number.isSafeInteger(info?.size) || info.size !== expectedBytes) {
            throw new Error(`${label} size is invalid`);
        }
        return this.io.read(filePath);
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

    #entryPath(cacheKey) {
        return this.path.join(this.rootPath, 'entries', cacheKey);
    }

    async #withOperation(operation) {
        const pending = this.operationTail.catch(() => {}).then(operation);
        this.operationTail = pending;
        return pending;
    }
}

function serializeRevision(revision) {
    const encoder = new TextEncoder();
    const markdown = revision.base.markdown;
    const sourceMapJSON = JSON.stringify(revision.base.sourceMap || []);
    const correctionsJSON = JSON.stringify({
        blocks: revision.blocks,
        corrections: revision.corrections,
    });
    const markdownBytes = encoder.encode(markdown).length;
    const sourceMapBytes = encoder.encode(sourceMapJSON).length;
    const correctionsBytes = encoder.encode(correctionsJSON).length;
    if (markdownBytes > MAX_MARKDOWN_BYTES) {
        throw new Error('The Markdown revision base exceeds its size limit');
    }
    if (sourceMapBytes > MAX_SOURCE_MAP_BYTES) {
        throw new Error('The Markdown revision source map exceeds its size limit');
    }
    if (correctionsBytes > MAX_CORRECTIONS_BYTES) {
        throw new Error('The Markdown revision corrections exceed their size limit');
    }
    if ((revision.base.assets || []).length > MAX_ASSETS) {
        throw new Error('The Markdown revision has too many assets');
    }
    let totalAssetBytes = 0;
    const assets = (revision.base.assets || []).map((asset, index) => {
        const data = asset.data instanceof Uint8Array
            ? asset.data
            : new Uint8Array(asset.data || []);
        if (data.length > MAX_SINGLE_ASSET_BYTES) {
            throw new Error(
                'The Markdown revision assets exceed their size limit'
            );
        }
        totalAssetBytes += data.length;
        return {
            file: `${String(index).padStart(4, '0')}.bin`,
            path: String(asset.path || ''),
            mimeType: String(asset.mimeType || ''),
            size: data.length,
            data,
        };
    });
    if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) {
        throw new Error('The Markdown revision assets exceed their size limit');
    }
    return {
        markdown,
        sourceMapJSON,
        correctionsJSON,
        correctionsBytes,
        assets,
        metadata: {
            schemaVersion: STORE_SCHEMA_VERSION,
            cacheKey: revision.base.cacheKey,
            itemID: revision.base.itemID ?? null,
            markdownBytes,
            sourceMapBytes,
            assetBasePath: String(revision.base.assetBasePath || ''),
            extractedPages: revision.base.extractedPages ?? null,
            totalPages: revision.base.totalPages ?? null,
            assets: assets.map(({ data: _data, ...asset }) => asset),
        },
    };
}

function validateRevision(revision, cacheKey) {
    if (revision?.schemaVersion !== STORE_SCHEMA_VERSION
        || revision.base?.cacheKey !== cacheKey
        || typeof revision.base?.markdown !== 'string'
        || !Array.isArray(revision.blocks)
        || !Array.isArray(revision.corrections)) {
        throw new TypeError('Invalid Markdown revision');
    }
}

function validateMetadata(metadata, cacheKey) {
    if (metadata?.schemaVersion !== STORE_SCHEMA_VERSION
        || metadata.cacheKey !== cacheKey
        || !validSize(metadata.markdownBytes, MAX_MARKDOWN_BYTES)
        || !validSize(metadata.sourceMapBytes, MAX_SOURCE_MAP_BYTES)
        || !validSize(metadata.correctionsBytes, MAX_CORRECTIONS_BYTES)
        || !CORRECTIONS_FILE_PATTERN.test(metadata.correctionsFile || '')
        || typeof metadata.assetBasePath !== 'string'
        || !Array.isArray(metadata.assets)
        || metadata.assets.length > MAX_ASSETS) {
        throw new Error('Invalid revision metadata');
    }
    let totalAssetBytes = 0;
    for (const asset of metadata.assets) {
        if (!/^\d{4}\.bin$/.test(asset?.file || '')
            || typeof asset.path !== 'string'
            || !asset.path
            || typeof asset.mimeType !== 'string'
            || !validSize(asset.size, MAX_SINGLE_ASSET_BYTES)) {
            throw new Error('Invalid revision metadata');
        }
        totalAssetBytes += asset.size;
    }
    if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) {
        throw new Error('Invalid revision metadata');
    }
}

function validateImmutableBase(previous, next) {
    const fields = [
        'markdownBytes',
        'sourceMapBytes',
        'figureMapBytes',
        'figureMapHash',
        'assetBasePath',
        'extractedPages',
        'totalPages',
    ];
    if (fields.some(field => previous[field] !== next[field])
        || JSON.stringify(previous.assets) !== JSON.stringify(next.assets)) {
        throw new Error('The saved Markdown revision base cannot be replaced');
    }
}

function validSize(value, maximum) {
    return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validateCacheKey(cacheKey) {
    if (!CACHE_KEY_PATTERN.test(cacheKey || '')) {
        throw new TypeError('Invalid Markdown revision cache key');
    }
}
