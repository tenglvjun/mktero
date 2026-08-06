import { Marked } from 'marked';
import katex from 'katex';
import { translateEnglish } from '../i18n/localization.js';
import {
    findMinerUAlgorithmGroups,
    stripMinerUAlgorithmWrappers,
} from './markdown-algorithms.js';
import {
    findAcademicFigureGroups,
    findAcademicTableGroups,
    parseAcademicFigureCaption,
} from './markdown-figures.js';

const MAX_MATH_EXPRESSIONS = 1000;
const MAX_MATH_OUTPUT_LENGTH = 250_000;
const MAX_MATH_SOURCE_LENGTH = 10_000;
const MAX_TOTAL_MATH_OUTPUT_LENGTH = 1_000_000;
const MAX_TOTAL_MATH_SOURCE_LENGTH = 100_000;
const UNSAFE_MATH_COMMAND = /\\(?:csname|def|edef|futurelet|gdef|global|let|newcommand|providecommand|renewcommand|xdef)\b/;
const INLINE_CHILD_TOKEN_TYPES = new Set(['strong', 'em', 'del', 'link', 'image']);
const MATH_RANGE_TOKEN_TYPES = new Set(['text', 'escape', 'strong', 'em', 'del', 'link']);
const SAFE_TABLE_TAGS = new Set([
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'caption',
    'colgroup',
    'col',
    'p',
    'br',
    'strong',
    'em',
    'b',
    'i',
    'sub',
    'sup',
    'code',
]);

export function renderMarkdownHTML(
    markdown,
    {
        resolveImageURL = () => null,
        resolveImageAttachmentKey = null,
        target = 'mktero',
        translate = translateEnglish,
    } = {}
) {
    if (typeof markdown !== 'string') {
        throw new TypeError('Markdown must be a string');
    }

    const mathBudget = createMathRenderBudget();
    const renderer = createSafeRenderer(resolveImageURL, mathBudget, {
        resolveImageAttachmentKey,
        target,
        translate,
    });
    const parser = new Marked({
        gfm: true,
        renderer,
        extensions: [
            createMathBlockExtension(mathBudget, target),
            createMathInlineExtension(mathBudget, target),
            createAcademicTableExtension(),
        ],
    });
    const algorithmHTML = renderStandaloneMinerUAlgorithm(markdown, parser);
    if (algorithmHTML) return algorithmHTML;
    const figureGroupHTML = renderStandaloneAcademicFigureGroup(
        markdown,
        parser,
        resolveImageURL,
        resolveImageAttachmentKey,
        mathBudget,
        target,
        translate,
    );
    if (figureGroupHTML) return figureGroupHTML;
    return renderParsedMarkdown(stripMinerUAlgorithmWrappers(markdown), parser);
}

function renderStandaloneMinerUAlgorithm(markdown, parser) {
    const groups = findMinerUAlgorithmGroups(markdown);
    if (groups.length !== 1) return null;
    const group = groups[0];
    if (markdown.slice(0, group.from).trim()
        || markdown.slice(group.to).trim()) {
        return null;
    }
    return '<section class="mktero-algorithm">'
        + renderParsedMarkdown(group.content, parser)
        + '</section>\n';
}

function renderParsedMarkdown(markdown, parser) {
    if (!markdown) return '';
    const tokens = parser.lexer(markdown);
    const transformedTokens = transformBlockTokens(tokens, parser.Lexer, parser.defaults, {
        links: tokens.links,
    });
    const groupedTokens = groupAcademicTableTokens(transformedTokens);
    groupedTokens.links = tokens.links;
    return parser.parser(groupedTokens);
}

