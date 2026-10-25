// The marks that tie a footnote to the text that cites it: "1", "a", "*",
// "†". A superscript can carry several ("1,3"); TeX names become symbols.
const MARK_NAMES = new Map([
    ['\\ddagger', '‡'], ['\\dagger', '†'], ['\\ast', '*'], ['\\star', '*'], ['\\S', '§'], ['\\P', '¶'],
    ['\\#', '#'], ['\\sharp', '#'], ['\\circ', '°'], ['\\triangle', '△'],
]);
const SUPERSCRIPT_DIGITS = new Map([...'⁰¹²³⁴⁵⁶⁷⁸⁹'].map((digit, value) => [digit, String(value)]));
const MARK_KEY = /^(?:\d{1,3}|[a-z]|[*†‡§¶#°△]+)$/u;

// What a footnote link shows for a TeX mark: every mark it holds, as the PDF
// prints them ("1,\dagger" → "1,†"). When a part is not a mark the link
// knows, it shows the first mark alone rather than a partial list.
export function footnoteMarkDisplayText(value) {
    const parts = String(value || '').trim().split(/\s*,\s*/u).filter(Boolean);
    const keys = footnoteMarkKeys(value);
    if (!keys.length) return '';
    return keys.length === parts.length ? keys.join(',') : keys[0];
}

// Normalized marks of a superscript: "1,3" → ["1", "3"], "\dagger" → ["†"],
// "¹²" → ["12"].
export function footnoteMarkKeys(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];
    if ([...raw].every(character => SUPERSCRIPT_DIGITS.has(character))) {
        return [[...raw].map(character => SUPERSCRIPT_DIGITS.get(character)).join('')];
    }
    return raw.split(/\s*,\s*/u).map(part => {
        let key = part.replace(/\s+/gu, '');
        for (const [name, symbol] of MARK_NAMES) key = key.replaceAll(name, symbol);
        return key;
    }).filter(key => MARK_KEY.test(key));
}
