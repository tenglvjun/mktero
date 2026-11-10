import { createEpub } from '../epub/epub-export.js';
import { translateEnglish } from '../i18n/localization.js';
import {
    constrainExportFileNameStem,
    createMarkdownExportDirectoryName,
    MAX_EXPORT_COLLISION_INDEX,
} from '../markdown/markdown-export.js';

// The picker gives a native path (`\` on Windows, `/` elsewhere), so the
// destination has to be joined by the platform instead of by string literals.
// A hand-built `C:\Downloads/Paper.epub` is rejected by Gecko on Windows with
// NS_ERROR_FILE_UNRECOGNIZED_PATH, which made every batch export fail there.
export function createZoteroEpubExporter({
    createFilePicker,
    ioUtils,
    pathUtils,
    createID,
    renderWideTable,
    renderImageToPNG,
    renderMathToPNG,
    translate = translateEnglish,
    buildEpub = createEpub,
    isWindows = false,
} = {}) {
    if (typeof createFilePicker !== 'function') {
        throw new TypeError('A Zotero file picker factory is required');
    }
    if (typeof ioUtils?.write !== 'function') {
        throw new TypeError('Zotero binary file I/O is required');
    }
    if (typeof pathUtils?.join !== 'function') {
        throw new TypeError('Zotero path utilities are required');
    }
    if (typeof createID !== 'function') {
        throw new TypeError('An EPUB export ID factory is required');
    }
    if (typeof buildEpub !== 'function') {
        throw new TypeError('An EPUB builder is required');
    }
    if (typeof isWindows !== 'boolean') {
        throw new TypeError('A Windows platform flag is required');
    }

    return {
        // A batch resolves the output folder once, then passes it to every
        // document. `null` means the user cancelled the picker.
        async resolveDirectory({ ownerWindow } = {}) {
            return pickEpubDirectory({
                createFilePicker,
                translate,
                ownerWindow,
            });
        },

        async export({
            ownerWindow,
            directory = '',
            usedPaths = null,
            title,
            markdown,
            assets,
            assetBasePath,
            language = 'en',
        } = {}) {
            if (typeof directory === 'string' && directory) {
                const stem = constrainEpubStem({
                    directory,
                    title,
                    translate,
                    pathUtils,
                    isWindows,
                });
                const filePath = await createAvailableEpubPath({
                    directory,
                    stem,
                    // A batch passes one shared set so two documents with the
                    // same title do not both claim `Paper.epub`.
                    used: usedPaths instanceof Set ? usedPaths : new Set(),
                    ioUtils,
                    pathUtils,
                    translate,
                });
                if (usedPaths instanceof Set) usedPaths.add(filePath);
                return writeEpubFile({
                    filePath,
                    title,
                    language,
                    markdown,
                    assets,
                    assetBasePath,
                    ioUtils,
                    createID,
                    translate,
                    buildEpub,
                    renderWideTable,
                    renderImageToPNG,
                    renderMathToPNG,
                });
            }
            const filePath = await pickEpubPath({
                createFilePicker,
                translate,
                ownerWindow,
                title,
            });
            if (filePath === null) return { status: 'cancelled' };
            return writeEpubFile({
                filePath,
                title,
                language,
                markdown,
                assets,
                assetBasePath,
                ioUtils,
                createID,
                translate,
                buildEpub,
                renderWideTable,
                renderImageToPNG,
                renderMathToPNG,
            });
        },
    };
}

async function pickEpubDirectory({ createFilePicker, translate, ownerWindow }) {
    const picker = createFilePicker();
    if (!picker?.init || typeof picker.show !== 'function'
        || picker.modeGetFolder == null) {
        throw new Error(translate('viewer.exportEpubFailed'));
    }
    picker.init(
        ownerWindow,
        translate('viewer.exportEpubDialogTitle'),
        picker.modeGetFolder
    );
    const result = await picker.show();
    if (result === picker.returnCancel) return null;
    const directory = String(picker.file || '');
    if (!directory) throw new Error(translate('viewer.exportEpubFailed'));
    return directory;
}

