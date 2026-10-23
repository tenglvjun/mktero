import { unzipSync, zipSync } from 'fflate';
import { toUint8Array } from './binary.js';

const KEPT_FILE = /(?:^|\/)(?:full\.md|(?:.+_)?content_list\.json|(?:.+_)?(?:middle|layout)\.json)$/i;
const KEPT_IMAGE = /\.(?:gif|jpe?g|png|webp)$/i;
const DEFAULT_MAX_RESULT_ARCHIVE_BYTES = 256 * 1024 * 1024;

// Keeps only the files the extension reads from a MinerU result: Markdown,
// the stable content list, the layout JSON, and images. The original PDF
// copy, model.json, and content_list_v2 are dropped. Images are stored
// uncompressed because they are already compressed formats.
export function createMinerUResultArchive(archive, {
    maxBytes = DEFAULT_MAX_RESULT_ARCHIVE_BYTES,
} = {}) {
    const bytes = toUint8Array(archive, 'The MinerU result archive');
    let total = 0;
    const files = unzipSync(bytes, {
        filter(file) {
            const kept = KEPT_FILE.test(file.name) && !/_v\d+\.json$/i.test(file.name)
                || KEPT_IMAGE.test(file.name);
            if (!kept) return false;
            total += file.originalSize;
            if (total > maxBytes) throw new Error('The MinerU result archive is too large to keep');
            return true;
        },
    });
    const entries = {};
    for (const [name, data] of Object.entries(files)) {
        entries[name] = [data, { level: KEPT_IMAGE.test(name) ? 0 : 6 }];
    }
    if (!Object.keys(entries).some(name => /(?:^|\/)full\.md$/i.test(name))) {
        throw new Error('The MinerU result archive does not contain full.md');
    }
    return zipSync(entries);
}

// Keeping the archive is an optimization; a failure must not fail the
// conversion that already produced a readable result.
export function tryCreateMinerUResultArchive(archive, options) {
    try {
        return createMinerUResultArchive(archive, options);
    }
    catch {
        return null;
    }
}