function createSafeRenderer(
    resolveImageURL,
    mathBudget,
    {
        resolveImageAttachmentKey = null,
        target = 'mktero',
        translate = translateEnglish,
    } = {}
) {
    return {
        html({ text }) {
            const page = text.trim().match(/^<!--\s*zotero-page:\s*(.*?)\s*-->$/);
            if (page) {
                return `<span class="page-marker" data-page="${escapeAttribute(page[1])}">`
                    + `${escapeHTML(translate('markdown.page', { page: page[1] }))}</span>`;
            }
            const table = sanitizeRawHTMLTable(text, mathBudget, target);
            if (table) return table;
            return escapeKnownInlineTags(escapeHTML(text));
        },

        link({ href, tokens }) {
            const label = this.parser.parseInline(tokens);
            const safeHref = safeMarkdownLinkURL(href);
            if (!safeHref) return label;
            return `<a href="${escapeAttribute(safeHref)}" rel="noreferrer">${label}</a>`;
        },

        paragraph({ tokens }) {
            const image = standaloneImageToken(tokens);
            const caption = image
                ? parseAcademicFigureCaption(imageTokenDescription(image))
                : null;
            const content = this.parser.parseInline(tokens);
            if (!caption) return `<p>${content}</p>\n`;
            return '<figure class="mktero-figure">'
                + content
                + renderFigureCaption(caption, mathBudget, image.tokens, target)
                + '</figure>\n';
        },

        image(token) {
            return renderImageToken(
                token,
                resolveImageURL,
                resolveImageAttachmentKey,
                translate
            );
        },
    };
}

function renderStandaloneAcademicFigureGroup(
    markdown,
    parser,
    resolveImageURL,
    resolveImageAttachmentKey,
    mathBudget,
    target,
    translate,
) {
    const groups = findAcademicFigureGroups(markdown);
    if (groups.length !== 1) return null;
    const group = groups[0];
    if (markdown.slice(0, group.from).trim()
        || markdown.slice(group.to).trim()) {
        return null;
    }

    const panels = group.images.map(image => {
        const tokens = parser.lexer(image.source);
        const paragraph = tokens.find(token => token.type !== 'space');
        const imageToken = paragraph?.type === 'paragraph'
            ? standaloneImageToken(paragraph.tokens)
            : null;
        return imageToken ? {
            imageToken,
            panelLabel: image.panelLabel || '',
            panelLabelPosition: image.panelLabelPosition || 'after',
        } : null;
    });
    if (panels.some(panel => !panel)) return null;

    const horizontal = group.layout === 'horizontal';
    const vertical = group.layout === 'vertical';
    const layoutClass = horizontal
        ? ' mktero-figure-group-horizontal'
        : vertical
            ? ' mktero-figure-group-vertical'
            : '';
    const renderedPanels = panels.map(panel => renderFigurePanel(
        panel,
        resolveImageURL,
        mathBudget,
        resolveImageAttachmentKey,
        target,
        translate,
    )).join('');
    const panelHTML = horizontal
        ? `<div class="mktero-figure-panels-horizontal">${renderedPanels}</div>`
        : renderedPanels;
    return `<figure class="mktero-figure mktero-figure-group${layoutClass}">`
        + panelHTML
        + renderFigureCaption(group.caption, mathBudget, null, target)
        + '</figure>\n';
}

function renderFigurePanel(
    panel,
    resolveImageURL,
    mathBudget,
    resolveImageAttachmentKey,
    target,
    translate
) {
    const image = renderImageToken(
        panel.imageToken,
        resolveImageURL,
        resolveImageAttachmentKey,
        translate
    );
    if (!panel.panelLabel) return image;
    const before = panel.panelLabelPosition === 'before';
    const label = '<div class="mktero-figure-panel-label'
        + (before ? ' mktero-figure-panel-label-before' : '')
        + '">'
        + renderCaptionMathSource(panel.panelLabel, mathBudget, target)
        + '</div>';
    return '<div class="mktero-figure-panel">'
        + (before ? label : '')
        + image
        + (before ? '' : label)
        + '</div>';
}

function renderImageToken(
    { href, title, text, tokens },
    resolveImageURL,
    resolveImageAttachmentKey = null,
    translate = translateEnglish
) {
    const alt = imageTokenDescription({ text, tokens });
    const attachmentKey = resolveImageAttachmentKey?.(href);
    if (attachmentKey) {
        const titleAttribute = title
            ? ` title="${escapeAttribute(title)}"`
            : '';
        return `<img data-attachment-key="${escapeAttribute(attachmentKey)}"`
            + ` alt="${escapeAttribute(alt)}"${titleAttribute}>`;
    }
    const resolved = resolveImageURL(href);
    if (!resolved || !String(resolved).startsWith('blob:')) {
        return `<span class="missing-image">${escapeHTML(
            alt || translate('image.fallbackAlt')
        )}</span>`;
    }
    const titleAttribute = title
        ? ` title="${escapeAttribute(title)}"`
        : '';
    return `<img src="${escapeAttribute(resolved)}" alt="${escapeAttribute(alt)}"${titleAttribute}>`;
}

