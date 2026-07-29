const REFERENCE_HEADING_PATTERN = /^(?:(#{1,6})[ \t]+)?(?:\*{1,2}|_{1,2})?(?:references?|bibliography|works[ \t]+cited|literature[ \t]+cited|参考文献|参考资料|参考书目)(?:\*{1,2}|_{1,2})?[ \t]*[:：]?[ \t]*#*[ \t]*$/gim;
const MAIN_CONTENT_HEADING_PATTERN = /^(?:(?:#{1,6})[ \t]+)?(?:\*{1,2}|_{1,2})?(?:(?:\d+(?:\.\d+)*)[.)]?[ \t]+)?(?:abstract|summary|background|introduction|materials?[ \t]+and[ \t]+methods|methods?|results?|摘要|背景|引言|绪论|材料与方法|方法|结果)(?:\*{1,2}|_{1,2})?[ \t]*[:：]?[ \t]*#*[ \t]*$/gim;
const FRONT_MATTER_HEADING_PATTERN = /^(?:authors?(?:[ \t]+(?:details?|information))?|affiliations?|institutional[ \t]+affiliations?|institutions?|departments?|correspond(?:ence|ing[ \t]+authors?)|contact[ \t]+information|keywords?|作者|作者信息|作者单位|机构|所属机构|通讯作者|关键词)$/i;
const MARKDOWN_HEADING_PATTERN = /^(#{1,6})[ \t]+.+$/gm;
const NUMBERED_REFERENCE_PATTERN = /^[ \t]*(?:[-*+][ \t]+)?(?:\[(\d{1,4})\]|(\d{1,4})[.)])[ \t]+/gm;
const MIN_NUMERIC_CITATION_STYLE_CONTAINERS = 2;
const MIN_INFERRED_NUMBERED_REFERENCES = 3;
const YEAR_PATTERN = /(?:^|[^\d])((?:18|19|20)\d{2}[a-z]?)(?=$|[^\d])/i;
const UNICODE_SUPERSCRIPT_PATTERN = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s*(?:[,;，；]\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[-–—⁻]\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]+))*/g;
const WRAPPED_SUPERSCRIPT_PATTERNS = [
    /<sup(?:\s[^>]*)?>([^<>\r\n]{1,80})<\/sup\s*>/gi,
    /\$(?:\{\})?\^\{\s*([^{}\r\n]{1,80}?)\s*\}\$/g,
    /\\\((?:\{\})?\^\{\s*([^{}\r\n]{1,80}?)\s*\}\\\)/g,
];
const AUTHOR_NOTE_DECORATED_AFFILIATION_PATTERN = /^([*†‡§¶#+‖]*)(\d+|\p{L})([*†‡§¶#+‖]*)$/u;
const UNICODE_SUPERSCRIPT_CHARACTERS = {
    '⁰': '0',
    '¹': '1',
    '²': '2',
    '³': '3',
    '⁴': '4',
    '⁵': '5',
    '⁶': '6',
    '⁷': '7',
    '⁸': '8',
    '⁹': '9',
    '⁻': '-',
};

export function analyzeMarkdownCitations(markdown) {
    const source = String(markdown || '');
    const section = findReferenceSection(source);
    const references = section ? parseReferences(source, section) : [];
    const bodyEnd = section?.from ?? source.length;
    const frontMatter = analyzeFrontMatter(source, bodyEnd);
    const citations = [
        ...frontMatter.citations,
        ...findNumericCitations(
            source,
            frontMatter.bodyFrom,
            bodyEnd,
            references
        ),
        ...findAuthorYearCitations(
            source,
            frontMatter.bodyFrom,
            bodyEnd,
            references
        ),
    ].sort((left, right) => left.from - right.from || left.to - right.to);

    return {
        references,
        affiliations: frontMatter.affiliations,
        citations: removeOverlappingCitations(citations),
    };
}

function analyzeFrontMatter(markdown, bodyEnd) {
    const detectedBodyFrom = findMainContentStart(markdown, bodyEnd);
    const frontMatterEnd = detectedBodyFrom
        ?? Math.min(bodyEnd, 5000);
    const definition = parseAffiliations(markdown, frontMatterEnd);
    if (!definition.affiliations.length) {
        return {
            affiliations: [],
            citations: [],
            bodyFrom: detectedBodyFrom ?? 0,
        };
    }

    const byMarker = new Map(
        definition.affiliations.map(affiliation => [
            affiliationMarkerKey(affiliation.label),
            affiliation,
        ])
    );
    const citations = findSuperscriptMarkers(
        markdown,
        findAuthorAreaStart(markdown, definition.authorAreaEnd),
        definition.authorAreaEnd,
        { includeLikelyExponents: true }
    ).flatMap(marker => numericCitationsInText(
        marker.value,
        marker.from,
        byMarker,
        marker.markup,
        'affiliation'
    ));

    return {
        affiliations: definition.affiliations,
        citations,
        bodyFrom: detectedBodyFrom ?? definition.affiliationAreaEnd,
    };
}

function findAuthorAreaStart(markdown, authorAreaEnd) {
    const source = markdown.slice(0, authorAreaEnd);
    for (const heading of source.matchAll(new RegExp(MARKDOWN_HEADING_PATTERN))) {
        if (heading[1].length !== 1) continue;
        let from = heading.index + heading[0].length;
        if (markdown[from] === '\r') from++;
        if (markdown[from] === '\n') from++;
        return from;
    }
    return 0;
}

function findMainContentStart(markdown, bodyEnd) {
    const source = markdown.slice(0, bodyEnd);
    const pattern = new RegExp(MAIN_CONTENT_HEADING_PATTERN);
    const candidates = [];
    const recognized = pattern.exec(source);
    if (recognized) candidates.push(recognized.index);

    const headings = [...source.matchAll(new RegExp(MARKDOWN_HEADING_PATTERN))];
    for (const [index, heading] of headings.entries()) {
        const level = heading[1].length;
        const label = heading[0]
            .slice(level)
            .replace(/[ \t]+#+[ \t]*$/, '')
            .trim();
        if (index === 0 && level === 1
            && !new RegExp(MAIN_CONTENT_HEADING_PATTERN).test(heading[0])) {
            continue;
        }
        if (FRONT_MATTER_HEADING_PATTERN.test(label)) continue;
        if (new RegExp(REFERENCE_HEADING_PATTERN).test(heading[0])) continue;
        candidates.push(heading.index);
        break;
    }
    return candidates.length ? Math.min(...candidates) : null;
}

function parseAffiliations(markdown, frontMatterEnd) {
    const affiliations = [];
    const definitionRanges = [];
    let foundDefinition = false;
    const paragraphs = paragraphRanges(markdown, {
        from: 0,
        to: frontMatterEnd,
    });
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
        const markers = findSuperscriptMarkers(
            markdown,
            paragraph.from,
            paragraph.to
        ).filter(marker => affiliationMarkerKey(marker.value) !== null);
        if (!markers.length) {
            if (!foundDefinition) continue;
            const authorMarkerKeys = findAuthorAffiliationMarkerKeys(
                markdown,
                definitionRanges[0].from
            );
            const plainAffiliations = parsePlainAffiliationParagraph(
                markdown,
                paragraph,
                authorMarkerKeys,
                affiliationMarkerKey(affiliations.at(-1)?.label || ''),
                leadingAffiliationMarkerKey(
                    markdown,
                    paragraphs[paragraphIndex + 1]
                )
            );
            if (!plainAffiliations.length) break;
            affiliations.push(...plainAffiliations);
            definitionRanges.push(paragraph);
            continue;
        }
        const leading = markdown.slice(
            paragraph.from,
            markers[0].markup.wrapperFrom
        );
        if (leading.trim()) {
            if (foundDefinition) break;
            continue;
        }

        const paragraphAffiliations = [];
        for (const [index, marker] of markers.entries()) {
            let contentFrom = marker.markup.wrapperTo;
            while (contentFrom < paragraph.to
                && /\s/.test(markdown[contentFrom])) {
                contentFrom++;
            }
            const rawTo = index + 1 < markers.length
                ? markers[index + 1].markup.wrapperFrom
                : paragraph.to;
            const to = trimRangeEnd(markdown, contentFrom, rawTo);
            const text = plainReferenceText(markdown.slice(contentFrom, to));
            if (!text || !/\p{L}/u.test(text)) continue;
            const label = marker.value.trim();
            const markerKey = affiliationMarkerKey(label);
            const number = Number.isInteger(markerKey) ? markerKey : null;
            paragraphAffiliations.push({
                id: `affiliation:${markerKey}`,
                label,
                number,
                text,
                from: contentFrom,
                to,
                markerMarkup: marker.markup,
            });
        }
        if (!paragraphAffiliations.length) {
            if (foundDefinition) break;
            continue;
        }
        foundDefinition = true;
        affiliations.push(...paragraphAffiliations);
        definitionRanges.push(paragraph);
    }

    const unique = [...new Map(
        affiliations.map(affiliation => [affiliation.id, affiliation])
    ).values()];
    return {
        affiliations: unique,
        authorAreaEnd: definitionRanges.length
            ? Math.min(...definitionRanges.map(range => range.from))
            : frontMatterEnd,
        affiliationAreaEnd: definitionRanges.length
            ? Math.max(...definitionRanges.map(range => range.to))
            : frontMatterEnd,
    };
}

function findAuthorAffiliationMarkerKeys(markdown, authorAreaEnd) {
    const keys = new Set();
    const markers = findSuperscriptMarkers(
        markdown,
        findAuthorAreaStart(markdown, authorAreaEnd),
        authorAreaEnd,
        { includeLikelyExponents: true }
    );
    for (const marker of markers) {
        for (const segment of marker.value.split(/[,;，；]/)) {
            const parsed = affiliationCitationMarker(segment.trim());
            if (parsed !== null) keys.add(parsed.key);
        }
    }
    return keys;
}

function leadingAffiliationMarkerKey(markdown, paragraph) {
    if (!paragraph) return null;
    const marker = findSuperscriptMarkers(
        markdown,
        paragraph.from,
        paragraph.to
    ).find(candidate => affiliationMarkerKey(candidate.value) !== null);
    if (!marker) return null;
    const leading = markdown.slice(paragraph.from, marker.markup.wrapperFrom);
    return leading.trim() ? null : affiliationMarkerKey(marker.value);
}

function parsePlainAffiliationParagraph(
    markdown,
    paragraph,
    expectedKeys,
    previousKey,
    nextKey
) {
    const source = markdown.slice(paragraph.from, paragraph.to);
    const linePattern = /^[ \t]*([A-Za-z])[ \t]+([^\r\n]*\p{L}[^\r\n]*)$/gmu;
    const lines = [...source.matchAll(linePattern)];
    if (lines.length < 2) return [];
    let coveredTo = 0;
    for (const line of lines) {
        if (line.index !== coveredTo) return [];
        coveredTo = line.index + line[0].length;
        const newline = /^\r?\n/.exec(source.slice(coveredTo))?.[0] || '';
        coveredTo += newline.length;
    }
    if (coveredTo !== source.length) return [];
    if (typeof previousKey !== 'string' || !/^[a-z]$/.test(previousKey)) {
        return [];
    }

    const affiliations = [];
    const usedKeys = new Set();
    let expectedCodePoint = previousKey.codePointAt(0) + 1;
    for (const line of lines) {
        const label = line[1];
        const markerKey = affiliationMarkerKey(label);
        if (!expectedKeys.has(markerKey)
            || usedKeys.has(markerKey)
            || markerKey.codePointAt(0) !== expectedCodePoint) {
            return [];
        }
        usedKeys.add(markerKey);
        expectedCodePoint++;

        const markerOffset = line[0].indexOf(label);
        const markerFrom = paragraph.from + line.index + markerOffset;
        const contentOffset = line[0].indexOf(
            line[2],
            markerOffset + label.length
        );
        const contentFrom = paragraph.from + line.index + contentOffset;
        const to = trimRangeEnd(
            markdown,
            contentFrom,
            paragraph.from + line.index + line[0].length
        );
        const text = plainReferenceText(markdown.slice(contentFrom, to));
        if (!text) return [];
        affiliations.push({
            id: `affiliation:${markerKey}`,
            label,
            number: null,
            text,
            from: contentFrom,
            to,
            markerMarkup: {
                wrapperFrom: markerFrom,
                contentFrom: markerFrom,
                contentTo: markerFrom + label.length,
                wrapperTo: markerFrom + label.length,
                raiseContent: true,
            },
        });
    }
    if (typeof nextKey !== 'string'
        || nextKey.codePointAt(0) !== expectedCodePoint) {
        return [];
    }
    return affiliations;
}

function affiliationMarkerKey(value) {
    const marker = String(value).trim();
    if (/^\d+$/.test(marker)) return Number(marker);
    if (/^\p{L}$/u.test(marker)) return marker.toLocaleLowerCase('en-US');
    return null;
}

function findReferenceSection(markdown) {
    const headingPattern = new RegExp(REFERENCE_HEADING_PATTERN);
    const match = [...markdown.matchAll(headingPattern)].at(-1);
    if (!match) return inferNumberedReferenceSection(markdown);

    const level = match[1]?.length || 6;
    let from = match.index + match[0].length;
    if (markdown[from] === '\r') from++;
    if (markdown[from] === '\n') from++;
    let to = markdown.length;
    const followingHeadings = new RegExp(MARKDOWN_HEADING_PATTERN);
    followingHeadings.lastIndex = from;
    for (let heading = followingHeadings.exec(markdown); heading; heading = followingHeadings.exec(markdown)) {
        if (heading[1].length <= level) {
            to = heading.index;
            break;
        }
    }
    const explicitSection = { from, to };
    const inferredSection = inferNumberedReferenceSection(markdown);
    if (inferredSection
        && inferredSection.from >= explicitSection.to
        && !parseReferences(markdown, explicitSection).length) {
        return inferredSection;
    }
    return explicitSection;
}

function inferNumberedReferenceSection(markdown) {
    const markers = [...markdown.matchAll(
        new RegExp(NUMBERED_REFERENCE_PATTERN)
    )].filter(marker => marker[1]);
    const minimumFrom = Math.floor(markdown.length / 3);
    let inferred = null;

    for (let start = 0; start < markers.length; start++) {
        if (Number(markers[start][1]) !== 1
            || markers[start].index < minimumFrom) {
            continue;
        }
        let count = 1;
        while (start + count < markers.length
            && Number(markers[start + count][1]) === count + 1) {
            count++;
        }
        if (count >= MIN_INFERRED_NUMBERED_REFERENCES
            && hasNumberedCitationBefore(
                markdown,
                markers[start].index,
                count
            )) {
            inferred = {
                from: markers[start].index,
                to: markdown.length,
            };
        }
    }
    return inferred;
}

function hasNumberedCitationBefore(markdown, to, maximumNumber) {
    const source = markdown.slice(0, to);
    for (const match of source.matchAll(/\[(\d{1,4})\]/g)) {
        const number = Number(match[1]);
        if (number < 1 || number > maximumNumber) continue;
        const lineFrom = source.lastIndexOf('\n', match.index - 1) + 1;
        if (source.slice(lineFrom, match.index).trim()) return true;
    }
    return false;
}

function parseReferences(markdown, section) {
    const source = markdown.slice(section.from, section.to);
    const markerPattern = new RegExp(NUMBERED_REFERENCE_PATTERN);
    const markers = [...source.matchAll(markerPattern)];
    if (markers.length) {
        return markers.map((marker, index) => {
            const number = Number(marker[1] || marker[2]);
            const from = section.from + marker.index;
            const contentFrom = from + marker[0].length;
            const rawTo = index + 1 < markers.length
                ? section.from + markers[index + 1].index
                : section.to;
            const to = trimRangeEnd(markdown, contentFrom, rawTo);
            return createReference({
                id: `number:${number}`,
                number,
                text: plainReferenceText(markdown.slice(contentFrom, to)),
                from,
                to,
            });
        }).filter(reference => reference.text);
    }

    return unnumberedReferenceRanges(markdown, section)
        .map(({ from, to }, index) => createReference({
            id: `reference:${index + 1}`,
            number: null,
            text: plainReferenceText(markdown.slice(from, to)),
            from,
            to,
        }))
        .filter(reference => reference.text && reference.year);
}

function unnumberedReferenceRanges(markdown, section) {
    const paragraphs = paragraphRanges(markdown, section);
    if (paragraphs.length !== 1) return paragraphs;

    const source = markdown.slice(section.from, section.to);
    const linePattern = /^[ \t]*(?:[-*+][ \t]+)?(?=\p{L})[^\r\n]*(?:18|19|20)\d{2}[a-z]?[^\r\n]*$/gimu;
    const starts = [...source.matchAll(linePattern)];
    if (starts.length < 2) return paragraphs;

    return starts.map((start, index) => {
        let from = section.from + start.index;
        const leading = /^[ \t]*/.exec(markdown.slice(from))?.[0].length || 0;
        from += leading;
        const bullet = /^(?:[-*+][ \t]+)/.exec(markdown.slice(from))?.[0] || '';
        from += bullet.length;
        const rawTo = index + 1 < starts.length
            ? section.from + starts[index + 1].index
            : section.to;
        return { from, to: trimRangeEnd(markdown, from, rawTo) };
    });
}

function paragraphRanges(markdown, section) {
    const source = markdown.slice(section.from, section.to);
    const ranges = [];
    const blockPattern = /\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/g;
    for (const match of source.matchAll(blockPattern)) {
        const leading = /^\s*/.exec(match[0])?.[0].length || 0;
        let from = section.from + match.index + leading;
        const bullet = /^(?:[-*+][ \t]+)/.exec(markdown.slice(from))?.[0] || '';
        from += bullet.length;
        const to = trimRangeEnd(
            markdown,
            from,
            section.from + match.index + match[0].length
        );
        if (from < to) ranges.push({ from, to });
    }
    return ranges;
}

function createReference({ id, number, text, from, to }) {
    const year = extractYear(text);
    return {
        id,
        number,
        text,
        from,
        to,
        year,
        authorSearchText: normalizeSearchText(referenceAuthorText(text, year)),
    };
}

function findNumericCitations(markdown, bodyFrom, bodyEnd, references) {
    const byNumber = new Map(
        references
            .filter(reference => Number.isInteger(reference.number))
            .map(reference => [reference.number, reference])
    );
    if (!byNumber.size) return [];

    const squareBracketCitations = [];
    const parentheticalCitations = [];
    let bracketCitationContainers = 0;
    let parentheticalCitationContainers = 0;
    const body = markdown.slice(bodyFrom, bodyEnd);
    const numericEnumerationStarts = findNumericEnumerationStarts(body);
    const containers = [
        { pattern: /\[([^\]\r\n]{1,80})\]/g, squareBrackets: true },
        { pattern: /\(([^()\r\n]{1,80})\)/g, squareBrackets: false },
        { pattern: /（([^（）\r\n]{1,80})）/g, squareBrackets: false },
    ];
    for (const { pattern, squareBrackets } of containers) {
        for (const match of body.matchAll(pattern)) {
            const after = body[match.index + match[0].length] || '';
            const before = body[match.index - 1] || '';
            if (squareBrackets
                && (before === '!'
                    || ['(', '[', ':'].includes(after)
                    || squareBracketLooksStatistical(body, match))) {
                continue;
            }
            if (!squareBrackets
                && (numericEnumerationStarts.has(match.index)
                    || parentheticalRangeLooksStatistical(body, match))) {
                continue;
            }
            const matched = numericCitationsInContainer(
                match,
                bodyFrom,
                byNumber
            );
            if (squareBrackets) {
                squareBracketCitations.push(...matched);
                if (matched.length) bracketCitationContainers++;
            } else {
                parentheticalCitations.push(...matched);
                if (matched.length) parentheticalCitationContainers++;
            }
        }
    }
    if (hasBracketCitationStyle(bracketCitationContainers)) {
        return squareBracketCitations;
    }

    const superscriptCitations = [];
    let superscriptCitationContainers = 0;
    for (const marker of findSuperscriptMarkers(markdown, bodyFrom, bodyEnd)) {
        const matched = numericCitationsInText(
            marker.value,
            marker.from,
            byNumber,
            marker.markup
        );
        superscriptCitations.push(...matched);
        if (matched.length) superscriptCitationContainers++;
    }
    if (hasParentheticalCitationStyle(parentheticalCitationContainers)
        && parentheticalCitationContainers >= superscriptCitationContainers) {
        return [...squareBracketCitations, ...parentheticalCitations];
    }
    if (hasSuperscriptCitationStyle(superscriptCitationContainers)) {
        return [...squareBracketCitations, ...superscriptCitations];
    }
    return [
        ...squareBracketCitations,
        ...parentheticalCitations,
        ...superscriptCitations,
    ];
}

function hasBracketCitationStyle(containerCount) {
    return hasNumericCitationStyle(containerCount);
}

function hasSuperscriptCitationStyle(containerCount) {
    return hasNumericCitationStyle(containerCount);
}

function hasParentheticalCitationStyle(containerCount) {
    return hasNumericCitationStyle(containerCount);
}

function hasNumericCitationStyle(containerCount) {
    return containerCount >= MIN_NUMERIC_CITATION_STYLE_CONTAINERS;
}

function squareBracketLooksStatistical(body, match) {
    if (!/^\s*\d+\s*[,;，；]\s*\d+\s*$/.test(match[1])) return false;
    const preceding = body.slice(Math.max(0, match.index - 12), match.index);
    if (!/\bF\s*$/i.test(preceding)) return false;
    const following = body.slice(match.index + match[0].length);
    return /^\s*=\s*-?\d/.test(following);
}

function findNumericEnumerationStarts(body) {
    const starts = new Set();
    const paragraphs = body.matchAll(/\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/g);
    for (const paragraphMatch of paragraphs) {
        const paragraph = paragraphMatch[0];
        const paragraphFrom = paragraphMatch.index;
        const markers = [...paragraph.matchAll(/\((\d{1,3})\)/g)];
        let sequence = [];
        for (const marker of markers) {
            const number = Number(marker[1]);
            const previous = sequence.at(-1);
            const between = previous
                ? paragraph.slice(previous.index + previous[0].length, marker.index)
                : '';
            if (!previous || (number === Number(previous[1]) + 1
                && !/[.!?。！？]/u.test(between))) {
                sequence.push(marker);
                continue;
            }
            recordNumericEnumerationStarts(
                starts,
                sequence,
                paragraph,
                paragraphFrom
            );
            sequence = [marker];
        }
        recordNumericEnumerationStarts(
            starts,
            sequence,
            paragraph,
            paragraphFrom
        );
    }
    return starts;
}

function recordNumericEnumerationStarts(
    starts,
    sequence,
    paragraph,
    paragraphFrom
) {
    if (sequence.length < 2) return;
    const first = sequence[0];
    const startsAtOne = Number(first[1]) === 1;
    const continuesNumberedItems = sequence.length >= 3
        && sequence.slice(0, -1).every((item, index) => {
            const next = sequence[index + 1];
            const itemText = paragraph.slice(
                item.index + item[0].length,
                next.index
            );
            return /\p{L}/u.test(itemText)
                && /[,;:，；：]\s*(?:(?:and|or)|(?:以及|和|及))?\s*$/iu
                    .test(itemText);
        });
    if (!startsAtOne && !continuesNumberedItems) return;
    for (const item of sequence) {
        starts.add(paragraphFrom + item.index);
    }
}

function parentheticalRangeLooksStatistical(body, match) {
    const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(match[1].trim());
    if (!range) return false;
    const preceding = body.slice(Math.max(0, match.index - 120), match.index);
    if (/\d+(?:[.,]\d+)?\s*$/.test(preceding)) return true;
    const first = range[1];
    const last = range[2];
    return new RegExp(`\\b${first}\\b[^\\r\\n]{0,80}\\b${last}\\b`)
        .test(preceding);
}

function findSuperscriptMarkers(
    markdown,
    from,
    to,
    { includeLikelyExponents = false } = {}
) {
    const source = markdown.slice(from, to);
    const markers = [];
    for (const pattern of WRAPPED_SUPERSCRIPT_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
            const wrapperFrom = from + match.index;
            const value = normalizeSuperscriptCharacters(match[1]);
            if (!includeLikelyExponents
                && superscriptIsLikelyExponent(markdown, wrapperFrom, value)) {
                continue;
            }
            const contentFrom = wrapperFrom + match[0].indexOf(match[1]);
            const contentTo = contentFrom + match[1].length;
            markers.push({
                value,
                from: contentFrom,
                to: contentTo,
                markup: {
                    wrapperFrom,
                    contentFrom,
                    contentTo,
                    wrapperTo: wrapperFrom + match[0].length,
                    raiseContent: true,
                },
            });
        }
    }
    for (const match of source.matchAll(UNICODE_SUPERSCRIPT_PATTERN)) {
        const wrapperFrom = from + match.index;
        const wrapperTo = wrapperFrom + match[0].length;
        const after = markdown[wrapperTo] || '';
        const value = normalizeSuperscriptCharacters(match[0]);
        if (/^[\p{L}\p{N}_]$/u.test(after)
            || (!includeLikelyExponents
                && superscriptIsLikelyExponent(markdown, wrapperFrom, value))) {
            continue;
        }
        markers.push({
            value,
            from: wrapperFrom,
            to: wrapperTo,
            markup: {
                wrapperFrom,
                contentFrom: wrapperFrom,
                contentTo: wrapperTo,
                wrapperTo,
                raiseContent: false,
            },
        });
    }
    const sorted = markers.sort((left, right) => (
        left.markup.wrapperFrom - right.markup.wrapperFrom
        || right.markup.wrapperTo - left.markup.wrapperTo
    ));
    const nonOverlapping = [];
    let occupiedUntil = -1;
    for (const marker of sorted) {
        if (marker.markup.wrapperFrom < occupiedUntil) continue;
        nonOverlapping.push(marker);
        occupiedUntil = marker.markup.wrapperTo;
    }
    return nonOverlapping;
}

function normalizeSuperscriptCharacters(value) {
    return [...String(value)]
        .map(character => UNICODE_SUPERSCRIPT_CHARACTERS[character] || character)
        .join('');
}

function superscriptIsLikelyExponent(body, from, value) {
    if (!/^\s*\d+\s*$/.test(value)) return false;
    const preceding = body.slice(0, from);
    if (/\d[ \t]*$/u.test(preceding)) return true;
    const base = /([\p{L}_][\p{L}\p{N}_]*)[ \t]*$/u
        .exec(preceding)?.[1] || '';
    return base.length > 0 && base.length <= 2;
}

function numericCitationsInContainer(match, offset, byNumber) {
    return numericCitationsInText(
        match[1],
        offset + match.index + 1,
        byNumber
    );
}

function numericCitationsInText(
    value,
    valueFrom,
    targetsByMarker,
    superscriptMarkup = null,
    kind = 'reference'
) {
    const numericOnly = /^\s*\d+(?:\s*(?:[,;，；]\s*\d+|[-–—]\s*\d+))*\s*$/
        .test(value);
    if (!numericOnly && kind !== 'affiliation') {
        return [];
    }
    const citations = [];
    for (const segment of value.matchAll(/[^,;，；]+/g)) {
        const raw = segment[0];
        const leading = /^\s*/.exec(raw)?.[0].length || 0;
        const label = raw.trim();
        const from = valueFrom + segment.index + leading;
        const to = from + label.length;
        const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(label);
        if (range) {
            const first = Number(range[1]);
            const last = Number(range[2]);
            if (last < first || last - first > 100) continue;
            const matched = [];
            for (let number = first; number <= last; number++) {
                const reference = targetsByMarker.get(number);
                if (reference) matched.push(reference);
            }
            if (matched.length) {
                citations.push(createCitation(
                    from,
                    to,
                    matched,
                    superscriptMarkup,
                    kind
                ));
            }
            continue;
        }
        const marker = kind === 'affiliation'
            ? affiliationCitationMarker(label)
            : { key: Number(label), from: 0, to: label.length };
        const reference = marker === null
            ? null
            : targetsByMarker.get(marker.key);
        if (reference) {
            citations.push(createCitation(
                from + marker.from,
                from + marker.to,
                [reference],
                superscriptMarkup,
                kind
            ));
        }
    }
    return citations;
}

function affiliationCitationMarker(label) {
    const direct = affiliationMarkerKey(label);
    if (direct !== null) {
        return { key: direct, from: 0, to: label.length };
    }

    const decorated = AUTHOR_NOTE_DECORATED_AFFILIATION_PATTERN.exec(label);
    if (!decorated || (!decorated[1] && !decorated[3])) return null;
    const key = affiliationMarkerKey(decorated[2]);
    return key === null ? null : {
        key,
        from: decorated[1].length,
        to: decorated[1].length + decorated[2].length,
    };
}

function findAuthorYearCitations(markdown, bodyFrom, bodyEnd, references) {
    const body = markdown.slice(bodyFrom, bodyEnd);
    const citations = [];
    const referencesByYear = groupReferencesByYear(references);
    const parentheticalPattern = /[（(]([^()（）\r\n]{1,240})[)）]/g;
    for (const match of body.matchAll(parentheticalPattern)) {
        const matched = [];
        for (const segment of match[1].split(/[;；]/)) {
            const authorYear = parseAuthorYearSegment(segment);
            if (!authorYear) continue;
            for (const year of authorYear.years) {
                matched.push(...matchAuthorReferences(
                    referencesByYear,
                    authorYear.authors,
                    year
                ));
            }
        }
        const unique = uniqueReferences(matched);
        if (unique.length) {
            citations.push(createCitation(
                bodyFrom + match.index,
                bodyFrom + match.index + match[0].length,
                unique
            ));
        }
    }

    const narrativePattern = /(^|[^\p{L}\p{N}_])([\p{L}][\p{L}'’.-]*(?:\s+et\s+al\.?|\s+(?:&|and)\s+[\p{L}][\p{L}'’.-]*)?)\s*[（(]([^()（）\r\n]{1,120})[)）]/giu;
    for (const match of body.matchAll(narrativePattern)) {
        const years = parseYearSequence(match[3]);
        const matched = uniqueReferences(years.flatMap(year => (
            matchAuthorReferences(referencesByYear, match[2], year)
        )));
        if (!matched.length) continue;
        const from = bodyFrom + match.index + match[1].length;
        citations.push(createCitation(
            from,
            bodyFrom + match.index + match[0].length,
            matched
        ));
    }
    return citations;
}

function parseAuthorYearSegment(segment) {
    const value = segment.trim();
    const firstYear = /(?:18|19|20)\d{2}[a-z]?/i.exec(value);
    if (!firstYear) return null;
    const authors = value
        .slice(0, firstYear.index)
        .replace(/[\s,，]+$/u, '')
        .trim();
    if (!/\p{L}/u.test(authors)) return null;
    const years = parseYearSequence(value.slice(firstYear.index));
    return years.length ? { authors, years } : null;
}

function parseYearSequence(value) {
    const years = [];
    let remaining = String(value);
    let match = /^\s*((?:18|19|20)\d{2}[a-z]?)/i.exec(remaining);
    if (!match) return years;
    years.push(match[1].toLowerCase());
    remaining = remaining.slice(match[0].length);

    while ((match = /^\s*[,，]\s*((?:18|19|20)\d{2}[a-z]?)/i.exec(remaining))) {
        years.push(match[1].toLowerCase());
        remaining = remaining.slice(match[0].length);
    }
    return years;
}

function groupReferencesByYear(references) {
    const result = new Map();
    for (const reference of references) {
        if (!reference.year) continue;
        const sameYear = result.get(reference.year) || [];
        sameYear.push(reference);
        result.set(reference.year, sameYear);
    }
    return result;
}

function matchAuthorReferences(referencesByYear, authors, year) {
    const keys = normalizeAuthorKeys(authors);
    if (!keys.length) return [];
    const normalizedYear = String(year).toLowerCase();
    return (referencesByYear.get(normalizedYear) || []).filter(reference => {
        const searchable = ` ${reference.authorSearchText} `;
        return keys.every(key => searchable.includes(` ${key} `));
    });
}

function normalizeAuthorKeys(authors) {
    return String(authors)
        .replace(/^\s*(?:see|cf\.|e\.g\.,?)\s+/i, '')
        .replace(/\bet\s+al\.?/giu, '')
        .replace(/\band\b/giu, '&')
        .split(/\s*(?:[,，]|[&＆])\s*/u)
        .map(normalizeSearchText)
        .filter(key => /\p{L}/u.test(key));
}

function normalizeSearchText(value) {
    return String(value)
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function createCitation(
    from,
    to,
    references,
    superscriptMarkup = null,
    kind = 'reference'
) {
    const unique = uniqueReferences(references);
    const citation = {
        from,
        to,
        referenceIds: unique.map(reference => reference.id),
        references: unique,
        kind,
    };
    if (superscriptMarkup) citation.superscriptMarkup = superscriptMarkup;
    return citation;
}

function uniqueReferences(references) {
    return [...new Map(references.map(reference => [reference.id, reference])).values()];
}

function removeOverlappingCitations(citations) {
    const result = [];
    for (const citation of citations) {
        const previous = result.at(-1);
        if (previous && previous.to > citation.from) continue;
        result.push(citation);
    }
    return result;
}

function extractYear(text) {
    return YEAR_PATTERN.exec(text)?.[1].toLowerCase() || '';
}

function referenceAuthorText(text, year) {
    if (!year) return '';
    const escapedYear = year.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parentheticalYear = new RegExp(`[（(]\\s*${escapedYear}\\s*[)）]`, 'i')
        .exec(text);
    if (parentheticalYear) return text.slice(0, parentheticalYear.index);
    const sentenceEnd = /[.。]\s+(?=\p{L})/u.exec(text);
    if (sentenceEnd) return text.slice(0, sentenceEnd.index);
    const yearIndex = text.toLowerCase().indexOf(year);
    return yearIndex < 0 ? text : text.slice(0, yearIndex);
}

function trimRangeEnd(markdown, from, to) {
    while (to > from && /\s/.test(markdown[to - 1])) to--;
    return to;
}

function plainReferenceText(source) {
    return String(source)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<((?:https?:\/\/|doi:)[^>]+)>/gi, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[`*_~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
