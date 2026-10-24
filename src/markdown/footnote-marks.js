// The marks that tie a footnote to the text that cites it: "1", "a", "*",
// "†". A superscript can carry several ("1,3"); TeX names become symbols.
const MARK_NAMES = new Map([
    ['\\ddagger', '‡'], ['\\dagger', '†'], ['\\ast', '*'], ['\\star', '*'], ['\\S', '§'], ['\\P', '¶'],
    ['\\#', '#'], ['\\sharp', '#'], ['\\circ', '°'], ['\\triangle', '△'],
]);
const SUPERSCRIPT_DIGITS = new Map([...'⁰¹²³⁴⁵⁶⁷⁸⁹'].map((digit, value) => [digit, String(value)]));
const MARK_KEY = /^(?:\d{1,3}|[a-z]|[*†‡§¶#°△]+)$/u;

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