function renderFigureCaption(caption, mathBudget, tokens = null, target = 'mktero') {
    return '<figcaption>'
        + `<span class="mktero-figure-label">${escapeHTML(caption.label)}</span>`
        + ` ${renderFigureCaptionDescription(caption, mathBudget, tokens, target)}`
        + '</figcaption>';
}

function renderFigureCaptionDescription(caption, mathBudget, tokens, target) {
    if (!tokens) {
        return renderCaptionMathSource(caption.description, mathBudget, target);
    }
    const segments = inlineTokenTextSegments(tokens);
    const text = segments.map(segment => segment.text).join('');
    const captionFrom = text.indexOf(caption.text);
    if (captionFrom < 0) return escapeHTML(caption.description);
    const descriptionFrom = captionFrom
        + caption.text.length
        - caption.description.length;
    return renderCaptionTokenSegments(
        segments,
        descriptionFrom,
        descriptionFrom + caption.description.length,
        mathBudget,
        target
    );
}

function renderCaptionTokenSegments(segments, from, to, mathBudget, target) {
    let offset = 0;
    let html = '';
    for (const segment of segments) {
        const segmentFrom = offset;
        const segmentTo = segmentFrom + segment.text.length;
        offset = segmentTo;
        if (segmentTo <= from || segmentFrom >= to) continue;
        const text = segment.text.slice(
            Math.max(0, from - segmentFrom),
            Math.min(segment.text.length, to - segmentFrom)
        );
        html += segment.math
            ? renderCaptionMath(text, mathBudget, target)
            : escapeHTML(text);
    }
    return html;
}

function renderCaptionMathSource(source, mathBudget, target = 'mktero') {
    const matches = findInlineMathMatches(source);
    let html = '';
    let offset = 0;
    for (const match of matches) {
        html += escapeHTML(source.slice(offset, match.start));
        html += renderCaptionMath(match.text, mathBudget, target);
        offset = match.end;
    }
    return html + escapeHTML(source.slice(offset));
}

function renderCaptionMath(source, mathBudget, target = 'mktero') {
    return renderMath(source, false, mathBudget, target);
}

function renderTableCaption(caption) {
    return '<caption>'
        + `<span class="mktero-table-label">${escapeHTML(caption.label)}</span>`
        + ` ${escapeHTML(caption.description)}`
        + '</caption>';
}

function createAcademicTableExtension() {
    return {
        name: 'mkteroAcademicTable',
        renderer(token) {
            const table = this.parser.parse([token.table]).trim();
            return table.replace(
                /^<table>/,
                `<table>${renderTableCaption(token.caption)}`
            );
        },
    };
}

function groupAcademicTableTokens(tokens) {
    const grouped = [];
    for (let index = 0; index < tokens.length; index++) {
        const firstToken = tokens[index];
        if (!['heading', 'paragraph'].includes(firstToken.type)) {
            grouped.push(firstToken);
            continue;
        }

        let tableIndex = index + 1;
        while (tokens[tableIndex]?.type === 'space') tableIndex++;
        if (tokens[tableIndex]?.type === 'paragraph') {
            tableIndex++;
            while (tokens[tableIndex]?.type === 'space') tableIndex++;
        }
        const tableToken = tokens[tableIndex];
        if (!['html', 'table'].includes(tableToken?.type)) {
            grouped.push(firstToken);
            continue;
        }

        const source = tokens
            .slice(index, tableIndex + 1)
            .map(token => token.raw || '')
            .join('');
        const groups = findAcademicTableGroups(source);
        const group = groups.length === 1 ? groups[0] : null;
        const kindMatches = group?.table.kind === 'html'
            ? tableToken.type === 'html'
            : group?.table.kind === 'gfm' && tableToken.type === 'table';
        if (!group
            || !kindMatches
            || source.slice(0, group.from).trim()
            || source.slice(group.to).trim()) {
            grouped.push(firstToken);
            continue;
        }

        grouped.push({
            type: 'mkteroAcademicTable',
            raw: source,
            caption: group.caption,
            table: tableToken,
        });
        index = tableIndex;
    }
    return grouped;
}

