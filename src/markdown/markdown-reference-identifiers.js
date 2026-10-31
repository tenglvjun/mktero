import { normalizeMarkdownLinkURL } from './markdown-links.js';
import {
    normalizeArxivID,
    normalizeDOI,
} from '../citations/citation-identifiers.js';

const MAX_REFERENCE_LENGTH = 16 * 1024;
const MAX_IDENTIFIER_LENGTH = 4_096;
const MAX_PDF_URL_LENGTH = 2_048;

const DOI_TOKEN_PATTERN = /(?:^|[\s(<\[])(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/)[ \t\r\n]*([!#$%&'*+./0-9:;<=>?@A-Z[\]^_`a-z{|}~-]+)/igu;
const ARXIV_TOKEN_PATTERN = /(?:^|[\s(<\[])(?:arxiv(?:\s+id)?\s*:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)([^\s)\]>},;]+)/igu;
const PMID_TOKEN_PATTERN = /\b(?:pmid|pubmed\s+id|medline)\s*[:#]?\s*(\d{1,12})\b/iu;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/igu;
const MARKDOWN_LINK_PATTERN = /\[((?:\\.|[^\]\n])*)\]\(((?:\\.|[^)\n])*)\)/gu;

/**
 * Extract bounded, normalized identity hints from a bibliographic reference.
 * This function intentionally does not infer identity from ordinary numbers.
 */
export function extractReferenceIdentifiers(text) {
    const source = boundedString(text, MAX_REFERENCE_LENGTH);
    if (!source) {
        return emptyIdentifiers();
    }

    const doi = firstDOI(source);
    const arxivID = firstNormalized(
        source,
        ARXIV_TOKEN_PATTERN,
        normalizeArxivID
    );
    const pmid = normalizePMID(source.match(PMID_TOKEN_PATTERN)?.[1]);
    const pdfURL = findPDFURL(source);

    return { doi, arxivID, pmid, pdfURL };
}

function firstNormalized(source, pattern, normalize) {
    for (const match of source.matchAll(pattern)) {
        const value = normalize(stripTrailingPunctuation(
            boundedString(match[1], MAX_IDENTIFIER_LENGTH)
        ));
        if (value) return value;
    }
    return '';
}

function firstDOI(source) {
    for (const match of source.matchAll(DOI_TOKEN_PATTERN)) {
        const value = normalizeDOI(stripTrailingPunctuation(
            `${match[1]}${match[2]}`
        ));
        if (value) return value;
    }
    return '';
}

function normalizePMID(value) {
    const normalized = boundedString(value, MAX_IDENTIFIER_LENGTH).trim();
    return /^\d{1,12}$/.test(normalized) ? normalized : '';
}

function findPDFURL(source) {
    const searchable = source.replace(MARKDOWN_LINK_PATTERN, (match, label, destination) => (
        `${label} ${normalizeMarkdownLinkURL(destination)}`
    ));
    for (const match of searchable.matchAll(URL_PATTERN)) {
        if (match[0].length > MAX_PDF_URL_LENGTH) continue;
        const candidate = stripTrailingPunctuation(
            normalizeMarkdownLinkURL(match[0])
        );
        if (!isHTTPURL(candidate)) continue;
        let url;
        try {
            url = new URL(candidate);
        }
        catch {
            continue;
        }
        if (!url.hostname || url.username || url.password
            || !looksLikePDFURL(url)) continue;
        url.hash = '';
        return url.toString();
    }
    return '';
}

function looksLikePDFURL(url) {
    if (/\.pdf$/iu.test(url.pathname)) return true;
    for (const key of ['format', 'type', 'download', 'filetype']) {
        if (url.searchParams.get(key)?.toLowerCase() === 'pdf') return true;
    }
    return false;
}

function stripTrailingPunctuation(value) {
    return value.replace(/[.,;:!?)}\]}>]+$/u, '');
}

function isHTTPURL(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
}

function boundedString(value, maximum) {
    return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function emptyIdentifiers() {
    return {
        doi: '',
        arxivID: '',
        pmid: '',
        pdfURL: '',
    };
}
