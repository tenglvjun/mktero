import { GFM, parser } from '@lezer/markdown';
import { createMarkdownExportDirectoryName } from './markdown-export.js';

const MARKDOWN_PARSER = parser.configure(GFM);
const MARKDOWN_ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]/;

export const DEFAULT_OBSIDIAN_SUBDIRECTORY = 'Mktero';
export const OBSIDIAN_LANGUAGE_LABELS = Object.freeze({
    'zh-CN': 'chinese',
    'zh-TW': 'traditional chinese',
    'ja-JP': 'japanese',
    'ko-KR': 'korean',
    'es-ES': 'spanish',
    'fr-FR': 'french',
    'pt-BR': 'portuguese',
});
export const OBSIDIAN_VIEWS = Object.freeze([
    'original',
    ...Object.keys(OBSIDIAN_LANGUAGE_LABELS),
]);
const MAX_AUTHORS = 32;
const MAX_TAGS = 50;
const MAX_TEXT_LENGTH = 500;
const MAX_SHORT_TEXT_LENGTH = 200;
const ITEM_KEY = /^[A-Z0-9]{8}$/;
const CITEKEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const DIRECTORY_NAME = /^(?!\.\.?$)[^<>:"/\\|?*\u0000-\u001f\u007f]{1,180}$/;

export function normalizeObsidianSubdirectory(value) {
    const name = String(value ?? '').trim();
    if (!name) return DEFAULT_OBSIDIAN_SUBDIRECTORY;
    if (!DIRECTORY_NAME.test(name) || name === '.' || name === '..') {
        throw new Error('The Obsidian export folder name is invalid');
    }
    return name;
}

export function createObsidianVersionFileStem(directoryName, language) {
    if (language === 'original') return directoryName;
    const label = OBSIDIAN_LANGUAGE_LABELS[language];
    if (!label) throw new Error('The Obsidian translation language is invalid');
    const suffix = ` - ${label}`;
    const room = 180 - [...suffix].length;
    const base = [...String(directoryName || '')]
        .slice(0, Math.max(1, room))
        .join('')
        .replace(/[ .]+$/g, '');
    return createMarkdownExportDirectoryName(base + suffix, directoryName);
}

export function createObsidianCollisionDirectoryName(title, itemKey, fallback) {
    return createMarkdownExportDirectoryName(
        `${String(title || '').trim()} ${itemKey}`.trim(),
        fallback
    );
}

export function resolveObsidianOutputRoot(vaultPath, subdirectory, join) {
    if (typeof join !== 'function') {
        throw new TypeError('A path join function is required');
    }
    const vault = String(vaultPath || '').trim();
    if (!vault) throw new Error('The Obsidian vault is unavailable');
    const folder = normalizeObsidianSubdirectory(subdirectory);
    const outputRoot = join(vault, folder);
    if (!isPathInside(vault, outputRoot)) {
        throw new Error('The Obsidian export folder escapes the vault');
    }
    return { subdirectory: folder, outputRoot };
}

export function createObsidianDocumentMetadata({
    libraryID,
    libraryType = 'user',
    groupID = '',
    itemKey,
    attachmentKey,
    title,
    creators = [],
    date = '',
    doi = '',
    extra = '',
    tags = [],
    provider = '',
    view = 'original',
    exportedAt,
}) {
    const library = normalizeLibraryID(libraryID);
    const item = normalizeItemKey(itemKey, 'Zotero item');
    const attachment = normalizeItemKey(attachmentKey, 'PDF attachment');
    const normalizedView = OBSIDIAN_VIEWS.includes(view) ? view : 'original';
    const citekey = citationKeyFromExtra(extra);
    const metadata = {
        title: boundedText(title, MAX_TEXT_LENGTH) || 'Mktero',
        authors: creatorNames(creators),
        year: documentYear(date),
        doi: boundedText(doi, MAX_SHORT_TEXT_LENGTH),
        citekey,
        tags: tagNames(tags),
        zotero: createZoteroSelectURI({
            libraryType,
            groupID,
            itemKey: item,
        }),
        library,
        item,
        attachment,
        provider: normalizeProvider(provider),
        view: normalizedView,
        exportedAt: normalizeExportedAt(exportedAt),
    };
    return metadata;
}

export function separateObsidianImageCaptions(markdown) {
    if (typeof markdown !== 'string') {
        throw new Error('The Obsidian note body is invalid');
    }
    const images = [];
    MARKDOWN_PARSER.parse(markdown).iterate({
        enter(node) {
            if (node.name !== 'Image') return undefined;
            const image = describeObsidianImage(node.node, markdown);
            if (image) images.push(image);
            return false;
        },
    });
    if (!images.length) return markdown;
    const edits = [];
    const captionsAt = new Map();
    for (const image of images) {
        edits.push({
            from: image.from,
            to: image.to,
            value: `![](${image.destination})`,
        });
        const captions = captionsAt.get(image.captionAt) || [];
        captions.push(image.caption);
        captionsAt.set(image.captionAt, captions);
    }
    for (const [position, captions] of captionsAt) {
        edits.push({
            from: position,
            to: position,
            value: `\n\n${captions.join('\n\n')}`,
        });
    }
    edits.sort((left, right) => right.from - left.from || right.to - left.to);
    let result = markdown;
    for (const edit of edits) {
        result = result.slice(0, edit.from) + edit.value + result.slice(edit.to);
    }
    return result;
}

export function createObsidianNote(metadata, body) {
    if (typeof body !== 'string') {
        throw new Error('The Obsidian note body is invalid');
    }
    return createObsidianFrontmatter(metadata) + body;
}

export function parseObsidianNote(markdown) {
    if (typeof markdown !== 'string' || !markdown.startsWith('---')) return null;
    const newline = markdown.startsWith('---\r\n') ? '\r\n' : '\n';
    if (!markdown.startsWith('---' + newline)) return null;
    const start = 3 + newline.length;
    const closing = newline + '---' + newline;
    const end = markdown.indexOf(closing, start);
    if (end < 0) return null;
    const fields = parseFrontmatterFields(markdown.slice(start, end), newline);
    return {
        library: fields['mktero-library'] || '',
        item: fields['mktero-item'] || '',
        body: markdown.slice(end + closing.length),
    };
}

export function decideObsidianOverwrite({
    existing,
    identity,
    previousBodyHash = '',
    nextBodyHash,
}) {
    if (!existing) return 'write';
    if (existing.library !== identity?.library
        || existing.item !== identity?.item) {
        return 'confirm';
    }
    if (existing.bodyHash === nextBodyHash) return 'write';
    if (previousBodyHash && existing.bodyHash === previousBodyHash) {
        return 'write';
    }
    return 'confirm';
}

export function citationKeyFromExtra(extra) {
    const match = /^(?:citation key|citationKey):\s*(\S+)\s*$/im
        .exec(String(extra || ''));
    if (!match || !CITEKEY.test(match[1])) return '';
    return match[1];
}

export function createZoteroSelectURI({
    libraryType,
    groupID,
    itemKey,
}) {
    const key = encodeURIComponent(normalizeItemKey(itemKey, 'Zotero item'));
    if (libraryType !== 'group') return `zotero://select/library/items/${key}`;
    const group = typeof groupID === 'string'
        ? groupID.trim()
        : String(groupID ?? '');
    if (!/^[1-9]\d*$/.test(group)) {
        throw new Error('Zotero group library is unavailable');
    }
    return `zotero://select/groups/${group}/items/${key}`;
}

function describeObsidianImage(image, markdown) {
    const marks = image.getChildren('LinkMark');
    const openAlt = marks.find(mark => (
        markdown.slice(mark.from, mark.to) === '!['
    ));
    const closeAlt = marks.find(mark => (
        markdown.slice(mark.from, mark.to) === ']'
    ));
    const openDestination = marks.find(mark => (
        markdown.slice(mark.from, mark.to) === '('
    ));
    const closeDestination = marks.findLast(mark => (
        markdown.slice(mark.from, mark.to) === ')'
    ));
    if (!openAlt || !closeAlt || !openDestination || !closeDestination
        || closeAlt.from < openAlt.to
        || closeDestination.from < openDestination.to) {
        return null;
    }
    const caption = unescapeMarkdownCaption(
        markdown.slice(openAlt.to, closeAlt.from)
    ).trim();
    const destination = markdown.slice(
        openDestination.to,
        closeDestination.from
    ).trim();
    if (!caption || !destination || /[\r\n()]/.test(destination)) return null;
    const paragraph = enclosingParagraph(image);
    return {
        from: image.from,
        to: image.to,
        destination,
        caption,
        captionAt: paragraph ? paragraph.to : image.to,
    };
}

function enclosingParagraph(node) {
    let current = node.parent;
    while (current) {
        if (current.name === 'Paragraph') return current;
        if (current.name === 'Document'
            || current.name === 'FencedCode'
            || current.name === 'CodeBlock') {
            return null;
        }
        current = current.parent;
    }
    return null;
}

function unescapeMarkdownCaption(value) {
    let result = '';
    for (let index = 0; index < value.length; index += 1) {
        const next = value[index + 1];
        if (value[index] === '\\' && next && MARKDOWN_ESCAPABLE.test(next)) {
            result += next;
            index += 1;
            continue;
        }
        result += value[index];
    }
    return result;
}

function createObsidianFrontmatter(metadata) {
    const lines = ['---', `title: ${yamlString(metadata.title)}`];
    lines.push(yamlList('authors', metadata.authors));
    if (metadata.year) lines.push(`year: ${metadata.year}`);
    if (metadata.doi) lines.push(`doi: ${yamlString(metadata.doi)}`);
    if (metadata.citekey) lines.push(`citekey: ${yamlString(metadata.citekey)}`);
    lines.push(yamlList('tags', metadata.tags));
    lines.push(
        `zotero: ${yamlString(metadata.zotero)}`,
        `mktero-library: ${yamlString(metadata.library)}`,
        `mktero-item: ${yamlString(metadata.item)}`,
        `mktero-attachment: ${yamlString(metadata.attachment)}`,
        `mktero-provider: ${yamlString(metadata.provider)}`,
        `mktero-view: ${yamlString(metadata.view)}`,
        `mktero-exported: ${yamlString(metadata.exportedAt)}`,
        '---',
        ''
    );
    return lines.join('\n');
}

function yamlList(name, values) {
    if (!values.length) return `${name}: []`;
    return [
        `${name}:`,
        ...values.map(value => `  - ${yamlString(value)}`),
    ].join('\n');
}

function yamlString(value) {
    return '"' + String(value)
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('\r', '\\r')
        .replaceAll('\n', '\\n')
        .replaceAll('\t', '\\t') + '"';
}

function parseFrontmatterFields(source, newline) {
    const fields = {};
    for (const line of source.split(newline)) {
        const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
        if (!match || !match[2].startsWith('"')) continue;
        fields[match[1]] = unquoteYamlString(match[2]);
    }
    return fields;
}

function unquoteYamlString(value) {
    if (!value.startsWith('"') || !value.endsWith('"')) return '';
    const inner = value.slice(1, -1);
    let result = '';
    for (let index = 0; index < inner.length; index += 1) {
        if (inner[index] !== '\\') {
            result += inner[index];
            continue;
        }
        const next = inner[index + 1];
        index += 1;
        if (next === 'n') result += '\n';
        else if (next === 'r') result += '\r';
        else if (next === 't') result += '\t';
        else if (next === '"' || next === '\\') result += next;
        else if (next) result += next;
    }
    return result;
}

function creatorNames(creators) {
    if (!Array.isArray(creators)) return [];
    const authors = creators.filter(creator => creator?.creatorType === 'author');
    const selected = authors.length ? authors : creators;
    return selected
        .slice(0, MAX_AUTHORS)
        .map(formatCreator)
        .filter(Boolean);
}

function formatCreator(creator) {
    const first = boundedText(creator?.firstName, MAX_SHORT_TEXT_LENGTH);
    const last = boundedText(creator?.lastName, MAX_SHORT_TEXT_LENGTH);
    if (first && last) return `${first} ${last}`;
    return boundedText(creator?.name || last || first, MAX_SHORT_TEXT_LENGTH);
}

function tagNames(tags) {
    if (!Array.isArray(tags)) return [];
    return tags
        .slice(0, MAX_TAGS)
        .map(tag => boundedText(
            typeof tag === 'string' ? tag : tag?.tag,
            MAX_SHORT_TEXT_LENGTH
        ))
        .filter(Boolean);
}

function documentYear(date) {
    const match = /(?:^|\D)((?:18|19|20)\d{2})(?:\D|$)/.exec(String(date || ''));
    return match ? Number(match[1]) : 0;
}

function normalizeProvider(provider) {
    const value = String(provider || '').trim().toLowerCase();
    if (value === 'mineru' || value === 'mistral') return value;
    return 'unknown';
}

function normalizeExportedAt(value) {
    const date = value instanceof Date ? value : new Date(value || 0);
    if (Number.isNaN(date.getTime())) {
        throw new Error('The Obsidian export time is invalid');
    }
    return date.toISOString();
}

function normalizeLibraryID(value) {
    const libraryID = Number(value);
    if (!Number.isSafeInteger(libraryID) || libraryID < 0) {
        throw new Error('The Zotero library is unavailable');
    }
    return String(libraryID);
}

function normalizeItemKey(value, label) {
    const key = String(value || '').trim();
    if (!ITEM_KEY.test(key)) throw new Error(`The ${label} is unavailable`);
    return key;
}

function boundedText(value, maxLength) {
    return String(value || '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function isPathInside(parent, child) {
    const parentSegments = pathSegments(parent);
    const childSegments = pathSegments(child);
    if (!parentSegments.length
        || childSegments.length < parentSegments.length) {
        return false;
    }
    return parentSegments.every((segment, index) => (
        segment === childSegments[index]
    ));
}

function pathSegments(value) {
    return String(value)
        .replace(/[\\/]+$/, '')
        .split(/[/\\]/)
        .filter(segment => segment.length > 0);
}