function standaloneImageToken(tokens) {
    return tokens?.length === 1 && tokens[0].type === 'image'
        ? tokens[0]
        : null;
}

function imageTokenDescription({ text, tokens }) {
    return tokens ? inlineTokensToText(tokens) : text;
}

function createMathBlockExtension(mathBudget, target = 'mktero') {
    return {
        name: 'mkteroMathBlock',
        renderer(token) {
            return renderMath(token.text, true, mathBudget, target) + '\n';
        },
    };
}

function createMathInlineExtension(mathBudget, target = 'mktero') {
    return {
        name: 'mkteroMathInline',
        renderer(token) {
            return renderMath(token.text, false, mathBudget, target);
        },
    };
}

function transformBlockTokens(tokens, Lexer, options, context) {
    const transformed = [];
    for (const token of tokens) {
        if (token.type === 'paragraph' || token.type === 'text') {
            const splitTokens = splitDisplayMathToken(
                token,
                Lexer,
                options,
                context
            );
            if (splitTokens) {
                appendTokens(transformed, splitTokens);
                continue;
            }
            token.tokens = transformInlineTokens(token.tokens, Lexer, options, context);
            transformed.push(token);
            continue;
        }
        if (token.type === 'heading') {
            token.tokens = transformInlineTokens(token.tokens, Lexer, options, context);
            transformed.push(token);
            continue;
        }
        if (token.type === 'blockquote') {
            token.tokens = transformBlockTokens(token.tokens, Lexer, options, context);
            transformed.push(token);
            continue;
        }
        if (token.type === 'list') {
            for (const item of token.items) {
                item.tokens = transformBlockTokens(
                    item.tokens,
                    Lexer,
                    options,
                    context
                );
            }
            transformed.push(token);
            continue;
        }
        if (token.type === 'table') {
            for (const cell of token.header) {
                cell.tokens = transformInlineTokens(
                    cell.tokens,
                    Lexer,
                    options,
                    context
                );
            }
            for (const row of token.rows) {
                for (const cell of row) {
                    cell.tokens = transformInlineTokens(
                        cell.tokens,
                        Lexer,
                        options,
                        context
                    );
                }
            }
        }
        transformed.push(token);
    }
    return transformed;
}

function splitDisplayMathToken(token, Lexer, options, context) {
    const source = token.text;
    const matches = findDisplayMathMatches(source);
    if (!matches.length) return null;

    const splitTokens = [];
    let sourceIndex = 0;
    for (const match of matches) {
        appendBlockFragment(
            splitTokens,
            source.slice(sourceIndex, match.start),
            token.type,
            Lexer,
            options,
            context
        );
        splitTokens.push({
            type: 'mkteroMathBlock',
            raw: match.raw,
            text: match.text,
        });
        sourceIndex = match.end;
    }
    appendBlockFragment(
        splitTokens,
        source.slice(sourceIndex),
        token.type,
        Lexer,
        options,
        context
    );
    return splitTokens;
}

function appendBlockFragment(target, source, parentType, Lexer, options, context) {
    if (!source) return;
    if (parentType === 'text') {
        const tokens = lexInlineFragment(source, Lexer, options, context);
        target.push({
            type: 'text',
            raw: source,
            text: source,
            tokens: transformInlineTokens(tokens, Lexer, options, context),
        });
        return;
    }
    const tokens = lexBlockFragment(source, Lexer, options, context);
    const transformed = transformBlockTokens(tokens, Lexer, options, {
        ...context,
        links: tokens.links,
    });
    appendTokens(target, transformed);
}

