export class MinerUConfigurationError extends Error {
    constructor() {
        super('Configure a MinerU API Token in the Mktero preferences');
        this.name = 'MinerUConfigurationError';
        this.code = 'MINERU_API_KEY_REQUIRED';
    }
}

export class MinerUDocumentExtractor {
    constructor({ zotero, client, getApiKey, readFile }) {
        if (!zotero) throw new TypeError('A Zotero runtime is required');
        if (!client) throw new TypeError('A MinerU client is required');
        if (!getApiKey) throw new TypeError('A MinerU API Token provider is required');
        if (!readFile) throw new TypeError('A file reader is required');
        this.zotero = zotero;
        this.client = client;
        this.getApiKey = getApiKey;
        this.readFile = readFile;
    }

    async extract(itemID, { onProgress, signal } = {}) {
        throwIfAborted(signal);
        const item = await this.zotero.Items.getAsync(itemID);
        if (!item?.isPDFAttachment?.()) {
            throw new Error('Only PDF attachments can be converted');
        }

        const apiKey = String(this.getApiKey() || '').trim();
        if (!apiKey) throw new MinerUConfigurationError();

        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            throw new Error('The local PDF file is unavailable');
        }

        const fileData = await this.readFile(filePath);
        throwIfAborted(signal);
        const result = await this.client.parse({
            apiKey,
            fileName: item.attachmentFilename || `zotero-${itemID}.pdf`,
            fileData,
            dataID: `zotero-${itemID}`,
            onProgress,
            signal,
        });
        const title = item.parentItem?.getDisplayTitle?.()
            || item.getDisplayTitle?.()
            || 'Untitled PDF';

        return {
            kind: 'markdown',
            title,
            markdown: result.markdown,
            assets: result.assets || [],
            assetBasePath: result.assetBasePath || '',
            extractedPages: result.extractedPages,
            totalPages: result.totalPages,
            warnings: [],
        };
    }
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
