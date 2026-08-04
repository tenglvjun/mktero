import { createEmptyAnnotationOverlay } from './markdown-annotation-overlay.js';
import { sha256Hex } from './sha256.js';

export class SavedMarkdownOpenResolver {
    constructor({
        store,
        cache = null,
        resolveSourceItem = async () => null,
        hash = sha256Hex,
        parserProfile = null,
        onCacheError = () => {},
    }) {
        if (!store?.read) {
            throw new TypeError('A saved Markdown store is required');
        }
        this.store = store;
        this.cache = cache;
        this.resolveSourceItem = resolveSourceItem;
        this.hash = hash;
        this.parserProfile = parserProfile;
        this.onCacheError = onCacheError;
    }

    async resolve(noteItemOrID) {
        const saved = await this.store.read(noteItemOrID);
        const sourceItem = await this.#resolveSourceItem(saved.manifest);
        const cached = await this.#readMatchingCache(saved);
        if (cached) {
            return createMarkdownDocument({
                saved,
                sourceItem,
                markdown: cached.markdown,
                assets: cached.assets || [],
                assetBasePath: cached.assetBasePath || '',
                sourceMap: Array.isArray(cached.sourceMap)
                    ? cached.sourceMap
                    : [],
                cacheHit: true,
            });
        }

        if (saved.sourceAvailable && saved.assetsComplete) {
            return createMarkdownDocument({
                saved,
                sourceItem,
                markdown: saved.markdown,
                assets: saved.assets,
                assetBasePath: saved.manifest.assetBasePath,
                sourceMap: saved.sourceMap,
                cacheHit: false,
            });
        }

        if (saved.snapshotAvailable) {
            return {
                documentID: saved.noteID,
                sourceItemID: sourceItem?.id ?? null,
                title: documentTitle(sourceItem, saved.note),
                status: 'ready',
                renderMode: 'html',
                sourceKind: 'snapshot',
                markdown: '',
                assets: [],
                assetBasePath: '',
                sourceMap: [],
                cacheHit: false,
                cacheKey: saved.manifest.cacheKey,
                snapshotHTML: saved.bodyHTML,
                snapshotAssets: saved.assets,
                snapshotModified: saved.snapshotModified,
                warnings: snapshotWarnings(saved),
                annotationOverlay: createEmptyAnnotationOverlay(),
            };
        }

        throw new Error(
            'The saved Markdown note has no readable source or HTML snapshot'
        );
    }

    async #resolveSourceItem(manifest) {
        try {
            const item = await this.resolveSourceItem(manifest);
            return item?.isPDFAttachment?.() ? item : null;
        }
        catch (error) {
            this.onCacheError(error);
            return null;
        }
    }

    async #readMatchingCache(saved) {
        if (!this.cache?.get
            || !saved.manifest.cacheKey
            || (this.parserProfile
                && saved.manifest.parserProfile !== this.parserProfile)) {
            return null;
        }
        try {
            const cached = await this.cache.get(saved.manifest.cacheKey);
            if (!cached || typeof cached.markdown !== 'string') return null;
            const markdownHash = await this.hash(
                new TextEncoder().encode(cached.markdown)
            );
            if (markdownHash !== saved.manifest.markdownHash) return null;
            if (!cacheAssetsMatch(cached.assets, saved.manifest.assets)) return null;
            return cached;
        }
        catch (error) {
            try {
                this.onCacheError(error);
            }
            catch {
                // Cache diagnostics must not affect opening the synced note.
            }
            return null;
        }
    }
}

export function createSavedMarkdownOpenResolver(options) {
    return new SavedMarkdownOpenResolver(options);
}

function createMarkdownDocument({
    saved,
    sourceItem,
    markdown,
    assets,
    assetBasePath,
    sourceMap,
    cacheHit,
}) {
    return {
        documentID: saved.noteID,
        sourceItemID: sourceItem?.id ?? null,
        title: documentTitle(sourceItem, saved.note),
        status: 'ready',
        renderMode: 'markdown',
        sourceKind: 'markdown',
        markdown: markdown || '',
        assets,
        assetBasePath,
        sourceMap: Array.isArray(sourceMap) ? sourceMap : [],
        cacheHit,
        cacheKey: saved.manifest.cacheKey,
        snapshotHTML: null,
        snapshotAssets: [],
        snapshotModified: saved.snapshotModified,
        warnings: [],
        annotationOverlay: createEmptyAnnotationOverlay(),
    };
}

function documentTitle(sourceItem, note) {
    return sourceItem?.parentItem?.getDisplayTitle?.()
        || sourceItem?.getDisplayTitle?.()
        || note?.getDisplayTitle?.()
        || 'Untitled PDF';
}

function cacheAssetsMatch(cachedAssets, manifestAssets) {
    if (!Array.isArray(cachedAssets)
        || cachedAssets.length !== manifestAssets.length) {
        return manifestAssets.length === 0;
    }
    const cachedPaths = new Set(cachedAssets.map(asset => (
        String(asset?.path || '')
    )));
    return manifestAssets.every(asset => cachedPaths.has(asset.path));
}

function snapshotWarnings(saved) {
    const warnings = [];
    if (!saved.sourceAvailable) {
        warnings.push('The synced Markdown source is unavailable; showing the HTML snapshot.');
    }
    if (!saved.assetsComplete) {
        warnings.push('Some synced Markdown images are unavailable.');
    }
    if (saved.snapshotModified) {
        warnings.push('The Zotero snapshot was modified outside Mktero.');
    }
    return warnings;
}