function transformInlineTokens(tokens, Lexer, options, context = {}) {
    if (!tokens?.length) return [];
    const { inLink = false } = context;
    const spans = createTokenSpans(tokens);
    const source = spans.map(span => span.token.raw).join('');
    const matches = filterReplaceableMathRanges(
        findInlineMathMatches(source),
        spans
    );
    if (matches.length) {
        return replaceInlineMathRanges(source, matches, Lexer, options, context);
    }

    for (const token of tokens) {
        if (INLINE_CHILD_TOKEN_TYPES.has(token.type)
            && Array.isArray(token.tokens)) {
            token.tokens = transformInlineTokens(token.tokens, Lexer, options, {
                ...context,
                inLink: inLink || token.type === 'link',
            });
        }
    }
    return tokens;
}

function createTokenSpans(tokens) {
    let offset = 0;
    return tokens.map(token => {
        const start = offset;
        offset += token.raw.length;
        return { token, start, end: offset };
    });
}

function filterReplaceableMathRanges(matches, spans) {
    const replaceable = [];
    let spanIndex = 0;
    for (const match of matches) {
        while (spanIndex < spans.length && spans[spanIndex].end <= match.start) {
            spanIndex++;
        }
        let touchedCount = 0;
        let onlyTokenType = '';
        let allowed = true;
        for (let index = spanIndex;
            index < spans.length && spans[index].start < match.end;
            index++) {
            const type = spans[index].token.type;
            touchedCount++;
            onlyTokenType = type;
            allowed &&= MATH_RANGE_TOKEN_TYPES.has(type);
        }
        const nestedInContainer = touchedCount === 1
            && onlyTokenType !== 'text'
            && onlyTokenType !== 'escape';
        if (allowed && touchedCount && !nestedInContainer) {
            replaceable.push(match);
        }
    }
    return replaceable;
}

function replaceInlineMathRanges(source, matches, Lexer, options, context) {
    const transformed = [];
    let sourceIndex = 0;
    for (const match of matches) {
        if (match.start > sourceIndex) {
            const tokens = lexInlineFragment(
                source.slice(sourceIndex, match.start),
                Lexer,
                options,
                context
            );
            appendTokens(
                transformed,
                transformInlineTokens(tokens, Lexer, options, context)
            );
        }
        transformed.push({
            type: 'mkteroMathInline',
            raw: match.raw,
            text: match.text,
        });
        sourceIndex = match.end;
    }
    if (sourceIndex < source.length) {
        const tokens = lexInlineFragment(
            source.slice(sourceIndex),
            Lexer,
            options,
            context
        );
        appendTokens(
            transformed,
            transformInlineTokens(tokens, Lexer, options, context)
        );
    }
    return transformed;
}

function appendTokens(target, tokens) {
    for (const token of tokens) target.push(token);
}

function lexInlineFragment(source, Lexer, options, { inLink = false, links } = {}) {
    const lexer = new Lexer(options);
    if (links) lexer.tokens.links = links;
    lexer.state.inLink = inLink;
    return lexer.inlineTokens(source);
}

function lexBlockFragment(source, Lexer, options, { links } = {}) {
    const lexer = new Lexer(options);
    if (links) lexer.tokens.links = links;
    return lexer.lex(source);
}

export function findDisplayMathMatches(source) {
    const dollarMatches = [];
    const bracketMatches = [];
    let dollarOpener = null;
    let bracketOpener = null;
    const lines = splitSourceLines(source);

    for (const line of lines) {
        const inlineDollar = /^\$\$[ \t]*(.*?)[ \t]*\$\$[ \t]*$/.exec(line.text);
        if (inlineDollar?.[1].trim()) {
            dollarMatches.push(createLineMathRange(
                source,
                line,
                inlineDollar[1]
            ));
        }
        else if (/^\$\$[ \t]*$/.test(line.text)) {
            if (dollarOpener) {
                dollarMatches.push(createMultilineMathRange(
                    source,
                    dollarOpener,
                    line
                ));
                dollarOpener = null;
            }
            else {
                dollarOpener = line;
            }
        }

        const inlineBracket = /^\\\[[ \t]*(.*?)[ \t]*\\\][ \t]*$/.exec(line.text);
        if (inlineBracket?.[1].trim()) {
            bracketMatches.push(createLineMathRange(
                source,
                line,
                inlineBracket[1]
            ));
        }
        else if (/^\\\[[ \t]*$/.test(line.text)) {
            bracketOpener = line;
        }
        else if (bracketOpener && /^[ \t]*\\\][ \t]*$/.test(line.text)) {
            bracketMatches.push(createMultilineMathRange(
                source,
                bracketOpener,
                line
            ));
            bracketOpener = null;
        }
    }

    return selectNonOverlappingRanges(dollarMatches, bracketMatches);
}

