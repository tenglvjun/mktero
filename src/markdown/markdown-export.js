import { GFM, parser } from '@lezer/markdown';
import { toUint8Array } from '../mineru/binary.js';

export const MAX_EXPORT_FILE_STEM_CODE_POINTS = 180;
export const MAX_EXPORT_MARKDOWN_BYTES = 50 * 1024 * 1024;
export const MAX_EXPORT_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_EXPORT_TOTAL_ASSET_BYTES = 150 * 1024 * 1024;
export const MAX_EXPORT_ASSETS = 2_000;
// Windows CreateFile fails at 260 characters with NS_ERROR_FILE_NOT_FOUND.
export const MAX_WINDOWS_EXPORT_PATH_LENGTH = 259;
export const MAX_WINDOWS_PATH_COMPONENT_LENGTH = 255;
export const EXPORT_DIRECTORY_COLLISION_RESERVE = '-1000';
const RESERVED_WINDOWS_FILE_STEMS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MARKDOWN_PARSER = parser.configure(GFM);

export function createMarkdownExportDirectoryName(
    title,
    fallbackTitle = 'Mktero'
) {
    return normalizeExportFileStem(title)
        || normalizeExportFileStem(fallbackTitle)
        || 'Mktero';
}

export function createMarkdownExportFileName(title, fallbackTitle = 'Mktero') {
    return createMarkdownExportDirectoryName(title, fallbackTitle) + '.md';
}

export function markdownExportTemporarySuffix(exportID) {
    return `.mktero-${String(exportID).slice(0, 8)}.tmp`;
}

export function usesWindowsPathSeparator(join) {
    if (typeof join !== 'function') {
        throw new TypeError('A path join function is required');
    }
    return join('a', 'b') === 'a\\b';
}

export function exportDirectoryPathsFit(directoryName, {
    parentPath,
    join,
    temporarySuffix,
    fileStemsFor = name => [name],
    assetRelativePaths = [],
    maxPathLength = MAX_WINDOWS_EXPORT_PATH_LENGTH,
    maxComponentLength = MAX_WINDOWS_PATH_COMPONENT_LENGTH,
}) {
    if (typeof join !== 'function') {
        throw new TypeError('A path join function is required');
    }
    if (!componentFits(directoryName, maxComponentLength)) return false;
    const fileStems = fileStemsFor(directoryName);
    if (!Array.isArray(fileStems) || !fileStems.length) return false;
    for (const fileStem of fileStems) {
        const fileName = `${fileStem}.md${temporarySuffix}`;
        if (!componentFits(fileStem, maxComponentLength)
            || !componentFits(fileName, maxComponentLength)
            || join(parentPath, directoryName, fileName).length
                > maxPathLength) {
            return false;
        }
    }
    for (const relativePath of assetRelativePaths) {
        const segments = String(relativePath || '').split('/');
        if (!segments.length
            || segments.some(segment => (
                !componentFits(segment, maxComponentLength)
            ))
            || join(
                parentPath,
                directoryName,
                'assets',
                ...segments
            ).length > maxPathLength) {
            return false;
        }
    }
    return join(parentPath, directoryName).length <= maxPathLength;
}

export function constrainExportDirectoryName({
    preferredName,
    collisionReserve = EXPORT_DIRECTORY_COLLISION_RESERVE,
    ...options
}) {
    let source = createMarkdownExportDirectoryName(
        preferredName,
        preferredName
    );
    const seen = new Set();
    while (source && !seen.has(source)) {
        seen.add(source);
        if (exportDirectoryPathsFit(source + collisionReserve, options)) {
            return source;
        }
        source = normalizeExportFileStem(
            [...source].slice(0, -1).join('')
        );
    }
    throw new Error(
        'The selected folder path is too long to export this Markdown'
    );
}

function componentFits(value, maxComponentLength) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxComponentLength
        && !value.includes('/')
        && !value.includes('\\');
}

function normalizeExportFileStem(value) {
    let stem = String(value || '').trim().replace(/\.pdf$/i, '');
    stem = stem
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[ .]+|[ .]+$/g, '');
    stem = [...stem].slice(0, MAX_EXPORT_FILE_STEM_CODE_POINTS).join('')
        .replace(/[ .]+$/g, '');
    if (RESERVED_WINDOWS_FILE_STEMS.test(stem)) stem = '_' + stem;
    return stem;
}

