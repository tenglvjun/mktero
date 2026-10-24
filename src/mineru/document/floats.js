import {
    parseAcademicFigureCaption,
    parseAcademicTableCaption,
} from '../../markdown/markdown-figures.js';
import { BLOCK_KIND, BLOCK_ROLE, blockPlainText, fragmentText, isFloatBlock } from './ir.js';
import { sanitizeTableHTML } from './text.js';

const NOTE_FLOAT_KINDS = new Set([BLOCK_KIND.IMAGE, BLOCK_KIND.CHART, BLOCK_KIND.TABLE]);
const NOTE_START = /^(?:\^\{|[*†‡§¶#]|\(?[a-z]\)\s|notes?\b|abbreviations?\b|sources?\b|data (?:are|is|were)\b|values (?:are|were)\b|numbers (?:are|were)\b|results (?:are|were)\b|all values\b|p\s*[<>=≤≥]|n\s*=)/iu;
const MAX_NOTE_GAP = 14;
const MAX_NOTE_WORDS = 160;
const HORIZONTAL_SLACK = 12;

// MinerU sometimes leaves a table or figure footnote as body text right under
// its float. A short block that sits directly below a float, inside its
// width, and reads like a note ("Numbers are …", "^{b} …", "Abbreviations:")
// is attached to the float; a chain of such blocks attaches together.
export function attachFloatNotes(ir) {
    const byPage = new Map();
    for (const block of ir.blocks) {
        if (!byPage.has(block.pageIndex)) byPage.set(block.pageIndex, []);
        byPage.get(block.pageIndex).push(block);
    }
    for (const blocks of byPage.values()) {
        const candidates = blocks
            .filter(block => block.role === BLOCK_ROLE.BODY && block.kind === BLOCK_KIND.TEXT
                && block.bbox && block.fragments.length === 1)
            .sort((left, right) => left.bbox[1] - right.bbox[1]);
        for (const float of blocks) {
            if (!NOTE_FLOAT_KINDS.has(float.kind) || !float.bbox) continue;
            let bottom = float.bbox[3];
            for (const candidate of candidates) {
                if (candidate.role !== BLOCK_ROLE.BODY || candidate.bbox[1] < bottom - 4) continue;
                if (candidate.bbox[1] - bottom > MAX_NOTE_GAP) break;
                if (candidate.bbox[0] < float.bbox[0] - HORIZONTAL_SLACK
                    || candidate.bbox[2] > float.bbox[2] + HORIZONTAL_SLACK) {
                    continue;
                }
                const text = blockPlainText(candidate).trim();
                if (!NOTE_START.test(text) || text.split(/\s+/u).length > MAX_NOTE_WORDS) break;
                candidate.role = BLOCK_ROLE.FLOAT_NOTE;
                candidate.attachedTo = float.id;
                bottom = candidate.bbox[3];
            }
        }
    }
    return ir;
}

const TABLE_LABEL = /^table\b/iu;
const FIGURE_LABEL = /^(?:fig(?:ure)?|chart|scheme|algorithm)\b/iu;
const BARE_LABEL_START = /^(?:table|fig(?:ure)?\.?|chart|scheme|algorithm|supplement(?:ary|al)?|extended|suppl\.?)\b/iu;
const CAPTION_CLASS = new Map([
    [BLOCK_KIND.TABLE, 'table'],
    [BLOCK_KIND.IMAGE, 'figure'],
    [BLOCK_KIND.CHART, 'figure'],
]);
const GROUP_GAP = 30;
const GROUP_WIDTH_RATIO = 0.1;
const GROUP_OVERLAP = 0.5;
const GROUP_LIMIT = 8;
const CONTINUED_TOP = 150;
const ORDERED_ROLES = new Set([BLOCK_ROLE.BODY, BLOCK_ROLE.HEADING, BLOCK_ROLE.REFERENCE, BLOCK_ROLE.FLOAT]);

// MinerU sometimes attaches the next float's caption to the float above it.
// When one float carries two labels of its class and the second label is
// closer to an unlabeled float of the same class, that label and the
// unlabeled caption pieces after it move. Distance is center to center:
// a label under a tall table can be nearer that table's bottom edge and
// still closer to the short table it captions.
export function reassignFloatCaptions(ir) {
    const moves = ensureList(ir, 'captionMoves');
    const pending = [];
    for (const group of floatsByPageClass(ir.blocks)) {
        for (const source of group) {
            const pieces = classedCaptionPieces(source);
            if (pieces.labeled.length < 2) continue;
            const second = pieces.labeled[1];
            const own = captionDistance(second.bbox, bodyBox(source));
            let target = null;
            let best = own;
            for (const candidate of group) {
                if (candidate === source || classedCaptionPieces(candidate).labeled.length) continue;
                const box = bodyBox(candidate);
                if (!boxesOverlapX(second.bbox, box)) continue;
                const distance = captionDistance(second.bbox, box);
                if (distance < best) {
                    best = distance;
                    target = candidate;
                }
            }
            if (!target) continue;
            const start = pieces.ordered.indexOf(second.child);
            const nextLabel = pieces.ordered.findIndex((child, index) => (
                index > start && captionLabel(captionChildText(child), floatClass(source))
            ));
            pending.push({
                source,
                target,
                moving: pieces.ordered.slice(start, nextLabel < 0 ? undefined : nextLabel),
                distance: best,
            });
        }
    }
    pending.sort((left, right) => left.distance - right.distance);
    const usedTargets = new Set();
    const usedSources = new Set();
    for (const move of pending) {
        if (usedTargets.has(move.target) || usedSources.has(move.source)) continue;
        usedTargets.add(move.target);
        usedSources.add(move.source);
        const ids = new Set(move.moving.map(child => child.id));
        move.source.children = move.source.children.filter(child => !ids.has(child.id));
        move.target.children.push(...move.moving);
        moves.push({
            from: move.source.id,
            to: move.target.id,
            ids: move.moving.map(child => child.id),
            pageIndex: move.source.pageIndex,
        });
    }
    return ir;
}

// A table directly below a captioned table, with a similar width and no
// caption of its own, is the next panel of that table. It is written
// immediately after the captioned table so the Markdown group can keep one
// caption. A chain continues while each next table still meets the gap.
export function groupAdjacentTables(ir) {
    const groups = ensureList(ir, 'tableGroups');
    const tables = ir.blocks.filter(block => block.kind === BLOCK_KIND.TABLE && block.role === BLOCK_ROLE.FLOAT);
    const consumed = new Set();
    for (const host of tables) {
        if (consumed.has(host) || !hasTableLabel(host)) continue;
        const hostBox = bodyBox(host);
        if (!hostBox) continue;
        const members = [host];
        let anchor = host;
        let anchorBox = hostBox;
        while (members.length < GROUP_LIMIT) {
            const next = tables
                .filter(other => other !== anchor && !consumed.has(other) && !members.includes(other)
                    && other.pageIndex === host.pageIndex && !hasCaptionText(other))
                .map(other => ({ other, box: bodyBox(other) }))
                .filter(entry => entry.box && directlyBelow(anchorBox, entry.box, hostBox)
                    && !separatedByContent(ir.blocks, anchor, entry.other, members))
                .sort((left, right) => left.box[1] - right.box[1])[0]?.other;
            if (!next) break;
            members.push(next);
            consumed.add(next);
            anchor = next;
            anchorBox = bodyBox(next);
        }
        if (members.length < 2) continue;
        ir.blocks = placeTableGroup(ir.blocks, members);
        groups.push({
            id: host.id,
            pageIndex: host.pageIndex,
            members: members.map(member => member.id),
        });
    }
    return ir;
}

// A page-top uncaptioned table continues the previous page's last table when
// both have the same column count. Rows are appended; a repeated header row
// is dropped. MinerU's own merged continuations already have a fragment on
// the next page and are left alone. Any HTML we cannot parse stays separate.
export function mergeContinuedTables(ir) {
    const merged = ensureList(ir, 'continuedTables');
    const removed = new Set();
    const pages = [...new Set(ir.blocks.map(block => block.pageIndex))].sort((left, right) => left - right);
    for (const pageIndex of pages) {
        // MinerU 4.0 says which table continues, wherever it starts on the
        // page; otherwise an uncaptioned table at the top of the page does.
        const first = ir.blocks.find(block => block.pageIndex === pageIndex && !removed.has(block)
            && block.kind === BLOCK_KIND.TABLE && block.role === BLOCK_ROLE.FLOAT && block.continuesPrev)
            || ir.blocks.find(block => (
                block.pageIndex === pageIndex && !removed.has(block) && isOrderedItem(block)
            ));
        if (!first || first.kind !== BLOCK_KIND.TABLE || first.role !== BLOCK_ROLE.FLOAT) continue;
        if (!first.continuesPrev) {
            if (hasCaptionText(first)) continue;
            const top = bodyBox(first)?.[1] ?? first.bbox?.[1];
            if (!Number.isFinite(top) || top > CONTINUED_TOP) continue;
        }
        const host = [...ir.blocks].reverse().find(block => (
            block.pageIndex === pageIndex - 1 && !removed.has(block)
            && block.role === BLOCK_ROLE.FLOAT && isFloatBlock(block)
        ));
        if (!host || host.kind !== BLOCK_KIND.TABLE || mineruMergedTable(host)) continue;
        const appended = appendTableHTML(tableHTML(host), tableHTML(first));
        const box = sourceBox(bodyBox(first) || first.bbox);
        if (!appended || !box) continue;
        const body = htmlBody(host);
        if (!body) continue;
        body.html = appended.html;
        host.fragments ||= [];
        host.absorbed ||= [];
        host.fragments.push({ pageIndex, bbox: [...box], lines: [], sourceId: first.id });
        host.absorbed.push(first.id);
        for (const child of first.children || []) {
            if (child.kind === 'footnote') host.children.push(child);
        }
        for (const note of ir.blocks) {
            if (note.attachedTo === first.id) note.attachedTo = host.id;
        }
        removed.add(first);
        merged.push({
            id: first.id,
            into: host.id,
            pageIndex,
            droppedHeader: appended.droppedHeader,
        });
    }
    if (removed.size) ir.blocks = ir.blocks.filter(block => !removed.has(block));
    return ir;
}

function ensureList(ir, key) {
    ir.diagnostics ||= {};
    ir.diagnostics[key] ||= [];
    return ir.diagnostics[key];
}

function floatsByPageClass(blocks) {
    const groups = new Map();
    for (const block of blocks) {
        const cls = floatClass(block);
        if (!cls || block.role !== BLOCK_ROLE.FLOAT) continue;
        const key = `${block.pageIndex}:${cls}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(block);
    }
    return groups.values();
}

function floatClass(block) {
    return CAPTION_CLASS.get(block?.kind) || null;
}

function classedCaptionPieces(block) {
    const cls = floatClass(block);
    const ordered = captionChildren(block);
    const labeled = ordered
        .map(child => ({ child, bbox: child.bbox, label: captionLabel(captionChildText(child), cls) }))
        .filter(piece => piece.label);
    return { ordered, labeled };
}

function captionChildren(block) {
    return (block.children || [])
        .map((child, index) => ({ child, index }))
        .filter(entry => entry.child.kind === 'caption')
        .sort((left, right) => (left.child.bbox && right.child.bbox
            ? left.child.bbox[1] - right.child.bbox[1] || left.child.bbox[0] - right.child.bbox[0]
            : 0) || left.index - right.index)
        .map(entry => entry.child);
}

function captionChildText(child) {
    return (child.fragments || [])
        .map(fragment => fragmentText(fragment))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function captionLabel(text, cls) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    const direct = parsedCaptionLabel(trimmed);
    const label = direct || bareCaptionLabel(trimmed);
    if (!label || (cls && label.class !== cls)) return null;
    return label;
}

function parsedCaptionLabel(text) {
    const table = parseAcademicTableCaption(text);
    if (table && TABLE_LABEL.test(table.label)) return { ...table, class: 'table' };
    const figure = parseAcademicFigureCaption(text);
    if (figure && FIGURE_LABEL.test(figure.label)) return { ...figure, class: 'figure' };
    if (figure && TABLE_LABEL.test(figure.label)) return { ...figure, class: 'table' };
    return null;
}

function bareCaptionLabel(text) {
    if (text.length > 48 || text.split(/\s+/u).length > 6 || !BARE_LABEL_START.test(text)) return null;
    const stem = text.replace(/[.:：。|｜\s]+$/u, '');
    if (!stem) return null;
    for (const trial of [`${text} x`, `${stem}. x`, `${stem}: x`]) {
        const parsed = parsedCaptionLabel(trial);
        if (!parsed) continue;
        if (parsed.label.replace(/[.:：。|｜\s]+$/u, '').toLowerCase() !== stem.toLowerCase()) continue;
        return { ...parsed, text, label: parsed.label.replace(/\s+x$/u, '').trim(), description: '' };
    }
    return null;
}

function hasTableLabel(block) {
    return captionChildren(block).some(child => captionLabel(captionChildText(child), 'table'));
}

function hasCaptionText(block) {
    return captionChildren(block).some(child => captionChildText(child));
}

function bodyBox(block) {
    const boxes = (block.children || []).filter(child => child.kind === 'body' && child.bbox).map(child => child.bbox);
    return unionBox(boxes) || block.bbox || null;
}

function unionBox(boxes) {
    let output = null;
    for (const bbox of boxes) {
        if (!validBox(bbox)) continue;
        output = output
            ? [
                Math.min(output[0], bbox[0]),
                Math.min(output[1], bbox[1]),
                Math.max(output[2], bbox[2]),
                Math.max(output[3], bbox[3]),
            ]
            : [...bbox];
    }
    return output;
}

function validBox(bbox) {
    return Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)
        && bbox[2] > bbox[0] && bbox[3] > bbox[1];
}

function sourceBox(bbox) {
    return validBox(bbox) && bbox.every(value => value >= 0 && value <= 1000) ? bbox : null;
}

function captionDistance(caption, body) {
    if (!validBox(caption) || !validBox(body)) return Infinity;
    return Math.hypot(
        (caption[0] + caption[2]) / 2 - (body[0] + body[2]) / 2,
        (caption[1] + caption[3]) / 2 - (body[1] + body[3]) / 2,
    );
}

function boxesOverlapX(left, right) {
    if (!validBox(left) || !validBox(right)) return false;
    return Math.min(left[2], right[2]) - Math.max(left[0], right[0]) > 0;
}

function directlyBelow(above, below, reference) {
    const gap = below[1] - above[3];
    if (gap < 0 || gap > GROUP_GAP) return false;
    const width = reference[2] - reference[0];
    const other = below[2] - below[0];
    if (!(width > 0) || Math.abs(other - width) / width > GROUP_WIDTH_RATIO) return false;
    const overlap = Math.min(above[2], below[2]) - Math.max(above[0], below[0]);
    const narrower = Math.min(above[2] - above[0], below[2] - below[0]);
    return narrower > 0 && overlap / narrower >= GROUP_OVERLAP;
}

function separatedByContent(blocks, above, below, members) {
    const memberIds = new Set(members.map(member => member.id));
    const top = bodyBox(above)?.[3] ?? above.bbox?.[3];
    const bottom = bodyBox(below)?.[1] ?? below.bbox?.[1];
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return true;
    return blocks.some(block => {
        if (block === above || block === below || memberIds.has(block.id) || !block.bbox) return false;
        if (block.pageIndex !== above.pageIndex) return false;
        if (block.role === BLOCK_ROLE.CHROME || block.role === BLOCK_ROLE.PAGE_NOTE
            || block.kind === BLOCK_KIND.DISCARDED) return false;
        if (block.role === BLOCK_ROLE.FLOAT_NOTE && memberIds.has(block.attachedTo)) return false;
        const overlapsY = block.bbox[3] > top + 2 && block.bbox[1] < bottom - 2;
        return overlapsY && boxesOverlapX(block.bbox, above.bbox || bodyBox(above));
    });
}

function placeTableGroup(blocks, members) {
    const memberIds = new Set(members.map(member => member.id));
    const notes = blocks.filter(block => memberIds.has(block.attachedTo));
    const moving = new Set([...members.slice(1), ...notes]);
    const rest = blocks.filter(block => !moving.has(block));
    rest.splice(rest.indexOf(members[0]) + 1, 0, ...members.slice(1), ...notes);
    return rest;
}

function isOrderedItem(block) {
    return ORDERED_ROLES.has(block?.role) && block.kind !== BLOCK_KIND.DISCARDED;
}

function mineruMergedTable(block) {
    return (block.absorbed || []).length > 0
        || (block.fragments || []).some(fragment => fragment.pageIndex !== block.pageIndex);
}

function htmlBody(block) {
    const bodies = (block.children || []).filter(child => (
        child.kind === 'body' && typeof child.html === 'string' && child.html.trim()
    ));
    return bodies.length === 1 ? bodies[0] : null;
}

function tableHTML(block) {
    return htmlBody(block)?.html || '';
}

function appendTableHTML(hostHTML, continuationHTML) {
    const host = parseTableHTML(hostHTML);
    const continuation = parseTableHTML(continuationHTML);
    if (!host || !continuation || host.columns !== continuation.columns) return null;
    const dropHeader = sameRow(host.rows[0], continuation.rows[0]);
    const rows = dropHeader ? continuation.rows.slice(1) : continuation.rows;
    const html = `${host.open}${[...host.rows, ...rows].map(row => row.html).join('')}</table>`;
    return sanitizeTableHTML(html) ? { html, droppedHeader: dropHeader } : null;
}

function parseTableHTML(html) {
    const trimmed = String(html || '').trim();
    const open = /^<table\b[^>]*>/iu.exec(trimmed);
    if (!open || !/<\/table>$/iu.test(trimmed)) return null;
    if ((trimmed.match(/<table\b/giu) || []).length !== 1) return null;
    if ((trimmed.match(/<\/table>/giu) || []).length !== 1) return null;
    let inner = trimmed.slice(open[0].length, trimmed.length - '</table>'.length);
    if (/<!--|<!\[CDATA\[|<script\b|<style\b/iu.test(inner)) return null;
    if (/<\/(?:thead|tbody|tfoot)\b/iu.test(inner) && !sectionTagsBalance(inner)) return null;
    inner = inner.replace(/<\/?(?:thead|tbody|tfoot)\b[^>]*>/giu, '');
    const rows = [];
    const pattern = /<tr\b[^>]*>[\s\S]*?<\/tr>/giu;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(inner))) {
        if (inner.slice(cursor, match.index).trim()) return null;
        const cells = parseRowCells(match[0]);
        if (!cells) return null;
        rows.push({ html: match[0], cells });
        cursor = match.index + match[0].length;
    }
    if (!rows.length || inner.slice(cursor).trim()) return null;
    const columns = rows[0].cells.reduce((sum, cell) => sum + cell.colspan, 0);
    if (!Number.isInteger(columns) || columns < 1 || columns > 64) return null;
    return { open: open[0], rows, columns };
}

function sectionTagsBalance(html) {
    const tags = html.match(/<\/?(?:thead|tbody|tfoot)\b[^>]*>/giu) || [];
    const stack = [];
    for (const tag of tags) {
        const name = tag.replace(/<\/?|\s.*|>/gu, '').toLowerCase();
        if (tag.startsWith('</')) {
            if (stack.pop() !== name) return false;
        }
        else stack.push(name);
    }
    return stack.length === 0;
}

function parseRowCells(rowHTML) {
    const inner = rowHTML.replace(/^<tr\b[^>]*>/iu, '').replace(/<\/tr>$/iu, '');
    const cells = [];
    const pattern = /<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/giu;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(inner))) {
        if (inner.slice(cursor, match.index).trim()) return null;
        if (/<t[dh]\b|<\/?tr\b|<table\b/iu.test(match[3])) return null;
        const colspan = colspanOf(match[2]);
        if (!colspan) return null;
        cells.push({ colspan });
        cursor = match.index + match[0].length;
    }
    if (!cells.length || inner.slice(cursor).trim()) return null;
    return cells;
}

function colspanOf(attrs) {
    const match = /\bcolspan\s*=\s*("[^"]*"|'[^']*'|\S+)/iu.exec(attrs);
    if (!match) return 1;
    const raw = match[1].replace(/^["']|["']$/gu, '');
    if (!/^\d+$/u.test(raw)) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= 64 ? value : null;
}

function sameRow(left, right) {
    return left.html.replace(/\s+/gu, ' ').trim() === right.html.replace(/\s+/gu, ' ').trim();
}