function splitSourceLines(source) {
    const lines = [];
    let start = 0;
    while (start < source.length) {
        const newline = source.indexOf('\n', start);
        const end = newline < 0 ? source.length : newline;
        const next = newline < 0 ? end : end + 1;
        lines.push({
            start,
            end,
            next,
            text: source.slice(start, end),
        });
        start = next;
    }
    return lines;
}

function createLineMathRange(source, line, text) {
    return {
        start: line.start,
        end: line.next,
        raw: source.slice(line.start, line.next),
        text,
    };
}

function createMultilineMathRange(source, opener, closer) {
    const contentEnd = closer.start > opener.next
        && source[closer.start - 1] === '\n'
        ? closer.start - 1
        : closer.start;
    return {
        start: opener.start,
        end: closer.next,
        raw: source.slice(opener.start, closer.next),
        text: source.slice(opener.next, contentEnd),
    };
}

export function findInlineMathMatches(source) {
    const dollarMatches = [];
    const parenthesisMatches = [];
    let dollarOpener = -1;
    let parenthesisOpener = -1;

    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\n') {
            dollarOpener = -1;
            parenthesisOpener = -1;
            continue;
        }
        if (source.startsWith('\\(', index) && !isEscaped(source, index)) {
            parenthesisOpener = index;
            index++;
            continue;
        }
        if (source.startsWith('\\)', index) && !isEscaped(source, index)) {
            if (parenthesisOpener >= 0) {
                const match = createInlineMathMatch(
                    source,
                    parenthesisOpener,
                    index,
                    '\\(',
                    '\\)'
                );
                if (match) {
                    parenthesisMatches.push(toMathRange(match, parenthesisOpener));
                }
                parenthesisOpener = -1;
            }
            index++;
            continue;
        }
        if (!isSingleDollarAt(source, index)) continue;
        if (dollarOpener < 0) {
            dollarOpener = index;
            continue;
        }
        const match = createInlineMathMatch(
            source,
            dollarOpener,
            index,
            '$',
            '$',
            {
                rejectClosingBeforeDigit: true,
                rejectSpacedContentBeforeAlphanumeric: true,
            }
        );
        if (match) {
            dollarMatches.push(toMathRange(match, dollarOpener));
            dollarOpener = -1;
        }
        else {
            dollarOpener = index;
        }
    }

    return selectNonOverlappingRanges(dollarMatches, parenthesisMatches);
}

function toMathRange(match, start) {
    return {
        ...match,
        start,
        end: start + match.raw.length,
    };
}

function selectNonOverlappingRanges(left, right) {
    const selected = [];
    let leftIndex = 0;
    let rightIndex = 0;
    let selectedEnd = 0;
    while (leftIndex < left.length || rightIndex < right.length) {
        const useLeft = rightIndex >= right.length
            || (leftIndex < left.length
                && left[leftIndex].start <= right[rightIndex].start);
        const candidate = useLeft ? left[leftIndex++] : right[rightIndex++];
        if (candidate.start < selectedEnd) continue;
        selected.push(candidate);
        selectedEnd = candidate.end;
    }
    return selected;
}

function createInlineMathMatch(source, openerIndex, closerIndex, opener, closer, options = {}) {
    if (options.rejectClosingBeforeDigit
        && /\d/.test(source[closerIndex + closer.length] || '')) return null;
    const contentStart = openerIndex + opener.length;
    const openerIsPadded = /\s/.test(source[contentStart] || '');
    const closerIsPadded = /\s/.test(source[closerIndex - 1] || '');
    if (closerIsPadded !== openerIsPadded) return null;
    const text = source.slice(contentStart, closerIndex).trim();
    if (!text) return null;
    if (options.rejectSpacedContentBeforeAlphanumeric
        && /\s/.test(text)
        && /[\p{L}\p{N}]/u.test(source[closerIndex + closer.length] || '')) {
        return null;
    }
    return {
        raw: source.slice(openerIndex, closerIndex + closer.length),
        text,
    };
}

