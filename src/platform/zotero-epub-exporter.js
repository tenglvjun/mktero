import { createEpub } from '../epub/epub-export.js';
import { translateEnglish } from '../i18n/localization.js';
import { createMarkdownExportDirectoryName } from '../markdown/markdown-export.js';

export function createZoteroEpubExporter({
    createFilePicker,
    ioUtils,
    createID,
    renderWideTable,
    renderImageToPNG,
    renderMathToPNG,
    translate = translateEnglish,
    buildEpub = createEpub,
} = {}) {
    if (typeof createFilePicker !== 'function') {
        throw new TypeError('A Zotero file picker factory is required');
    }
    if (typeof ioUtils?.write !== 'function') {
        throw new TypeError('Zotero binary file I/O is required');
    }
    if (typeof createID !== 'function') {
        throw new TypeError('An EPUB export ID factory is required');
    }
    if (typeof buildEpub !== 'function') {
        throw new TypeError('An EPUB builder is required');
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
                const filePath = await createAvailableEpubPath({
                    directory,
                    title,
                    // A batch passes one shared set so two documents with the
                    // same title do not both claim `Paper.epub`.
                    used: usedPaths instanceof Set ? usedPaths : new Set(),
                    ioUtils,
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
    const stem = createMarkdownExportDirectoryName(
        title,
        translate('viewer.exportEpubDefaultFileName')
    );
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

// The folder join goes through a tiny local helper rather than a new path
// adapter, because the exporter already writes to whatever the picker returns.
async function createAvailableEpubPath({
    directory,
    title,
    used,
    ioUtils,
    translate,
}) {
    const stem = createMarkdownExportDirectoryName(
        title,
        translate('viewer.exportEpubDefaultFileName')
    );
    for (let index = 1; index <= 1_000; index += 1) {
        const name = index === 1 ? stem : `${stem}-${index}`;
        const filePath = `${directory}/${name}.epub`;
        if (used.has(filePath)) continue;
        if (typeof ioUtils.exists === 'function' && await ioUtils.exists(filePath)) {
            continue;
        }
        return filePath;
    }
    throw new Error(translate('viewer.exportEpubFailed'));
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
