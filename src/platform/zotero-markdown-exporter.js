import {
    constrainExportDirectoryName,
    createMarkdownExportDirectoryName,
    createMarkdownExportPlan,
    markdownExportTemporarySuffix,
    usesWindowsPathSeparator,
} from '../markdown/markdown-export.js';
import { translateEnglish } from '../i18n/localization.js';

export function createZoteroMarkdownExporter({
    createFilePicker,
    ioUtils,
    pathUtils,
    createID,
    translate = translateEnglish,
}) {
    if (typeof createFilePicker !== 'function') {
        throw new TypeError('A Zotero file picker factory is required');
    }
    if (!ioUtils || !pathUtils) {
        throw new TypeError('Zotero file adapters are required');
    }
    if (typeof createID !== 'function') {
        throw new TypeError('A Markdown export ID factory is required');
    }
    return {
        async export({ ownerWindow, title, markdown, assets, assetBasePath }) {
            const picker = createFilePicker();
            picker.init(
                ownerWindow,
                translate('viewer.exportMarkdownDialogTitle'),
                picker.modeGetFolder
            );
            const result = await picker.show();
            if (result === picker.returnCancel) {
                return { status: 'cancelled' };
            }
            const selectedDirectory = String(picker.file || '');
            if (!selectedDirectory) {
                throw new Error('The Markdown export directory is unavailable');
            }
            const plan = createMarkdownExportPlan({
                markdown,
                assets,
                assetBasePath,
                assetDirectoryName: 'assets',
            });
            const exportID = normalizeExportID(createID());
            const temporarySuffix = markdownExportTemporarySuffix(exportID);
            const join = (...parts) => pathUtils.join(...parts);
            let preferredDocumentName = createMarkdownExportDirectoryName(
                title,
                translate('viewer.exportMarkdownDefaultFileName')
            );
            if (usesWindowsPathSeparator(join)) {
                preferredDocumentName = constrainExportDirectoryName({
                    preferredName: preferredDocumentName,
                    parentPath: selectedDirectory,
                    join,
                    temporarySuffix,
                    assetRelativePaths: plan.assets.map(asset => (
                        asset.relativePath
                    )),
                });
            }
            let directoryPath = null;
            let outputPath = null;
            let assetDirectoryPath = null;
            let temporaryMarkdownPath = null;
            let createdDocumentDirectory = false;
            try {
                const available = await createAvailableExportDirectory({
                    directory: selectedDirectory,
                    preferredName: preferredDocumentName,
                    ioUtils,
                    pathUtils,
                });
                directoryPath = available.path;
                createdDocumentDirectory = true;
                outputPath = pathUtils.join(
                    directoryPath,
                    available.name + '.md'
                );
                temporaryMarkdownPath = outputPath + temporarySuffix;
                if (plan.assets.length) {
                    assetDirectoryPath = pathUtils.join(directoryPath, 'assets');
                    await ioUtils.makeDirectory(assetDirectoryPath, {
                        ignoreExisting: false,
                    });
                    await writeExportAssets(
                        assetDirectoryPath,
                        plan.assets,
                        ioUtils,
                        pathUtils
                    );
                }
                await ioUtils.writeUTF8(outputPath, plan.markdown, {
                    tmpPath: temporaryMarkdownPath,
                });
            }
            catch (error) {
                if (temporaryMarkdownPath) {
                    await ioUtils.remove(temporaryMarkdownPath, {
                        ignoreAbsent: true,
                    }).catch(() => {});
                }
                if (createdDocumentDirectory) {
                    await ioUtils.remove(directoryPath, {
                        recursive: true,
                        ignoreAbsent: true,
                    }).catch(() => {});
                }
                throw error;
            }
            return {
                status: 'exported',
                path: outputPath,
                assetDirectoryPath,
                assetCount: plan.assets.length,
            };
        },
    };
}

async function createAvailableExportDirectory({
    directory,
    preferredName,
    ioUtils,
    pathUtils,
}) {
    for (let index = 1; index <= 1_000; index += 1) {
        const name = index === 1
            ? preferredName
            : preferredName + '-' + index;
        const candidate = pathUtils.join(directory, name);
        if (await ioUtils.exists(candidate)) continue;
        try {
            await ioUtils.makeDirectory(candidate, {
                ignoreExisting: false,
            });
            return { name, path: candidate };
        }
        catch (error) {
            if (await ioUtils.exists(candidate)) continue;
            throw error;
        }
    }
    throw new Error('No safe Markdown export asset directory is available');
}

async function writeExportAssets(rootPath, assets, ioUtils, pathUtils) {
    const createdDirectories = new Set();
    for (const asset of assets) {
        const segments = asset.relativePath.split('/');
        if (segments.length > 1) {
            const directory = pathUtils.join(
                rootPath,
                ...segments.slice(0, -1)
            );
            if (!createdDirectories.has(directory)) {
                await ioUtils.makeDirectory(directory, {
                    ignoreExisting: true,
                });
                createdDirectories.add(directory);
            }
        }
        await ioUtils.write(
            pathUtils.join(rootPath, ...segments),
            asset.data
        );
    }
}

function normalizeExportID(value) {
    const id = String(value || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        throw new Error('The Markdown export request ID is invalid');
    }
    return id;
}