function inlineTokensToText(tokens) {
    return inlineTokenTextSegments(tokens)
        .map(segment => segment.text)
        .join('');
}

function inlineTokenTextSegments(tokens) {
    return tokens.flatMap(token => {
        if (token.type === 'mkteroMathInline') {
            return [{
                text: unescapeImageMathSource(token.text || ''),
                math: true,
            }];
        }
        if (Array.isArray(token.tokens)) {
            return inlineTokenTextSegments(token.tokens);
        }
        const text = token.type === 'br' ? '\n' : token.text || '';
        return text ? [{ text, math: false }] : [];
    });
}

function unescapeImageMathSource(source) {
    return String(source).replace(/\\\\/g, '\\');
}

function isSingleDollarAt(source, index) {
    return source[index] === '$'
        && source[index - 1] !== '$'
        && source[index + 1] !== '$'
        && !isEscaped(source, index);
}

function isEscaped(source, index) {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

function createMathRenderBudget() {
    let expressionCount = 0;
    let totalOutputLength = 0;
    let totalSourceLength = 0;
    return {
        claimSource(source) {
            if (source.length > MAX_MATH_SOURCE_LENGTH) return false;
            if (expressionCount >= MAX_MATH_EXPRESSIONS) return false;
            if (totalSourceLength + source.length > MAX_TOTAL_MATH_SOURCE_LENGTH) {
                return false;
            }
            expressionCount++;
            totalSourceLength += source.length;
            return true;
        },
        claimOutput(output) {
            if (output.length > MAX_MATH_OUTPUT_LENGTH) return false;
            if (totalOutputLength + output.length > MAX_TOTAL_MATH_OUTPUT_LENGTH) {
                return false;
            }
            totalOutputLength += output.length;
            return true;
        },
    };
}

function renderMath(source, displayMode, mathBudget, target = 'mktero') {
    const normalizedSource = String(source).trim();
    if (UNSAFE_MATH_COMMAND.test(normalizedSource)
        || !mathBudget.claimSource(normalizedSource)) {
        return wrapMathFallback(normalizedSource, displayMode, target);
    }
    try {
        const rendered = target === 'zotero-note'
            ? renderZoteroNoteMath(normalizedSource, displayMode)
            : wrapMkteroMath(
                renderMathML(normalizedSource, displayMode),
                displayMode
            );
        return rendered && mathBudget.claimOutput(rendered)
            ? rendered
            : wrapMathFallback(normalizedSource, displayMode, target);
    }
    catch {
        return wrapMathFallback(normalizedSource, displayMode, target);
    }
}

function renderMathML(source, displayMode, options = {}) {
    return katex.renderToString(source, {
        displayMode,
        output: 'mathml',
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        maxExpand: 100,
        maxSize: 100,
        ...options,
    });
}

function renderZoteroNoteMath(source, displayMode) {
    const bounded = renderMathML(source, displayMode, {
        throwOnError: true,
    });
    const unbounded = renderMathML(source, displayMode, {
        throwOnError: true,
        maxSize: Infinity,
    });
    if (bounded !== unbounded) return null;

    const delimiter = displayMode ? '$$' : '$';
    const tagName = displayMode ? 'pre' : 'span';
    return `<${tagName} class="math">${delimiter}`
        + escapeHTML(source)
        + `${delimiter}</${tagName}>`;
}

function wrapMkteroMath(rendered, displayMode) {
    return displayMode
        ? `<div class="math math-display">${rendered}</div>`
        : `<span class="math-inline">${rendered}</span>`;
}

function wrapMathFallback(source, displayMode, target) {
    const fallback = renderMathFallback(source);
    return target === 'zotero-note'
        ? fallback
        : wrapMkteroMath(fallback, displayMode);
}

function renderMathFallback(source) {
    return `<code class="math-fallback">${escapeHTML(source)}</code>`;
}

export function safeMarkdownLinkURL(value) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url) || /^zotero:\/\//i.test(url) || url.startsWith('#')) {
        return url.replace(/[\u0000-\u001F\u007F]/g, '');
    }
    return null;
}

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
    return escapeHTML(value).replace(/[\u0000-\u001F\u007F]/g, '');
}

