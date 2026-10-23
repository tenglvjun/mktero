import { BLOCK_KIND, BLOCK_ROLE, blockPlainText } from './ir.js';

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
