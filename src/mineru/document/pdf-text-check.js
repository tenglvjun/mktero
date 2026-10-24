import { BLOCK_KIND } from './ir.js';
import { itemsInBox, pdfLines, pdfTextItemsByPage } from './pdf-geometry.js';

// MinerU's VLM reads the page image and now and then writes what it expects
// instead of what is printed: a misspelled name spelled "right", an author's
// typo or grammar quietly corrected, a run-in heading written twice with a
// different section number. The PDF's own text layer is the printed text
// when the PDF was typeset. When it was scanned, the layer is an older OCR
// that MinerU reads better, so the layer is trusted only when it agrees with
// MinerU almost everywhere and shows no OCR confusions (a digit read as a
// letter, stray symbols inside a word).
//
// In a trusted document the check restores single printed words: a 1:1
// word difference between matching neighbours, letters only, with the same
// first letter, punctuation, and script, and a small edit distance. It also
// removes a heading MinerU wrote twice when the PDF prints its words once.
// Everything else is left as MinerU read it; `diagnostics.pdfText` records
// what was compared and changed.
export const PDF_TEXT_CHECK_LIMITS = Object.freeze({
    maxFragmentCells: 250_000,
    maxDocumentCells: 8_000_000,
    minFragmentWords: 8,
    minFragmentSimilarity: 0.9,
    minDocumentWords: 300,
    maxDisagreementsPerThousand: 1.5,
    minReplacedWordLength: 4,
    maxComparedWordLength: 64,
    maxFragmentItems: 4_000,
    minDuplicateHeadingLetters: 6,
});