export function createMarkdownExportPlan({
    markdown,
    assets = [],
    assetBasePath = '',
    assetDirectoryName,
}) {
    if (typeof markdown !== 'string'
        || new TextEncoder().encode(markdown).length
            > MAX_EXPORT_MARKDOWN_BYTES) {
        throw new Error('The Markdown export source is invalid');
    }
    const directoryName = normalizeAssetDirectoryName(assetDirectoryName);
    const basePath = normalizeRelativePath(assetBasePath, { allowEmpty: true });
    const normalizedAssets = normalizeExportAssets(assets, basePath);
    const assetsByPath = new Map();
    for (const asset of normalizedAssets) {
        assetsByPath.set(asset.sourcePath, asset);
        assetsByPath.set(asset.sourceRelativePath, asset);
    }
    const replacements = normalizedAssets.length
        ? collectImageURLReplacements(
            markdown,
            basePath,
            directoryName,
            assetsByPath
        )
        : [];
    let exportedMarkdown = markdown;
    for (const replacement of replacements.sort((left, right) => (
        right.from - left.from
    ))) {
        exportedMarkdown = exportedMarkdown.slice(0, replacement.from)
            + replacement.value
            + exportedMarkdown.slice(replacement.to);
    }
    return {
        markdown: exportedMarkdown,
        assets: normalizedAssets.map(({
            sourcePath,
            sourceRelativePath,
            ...asset
        }) => asset),
    };
}

function normalizeAssetDirectoryName(value) {
    const name = String(value || '').trim();
    if (!name
        || name === '.'
        || name === '..'
        || name.includes('/')
        || name.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error('The Markdown export asset directory is invalid');
    }
    return name;
}

function normalizeExportAssets(assets, basePath) {
    if (!Array.isArray(assets) || assets.length > MAX_EXPORT_ASSETS) {
        throw new Error('The Markdown export images are invalid');
    }
    const sourcePaths = new Set();
    const sourceRelativePaths = new Set();
    const portableRelativePaths = new Set();
    let totalBytes = 0;
    return assets.map(source => {
        const sourcePath = normalizeRelativePath(source?.path);
        const sourceRelativePath = basePath
            && sourcePath.startsWith(basePath + '/')
            ? sourcePath.slice(basePath.length + 1)
            : sourcePath;
        const mimeType = String(source?.mimeType || '');
        const data = toUint8Array(source?.data, 'Markdown export image');
        totalBytes += data.length;
        if (!/^image\/[A-Za-z0-9.+-]+$/.test(mimeType)
            || data.length > MAX_EXPORT_ASSET_BYTES
            || totalBytes > MAX_EXPORT_TOTAL_ASSET_BYTES
            || sourcePaths.has(sourcePath)
            || sourceRelativePaths.has(sourceRelativePath)) {
            throw new Error('The Markdown export image metadata is invalid');
        }
        sourcePaths.add(sourcePath);
        sourceRelativePaths.add(sourceRelativePath);
        const relativePath = allocatePortableRelativePath(
            sourceRelativePath,
            portableRelativePaths
        );
        return {
            sourcePath,
            sourceRelativePath,
            relativePath,
            mimeType,
            data,
        };
    });
}

function allocatePortableRelativePath(sourcePath, usedPaths) {
    let candidate = sourcePath;
    for (
        let suffix = 2;
        usedPaths.has(portablePathKey(candidate));
        suffix += 1
    ) {
        candidate = appendPathSuffix(sourcePath, suffix);
        if (candidate.length > 1_024) {
            throw new Error('The Markdown export image path is invalid');
        }
    }
    usedPaths.add(portablePathKey(candidate));
    return candidate;
}

function portablePathKey(path) {
    return path.normalize('NFC').toLowerCase();
}

function appendPathSuffix(path, suffix) {
    const separator = path.lastIndexOf('/');
    const directory = separator < 0 ? '' : path.slice(0, separator + 1);
    const fileName = path.slice(separator + 1);
    const extension = fileName.lastIndexOf('.');
    const stemEnd = extension > 0 ? extension : fileName.length;
    return directory
        + fileName.slice(0, stemEnd)
        + `-${suffix}`
        + fileName.slice(stemEnd);
}