async function pickEpubPath({ createFilePicker, translate, ownerWindow, title }) {
    const picker = createFilePicker();
    if (!picker?.init || typeof picker.show !== 'function'
        || picker.modeSave == null) {
        throw new Error(translate('viewer.exportEpubFailed'));
    }
    picker.init(
        ownerWindow,
        translate('viewer.exportEpubDialogTitle'),
        picker.modeSave
    );
    const stem = createEpubStem(title, translate);
    picker.defaultString = `${stem}.epub`;
    picker.appendFilter?.(
        translate('viewer.exportEpubFilter'),
        '*.epub'
    );
    const result = await picker.show();
    if (result === picker.returnCancel) return null;
    let filePath = String(picker.file || '');
    if (!filePath) throw new Error(translate('viewer.exportEpubFailed'));
    if (!/\.epub$/iu.test(filePath)) filePath += '.epub';
    return filePath;
}

function createEpubStem(title, translate) {
    return createMarkdownExportDirectoryName(
        title,
        translate('viewer.exportEpubDefaultFileName')
    );
}

// Windows rejects a native path longer than 259 characters, and EPUB writes a
// temporary sibling with a random suffix, so a long paper title has to be
// shortened before the write instead of failing on it.
const EPUB_TEMPORARY_SUFFIX = '.mktero-xxxxxxxx.tmp';

function constrainEpubStem({ directory, title, translate, pathUtils, isWindows }) {
    const stem = createEpubStem(title, translate);
    if (!isWindows) return stem;
    try {
        return constrainExportFileNameStem({
            preferredName: stem,
            extension: 'epub',
            parentPath: directory,
            join: (...parts) => pathUtils.join(...parts),
            temporarySuffix: EPUB_TEMPORARY_SUFFIX,
        });
    }
    catch {
        throw new Error(translate('viewer.exportEpubFailed'));
    }
}

async function createAvailableEpubPath({
    directory,
    stem,
    used,
    ioUtils,
    pathUtils,
    translate,
}) {
    for (let index = 1; index <= MAX_EXPORT_COLLISION_INDEX; index += 1) {
        const name = index === 1 ? stem : `${stem}-${index}`;
        const filePath = pathUtils.join(directory, `${name}.epub`);
        if (used.has(filePath)) continue;
        if (await epubPathExists(filePath, ioUtils)) continue;
        return filePath;
    }
    throw new Error(translate('viewer.exportEpubFailed'));
}

// IOUtils.exists() throws instead of returning false for a path the platform
// cannot parse, and that parse error is not the same thing as a real one.
async function epubPathExists(filePath, ioUtils) {
    if (typeof ioUtils.exists !== 'function') return false;
    try {
        return Boolean(await ioUtils.exists(filePath));
    }
    catch (error) {
        if (isUnrecognizedPath(error)) return false;
        throw error;
    }
}

function isUnrecognizedPath(error) {
    const message = String(error?.message || '');
    return error?.name === 'OperationError'
        && message.includes('NS_ERROR_FILE_UNRECOGNIZED_PATH');
}

async function writeEpubFile({
    filePath,
    title,
    language,
    markdown,
    assets,
    assetBasePath,
    ioUtils,
    createID,
    translate,
    buildEpub,
    renderWideTable,
    renderImageToPNG,
    renderMathToPNG,
}) {
    const archive = await buildEpub({
        title,
        language,
        markdown,
        assets,
        assetBasePath,
        renderWideTable,
        renderImageToPNG,
        renderMathToPNG,
    });
    if (!(archive instanceof Uint8Array) || !archive.byteLength) {
        throw new Error(translate('viewer.exportEpubFailed'));
    }
    const exportID = normalizeExportID(createID());
    const temporaryPath = `${filePath}.mktero-${exportID.slice(0, 8)}.tmp`;
    await ioUtils.write(filePath, archive, { tmpPath: temporaryPath });
    return {
        status: 'exported',
        path: filePath,
        byteLength: archive.byteLength,
    };
}

function normalizeExportID(value) {
    const id = String(value || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
        throw new Error('The EPUB export request ID is invalid');
    }
    return id;
}