function escapeKnownInlineTags(value) {
    return value
        .replace(/&lt;(br|sup|sub)&gt;/gi, '<$1>')
        .replace(/&lt;\/(br|sup|sub)&gt;/gi, '</$1>');
}

function sanitizeRawHTMLTable(value, mathBudget, target = 'mktero') {
    const source = String(value).trim();
    if (!/^<table(?:\s|>)/i.test(source) || !/<\/table>$/i.test(source)) {
        return null;
    }

    let output = '';
    let sourceIndex = 0;
    let tableCellDepth = 0;
    let codeDepth = 0;
    const tagPattern = /<\/?[a-z][^<>]*>/gi;
    for (const match of source.matchAll(tagPattern)) {
        const text = source.slice(sourceIndex, match.index);
        output += renderRawTableText(
            text,
            tableCellDepth > 0 && codeDepth === 0,
            mathBudget,
            target
        );
        const closing = /^<\s*\//.test(match[0]);
        const tagName = /^<\s*\/?\s*([a-z][a-z0-9]*)/i.exec(match[0])?.[1]
            ?.toLowerCase();
        if (SAFE_TABLE_TAGS.has(tagName)) {
            output += sanitizeTableTag(match[0], tagName, closing);
            const depthChange = closing ? -1 : 1;
            if (tagName === 'td' || tagName === 'th') {
                tableCellDepth = Math.max(0, tableCellDepth + depthChange);
            }
            if (tagName === 'code') {
                codeDepth = Math.max(0, codeDepth + depthChange);
            }
        }
        else {
            output += escapeHTML(match[0]);
        }
        sourceIndex = match.index + match[0].length;
    }
    const trailingText = source.slice(sourceIndex);
    output += renderRawTableText(
        trailingText,
        tableCellDepth > 0 && codeDepth === 0,
        mathBudget,
        target
    );
    return output;
}

function renderRawTableText(value, renderMath, mathBudget, target) {
    return renderMath
        ? renderRawTableInlineMath(value, mathBudget, target)
        : escapeHTMLText(value);
}

function renderRawTableInlineMath(value, mathBudget, target) {
    const source = String(value);
    const matches = findInlineMathMatches(source);
    if (!matches.length) return escapeHTMLText(source);

    let output = '';
    let sourceIndex = 0;
    for (const match of matches) {
        output += escapeHTMLText(source.slice(sourceIndex, match.start));
        output += renderMath(match.text, false, mathBudget, target);
        sourceIndex = match.end;
    }
    output += escapeHTMLText(source.slice(sourceIndex));
    return output;
}

function sanitizeTableTag(rawTag, tagName, closing) {
    if (closing) return `</${tagName}>`;
    let attributes = '';
    const attributeNames = tagName === 'td' || tagName === 'th'
        ? ['rowspan', 'colspan']
        : tagName === 'col' || tagName === 'colgroup'
            ? ['span']
            : [];
    for (const name of attributeNames) {
        const value = readNumericHTMLAttribute(rawTag, name);
        if (value !== null) attributes += ` ${name}="${value}"`;
    }
    return `<${tagName}${attributes}>`;
}

function readNumericHTMLAttribute(rawTag, name) {
    const source = rawTag
        .replace(/^<\s*[a-z][a-z0-9]*/i, '')
        .replace(/\/?>\s*$/, '');
    const attributePattern = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    for (const match of source.matchAll(attributePattern)) {
        if (match[1].toLowerCase() !== name) continue;
        const rawValue = match[2] ?? match[3] ?? match[4];
        if (!/^\d+$/.test(rawValue)) return null;
        const value = Number(rawValue);
        return Number.isSafeInteger(value) && value >= 1 && value <= 1000
            ? String(value)
            : null;
    }
    return null;
}

function escapeHTMLText(value) {
    return escapeHTML(value).replace(
        /&amp;((?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);)/gi,
        '&$1'
    );
}