function collectImageURLReplacements(
    markdown,
    basePath,
    directoryName,
    assetsByPath
) {
    const replacements = [];
    const imageReferenceLabels = new Set();
    const tree = MARKDOWN_PARSER.parse(markdown);
    tree.iterate({
        enter(node) {
            if (node.name !== 'Image') return undefined;
            const url = node.node.getChild('URL');
            if (url) {
                addImageURLReplacement(
                    replacements,
                    markdown,
                    url,
                    basePath,
                    directoryName,
                    assetsByPath
                );
            }
            const normalizedLabel = url
                ? ''
                : referenceLabelForImage(node.node, markdown);
            if (normalizedLabel) imageReferenceLabels.add(normalizedLabel);
            return false;
        },
    });
    if (!imageReferenceLabels.size) return replacements;
    tree.iterate({
        enter(node) {
            if (node.name !== 'LinkReference') return undefined;
            const label = node.node.getChild('LinkLabel');
            const url = node.node.getChild('URL');
            if (!label || !url
                || !imageReferenceLabels.has(normalizeReferenceLabel(
                    markdown.slice(label.from, label.to)
                ))) {
                return false;
            }
            addImageURLReplacement(
                replacements,
                markdown,
                url,
                basePath,
                directoryName,
                assetsByPath
            );
            return false;
        },
    });
    return replacements;
}

function referenceLabelForImage(image, markdown) {
    const explicitLabel = image.getChild('LinkLabel');
    const normalizedExplicitLabel = explicitLabel
        ? normalizeReferenceLabel(
            markdown.slice(explicitLabel.from, explicitLabel.to)
        )
        : '';
    if (normalizedExplicitLabel) return normalizedExplicitLabel;
    const marks = image.getChildren('LinkMark');
    const closingAlt = marks.find(mark => (
        markdown.slice(mark.from, mark.to) === ']'
    ));
    if (!marks.length || !closingAlt) return '';
    return normalizeReferenceLabel(
        markdown.slice(marks[0].to, closingAlt.from)
    );
}

function addImageURLReplacement(
    replacements,
    markdown,
    url,
    basePath,
    directoryName,
    assetsByPath
) {
    const asset = resolveExportAsset(
        markdown.slice(url.from, url.to),
        basePath,
        assetsByPath
    );
    if (!asset) return;
    replacements.push({
        from: url.from,
        to: url.to,
        value: encodeExportPath(directoryName + '/' + asset.relativePath),
    });
}

function resolveExportAsset(href, basePath, assetsByPath) {
    let source = String(href || '').trim();
    if (source.startsWith('<') && source.endsWith('>')) {
        source = source.slice(1, -1);
    }
    source = source.split(/[?#]/, 1)[0];
    if (!source
        || /^[a-z][a-z0-9+.-]*:/i.test(source)
        || source.startsWith('/')
        || source.includes('\\')) {
        return null;
    }
    try {
        source = decodeURIComponent(source);
    }
    catch {
        return null;
    }
    if (!source
        || /^[a-z][a-z0-9+.-]*:/i.test(source)
        || source.startsWith('/')
        || source.includes('\\')
        || source.includes('\u0000')) {
        return null;
    }
    const resolvedPath = resolveAssetSourcePath(basePath, source);
    if (!resolvedPath) return null;
    let directPath = '';
    try {
        directPath = normalizeRelativePath(source);
    }
    catch {
        directPath = '';
    }
    return assetsByPath.get(resolvedPath)
        || assetsByPath.get(directPath)
        || null;
}

function resolveAssetSourcePath(basePath, relativePath) {
    const segments = basePath ? basePath.split('/') : [];
    for (const segment of relativePath.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!segments.length) return null;
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    const resolved = segments.join('/');
    return resolved && resolved.length <= 1_024 ? resolved : null;
}

function normalizeReferenceLabel(value) {
    return String(value)
        .replace(/^\[|\]$/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function normalizeRelativePath(value, { allowEmpty = false } = {}) {
    const source = String(value || '');
    if ((!source && !allowEmpty)
        || source.startsWith('/')
        || source.includes('\\')
        || source.includes('\u0000')) {
        throw new Error('The Markdown export image path is invalid');
    }
    const segments = [];
    for (const segment of source.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            throw new Error('The Markdown export image path escapes its root');
        }
        segments.push(segment);
    }
    const normalized = segments.join('/');
    if ((!normalized && !allowEmpty) || normalized.length > 1_024) {
        throw new Error('The Markdown export image path is invalid');
    }
    return normalized;
}

function encodeExportPath(path) {
    return path.split('/').map(segment => (
        encodeURIComponent(segment).replace(/[()]/g, character => (
            '%' + character.codePointAt(0).toString(16).toUpperCase()
        ))
    )).join('/');
}
