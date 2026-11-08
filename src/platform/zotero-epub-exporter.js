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
        async export({
            ownerWindow,
            title,
            markdown,
            assets,
            assetBasePath,
            language = 'en',
        } = {}) {
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
            if (result === picker.returnCancel) return { status: 'cancelled' };
            let filePath = String(picker.file || '');
            if (!filePath) throw new Error(translate('viewer.exportEpubFailed'));
            if (!/\.epub$/iu.test(filePath)) filePath += '.epub';

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
        },
    };
}

function normalizeExportID(value) {
    const id = String(value || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
        throw new Error('The EPUB export request ID is invalid');
    }
    return id;
}
