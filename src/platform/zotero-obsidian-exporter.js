import { sha256Hex } from '../core/sha256.js';
import {
    createMarkdownExportDirectoryName,
    createMarkdownExportPlan,
    MAX_EXPORT_MARKDOWN_BYTES,
} from '../markdown/markdown-export.js';
import {
    createObsidianCollisionDirectoryName,
    createObsidianDocumentMetadata,
    createObsidianNote,
    createObsidianVersionFileStem,
    decideObsidianOverwrite,
    OBSIDIAN_LANGUAGE_LABELS,
    parseObsidianNote,
    resolveObsidianOutputRoot,
    separateObsidianImageCaptions,
} from '../markdown/obsidian-note.js';
import { translateEnglish } from '../i18n/localization.js';

const INDEX_VERSION = 1;
const MAX_INDEX_ENTRIES = 5_000;
const MAX_NOTE_BYTES = MAX_EXPORT_MARKDOWN_BYTES + (64 * 1024);
const BODY_HASH = /^[a-f0-9]{64}$/;
const DIRECTORY_NAME = /^(?!\.\.?$)[^<>:"/\\|?*\u0000-\u001f\u007f]{1,180}$/;

export function createZoteroObsidianExporter({
    createFilePicker,
    ioUtils,
    pathUtils,
    createID,
    translate = translateEnglish,
    getVaultPath,
    setVaultPath,
    getSubdirectory,
    profilePath,
    getProfilePath = () => profilePath,
    confirmOverwrite,
    now = () => new Date(),
    hashBody = hashMarkdownBody,
}) {
    if (typeof createFilePicker !== 'function') {
        throw new TypeError('A Zotero file picker factory is required');
    }
    if (!ioUtils || !pathUtils) {
        throw new TypeError('Zotero file adapters are required');
    }
    if (typeof createID !== 'function') {
        throw new TypeError('An Obsidian export ID factory is required');
    }
    if (typeof getVaultPath !== 'function'
        || typeof setVaultPath !== 'function'
        || typeof getSubdirectory !== 'function') {
        throw new TypeError('Obsidian vault preferences are required');
    }
    if (typeof confirmOverwrite !== 'function') {
        throw new TypeError('An Obsidian overwrite confirmation is required');
    }
    if (typeof getProfilePath !== 'function') {
        throw new TypeError('An Obsidian export profile path is required');
    }
    return {
        async export({
            ownerWindow,
            title,
            markdown,
            assets,
            assetBasePath,
            metadata,
            translations = [],
        }) {
            const vaultPath = await resolveVaultPath({
                ownerWindow,
                createFilePicker,
                ioUtils,
                pathUtils,
                translate,
                getVaultPath,
                setVaultPath,
            });
            if (!vaultPath) return { status: 'cancelled' };
            const { outputRoot } = resolveObsidianOutputRoot(
                vaultPath,
                getSubdirectory(),
                pathUtils.join
            );
            const noteMetadata = createObsidianDocumentMetadata({
                ...metadata,
                title: metadata?.title || title,
                exportedAt: now(),
            });
            const versions = obsidianExportVersions(markdown, translations);
            const originalPlan = createMarkdownExportPlan({
                markdown: versions[0].markdown,
                assets,
                assetBasePath,
                assetDirectoryName: 'assets',
            });
            const profile = getProfilePath();
            if (!profile) {
                throw new Error('The Zotero profile directory is unavailable');
            }
            const index = createObsidianExportIndex({
                rootPath: pathUtils.join(profile, 'mktero-obsidian', 'v1'),
                ioUtils,
                pathUtils,
            });
            const identity = `${noteMetadata.library}:${noteMetadata.item}`;
            const indexRecord = await index.get(identity);
            const preferred = createMarkdownExportDirectoryName(
                noteMetadata.title,
                translate('viewer.exportMarkdownDefaultFileName')
            );
            const directoryName = await chooseDirectoryName({
                outputRoot,
                preferred,
                identity: noteMetadata,
                indexRecord,
                ioUtils,
                pathUtils,
            });
            const directoryPath = pathUtils.join(outputRoot, directoryName);
            const prepared = [];
            for (const version of versions) {
                const plan = version.language === 'original'
                    ? originalPlan
                    : createMarkdownExportPlan({
                        markdown: version.markdown,
                        assets,
                        assetBasePath,
                        assetDirectoryName: 'assets',
                    });
                const exportedBody = separateObsidianImageCaptions(plan.markdown);
                const fileStem = createObsidianVersionFileStem(
                    directoryName,
                    version.language
                );
                const outputPath = pathUtils.join(directoryPath, fileStem + '.md');
                const existingMarkdown = await readExistingNote(
                    ioUtils,
                    outputPath
                );
                const existingNote = existingMarkdown == null
                    ? null
                    : await existingNoteRecord(existingMarkdown, hashBody);
                const nextBodyHash = await hashBody(exportedBody);
                const decision = decideObsidianOverwrite({
                    existing: existingNote,
                    identity: {
                        library: noteMetadata.library,
                        item: noteMetadata.item,
                    },
                    previousBodyHash: previousVersionHash(
                        indexRecord,
                        version.language
                    ),
                    nextBodyHash,
                });
                prepared.push({
                    language: version.language,
                    outputPath,
                    exportedBody,
                    nextBodyHash,
                    decision,
                    write: decision !== 'confirm',
                });
            }
            for (const version of prepared) {
                if (version.decision !== 'confirm') continue;
                version.write = Boolean(await confirmOverwrite({
                    ownerWindow,
                    path: version.outputPath,
                }));
            }
            if (!prepared.some(version => version.write)) {
                return { status: 'cancelled' };
            }
            const exportID = normalizeExportID(createID());
            const createdDirectory = !await ioUtils.exists(directoryPath);
            let assetDirectoryPath = null;
            const temporaryPaths = [];
            try {
                await ioUtils.makeDirectory(outputRoot, { ignoreExisting: true });
                await ioUtils.makeDirectory(directoryPath, {
                    ignoreExisting: true,
                });
                if (originalPlan.assets.length) {
                    assetDirectoryPath = pathUtils.join(directoryPath, 'assets');
                    await ioUtils.makeDirectory(assetDirectoryPath, {
                        ignoreExisting: true,
                    });
                    await writeExportAssets(
                        assetDirectoryPath,
                        originalPlan.assets,
                        ioUtils,
                        pathUtils
                    );
                }
                for (const version of prepared) {
                    if (!version.write) continue;
                    const temporaryMarkdownPath = version.outputPath
                        + '.mktero-' + exportID + '.tmp';
                    temporaryPaths.push(temporaryMarkdownPath);
                    const versionMetadata = {
                        ...noteMetadata,
                        view: version.language,
                    };
                    await ioUtils.writeUTF8(
                        version.outputPath,
                        createObsidianNote(
                            versionMetadata,
                            version.exportedBody
                        ),
                        { tmpPath: temporaryMarkdownPath }
                    );
                }
            }
            catch (error) {
                await Promise.all(temporaryPaths.map(path => (
                    ioUtils.remove(path, { ignoreAbsent: true }).catch(() => {})
                )));
                if (createdDirectory) {
                    await ioUtils.remove(directoryPath, {
                        recursive: true,
                        ignoreAbsent: true,
                    }).catch(() => {});
                }
                throw error;
            }
            const storedVersions = { ...(indexRecord?.versions || {}) };
            for (const version of prepared) {
                if (!version.write) continue;
                storedVersions[version.language] = {
                    bodyHash: version.nextBodyHash,
                };
            }
            await index.put(identity, {
                directoryName,
                versions: storedVersions,
            });
            const original = prepared.find(version => (
                version.language === 'original'
            ));
            return {
                status: 'exported',
                path: original?.write
                    ? original.outputPath
                    : prepared.find(version => version.write).outputPath,
                assetDirectoryPath,
                assetCount: originalPlan.assets.length,
                versions: prepared.map(version => ({
                    language: version.language,
                    path: version.outputPath,
                    status: version.write ? 'exported' : 'cancelled',
                })),
            };
        },
    };
}

function obsidianExportVersions(markdown, translations) {
    if (typeof markdown !== 'string') {
        throw new Error('The Obsidian note body is invalid');
    }
    const versions = [{ language: 'original', markdown }];
    const seen = new Set();
    for (const translation of Array.isArray(translations) ? translations : []) {
        const language = String(translation?.language || '');
        if (!OBSIDIAN_LANGUAGE_LABELS[language] || seen.has(language)) continue;
        if (typeof translation.markdown !== 'string' || !translation.markdown) {
            continue;
        }
        seen.add(language);
        versions.push({ language, markdown: translation.markdown });
    }
    return versions;
}

function previousVersionHash(indexRecord, language) {
    return indexRecord?.versions?.[language]?.bodyHash
        || (language === 'original' ? indexRecord?.bodyHash : '')
        || '';
}

function normalizeStoredVersions(record) {
    const versions = {};
    const source = record?.versions;
    if (source && typeof source === 'object' && !Array.isArray(source)) {
        for (const [language, version] of Object.entries(source)) {
            if (language !== 'original'
                && !OBSIDIAN_LANGUAGE_LABELS[language]) {
                continue;
            }
            if (!BODY_HASH.test(version?.bodyHash || '')) continue;
            versions[language] = { bodyHash: version.bodyHash };
        }
    }
    if (!versions.original && BODY_HASH.test(record?.bodyHash || '')) {
        versions.original = { bodyHash: record.bodyHash };
    }
    return versions;
}

export function createObsidianExportIndex({ rootPath, ioUtils, pathUtils }) {
    const filePath = pathUtils.join(rootPath, 'index.json');
    return {
        async get(identity) {
            const index = await readIndex(ioUtils, filePath);
            const record = index.entries[identity];
            if (!record || !DIRECTORY_NAME.test(record.directoryName || '')) {
                return null;
            }
            const versions = normalizeStoredVersions(record);
            return {
                directoryName: record.directoryName,
                bodyHash: versions.original?.bodyHash || '',
                versions,
            };
        },
        async put(identity, record) {
            const versions = normalizeStoredVersions(record);
            if (!/^\d+:[A-Z0-9]{8}$/.test(identity)
                || !DIRECTORY_NAME.test(record?.directoryName || '')
                || !Object.keys(versions).length) {
                throw new Error('The Obsidian export index record is invalid');
            }
            const index = await readIndex(ioUtils, filePath);
            index.entries[identity] = {
                directoryName: record.directoryName,
                versions,
            };
            if (Object.keys(index.entries).length > MAX_INDEX_ENTRIES) {
                throw new Error('The Obsidian export index is full');
            }
            await ioUtils.makeDirectory(rootPath, { ignoreExisting: true });
            await ioUtils.writeUTF8(filePath, JSON.stringify(index), {
                tmpPath: filePath + '.tmp',
            });
        },
    };
}

async function resolveVaultPath({
    ownerWindow,
    createFilePicker,
    ioUtils,
    pathUtils,
    translate,
    getVaultPath,
    setVaultPath,
}) {
    const saved = String(getVaultPath() || '').trim();
    if (saved && await isObsidianVault(saved, ioUtils, pathUtils)) return saved;
    const picker = createFilePicker();
    picker.init(
        ownerWindow,
        translate('viewer.exportObsidianDialogTitle'),
        picker.modeGetFolder
    );
    const result = await picker.show();
    if (result === picker.returnCancel) return '';
    const selected = String(picker.file || '').trim();
    if (!selected) throw new Error('The Obsidian vault is unavailable');
    if (!await isObsidianVault(selected, ioUtils, pathUtils)) {
        throw new Error('The selected folder is not an Obsidian vault');
    }
    setVaultPath(selected);
    return selected;
}

async function isObsidianVault(vaultPath, ioUtils, pathUtils) {
    return Boolean(await ioUtils.exists(pathUtils.join(vaultPath, '.obsidian')));
}

async function chooseDirectoryName({
    outputRoot,
    preferred,
    identity,
    indexRecord,
    ioUtils,
    pathUtils,
}) {
    const indexed = indexRecord?.directoryName;
    if (DIRECTORY_NAME.test(indexed || '')) {
        const indexedPath = pathUtils.join(outputRoot, indexed);
        const originalNote = pathUtils.join(indexedPath, indexed + '.md');
        if (!await ioUtils.exists(indexedPath)
            || !await ioUtils.exists(originalNote)
            || await noteMatches(
                outputRoot,
                indexed,
                identity,
                ioUtils,
                pathUtils
            )) {
            return indexed;
        }
    }
    if (await directoryAvailable(
        outputRoot,
        preferred,
        identity,
        ioUtils,
        pathUtils
    )) {
        return preferred;
    }
    const suffixed = createObsidianCollisionDirectoryName(
        preferred,
        identity.item,
        preferred
    );
    if (suffixed !== preferred && await directoryAvailable(
        outputRoot,
        suffixed,
        identity,
        ioUtils,
        pathUtils
    )) {
        return suffixed;
    }
    throw new Error('The Obsidian export folder is already used');
}

async function directoryAvailable(
    outputRoot,
    directoryName,
    identity,
    ioUtils,
    pathUtils
) {
    const directoryPath = pathUtils.join(outputRoot, directoryName);
    if (!await ioUtils.exists(directoryPath)) return true;
    return noteMatches(
        outputRoot,
        directoryName,
        identity,
        ioUtils,
        pathUtils
    );
}

async function noteMatches(
    outputRoot,
    directoryName,
    identity,
    ioUtils,
    pathUtils
) {
    const notePath = pathUtils.join(
        outputRoot,
        directoryName,
        directoryName + '.md'
    );
    const markdown = await readExistingNote(ioUtils, notePath);
    const parsed = markdown == null ? null : parseObsidianNote(markdown);
    return parsed?.library === identity.library && parsed?.item === identity.item;
}

async function readExistingNote(ioUtils, notePath) {
    if (!await ioUtils.exists(notePath)) return null;
    const markdown = await ioUtils.readUTF8(notePath);
    if (typeof markdown !== 'string'
        || new TextEncoder().encode(markdown).length > MAX_NOTE_BYTES) {
        throw new Error('The Obsidian note is invalid');
    }
    return markdown;
}

async function existingNoteRecord(markdown, hashBody) {
    const parsed = parseObsidianNote(markdown);
    if (!parsed) return { library: '', item: '', bodyHash: '' };
    return {
        library: parsed.library,
        item: parsed.item,
        bodyHash: await hashBody(parsed.body),
    };
}

async function readIndex(ioUtils, filePath) {
    if (!await ioUtils.exists(filePath)) {
        return { version: INDEX_VERSION, entries: {} };
    }
    let parsed;
    try {
        parsed = JSON.parse(await ioUtils.readUTF8(filePath));
    }
    catch {
        throw new Error('The Obsidian export index is invalid');
    }
    if (parsed?.version !== INDEX_VERSION
        || !parsed.entries
        || typeof parsed.entries !== 'object'
        || Array.isArray(parsed.entries)) {
        throw new Error('The Obsidian export index is invalid');
    }
    return {
        version: INDEX_VERSION,
        entries: parsed.entries,
    };
}

async function writeExportAssets(rootPath, assets, ioUtils, pathUtils) {
    const createdDirectories = new Set();
    for (const asset of assets) {
        const segments = asset.relativePath.split('/');
        if (segments.length > 1) {
            const directory = pathUtils.join(rootPath, ...segments.slice(0, -1));
            if (!createdDirectories.has(directory)) {
                await ioUtils.makeDirectory(directory, { ignoreExisting: true });
                createdDirectories.add(directory);
            }
        }
        await ioUtils.write(
            pathUtils.join(rootPath, ...segments),
            asset.data
        );
    }
}

async function hashMarkdownBody(body) {
    return sha256Hex(new TextEncoder().encode(body));
}

function normalizeExportID(value) {
    const id = String(value || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        throw new Error('The Obsidian export request ID is invalid');
    }
    return id;
}