const CHECKED_KINDS = new Set([BLOCK_KIND.TEXT, BLOCK_KIND.TITLE, BLOCK_KIND.LIST]);
const BARRIER = '\u0000';
// Items closer than this share of their height, of the same size and on
// the same baseline, are one word. A superscript or a drop cap is not.
const GLUE_GAP = 0.15;
const GLUE_SIZE_RATIO = 0.15;
const GLUE_BASELINE = 0.2;
// A text layer without a ligature's mapping drops letters next to these.
const LIGATURE_PAIRS = new Set(['ff', 'fi', 'fl', 'ft', 'fj', 'th', 'st', 'ct']);
const WORD = /^\p{L}+(?:['’-]\p{L}+)*$/u;
const SHELL = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su;
const OCR_JUNK = /[\^_|~\\{}<>\uFFFD]/u;
const LETTER_GAP = /\p{L}[.,;:]\p{L}/u;
const UNSTABLE = /[\p{M}\p{Lm}\p{Sk}\p{Co}\uFFFD]/u;
const SCRIPTS = [/^\p{Script=Latin}+$/u, /^\p{Script=Greek}+$/u, /^\p{Script=Cyrillic}+$/u];

export function checkTextAgainstPDF(ir, pdfText) {
    const diagnostics = {
        trusted: false, fragments: 0, words: 0, disagreements: 0, ocrSignatures: 0, replaced: 0, duplicateHeadings: 0,
    };
    ir.diagnostics.pdfText = diagnostics;
    const itemsByPage = pdfTextItemsByPage(ir, pdfText);
    if (!itemsByPage.size) return ir;
    const candidates = [];
    let budget = PDF_TEXT_CHECK_LIMITS.maxDocumentCells;
    for (const block of ir.blocks) {
        if (!CHECKED_KINDS.has(block.kind)) continue;
        for (const fragment of block.fragments || []) {
            const items = itemsByPage.get(fragment.pageIndex);
            if (!items || !validBox(fragment.bbox)) continue;
            const ours = fragmentTokens(fragment);
            const words = ours.filter(token => !token.barrier).length;
            if (words < PDF_TEXT_CHECK_LIMITS.minFragmentWords) continue;
            const inside = itemsInBox(fragment.bbox, items);
            if (!inside.length || inside.length > PDF_TEXT_CHECK_LIMITS.maxFragmentItems) continue;
            const theirs = pdfTokens(inside);
            const cells = ours.length * theirs.length;
            if (!cells || cells > PDF_TEXT_CHECK_LIMITS.maxFragmentCells || cells > budget) continue;
            budget -= cells;
            const alignment = alignTokens(ours, theirs);
            if (2 * alignment.same / (ours.length + theirs.length) < PDF_TEXT_CHECK_LIMITS.minFragmentSimilarity) continue;
            diagnostics.fragments++;
            diagnostics.words += words;
            for (const [ourIndex, theirIndex] of alignment.substitutions) {
                const ourToken = ours[ourIndex];
                if (ourToken.barrier) continue;
                const verdict = compareWords(ourToken.text, theirs[theirIndex].text);
                diagnostics.disagreements++;
                if (verdict === 'ocr') diagnostics.ocrSignatures++;
                else if (verdict === 'replace') candidates.push({ token: ourToken, text: theirs[theirIndex].text });
            }
        }
    }
    diagnostics.trusted = diagnostics.words >= PDF_TEXT_CHECK_LIMITS.minDocumentWords
        && diagnostics.ocrSignatures === 0
        && 1000 * diagnostics.disagreements / diagnostics.words <= PDF_TEXT_CHECK_LIMITS.maxDisagreementsPerThousand;
    if (!diagnostics.trusted) return ir;
    // Last first, so a replacement does not move the words before it in its
    // span. Headings are compared afresh afterwards.
    for (const { token, text } of candidates.reverse()) {
        if (replaceTokenText(token, printedWord(token.text, text))) diagnostics.replaced++;
    }
    removeDuplicateHeadings(ir, itemsByPage, diagnostics);
    return ir;
}

// Our words in reading order, each with its span and offsets. An inline
// formula is one barrier token that never matches the PDF.
function fragmentTokens(fragment) {
    const tokens = [];
    for (const line of fragment.lines || []) {
        for (const span of line.spans || []) {
            if (span.type !== 'text') {
                tokens.push({ barrier: true, key: BARRIER });
                continue;
            }
            const content = typeof span.content === 'string' ? span.content : '';
            for (const match of content.matchAll(/\S+/gu)) {
                const key = looseKey(match[0]);
                if (key) tokens.push({ span, start: match.index, end: match.index + match[0].length, text: match[0], key });
            }
        }
    }
    return tokens;
}

// The PDF's words in its lines. Items that touch are one word; line-end
// hyphens are kept, as MinerU keeps its lines.
function pdfTokens(items) {
    const tokens = [];
    pdfLines(items).forEach((line, lineIndex) => {
        let previous = null;
        for (const item of line.items) {
            const pieces = item.text.split(/\s+/u).filter(Boolean);
            if (!pieces.length) continue;
            const glued = previous && tokens.length && glues(previous, item);
            pieces.forEach((piece, index) => {
                const token = { text: piece, font: item.font, size: item.size, line: lineIndex, bbox: item.bbox };
                if (index === 0 && glued) {
                    const last = tokens.at(-1);
                    last.text += piece;
                    last.bbox = [Math.min(last.bbox[0], item.bbox[0]), Math.min(last.bbox[1], item.bbox[1]),
                        Math.max(last.bbox[2], item.bbox[2]), Math.max(last.bbox[3], item.bbox[3])];
                }
                else tokens.push(token);
            });
            previous = item;
        }
    });
    return tokens.map(token => ({ ...token, key: looseKey(token.text) })).filter(token => token.key);
}

function glues(previous, item) {
    if (previous.spaceAfter || item.spaceBefore) return false;
    const height = Math.min(item.bbox[3] - item.bbox[1], previous.bbox[3] - previous.bbox[1]);
    if (!(height > 0) || item.bbox[0] - previous.bbox[2] >= GLUE_GAP * height) return false;
    if (Math.abs(item.size - previous.size) > GLUE_SIZE_RATIO * Math.max(item.size, previous.size)) return false;
    return Math.abs(item.bbox[3] - previous.bbox[3]) < GLUE_BASELINE * height;
}

// Case, accents, and punctuation do not separate two words.
function looseKey(text) {
    return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function strictText(text) {
    return text.normalize('NFKC').replace(/[‐‑‒–—−]/gu, '-').replace(/[‘’ʼ]/gu, "'").replace(/[“”]/gu, '"');
}

// Longest common subsequence of the keys; a substitution is a run of one
// word on each side between two matched words.
function alignTokens(ours, theirs) {
    const rows = ours.length;
    const width = theirs.length + 1;
    const table = new Uint16Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
        for (let j = theirs.length - 1; j >= 0; j--) {
            table[i * width + j] = ours[i].key === theirs[j].key
                ? table[(i + 1) * width + j + 1] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }
    const substitutions = [];
    let run = null;
    let matched = false;
    const close = followedByMatch => {
        if (run?.afterMatch && followedByMatch && run.deleted.length === 1 && run.inserted.length === 1) {
            substitutions.push([run.deleted[0], run.inserted[0]]);
        }
        run = null;
    };
    let i = 0;
    let j = 0;
    while (i < rows || j < theirs.length) {
        if (i < rows && j < theirs.length && ours[i].key === theirs[j].key) {
            close(true);
            matched = true;
            i++;
            j++;
            continue;
        }
        run ||= { afterMatch: matched, deleted: [], inserted: [] };
        if (j < theirs.length && (i === rows || table[i * width + j + 1] >= table[(i + 1) * width + j])) run.inserted.push(j++);
        else run.deleted.push(i++);
    }
    close(false);
    return { same: table[0], substitutions };
}

// 'replace' when the printed word may stand in for ours, 'ocr' when the
// difference looks like a scanned page's text layer, otherwise 'differ'.
export function compareWords(ours, theirs) {
    const limit = PDF_TEXT_CHECK_LIMITS.maxComparedWordLength;
    if (ours.length > limit || theirs.length > limit) return 'differ';
    const [, ourLead, ourCore, ourTail] = SHELL.exec(strictText(ours));
    const [, theirLead, theirCore, theirTail] = SHELL.exec(strictText(theirs));
    if (OCR_JUNK.test(theirs)) return 'ocr';
    const ourCharacters = [...ourCore];
    const theirCharacters = [...theirCore];
    if (ourCharacters.length === theirCharacters.length
        && ourCharacters.some((character, index) => isDigit(character) !== isDigit(theirCharacters[index])
            && /[\p{L}\p{N}]/u.test(character) && /[\p{L}\p{N}]/u.test(theirCharacters[index]))) {
        return 'ocr';
    }
    if (WORD.test(ourCore) && LETTER_GAP.test(theirCore)) return 'ocr';
    if (ourLead !== theirLead || ourTail !== theirTail) return 'differ';
    // Small capitals and title case are type, not text; a text layer often
    // loses accents.
    if (looseKey(ourCore) === looseKey(theirCore)) return 'differ';
    if (!WORD.test(ourCore) || !WORD.test(theirCore) || UNSTABLE.test(theirCore)) return 'differ';
    if (Math.min(ourCore.length, theirCore.length) < PDF_TEXT_CHECK_LIMITS.minReplacedWordLength) return 'differ';
    // A text layer without a ligature's mapping drops its letters ("specic",
    // "efect", "Tere").
    if (theirCore.length < ourCore.length - 1 || droppedLigature(ourCore, theirCore)) return 'differ';
    if (casePattern(ourCore) !== casePattern(theirCore)) return 'differ';
    if (ourCore[0] !== theirCore[0] || marks(ourCore) !== marks(theirCore)) return 'differ';
    const letters = core => core.replace(/['’-]/gu, '');
    if (!SCRIPTS.some(script => script.test(letters(ourCore)) && script.test(letters(theirCore)))) return 'differ';
    const distance = editDistance(ourCore.toLowerCase(), theirCore.toLowerCase());
    return distance <= (Math.max(ourCore.length, theirCore.length) >= 8 ? 2 : 1) ? 'replace' : 'differ';
}

// Whether the printed word is ours less one letter next to which a
// ligature would have printed.
function droppedLigature(ours, theirs) {
    if (theirs.length !== ours.length - 1) return false;
    const lower = ours.toLowerCase();
    for (let index = 0; index < ours.length; index++) {
        if (`${lower.slice(0, index)}${lower.slice(index + 1)}` !== theirs.toLowerCase()) continue;
        if (LIGATURE_PAIRS.has(lower.slice(Math.max(0, index - 1), index + 1))
            || LIGATURE_PAIRS.has(lower.slice(index, index + 2))) {
            return true;
        }
    }
    return false;
}

function casePattern(core) {
    const letters = core.replace(/[^\p{L}]/gu, '');
    if (letters === letters.toLowerCase()) return 'lower';
    if (letters === letters.toUpperCase()) return 'upper';
    if (letters[0] === letters[0].toUpperCase() && letters.slice(1) === letters.slice(1).toLowerCase()) return 'title';
    return 'mixed';
}

function isDigit(character) {
    return /\p{N}/u.test(character);
}

function marks(core) {
    return core.replace(/[^'’-]/gu, '');
}

function editDistance(left, right) {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
        const current = [i];
        for (let j = 1; j <= right.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
                previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[right.length];
}

// Our word with its letters as printed; our punctuation stays.
function printedWord(ours, theirs) {
    const [, lead, , tail] = SHELL.exec(ours);
    const [, , printed] = SHELL.exec(strictText(theirs));
    return `${lead}${printed}${tail}`;
}

function replaceTokenText(token, text) {
    const content = token.span.content;
    if (typeof content !== 'string' || content.slice(token.start, token.end) !== token.text) return false;
    token.span.content = `${content.slice(0, token.start)}${text}${content.slice(token.end)}`;
    return true;
}

// MinerU sometimes writes a heading as a title and again at the start of
// the paragraph below it. When the PDF prints the heading's words once,
// inside the title's box, one copy goes. A heading whose printed line also
// carries the paragraph's own type (its font and size) is a run-in heading:
// the paragraph keeps it, with its number and punctuation as printed, and
// the title goes. A heading set apart stays, and the paragraph loses its
// copy. Anything that does not line up exactly is left as it is.
function removeDuplicateHeadings(ir, itemsByPage, diagnostics) {
    const removed = new Set();
    for (let index = 0; index + 1 < ir.blocks.length; index++) {
        const heading = ir.blocks[index];
        const paragraph = ir.blocks[index + 1];
        if (heading.kind !== BLOCK_KIND.TITLE || paragraph.kind !== BLOCK_KIND.TEXT
            || heading.fragments?.length !== 1 || paragraph.fragments?.length !== 1
            || heading.fragments[0].pageIndex !== paragraph.fragments[0].pageIndex) {
            continue;
        }
        const items = itemsByPage.get(heading.fragments[0].pageIndex);
        const headingBox = heading.fragments[0].bbox;
        const paragraphBox = paragraph.fragments[0].bbox;
        if (!items || !validBox(headingBox) || !validBox(paragraphBox)) continue;
        const height = headingBox[3] - headingBox[1];
        // The paragraph starts below the heading's top and close to its
        // bottom, in the same column.
        if (paragraphBox[1] < headingBox[1] - height / 2 || paragraphBox[1] - headingBox[3] > height
            || paragraphBox[0] >= headingBox[2] || paragraphBox[2] <= headingBox[0]) {
            continue;
        }
        const headingTokens = fragmentTokens(heading.fragments[0]);
        if (!headingTokens.length || headingTokens.some(token => token.barrier)) continue;
        const words = withoutNumber(headingTokens);
        if (words.tokens.map(token => token.key).join('').replace(/\p{N}/gu, '').length
            < PDF_TEXT_CHECK_LIMITS.minDuplicateHeadingLetters) {
            continue;
        }
        const paragraphTokens = withoutNumber(fragmentTokens(paragraph.fragments[0]));
        // The paragraph has words of its own after the copy.
        if (paragraphTokens.tokens.length <= words.tokens.length) continue;
        const copy = paragraphTokens.tokens.slice(0, words.tokens.length);
        if (copy.some((token, at) => token.barrier || token.key !== words.tokens[at].key)) continue;
        const union = [Math.min(headingBox[0], paragraphBox[0]), Math.min(headingBox[1], paragraphBox[1]),
            Math.max(headingBox[2], paragraphBox[2]), Math.max(headingBox[3], paragraphBox[3])];
        const inside = itemsInBox(union, items);
        if (!inside.length || inside.length > PDF_TEXT_CHECK_LIMITS.maxFragmentItems) continue;
        const printed = pdfTokens(inside);
        const at = occurrences(printed, words.tokens);
        if (at.length !== 1) continue;
        const first = printed[at[0]];
        const last = printed[at[0] + words.tokens.length - 1];
        // The PDF prints the heading where MinerU found the title.
        if (!insideBox(headingBox, first.bbox) || !insideBox(headingBox, last.bbox)) continue;
        if (runsIn(printed, at[0], at[0] + words.tokens.length - 1)) {
            if (!repairRunInHeading(words, paragraphTokens, printed, at[0])) continue;
            removed.add(heading);
        }
        else {
            // Both copies carry the same number, or neither does.
            if (Boolean(words.number) !== Boolean(paragraphTokens.number)) continue;
            removeTokens(paragraph.fragments[0], [...(paragraphTokens.number ? [paragraphTokens.number] : []), ...copy]);
        }
        diagnostics.duplicateHeadings++;
    }
    if (removed.size) ir.blocks = ir.blocks.filter(block => !removed.has(block));
}

// Whether the lines of a printed heading also carry the paragraph's type,
// read from the paragraph's later lines (or the rest of the heading's line).
function runsIn(printed, firstAt, lastAt) {
    const first = printed[firstAt];
    const last = printed[lastAt];
    const later = printed.filter(token => token.line > last.line);
    const body = commonStyle(later.length ? later : printed.slice(lastAt + 1).filter(token => token.line === last.line));
    if (!body || style(first) === body) return false;
    return printed.some(token => token.line >= first.line && token.line <= last.line && style(token) === body);
}

function style(token) {
    return `${token.font}|${Math.round(token.size * 2)}`;
}

function commonStyle(tokens) {
    const counts = new Map();
    for (const token of tokens) counts.set(style(token), (counts.get(style(token)) || 0) + token.text.length);
    return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] || null;
}

function insideBox(box, inner) {
    const margin = 4;
    const x = (inner[0] + inner[2]) / 2;
    const y = (inner[1] + inner[3]) / 2;
    return x >= box[0] - margin && x <= box[2] + margin && y >= box[1] - margin && y <= box[3] + margin;
}

// A leading section number ("3.2.2.") is not part of a heading's words.
function withoutNumber(tokens) {
    const first = tokens[0];
    if (first && !first.barrier && isSectionNumber(first.text)) return { number: first, tokens: tokens.slice(1) };
    return { number: null, tokens };
}

function isSectionNumber(text) {
    return /^\d{1,3}(?:\.\d{1,3})*\.?$/u.test(strictText(text));
}

function occurrences(printed, words) {
    const found = [];
    for (let start = 0; start + words.length <= printed.length; start++) {
        if (words.every((word, offset) => printed[start + offset].key === word.key)) found.push(start);
    }
    return found;
}

// The paragraph's copy of a run-in heading takes the printed section number
// and punctuation. Returns false, changing nothing, unless the copy then
// reads as printed.
function repairRunInHeading(words, paragraphTokens, printed, start) {
    const before = printed[start - 1];
    const printedNumber = before && before.line === printed[start].line && isSectionNumber(before.text) ? before : null;
    if (Boolean(words.number) !== Boolean(printedNumber)) return false;
    if (words.number && strictText(words.number.text) !== strictText(printedNumber.text)) return false;
    if (paragraphTokens.number && !printedNumber) return false;
    const copy = paragraphTokens.tokens.slice(0, words.tokens.length);
    // In reading order; applied last first, so earlier offsets stay valid.
    const edits = [];
    if (paragraphTokens.number && strictText(paragraphTokens.number.text) !== strictText(printedNumber.text)) {
        edits.push([paragraphTokens.number, printedNumber.text]);
    }
    for (let offset = 0; offset < copy.length; offset++) {
        const [, ourLead, ourCore, ourTail] = SHELL.exec(strictText(copy[offset].text));
        const [, lead, , tail] = SHELL.exec(strictText(printed[start + offset].text));
        if (ourLead !== lead || ourTail !== tail) edits.push([copy[offset], `${lead}${ourCore}${tail}`]);
    }
    if (edits.some(([token]) => token.span.content.slice(token.start, token.end) !== token.text)) return false;
    for (const [token, text] of edits.reverse()) replaceTokenText(token, text);
    if (printedNumber && !paragraphTokens.number) {
        const token = copy[0];
        token.span.content = `${token.span.content.slice(0, token.start)}${printedNumber.text} ${token.span.content.slice(token.start)}`;
    }
    return true;
}

// Removes the words from their spans, last first so offsets stay valid,
// with the space that follows each, and drops spans and lines left empty.
function removeTokens(fragment, tokens) {
    for (const token of [...tokens].reverse()) {
        const content = token.span.content;
        if (content.slice(token.start, token.end) !== token.text) continue;
        const after = content.slice(token.end).match(/^\s*/u)[0].length;
        token.span.content = `${content.slice(0, token.start)}${content.slice(token.end + after)}`;
    }
    for (const span of new Set(tokens.map(token => token.span))) span.content = span.content.replace(/^\s+/u, '');
    for (const line of fragment.lines) {
        line.spans = line.spans.filter(span => span.type !== 'text' || span.content.trim());
    }
    fragment.lines = fragment.lines.filter(line => line.spans.length);
}

function validBox(bbox) {
    return Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite) && bbox[0] < bbox[2] && bbox[1] < bbox[3];
}
